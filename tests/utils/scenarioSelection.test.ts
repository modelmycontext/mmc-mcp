import { describe, it, expect } from 'vitest';
import { selectFirstMatch } from '../../src/utils/scenarioSelection.js';

describe('selectFirstMatch', () => {
  it('returns the first matching scenario by authored index', async () => {
    const r = await selectFirstMatch(['a', 'b', 'c'], (s) => s === 'b' || s === 'c');
    expect(r).toEqual({ scenario: 'b', index: 1 });
  });

  it('returns null when nothing matches', async () => {
    expect(await selectFirstMatch(['a', 'b'], () => false)).toBeNull();
  });

  it('returns null for an empty scenario list', async () => {
    expect(await selectFirstMatch([], () => true)).toBeNull();
  });

  it('selects by authored index, NOT completion order (slow earlier beats fast later)', async () => {
    // Earlier scenario resolves true but slowly; later scenario resolves true
    // fast. First-match must pick the earlier one regardless of timing.
    const order: number[] = [];
    const r = await selectFirstMatch([0, 1], async (_s, i) => {
      if (i === 0) { await new Promise(res => setTimeout(res, 30)); order.push(0); return true; }
      order.push(1); return true; // resolves first
    });
    expect(order[0]).toBe(1);            // later one finished first (proves parallelism)
    expect(r).toEqual({ scenario: 0, index: 0 }); // ...but earlier one is selected
  });

  it('evaluates all predicates in parallel (later predicates still run)', async () => {
    const seen: number[] = [];
    await selectFirstMatch([0, 1, 2], (_s, i) => { seen.push(i); return i === 0; });
    expect(seen.sort()).toEqual([0, 1, 2]); // every predicate invoked, even after index 0 matched
  });
});
