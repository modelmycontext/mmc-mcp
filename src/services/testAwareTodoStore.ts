import type { TodoRecord, TodoStoreLike } from '@src/services/todoStore.js';

/**
 * Routes todo operations to an in-memory store for test sessions and the
 * SQLite store otherwise — mirrors the TestAwareEventStore idiom. Test
 * sessions get full TodoProcessor / completion-gate behaviour without
 * polluting the persistent `todos` table.
 *
 * Routing:
 *  - session-scoped (sid is an argument): route by the `isTestSession`
 *    predicate (backed by the WorkflowRun's isTest flag, #73).
 *  - record-scoped (`upsert`/`insertPendingIfAbsent`): route by
 *    `todo.correlationId`.
 *  - id-scoped (`getById`/`claim`/`complete`): the in-memory store only
 *    holds test todos, so probe it first; fall back to SQLite.
 *  - cross-cutting (`findByStatus`/`findPending`/`findPendingBySliceName`):
 *    union both backends (confirmed desired: a test-panel connection sees
 *    its in-memory todos via list-todos).
 */
export class TestAwareTodoStore implements TodoStoreLike {
  constructor(
    private readonly prod: TodoStoreLike,
    private readonly mem: TodoStoreLike,
    private readonly isTestSession: (sessionId: string) => boolean,
  ) {}

  private bySession(sid: string): TodoStoreLike {
    return this.isTestSession(sid) ? this.mem : this.prod;
  }

  upsert(todo: TodoRecord): void {
    this.bySession(todo.correlationId).upsert(todo);
  }

  insertPendingIfAbsent(todo: TodoRecord): boolean {
    return this.bySession(todo.correlationId).insertPendingIfAbsent(todo);
  }

  getByCorrelation(correlationId: string): TodoRecord[] {
    return this.bySession(correlationId).getByCorrelation(correlationId);
  }

  findBySliceAndCorrelation(sliceName: string, correlationId: string): TodoRecord | null {
    return this.bySession(correlationId).findBySliceAndCorrelation(sliceName, correlationId);
  }

  // id-scoped: in-memory holds only test todos — probe it first.
  getById(id: string): TodoRecord | null {
    return this.mem.getById(id) ?? this.prod.getById(id);
  }

  claim(id: string, claimedBy: string): TodoRecord | null {
    return this.mem.getById(id) ? this.mem.claim(id, claimedBy) : this.prod.claim(id, claimedBy);
  }

  complete(id: string): TodoRecord | null {
    return this.mem.getById(id) ? this.mem.complete(id) : this.prod.complete(id);
  }

  private static sort(rows: TodoRecord[], status: string): TodoRecord[] {
    const out = [...rows];
    if (status === 'completed') {
      out.sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt));
    } else {
      out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return out;
  }

  findByStatus(status: string, role?: string): TodoRecord[] {
    return TestAwareTodoStore.sort(
      [...this.prod.findByStatus(status, role), ...this.mem.findByStatus(status, role)],
      status,
    );
  }

  findPending(role?: string): TodoRecord[] {
    return this.findByStatus('pending', role);
  }

  findPendingBySliceName(sliceName: string): TodoRecord | null {
    const p = this.prod.findPendingBySliceName(sliceName);
    const m = this.mem.findPendingBySliceName(sliceName);
    if (!p) return m;
    if (!m) return p;
    return m.createdAt.localeCompare(p.createdAt) >= 0 ? m : p;
  }

  close(): void {
    this.prod.close();
    this.mem.close();
  }
}
