import { Database, type Statement } from '@src/shims/bun-sqlite.js';
import path from 'path';
import type { Event } from './eventBus.js';
import { logger } from '@src/utils/logger.js';

/**
 * Fold one event payload's top-level fields into a session fact map, in place.
 *
 * Single source of the projection rule shared by the full-scan rebuild and the
 * incremental append-time fold, so both produce byte-identical maps: skip
 * null/undefined, preserve objects/arrays (so factField lookups can drill in),
 * and coerce primitives to string for deterministic comparison. Caller applies
 * payloads in ascending sequence order, so later values overwrite earlier ones.
 */
function applyPayloadToFactMap(target: Record<string, any>, payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  for (const [key, val] of Object.entries(payload)) {
    if (val === null || val === undefined) continue;
    target[key] = typeof val === 'object' ? val : String(val);
  }
}

export class SqliteEventStore {
  private db: Database;
  // Cached prepared statements — built on first call, reused to avoid re-parsing.
  private stmtInsert: Statement | null = null;
  private stmtNextUnfiltered: Statement | null = null;
  private stmtNextByCorrelation: Statement | null = null;

  // Per-correlation fact value cache, invalidated on append for the affected instance.
  private correlationFactCache = new Map<string, Record<string, any>>();

  constructor(dataDir: string) {
    const dbPath = path.join(dataDir, 'events.db');
    this.db = new Database(dbPath);
    this.init();
  }

  close(): void {
    this.stmtInsert = null;
    this.stmtNextUnfiltered = null;
    this.stmtNextByCorrelation = null;
    this.correlationFactCache.clear();
    try { this.db.close(); } catch { /* already closed */ }
  }

  private init() {
    // Hard cutover (workflow-instance-isolation RFC §5): the scope column moved
    // from `sessionId` → `correlationId`, no backfill. A pre-cutover events.db
    // still has the old column, so the correlationId index below would fail to
    // build. Detect the stale schema and drop the table — old rows are abandoned
    // by design (non-production). A fresh db has no `events` table and skips this.
    const eventCols = this.db.prepare(`SELECT name FROM pragma_table_info('events')`).all() as { name: string }[];
    if (eventCols.length > 0 && !eventCols.some(c => c.name === 'correlationId')) {
      this.db.exec(`DROP TABLE events`);
      logger.warn('[SqliteEventStore] Pre-cutover schema detected — dropped events table (correlationId hard cutover)');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        correlationId TEXT
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_correlationId ON events(correlationId)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_sequence ON events(sequence)`);
    logger.info(`[SqliteEventStore] Database initialized using bun:sqlite.`);
  }

  async append(event: Event): Promise<void> {
    try {
      const stmtInsert = this.stmtInsert ??= this.db.prepare(
        `INSERT INTO events (id, type, source, payload, timestamp, sequence, correlationId) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      // Keep the per-correlation fact cache warm by folding this event's payload
      // into it, instead of dropping it. Appends arrive in sequence order (the
      // EventBus assigns monotonically increasing sequence numbers and publishes
      // serially), so the new event is always the latest — applying it on top of
      // the cached map reproduces the same "later events override earlier" result
      // getCorrelationFactValues builds from a full scan. Only fold when a cache
      // already exists; a cold instance is left absent so the next read does the
      // authoritative full rebuild from disk.
      if (event.correlationId) {
        const cached = this.correlationFactCache.get(event.correlationId);
        if (cached) applyPayloadToFactMap(cached, event.payload);
      }

      stmtInsert.run(
        event.id,
        event.type,
        event.source,
        JSON.stringify(event.payload),
        event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp,
        event.sequence ?? 0,
        event.correlationId || null
      );
    } catch (error: any) {
      logger.error({ error: error.message }, `[SqliteEventStore] Error appending event: ${error.message}`);
    }
  }

  /**
   * Drop the cached fact-value map for one instance (WorkflowRun GC, #73). The
   * next read for this instance does an authoritative full rebuild from disk.
   * No-op if the instance was never cached.
   */
  dropCorrelationCache(correlationId: string): void {
    this.correlationFactCache.delete(correlationId);
  }

