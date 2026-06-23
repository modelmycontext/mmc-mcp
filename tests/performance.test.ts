import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { EventBus } from '../src/events/eventBus.js';
import { SqliteEventStore } from '../src/events/sqliteEventStore.js';
import { evaluateBusinessRules } from '../src/utils/businessRuleEvaluator.js';
import { makeEvent, makeBusinessRule, makeFactIdToName } from './helpers/fixtures.js';

vi.mock('@src/utils/logger.js', async () =>
  (await import('./_helpers/loggerMock')).loggerMock(),
);

/**
 * Performance regression tests.
 *
 * Each test asserts a generous upper-bound on wall-clock time.
 * The thresholds are intentionally loose (5-10x typical) so that
 * they only fail when a real regression is introduced — not from
 * normal CI jitter.
 */

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------
describe('Performance: EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('publishes 1 000 events with a handler in < 500 ms', async () => {
    let count = 0;
    bus.subscribe('PERF', () => { count++; });

    const start = performance.now();
    for (let i = 0; i < 1_000; i++) {
      await bus.publish(makeEvent({ id: `perf-${i}`, type: 'PERF', sequence: undefined }));
    }
    const elapsed = performance.now() - start;

    expect(count).toBe(1_000);
    expect(elapsed).toBeLessThan(500);
  });

  it('publishes 1 000 events with 10 handlers in < 1 000 ms', async () => {
    const counts = Array.from({ length: 10 }, () => ({ n: 0 }));
    for (const c of counts) {
      bus.subscribe('PERF', () => { c.n++; });
    }

    const start = performance.now();
    for (let i = 0; i < 1_000; i++) {
      await bus.publish(makeEvent({ id: `perf-${i}`, type: 'PERF', sequence: undefined }));
    }
    const elapsed = performance.now() - start;

    for (const c of counts) expect(c.n).toBe(1_000);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('wildcard + specific handlers scale linearly for 1 000 events in < 1 000 ms', async () => {
    let specificCount = 0;
    let wildcardCount = 0;
    bus.subscribe('PERF', () => { specificCount++; });
    bus.subscribe('*', () => { wildcardCount++; });

    const start = performance.now();
    for (let i = 0; i < 1_000; i++) {
      await bus.publish(makeEvent({ id: `perf-${i}`, type: 'PERF', sequence: undefined }));
    }
    const elapsed = performance.now() - start;

    expect(specificCount).toBe(1_000);
    expect(wildcardCount).toBe(1_000);
    expect(elapsed).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// SqliteEventStore
// ---------------------------------------------------------------------------
describe('Performance: SqliteEventStore', () => {
  let tmpDir: string;
  let store: SqliteEventStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'perf-sqlite-'));
    store = new SqliteEventStore(tmpDir);
  });

  afterEach(async () => {
    (store as any).db.close();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // The 1 000-row seed loop in these tests dominates wall time. On CI's slower
  // hardware it can take ~15-18 s, exceeding Vitest's 5 s default test timeout
  // and killing the test before the threshold assertion runs. The threshold
  // (the bit we actually care about) still validates the operation under test;
  // the test-level timeout below only controls how long Vitest waits for the
  // whole `it()` to finish, including the seed.
  const PERF_TEST_TIMEOUT_MS = 60_000;

  it('appends 1 000 events in < 10 000 ms', async () => {
    const start = performance.now();
    for (let i = 0; i < 1_000; i++) {
      await store.append(
        makeEvent({ id: `e-${i}`, sequence: i + 1, correlationId: 'perf-sess' })
      );
    }
    const elapsed = performance.now() - start;

    expect(await store.getMaxSequence()).toBe(1_000);
    expect(elapsed).toBeLessThan(10_000);
  }, PERF_TEST_TIMEOUT_MS);

  it('getNextAfterSequence on 1 000 rows completes in < 100 ms', async () => {
    for (let i = 0; i < 1_000; i++) {
      await store.append(
        makeEvent({ id: `e-${i}`, type: i % 2 === 0 ? 'A' : 'B', sequence: i + 1, correlationId: 'perf-sess' })
      );
    }

    const start = performance.now();
    // Query from the middle of the table
    const result = await store.getNextAfterSequence(500, ['A'], 'perf-sess');
    const elapsed = performance.now() - start;

    expect(result).not.toBeNull();
    expect(result!.sequence).toBeGreaterThan(500);
    expect(elapsed).toBeLessThan(100);
  }, PERF_TEST_TIMEOUT_MS);

  it('getPaged on 1 000 rows completes in < 100 ms', async () => {
    for (let i = 0; i < 1_000; i++) {
      await store.append(
        makeEvent({ id: `e-${i}`, sequence: i + 1, correlationId: 'perf-sess' })
      );
    }

    const start = performance.now();
    const result = await store.getPaged(20, 0, 'perf-sess');
    const elapsed = performance.now() - start;

    expect(result.events).toHaveLength(20);
    expect(result.total).toBe(1_000);
    expect(elapsed).toBeLessThan(100);
  }, PERF_TEST_TIMEOUT_MS);

  it('getCorrelationFactValues with 500 events completes in < 200 ms', async () => {
    for (let i = 0; i < 500; i++) {
      await store.append(
        makeEvent({
          id: `e-${i}`,
          sequence: i + 1,
          correlationId: 'perf-sess',
          payload: { [`field-${i}`]: `value-${i}`, shared: `v${i}` },
        })
      );
    }

    const start = performance.now();
    const facts = store.getCorrelationFactValues('perf-sess');
    const elapsed = performance.now() - start;

    // "shared" should be the last written value
    expect(facts.shared).toBe('v499');
    expect(Object.keys(facts).length).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(200);
  }, PERF_TEST_TIMEOUT_MS);

  it('getCorrelationFactValues cache hit is < 5 ms', async () => {
    for (let i = 0; i < 200; i++) {
      await store.append(
        makeEvent({
          id: `e-${i}`,
          sequence: i + 1,
          correlationId: 'cache-sess',
          payload: { [`f-${i}`]: `v-${i}` },
        })
      );
    }

    // Prime the cache
    store.getCorrelationFactValues('cache-sess');

    const start = performance.now();
    const facts = store.getCorrelationFactValues('cache-sess');
    const elapsed = performance.now() - start;

    expect(Object.keys(facts).length).toBe(200);
    expect(elapsed).toBeLessThan(5);
  }, PERF_TEST_TIMEOUT_MS);

  it('cache invalidation on append works correctly', async () => {
    await store.append(
      makeEvent({ id: 'e1', sequence: 1, correlationId: 's1', payload: { tier: 'silver' } })
    );
    // Prime cache
    expect(store.getCorrelationFactValues('s1').tier).toBe('silver');

    // Append new event — should invalidate
    await store.append(
      makeEvent({ id: 'e2', sequence: 2, correlationId: 's1', payload: { tier: 'gold' } })
    );
    expect(store.getCorrelationFactValues('s1').tier).toBe('gold');
  });
});

// ---------------------------------------------------------------------------
// Business Rule Evaluator
// ---------------------------------------------------------------------------
describe('Performance: evaluateBusinessRules', () => {
  it('evaluates 100 deterministic rules against 200 facts in < 50 ms', async () => {
    const factValues: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      factValues[`fact-${i}`] = `value-${i}`;
    }

    const rules = Array.from({ length: 100 }, (_, i) =>
      makeBusinessRule({
        id: `rule-${i}`,
        factId: `fact-${i}`,
        operator: 'equals',
        value: `value-${i}`,
      })
    );

    const factIdToName = makeFactIdToName(
      ...rules.map((r) => [r.factId, r.factId] as [string, string])
    );

    const start = performance.now();
    const result = await evaluateBusinessRules(rules, factValues, factIdToName);
    const elapsed = performance.now() - start;

    expect(result).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });

  it('short-circuits on first failing rule without evaluating the rest', async () => {
    const factValues: Record<string, string> = {
      'fact-0': 'wrong', // will fail
    };
    for (let i = 1; i < 100; i++) {
      factValues[`fact-${i}`] = `value-${i}`;
    }

    const rules = Array.from({ length: 100 }, (_, i) =>
      makeBusinessRule({
        id: `rule-${i}`,
        factId: `fact-${i}`,
        operator: 'equals',
        value: `value-${i}`,
      })
    );

    const factIdToName = makeFactIdToName(
      ...rules.map((r) => [r.factId, r.factId] as [string, string])
    );

    const start = performance.now();
    const result = await evaluateBusinessRules(rules, factValues, factIdToName);
    const elapsed = performance.now() - start;

    expect(result).toBe(false);
    // Short-circuit should be near-instant
    expect(elapsed).toBeLessThan(10);
  });

  it('handles 1 000 facts with case-insensitive lookup in < 100 ms', async () => {
    const factValues: Record<string, string> = {};
    for (let i = 0; i < 1_000; i++) {
      factValues[`My-Fact-${i}`] = `val-${i}`;
    }

    // Rules use lowercase keys — exercises the normalized index
    const rules = Array.from({ length: 50 }, (_, i) =>
      makeBusinessRule({
        id: `rule-${i}`,
        factId: `my-fact-${i}`,
        operator: 'equals',
        value: `val-${i}`,
      })
    );

    const factIdToName = makeFactIdToName(
      ...rules.map((r) => [r.factId, r.factId] as [string, string])
    );

    const start = performance.now();
    const result = await evaluateBusinessRules(rules, factValues, factIdToName);
    const elapsed = performance.now() - start;

    expect(result).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });

  it('evaluates all operator types without regression in < 20 ms', async () => {
    const factValues: Record<string, string> = {
      name: 'Alice',
      email: 'alice@example.com',
      age: '30',
      score: '85',
      empty: '',
      filled: 'something',
    };
    const factIdToName = makeFactIdToName(
      ['name', 'name'],
      ['email', 'email'],
      ['age', 'age'],
      ['score', 'score'],
      ['empty', 'empty'],
      ['filled', 'filled'],
    );

    const rules = [
      makeBusinessRule({ id: 'r1', factId: 'name', operator: 'equals', value: 'Alice' }),
      makeBusinessRule({ id: 'r2', factId: 'name', operator: 'contains', value: 'lic' }),
      makeBusinessRule({ id: 'r3', factId: 'name', operator: 'starts with', value: 'Al' }),
      makeBusinessRule({ id: 'r4', factId: 'email', operator: 'ends with', value: '@example.com' }),
      makeBusinessRule({ id: 'r5', factId: 'name', operator: 'does not equal', value: 'Bob' }),
      makeBusinessRule({ id: 'r6', factId: 'name', operator: 'does not contain', value: 'xyz' }),
      makeBusinessRule({ id: 'r7', factId: 'age', operator: 'is greater than', value: '20' }),
      makeBusinessRule({ id: 'r8', factId: 'age', operator: 'is greater than or equal to', value: '30' }),
      makeBusinessRule({ id: 'r9', factId: 'score', operator: 'is less than', value: '100' }),
      makeBusinessRule({ id: 'r10', factId: 'score', operator: 'is less than or equal to', value: '85' }),
      makeBusinessRule({ id: 'r11', factId: 'empty', operator: 'is empty' as any }),
      makeBusinessRule({ id: 'r12', factId: 'filled', operator: 'is not empty' as any }),
    ];

    const start = performance.now();
    const result = await evaluateBusinessRules(rules, factValues, factIdToName);
    const elapsed = performance.now() - start;

    expect(result).toBe(true);
    expect(elapsed).toBeLessThan(20);
  });
});
