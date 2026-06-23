import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../src/shims/bun-sqlite.js';
import { ConsumedJtiStore } from '../../src/forms/consumedJtiStore.js';

function freshStore() {
  return ConsumedJtiStore.fromDatabase(new Database(':memory:'));
}

describe('ConsumedJtiStore (single-use jti / replay protection)', () => {
  let store: ConsumedJtiStore;
  beforeEach(() => { store = freshStore(); });

  it('claims a jti on first use and rejects every replay', () => {
    expect(store.claim('jti-abc', 1000)).toBe(true);   // first use → proceed
    expect(store.claim('jti-abc', 1001)).toBe(false);  // replay → reject
    expect(store.claim('jti-abc', 2000)).toBe(false);  // still rejected later
  });

  it('treats distinct jtis independently', () => {
    expect(store.claim('jti-1')).toBe(true);
    expect(store.claim('jti-2')).toBe(true);
    expect(store.claim('jti-1')).toBe(false);
    expect(store.claim('jti-2')).toBe(false);
  });

  it('isConsumed reflects claim state without itself claiming', () => {
    expect(store.isConsumed('jti-x')).toBe(false);
    expect(store.claim('jti-x')).toBe(true);
    expect(store.isConsumed('jti-x')).toBe(true);
    // isConsumed must not have consumed anything new
    expect(store.isConsumed('jti-y')).toBe(false);
    expect(store.claim('jti-y')).toBe(true);
  });

  it('persists across store instances sharing the same database', () => {
    const db = new Database(':memory:');
    const a = ConsumedJtiStore.fromDatabase(db);
    expect(a.claim('jti-shared')).toBe(true);
    const b = ConsumedJtiStore.fromDatabase(db); // re-init is idempotent (IF NOT EXISTS)
    expect(b.claim('jti-shared')).toBe(false);   // sees a's claim
  });
});
