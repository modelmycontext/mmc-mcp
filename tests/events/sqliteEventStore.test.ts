import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteEventStore } from '../../src/events/sqliteEventStore.js';
import { makeEvent } from '../helpers/fixtures.js';

vi.mock('@src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let tmpDir: string;
let store: SqliteEventStore;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'sqlite-evt-test-'));
  store = new SqliteEventStore(tmpDir);
});

afterEach(async () => {
  (store as any).db.close();
  // rm is async and tolerates EBUSY from WAL file locks releasing on Windows
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('SqliteEventStore', () => {
  describe('append and getMaxSequence', () => {
    it('returns 0 for getMaxSequence on empty store', async () => {
      expect(await store.getMaxSequence()).toBe(0);
    });

    it('stores an event and reflects it in getMaxSequence', async () => {
      await store.append(makeEvent({ sequence: 5 }));
      expect(await store.getMaxSequence()).toBe(5);
    });

    it('returns the highest sequence when multiple events stored', async () => {
      await store.append(makeEvent({ id: 'a', sequence: 1 }));
      await store.append(makeEvent({ id: 'b', sequence: 3 }));
      await store.append(makeEvent({ id: 'c', sequence: 2 }));
      expect(await store.getMaxSequence()).toBe(3);
    });

    it('handles timestamp as Date object (converts to ISO string)', async () => {
      const event = makeEvent({ id: 'ts-test', sequence: 1, timestamp: new Date('2025-01-15T10:00:00Z') });
      await store.append(event);
      expect(await store.getMaxSequence()).toBe(1);
    });

    it('handles timestamp already as ISO string', async () => {
      const event = makeEvent({ id: 'ts-str', sequence: 1, timestamp: '2025-01-15T10:00:00Z' as any });
      await store.append(event);
      expect(await store.getMaxSequence()).toBe(1);
    });
  });

  describe('getNextAfterSequence', () => {
    it('returns null when no events match types after given sequence', async () => {
      await store.append(makeEvent({ id: 'a', type: 'A', sequence: 1 }));
      const result = await store.getNextAfterSequence(0, ['B']);
      expect(result).toBeNull();
    });

    it('returns the first event by sequence above afterSequence matching the given types', async () => {
      await store.append(makeEvent({ id: 'a', type: 'A', sequence: 1 }));
      await store.append(makeEvent({ id: 'b', type: 'A', sequence: 2 }));
      const result = await store.getNextAfterSequence(0, ['A']);
      expect(result!.sequence).toBe(1);
    });

    it('returns the lowest-sequence matching event (not highest)', async () => {
      await store.append(makeEvent({ id: 'a', type: 'A', sequence: 2 }));
      await store.append(makeEvent({ id: 'b', type: 'A', sequence: 4 }));
      const result = await store.getNextAfterSequence(0, ['A']);
      expect(result!.sequence).toBe(2);
    });

    it('skips events at or below afterSequence', async () => {
      await store.append(makeEvent({ id: 'a', type: 'A', sequence: 1 }));
      await store.append(makeEvent({ id: 'b', type: 'A', sequence: 2 }));
      const result = await store.getNextAfterSequence(1, ['A']);
      expect(result!.sequence).toBe(2);
    });

    it('returns null when types array is empty', async () => {
      await store.append(makeEvent({ id: 'a', type: 'A', sequence: 1 }));
      expect(await store.getNextAfterSequence(0, [])).toBeNull();
    });

    it('filters by sessionId when provided', async () => {
      await store.append(makeEvent({ id: 'a', type: 'A', sequence: 1, sessionId: 'sess-1' }));
      await store.append(makeEvent({ id: 'b', type: 'A', sequence: 2, sessionId: 'sess-2' }));
      const result = await store.getNextAfterSequence(0, ['A'], 'sess-1');
      expect(result!.sequence).toBe(1);
      expect(result!.sessionId).toBe('sess-1');
    });

    it('parses payload JSON on retrieval', async () => {
      await store.append(makeEvent({ id: 'x', sequence: 1, payload: { tier: 'gold' } }));
      const result = await store.getNextAfterSequence(0, ['TEST']);
      expect(result!.payload).toEqual({ tier: 'gold' });
    });

    it('reconstructs timestamp as Date object', async () => {
      await store.append(makeEvent({ id: 'y', sequence: 1 }));
      const result = await store.getNextAfterSequence(0, ['TEST']);
      expect(result!.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('getSessionEventTypes', () => {
    it('returns empty Set for unknown session', () => {
      expect(store.getSessionEventTypes('unknown').size).toBe(0);
    });

    it('returns distinct event types for a session', async () => {
      await store.append(makeEvent({ id: 'a', type: 'A', sequence: 1, sessionId: 'sess-1' }));
      await store.append(makeEvent({ id: 'b', type: 'A', sequence: 2, sessionId: 'sess-1' }));
      await store.append(makeEvent({ id: 'c', type: 'B', sequence: 3, sessionId: 'sess-1' }));
      const types = store.getSessionEventTypes('sess-1');
      expect(types).toEqual(new Set(['A', 'B']));
    });

    it('does not include events from other sessions', async () => {
      await store.append(makeEvent({ id: 'a', type: 'A', sequence: 1, sessionId: 'sess-1' }));
      await store.append(makeEvent({ id: 'b', type: 'B', sequence: 2, sessionId: 'sess-2' }));
      const types = store.getSessionEventTypes('sess-1');
      expect(types.has('A')).toBe(true);
      expect(types.has('B')).toBe(false);
    });
  });

  describe('getSessionFactValues', () => {
    it('returns empty object for unknown session', () => {
      expect(store.getSessionFactValues('unknown')).toEqual({});
    });

    it('collects scalar payload fields from all session events', async () => {
      await store.append(makeEvent({ id: 'a', sequence: 1, sessionId: 'sess-1', payload: { tier: 'gold' } }));
      await store.append(makeEvent({ id: 'b', sequence: 2, sessionId: 'sess-1', payload: { amount: '100' } }));
      const facts = store.getSessionFactValues('sess-1');
      expect(facts.tier).toBe('gold');
      expect(facts.amount).toBe('100');
    });

    it('later events override earlier for same key', async () => {
      await store.append(makeEvent({ id: 'a', sequence: 1, sessionId: 'sess-1', payload: { tier: 'silver' } }));
      await store.append(makeEvent({ id: 'b', sequence: 2, sessionId: 'sess-1', payload: { tier: 'gold' } }));
      expect(store.getSessionFactValues('sess-1').tier).toBe('gold');
    });

    it('preserves nested object values in payloads', async () => {
      await store.append(makeEvent({ id: 'a', sequence: 1, sessionId: 'sess-1', payload: { user: { name: 'Alice' }, name: 'Alice' } }));
      const facts = store.getSessionFactValues('sess-1');
      expect(facts.name).toBe('Alice');
      expect(facts.user).toEqual({ name: 'Alice' });
    });

    it('skips null payload values', async () => {
      await store.append(makeEvent({ id: 'a', sequence: 1, sessionId: 'sess-1', payload: { field: null } }));
      const facts = store.getSessionFactValues('sess-1');
      expect(facts.field).toBeUndefined();
    });
  });

  describe('getPaged', () => {
    it('returns total:0 and empty events for empty store', async () => {
      const result = await store.getPaged();
      expect(result.total).toBe(0);
      expect(result.events).toHaveLength(0);
    });

    it('returns events in descending sequence order', async () => {
      await store.append(makeEvent({ id: 'a', sequence: 1 }));
      await store.append(makeEvent({ id: 'b', sequence: 2 }));
      await store.append(makeEvent({ id: 'c', sequence: 3 }));
      const result = await store.getPaged(10, 0);
      const seqs = result.events.map(e => e.sequence);
      expect(seqs).toEqual([3, 2, 1]);
    });

    it('respects limit parameter', async () => {
      for (let i = 1; i <= 5; i++) {
        await store.append(makeEvent({ id: `e${i}`, sequence: i }));
      }
      const result = await store.getPaged(3, 0);
      expect(result.events).toHaveLength(3);
    });

    it('respects skip parameter', async () => {
      for (let i = 1; i <= 5; i++) {
        await store.append(makeEvent({ id: `e${i}`, sequence: i }));
      }
      // Desc order: 5,4,3,2,1. Skip 2 → 3,2,1
      const result = await store.getPaged(10, 2);
      expect(result.events[0].sequence).toBe(3);
    });

    it('filters by sessionId when provided', async () => {
      await store.append(makeEvent({ id: 'a', sequence: 1, sessionId: 'sess-1' }));
      await store.append(makeEvent({ id: 'b', sequence: 2, sessionId: 'sess-2' }));
      const result = await store.getPaged(10, 0, 'sess-1');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].sessionId).toBe('sess-1');
    });

    it('parses payload JSON back to object', async () => {
      await store.append(makeEvent({ id: 'x', sequence: 1, payload: { foo: 'bar' } }));
      const result = await store.getPaged(10, 0);
      expect(result.events[0].payload).toEqual({ foo: 'bar' });
    });

    it('reconstructs timestamp as Date object', async () => {
      await store.append(makeEvent({ id: 'x', sequence: 1 }));
      const result = await store.getPaged(10, 0);
      expect(result.events[0].timestamp).toBeInstanceOf(Date);
    });

    it('returns correct total count', async () => {
      for (let i = 1; i <= 5; i++) {
        await store.append(makeEvent({ id: `e${i}`, sequence: i }));
      }
      const result = await store.getPaged(2, 0);
      expect(result.total).toBe(5);
      expect(result.events).toHaveLength(2);
    });
  });
});
