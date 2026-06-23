// consumedJtiStore.ts — single-use enforcement for form tokens (replay
// protection). A jti may drive the /external-events webhook at most once: the
// first request atomically claims it; any later request with the same jti is a
// replay and is rejected.
//
// This is the code-level guard for forms.md blocker 3 — chosen over modeling
// token-consumption in the workflow (json-write a {jti,consumed} marker + a
// reject rule), which is far more fragile. The claim is a single SQL
// `INSERT OR IGNORE` on a jti PRIMARY KEY, so it is atomic and race-free even
// under concurrent submits. Persisted in events.db so it survives restarts.
import { Database } from '@src/shims/bun-sqlite.js';
import path from 'path';
import { logger } from '@src/utils/logger.js';

export class ConsumedJtiStore {
  private db: Database;

  constructor(dataDir: string) {
    this.db = new Database(path.join(dataDir, 'events.db'));
    this.init();
  }

  /** Allows tests to inject a pre-existing (e.g. in-memory) Database. */
  static fromDatabase(db: Database): ConsumedJtiStore {
    const store = Object.create(ConsumedJtiStore.prototype) as ConsumedJtiStore;
    store.db = db;
    store.init();
    return store;
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consumed_jtis (
        jti TEXT PRIMARY KEY,
        consumedAt INTEGER NOT NULL
      )
    `);
    logger.info('[ConsumedJtiStore] Table initialized');
  }

  /**
   * Atomically claim a jti for its single use. Returns true if this is the
   * FIRST time the jti is seen (claim succeeded — caller may proceed), false
   * if it was already consumed (a replay — caller must reject). The check and
   * write are one atomic statement, so concurrent submits can't both win.
   */
  claim(jti: string, now: number = Date.now()): boolean {
    const res = this.db
      .prepare(`INSERT OR IGNORE INTO consumed_jtis (jti, consumedAt) VALUES (?, ?)`)
      .run(jti, now);
    return Number(res.changes ?? 0) > 0;
  }

  /** Read-only check (does not claim). */
  isConsumed(jti: string): boolean {
    return !!this.db.prepare(`SELECT 1 AS x FROM consumed_jtis WHERE jti = ?`).get(jti);
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}
