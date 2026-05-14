import { Database } from 'bun:sqlite';
import path from 'path';
import { logger } from '@src/utils/logger.js';

export interface TodoRecord {
  id: string;
  workflowSessionId: string;
  sliceName: string;
  role: string;
  status: 'pending' | 'claimed' | 'completed';
  triggerEventType: string;
  /** Accumulated fact values at the time the todo was created */
  payload: Record<string, any>;
  createdAt: string;
  claimedBy?: string;
  claimedAt?: string;
  completedAt?: string;
  /**
   * Slice pattern at the time the todo was created. `view` todos are
   * read-only displays of upstream event payloads; `interface` todos require
   * user input + `complete-slice`. Consumers (mmc-workflow, workbench test
   * panel) use this to pick the right render path — they MUST NOT infer
   * pattern from the slice name (the legacy `-view` suffix is gone under
   * the workbench's `activity-{id}-{slice}` naming convention).
   */
  pattern?: 'interface' | 'view';
}

export class TodoStore {
  private db: Database;

  constructor(dataDir: string) {
    const dbPath = path.join(dataDir, 'events.db');
    this.db = new Database(dbPath);
    this.init();
  }

  /** Allows tests to inject a pre-existing Database instance. */
  static fromDatabase(db: Database): TodoStore {
    const store = Object.create(TodoStore.prototype) as TodoStore;
    store.db = db;
    store.init();
    return store;
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        workflowSessionId TEXT NOT NULL,
        sliceName TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        triggerEventType TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        claimedBy TEXT,
        claimedAt TEXT,
        completedAt TEXT
      )
    `);
    // Additive migration: existing dbs lack the `pattern` column. Defaulting
    // to 'interface' keeps legacy rows behaving as before; new rows set it
    // explicitly from the slice's `getSlicePattern` classification.
    const hasPatternCol = this.db
      .prepare(`SELECT 1 AS x FROM pragma_table_info('todos') WHERE name = 'pattern'`)
      .get();
    if (!hasPatternCol) {
      this.db.exec(`ALTER TABLE todos ADD COLUMN pattern TEXT NOT NULL DEFAULT 'interface'`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_role_status ON todos(role, status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(workflowSessionId)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_slice_session ON todos(sliceName, workflowSessionId)`);
    logger.info('[TodoStore] Table initialized');
  }

  upsert(todo: TodoRecord): void {
    this.db.prepare(`
      INSERT INTO todos (id, workflowSessionId, sliceName, role, status, triggerEventType, payload, createdAt, claimedBy, claimedAt, completedAt, pattern)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        payload = excluded.payload,
        claimedBy = excluded.claimedBy,
        claimedAt = excluded.claimedAt,
        completedAt = excluded.completedAt
    `).run(
      todo.id,
      todo.workflowSessionId,
      todo.sliceName,
      todo.role,
      todo.status,
      todo.triggerEventType,
      JSON.stringify(todo.payload),
      todo.createdAt,
      todo.claimedBy ?? null,
      todo.claimedAt ?? null,
      todo.completedAt ?? null,
      todo.pattern ?? 'interface',
    );
  }

  /**
   * Atomically inserts a pending todo only if no pending or claimed todo
   * already exists for the same (sliceName, workflowSessionId). The check
   * and insert happen in a single SQL statement so concurrent event-bus
   * subscribers can't race past a non-atomic `findBySliceAndSession` +
   * `upsert` pair and create duplicate pending todos for the same slice.
   * Returns true if the todo was inserted, false if a live duplicate existed.
   */
  insertPendingIfAbsent(todo: TodoRecord): boolean {
    const result = this.db.prepare(`
      INSERT INTO todos (id, workflowSessionId, sliceName, role, status, triggerEventType, payload, createdAt, claimedBy, claimedAt, completedAt, pattern)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM todos
        WHERE sliceName = ? AND workflowSessionId = ? AND status IN ('pending', 'claimed')
      )
    `).run(
      todo.id,
      todo.workflowSessionId,
      todo.sliceName,
      todo.role,
      todo.status,
      todo.triggerEventType,
      JSON.stringify(todo.payload),
      todo.createdAt,
      todo.claimedBy ?? null,
      todo.claimedAt ?? null,
      todo.completedAt ?? null,
      todo.pattern ?? 'interface',
      todo.sliceName,
      todo.workflowSessionId,
    );
    return (result as any).changes > 0;
  }

  findPending(role?: string): TodoRecord[] {
    return this.findByStatus('pending', role);
  }

  findByStatus(status: string, role?: string): TodoRecord[] {
    // Completed todos read newest-first (by completion or creation time); others oldest-first.
    const order = status === 'completed'
      ? `ORDER BY COALESCE(completedAt, createdAt) DESC`
      : `ORDER BY createdAt ASC`;
    let rows: any[];
    if (role !== undefined) {
      rows = this.db.prepare(
        `SELECT * FROM todos WHERE status = ? AND role = ? ${order}`
      ).all(status, role);
    } else {
      rows = this.db.prepare(
        `SELECT * FROM todos WHERE status = ? ${order}`
      ).all(status);
    }
    return rows.map(this.rowToRecord);
  }

  /**
   * Atomically transitions a todo from pending to claimed.
   * Returns the updated record, or null if the todo doesn't exist or isn't pending.
   */
  claim(id: string, claimedBy: string): TodoRecord | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE todos SET status = 'claimed', claimedBy = ?, claimedAt = ?
      WHERE id = ? AND status = 'pending'
    `).run(claimedBy, now, id);

    if ((result as any).changes === 0) return null;
    return this.getById(id);
  }

  /**
   * Marks a todo as completed.
   * Returns the updated record, or null if not found.
   */
  complete(id: string): TodoRecord | null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE todos SET status = 'completed', completedAt = ?
      WHERE id = ?
    `).run(now, id);
    return this.getById(id);
  }

  getById(id: string): TodoRecord | null {
    const row = this.db.prepare(`SELECT * FROM todos WHERE id = ?`).get(id) as any;
    return row ? this.rowToRecord(row) : null;
  }

  getBySession(workflowSessionId: string): TodoRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM todos WHERE workflowSessionId = ? ORDER BY createdAt ASC`
    ).all(workflowSessionId);
    return rows.map(this.rowToRecord);
  }

  /**
   * Find the most recent pending todo for a given slice name.
   * Used to auto-bind a connection to the correct workflow session
   * when a client dispatches a slice without claiming the todo first.
   */
  findPendingBySliceName(sliceName: string): TodoRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM todos WHERE sliceName = ? AND status = 'pending' ORDER BY createdAt DESC LIMIT 1`
    ).get(sliceName) as any;
    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Find an existing todo for a specific slice + session (any status).
   * Used to prevent duplicate todo creation.
   */
  findBySliceAndSession(sliceName: string, workflowSessionId: string): TodoRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM todos WHERE sliceName = ? AND workflowSessionId = ? LIMIT 1`
    ).get(sliceName, workflowSessionId) as any;
    return row ? this.rowToRecord(row) : null;
  }

  private rowToRecord(row: any): TodoRecord {
    return {
      id: row.id,
      workflowSessionId: row.workflowSessionId,
      sliceName: row.sliceName,
      role: row.role,
      status: row.status,
      triggerEventType: row.triggerEventType,
      payload: JSON.parse(row.payload),
      createdAt: row.createdAt,
      claimedBy: row.claimedBy ?? undefined,
      claimedAt: row.claimedAt ?? undefined,
      completedAt: row.completedAt ?? undefined,
      pattern: (row.pattern === 'view' || row.pattern === 'interface') ? row.pattern : 'interface',
    };
  }
}