  async getMaxSequence(): Promise<number> {
    try {
      const row = this.db.prepare('SELECT MAX(sequence) as maxSeq FROM events').get() as { maxSeq: number | null };
      return row?.maxSeq || 0;
    } catch (error: any) {
      logger.error({ error: error.message }, `[SqliteEventStore] Error getting max sequence: ${error.message}`);
      return 0;
    }
  }

  async getNextAfterSequence(afterSequence: number, types: string[], correlationId?: string): Promise<Event | null> {
    if (types.length === 0) return null;
    try {
      const placeholders = types.map(() => '?').join(',');
      let row: any;
      if (correlationId) {
        const stmt = this.stmtNextByCorrelation ??= this.db.prepare(
          `SELECT * FROM events WHERE sequence > ? AND type IN (${placeholders}) AND correlationId = ? ORDER BY sequence ASC LIMIT 1`
        );
        row = stmt.get(afterSequence, ...types, correlationId) as any;
      } else {
        const stmt = this.stmtNextUnfiltered ??= this.db.prepare(
          `SELECT * FROM events WHERE sequence > ? AND type IN (${placeholders}) ORDER BY sequence ASC LIMIT 1`
        );
        row = stmt.get(afterSequence, ...types) as any;
      }
      if (!row) return null;
      return {
        id: row.id,
        type: row.type,
        source: row.source,
        payload: JSON.parse(row.payload),
        timestamp: new Date(row.timestamp),
        sequence: row.sequence,
        correlationId: row.correlationId
      };
    } catch (error: any) {
      logger.error({ error: error.message }, `[SqliteEventStore] Error in getNextAfterSequence: ${error.message}`);
      return null;
    }
  }

  getCorrelationEventTypes(correlationId: string): Set<string> {
    try {
      const rows = this.db.prepare(
        'SELECT DISTINCT type FROM events WHERE correlationId = ?'
      ).all(correlationId) as { type: string }[];
      return new Set(rows.map(r => r.type));
    } catch (error: any) {
      logger.error({ error: error.message }, `[SqliteEventStore] Error getting correlation event types: ${error.message}`);
      return new Set();
    }
  }

  /**
   * Returns a flat map of all fact-like values that have appeared in event payloads
   * for the given instance, ordered by sequence (earlier events first, later override).
   * Only top-level scalar payload fields are included.
   */
  getCorrelationFactValues(correlationId: string): Record<string, any> {
    const cached = this.correlationFactCache.get(correlationId);
    if (cached) return { ...cached };

    try {
      const rows = this.db.prepare(
        'SELECT payload FROM events WHERE correlationId = ? ORDER BY sequence ASC'
      ).all(correlationId) as { payload: string }[];

      const result: Record<string, any> = {};
      for (const row of rows) {
        try {
          applyPayloadToFactMap(result, JSON.parse(row.payload));
        } catch {
          // Skip malformed payloads
        }
      }

      this.correlationFactCache.set(correlationId, result);
      return { ...result };
    } catch (error: any) {
      logger.error({ error: error.message }, '[SqliteEventStore] Error getting correlation fact values');
      return {};
    }
  }

  async getPaged(limit: number = 20, skip: number = 0, correlationId?: string): Promise<{ events: Event[], total: number }> {
    try {
      let query = 'SELECT * FROM events';
      let countQuery = 'SELECT COUNT(*) as total FROM events';
      const params: any[] = [];

      if (correlationId) {
        query += ' WHERE correlationId = ?';
        countQuery += ' WHERE correlationId = ?';
        params.push(correlationId);
      }

      query += ' ORDER BY sequence DESC LIMIT ? OFFSET ?';

      const totalRow = this.db.prepare(countQuery).get(...params) as { total: number };

      const finalParams = [...params, limit, skip];
      const rows = this.db.prepare(query).all(...finalParams) as any[];

      return {
        events: rows.map(row => ({
          id: row.id,
          type: row.type,
          source: row.source,
          payload: JSON.parse(row.payload),
          timestamp: new Date(row.timestamp),
          sequence: row.sequence,
          correlationId: row.correlationId
        })),
        total: totalRow.total
      };
    } catch (error: any) {
      logger.error({ error: error.message }, `[SqliteEventStore] Error reading events: ${error.message}`);
      return { events: [], total: 0 };
    }
  }
}
