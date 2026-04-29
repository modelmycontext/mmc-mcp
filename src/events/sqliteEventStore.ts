import { Database, type Statement } from 'bun:sqlite';
import path from 'path';
import type { Event } from './eventBus.js';
import { logger } from '@src/utils/logger.js';

export class SqliteEventStore {
  private db: Database;
  // Cached prepared statements — built on first call, reused to avoid re-parsing.
  private stmtInsert: Statement | null = null;
  private stmtNextUnfiltered: Statement | null = null;
  private stmtNextBySession: Statement | null = null;

  // Per-session fact value cache, invalidated on append for the affected session.
  private sessionFactCache = new Map<string, Record<string, any>>();

  constructor(dataDir: string) {
    const dbPath = path.join(dataDir, 'events.db');
    this.db = new Database(dbPath);
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        sessionId TEXT
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_sessionId ON events(sessionId)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_sequence ON events(sequence)`);
    logger.info(`[SqliteEventStore] Database initialized using bun:sqlite.`);
  }

  async append(event: Event): Promise<void> {
    try {
      if (!this.stmtInsert) {
        this.stmtInsert = this.db.prepare(
          `INSERT INTO events (id, type, source, payload, timestamp, sequence, sessionId) VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
      }

      // Invalidate fact cache for this session so next read picks up the new event.
      if (event.sessionId) {
        this.sessionFactCache.delete(event.sessionId);
      }

      this.stmtInsert.run(
        event.id,
        event.type,
        event.source,
        JSON.stringify(event.payload),
        event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp,
        event.sequence ?? 0,
        event.sessionId || null
      );
    } catch (error: any) {
      logger.error({ error: error.message }, `[SqliteEventStore] Error appending event: ${error.message}`);
    }
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

  async getNextAfterSequence(afterSequence: number, types: string[], sessionId?: string): Promise<Event | null> {
    if (types.length === 0) return null;
    try {
      const placeholders = types.map(() => '?').join(',');
      let row: any;
      if (sessionId) {
        if (!this.stmtNextBySession) {
          this.stmtNextBySession = this.db.prepare(
            `SELECT * FROM events WHERE sequence > ? AND type IN (${placeholders}) AND sessionId = ? ORDER BY sequence ASC LIMIT 1`
          );
        }
        row = this.stmtNextBySession.get(afterSequence, ...types, sessionId) as any;
      } else {
        if (!this.stmtNextUnfiltered) {
          this.stmtNextUnfiltered = this.db.prepare(
            `SELECT * FROM events WHERE sequence > ? AND type IN (${placeholders}) ORDER BY sequence ASC LIMIT 1`
          );
        }
        row = this.stmtNextUnfiltered.get(afterSequence, ...types) as any;
      }
      if (!row) return null;
      return {
        id: row.id,
        type: row.type,
        source: row.source,
        payload: JSON.parse(row.payload),
        timestamp: new Date(row.timestamp),
        sequence: row.sequence,
        sessionId: row.sessionId
      };
    } catch (error: any) {
      logger.error({ error: error.message }, `[SqliteEventStore] Error in getNextAfterSequence: ${error.message}`);
      return null;
    }
  }

  getSessionEventTypes(sessionId: string): Set<string> {
    try {
      const rows = this.db.prepare(
        'SELECT DISTINCT type FROM events WHERE sessionId = ?'
      ).all(sessionId) as { type: string }[];
      return new Set(rows.map(r => r.type));
    } catch (error: any) {
      logger.error({ error: error.message }, `[SqliteEventStore] Error getting session event types: ${error.message}`);
      return new Set();
    }
  }

  /**
   * Returns a flat map of all fact-like values that have appeared in event payloads
   * for the given session, ordered by sequence (earlier events first, later override).
   * Only top-level scalar payload fields are included.
   */
  getSessionFactValues(sessionId: string): Record<string, any> {
    const cached = this.sessionFactCache.get(sessionId);
    if (cached) return { ...cached };

    try {
      const rows = this.db.prepare(
        'SELECT payload FROM events WHERE sessionId = ? ORDER BY sequence ASC'
      ).all(sessionId) as { payload: string }[];

      const result: Record<string, any> = {};
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload);
          if (payload && typeof payload === 'object') {
            for (const [key, val] of Object.entries(payload)) {
              if (val === null || val === undefined) continue;
              // Preserve objects/arrays so factField lookups can drill in;
              // coerce primitives to string for backwards-compatible deterministic comparison.
              result[key] = typeof val === 'object' ? val : String(val);
            }
          }
        } catch {
          // Skip malformed payloads
        }
      }

      this.sessionFactCache.set(sessionId, result);
      return { ...result };
    } catch (error: any) {
      logger.error({ error: error.message }, '[SqliteEventStore] Error getting session fact values');
      return {};
    }
  }

  async getPaged(limit: number = 20, skip: number = 0, sessionId?: string): Promise<{ events: Event[], total: number }> {
    try {
      let query = 'SELECT * FROM events';
      let countQuery = 'SELECT COUNT(*) as total FROM events';
      const params: any[] = [];

      if (sessionId) {
        query += ' WHERE sessionId = ?';
        countQuery += ' WHERE sessionId = ?';
        params.push(sessionId);
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
          sessionId: row.sessionId
        })),
        total: totalRow.total
      };
    } catch (error: any) {
      logger.error({ error: error.message }, `[SqliteEventStore] Error reading events: ${error.message}`);
      return { events: [], total: 0 };
    }
  }
}
