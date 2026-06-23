import type { TodoRecord, TodoStoreLike } from '@src/services/todoStore.js';

/**
 * In-memory {@link TodoStoreLike} for test sessions. Behaviourally identical
 * to the SQLite {@link TodoStore} — same dedup, ordering, claim/complete
 * transitions — so a test session exercises production completion/branch
 * semantics without touching the persistent `todos` table. Records are
 * cloned on the way in and out (the SQLite store returns fresh rows per
 * query; callers mutate returned records, so aliasing would corrupt state).
 */
export class InMemoryTodoStore implements TodoStoreLike {
  private rows = new Map<string, TodoRecord>();

  private clone(t: TodoRecord): TodoRecord {
    return { ...t, payload: t.payload ? JSON.parse(JSON.stringify(t.payload)) : t.payload };
  }

  upsert(todo: TodoRecord): void {
    const existing = this.rows.get(todo.id);
    if (!existing) {
      this.rows.set(todo.id, this.clone(todo));
      return;
    }
    // SQLite ON CONFLICT(id) updates only these fields.
    existing.status = todo.status;
    existing.payload = todo.payload ? JSON.parse(JSON.stringify(todo.payload)) : todo.payload;
    existing.claimedBy = todo.claimedBy;
    existing.claimedAt = todo.claimedAt;
    existing.completedAt = todo.completedAt;
  }

  insertPendingIfAbsent(todo: TodoRecord): boolean {
    for (const r of this.rows.values()) {
      if (
        r.sliceName === todo.sliceName &&
        r.correlationId === todo.correlationId &&
        (r.status === 'pending' || r.status === 'claimed')
      ) {
        return false;
      }
    }
    this.rows.set(todo.id, this.clone({ ...todo, pattern: todo.pattern ?? 'interface' }));
    return true;
  }

  findByStatus(status: string, role?: string): TodoRecord[] {
    const out = [...this.rows.values()].filter(
      (r) => r.status === status && (role === undefined || r.role === role),
    );
    if (status === 'completed') {
      out.sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt));
    } else {
      out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return out.map((r) => this.clone(r));
  }

  findPending(role?: string): TodoRecord[] {
    return this.findByStatus('pending', role);
  }

  claim(id: string, claimedBy: string): TodoRecord | null {
    const r = this.rows.get(id);
    if (!r || r.status !== 'pending') return null;
    r.status = 'claimed';
    r.claimedBy = claimedBy;
    r.claimedAt = new Date().toISOString();
    return this.clone(r);
  }

  complete(id: string): TodoRecord | null {
    const r = this.rows.get(id);
    if (!r) return null;
    r.status = 'completed';
    r.completedAt = new Date().toISOString();
    return this.clone(r);
  }

  getById(id: string): TodoRecord | null {
    const r = this.rows.get(id);
    return r ? this.clone(r) : null;
  }

  getByCorrelation(correlationId: string): TodoRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.correlationId === correlationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => this.clone(r));
  }

  findPendingBySliceName(sliceName: string): TodoRecord | null {
    const matches = [...this.rows.values()]
      .filter((r) => r.sliceName === sliceName && r.status === 'pending')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matches.length ? this.clone(matches[0]) : null;
  }

  findBySliceAndCorrelation(sliceName: string, correlationId: string): TodoRecord | null {
    for (const r of this.rows.values()) {
      if (r.sliceName === sliceName && r.correlationId === correlationId) {
        return this.clone(r);
      }
    }
    return null;
  }

  close(): void {
    this.rows.clear();
  }
}
