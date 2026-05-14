import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsonEventStore } from '../../src/events/jsonEventStore.js';
import { makeEvent } from '../helpers/fixtures.js';

vi.mock('@src/utils/logger.js', async () =>
  (await import('../_helpers/loggerMock')).loggerMock(),
);

// Stateful mock for fs/promises
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockRename = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', () => ({
  default: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    rename: mockRename,
  },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  rename: mockRename,
}));

function makeStatefulFs() {
  let stored = '';
  mockReadFile.mockImplementation(async () => stored);
  mockWriteFile.mockImplementation(async (_p: string, data: string) => { stored = data; });
  mockRename.mockResolvedValue(undefined);
  return { getStored: () => stored };
}

describe('JsonEventStore', () => {
  let store: JsonEventStore;

  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockRename.mockReset();
    store = new JsonEventStore('/test/data');
  });

  describe('append', () => {
    it('creates a new events array when file does not exist (ENOENT)', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      await store.append(makeEvent({ id: 'a', sequence: 1 }));

      expect(mockWriteFile).toHaveBeenCalled();
      const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(Array.isArray(written)).toBe(true);
      expect(written).toHaveLength(1);
      expect(written[0].id).toBe('a');
    });

    it('appends to existing events array', async () => {
      const existing = JSON.stringify([makeEvent({ id: 'existing', sequence: 1 })]);
      mockReadFile.mockResolvedValue(existing);
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      await store.append(makeEvent({ id: 'new', sequence: 2 }));

      const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(written).toHaveLength(2);
      expect(written[1].id).toBe('new');
    });

    it('converts Date timestamp to ISO string before storing', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error(''), { code: 'ENOENT' }));
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      const event = makeEvent({ id: 'ts', sequence: 1, timestamp: new Date('2025-06-01T00:00:00Z') });
      await store.append(event);

      const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(typeof written[0].timestamp).toBe('string');
      expect(written[0].timestamp).toBe('2025-06-01T00:00:00.000Z');
    });

    it('resets to empty array when existing file is not a valid JSON array', async () => {
      mockReadFile.mockResolvedValue('"not an array"');
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      await store.append(makeEvent({ id: 'a', sequence: 1 }));

      const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(written).toHaveLength(1);
    });

    it('writes to a .tmp file then renames to final path (atomic write)', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error(''), { code: 'ENOENT' }));
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      await store.append(makeEvent({ id: 'a', sequence: 1 }));

      const writePath = mockWriteFile.mock.calls[0][0] as string;
      expect(writePath.endsWith('.tmp')).toBe(true);
      expect(mockRename).toHaveBeenCalled();
    });

    it('serialises events in order when multiple appends queue up', async () => {
      const { getStored } = makeStatefulFs();

      const p1 = store.append(makeEvent({ id: 'first', sequence: 1 }));
      const p2 = store.append(makeEvent({ id: 'second', sequence: 2 }));
      await Promise.all([p1, p2]);

      const final = JSON.parse(getStored());
      expect(final).toHaveLength(2);
      expect(final[0].id).toBe('first');
      expect(final[1].id).toBe('second');
    });

    it('does not write for null event', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      await store.append(null as any);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('getMaxSequence', () => {
    it('returns 0 when file does not exist', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error(''), { code: 'ENOENT' }));
      expect(await store.getMaxSequence()).toBe(0);
    });

    it('returns 0 when file is empty', async () => {
      mockReadFile.mockResolvedValue('   ');
      expect(await store.getMaxSequence()).toBe(0);
    });

    it('returns the highest sequence number in the file', async () => {
      const events = [
        makeEvent({ id: 'a', sequence: 1 }),
        makeEvent({ id: 'b', sequence: 5 }),
        makeEvent({ id: 'c', sequence: 3 }),
      ];
      mockReadFile.mockResolvedValue(JSON.stringify(events));
      expect(await store.getMaxSequence()).toBe(5);
    });

    it('returns 0 when no events have sequence numbers', async () => {
      const events = [{ id: 'a', type: 'TEST' }];
      mockReadFile.mockResolvedValue(JSON.stringify(events));
      expect(await store.getMaxSequence()).toBe(0);
    });
  });

  describe('getPaged', () => {
    it('returns empty result when file does not exist', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error(''), { code: 'ENOENT' }));
      const result = await store.getPaged();
      expect(result.events).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('returns events in descending sequence order', async () => {
      const events = [
        makeEvent({ id: 'a', sequence: 1 }),
        makeEvent({ id: 'b', sequence: 2 }),
        makeEvent({ id: 'c', sequence: 3 }),
      ];
      mockReadFile.mockResolvedValue(JSON.stringify(events));
      const result = await store.getPaged(10, 0);
      expect(result.events.map(e => e.sequence)).toEqual([3, 2, 1]);
    });

    it('respects limit parameter', async () => {
      const events = Array.from({ length: 5 }, (_, i) => makeEvent({ id: `e${i}`, sequence: i + 1 }));
      mockReadFile.mockResolvedValue(JSON.stringify(events));
      const result = await store.getPaged(3, 0);
      expect(result.events).toHaveLength(3);
    });

    it('respects skip parameter', async () => {
      const events = Array.from({ length: 5 }, (_, i) => makeEvent({ id: `e${i}`, sequence: i + 1 }));
      mockReadFile.mockResolvedValue(JSON.stringify(events));
      // Desc order: 5,4,3,2,1. Skip 2 → starts at seq 3
      const result = await store.getPaged(10, 2);
      expect(result.events[0].sequence).toBe(3);
    });

    it('filters by sessionId when provided', async () => {
      const events = [
        makeEvent({ id: 'a', sequence: 1, sessionId: 'sess-1' }),
        makeEvent({ id: 'b', sequence: 2, sessionId: 'sess-2' }),
      ];
      mockReadFile.mockResolvedValue(JSON.stringify(events));
      const result = await store.getPaged(10, 0, 'sess-1');
      expect(result.events).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('reconstructs timestamp as Date object', async () => {
      const events = [makeEvent({ id: 'a', sequence: 1 })];
      mockReadFile.mockResolvedValue(JSON.stringify(events));
      const result = await store.getPaged(10, 0);
      expect(result.events[0].timestamp).toBeInstanceOf(Date);
    });
  });
});
