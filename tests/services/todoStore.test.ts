import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/shims/bun-sqlite.js';
import { TodoStore, type TodoRecord } from '../../src/services/todoStore.js';

function makeTodo(overrides: Partial<TodoRecord> = {}): TodoRecord {
  return {
    id: `todo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    correlationId: 'sess-1',
    sliceName: 'approve-procurement',
    role: 'approver',
    status: 'pending',
    triggerEventType: 'procurement-requested',
    payload: { 'procurement-number': 'PR-001', 'total-amount': '10000' },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('TodoStore', () => {
  let db: Database;
  let store: TodoStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = TodoStore.fromDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('upsert', () => {
    it('inserts a new todo record', () => {
      const todo = makeTodo({ id: 'todo-1' });
      store.upsert(todo);
      const result = store.getById('todo-1');
      expect(result).not.toBeNull();
      expect(result!.sliceName).toBe('approve-procurement');
      expect(result!.role).toBe('approver');
      expect(result!.status).toBe('pending');
      expect(result!.payload).toEqual({ 'procurement-number': 'PR-001', 'total-amount': '10000' });
    });

    it('updates an existing todo on conflict', () => {
      const todo = makeTodo({ id: 'todo-1' });
      store.upsert(todo);
      store.upsert({ ...todo, status: 'claimed', claimedBy: 'agent-1', claimedAt: '2026-01-01T00:00:00Z' });
      const result = store.getById('todo-1');
      expect(result!.status).toBe('claimed');
      expect(result!.claimedBy).toBe('agent-1');
    });
  });

  describe('findPending', () => {
    it('returns all pending todos when no role filter', () => {
      store.upsert(makeTodo({ id: 'todo-1', role: 'approver' }));
      store.upsert(makeTodo({ id: 'todo-2', role: 'claims-processor' }));
      store.upsert(makeTodo({ id: 'todo-3', role: 'approver', status: 'completed', completedAt: '2026-01-01T00:00:00Z' }));
      const pending = store.findPending();
      expect(pending.length).toBe(2);
    });

    it('filters by role', () => {
      store.upsert(makeTodo({ id: 'todo-1', role: 'approver' }));
      store.upsert(makeTodo({ id: 'todo-2', role: 'claims-processor' }));
      const approver = store.findPending('approver');
      expect(approver.length).toBe(1);
      expect(approver[0].id).toBe('todo-1');
    });

    it('returns empty array when no pending todos', () => {
      expect(store.findPending()).toEqual([]);
    });
  });

  describe('claim', () => {
    it('transitions pending to claimed atomically', () => {
      store.upsert(makeTodo({ id: 'todo-1' }));
      const result = store.claim('todo-1', 'agent-1');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('claimed');
      expect(result!.claimedBy).toBe('agent-1');
      expect(result!.claimedAt).toBeDefined();
    });

    it('returns null if todo does not exist', () => {
      const result = store.claim('nonexistent', 'agent-1');
      expect(result).toBeNull();
    });

    it('returns null if todo is already claimed', () => {
      store.upsert(makeTodo({ id: 'todo-1' }));
      store.claim('todo-1', 'agent-1');
      const secondClaim = store.claim('todo-1', 'agent-2');
      expect(secondClaim).toBeNull();
    });

    it('returns null if todo is already completed', () => {
      store.upsert(makeTodo({ id: 'todo-1' }));
      store.claim('todo-1', 'agent-1');
      store.complete('todo-1');
      const result = store.claim('todo-1', 'agent-2');
      expect(result).toBeNull();
    });
  });

  describe('complete', () => {
    it('marks a claimed todo as completed', () => {
      store.upsert(makeTodo({ id: 'todo-1' }));
      store.claim('todo-1', 'agent-1');
      const result = store.complete('todo-1');
      expect(result!.status).toBe('completed');
      expect(result!.completedAt).toBeDefined();
    });

    it('can complete a pending todo directly', () => {
      store.upsert(makeTodo({ id: 'todo-1' }));
      const result = store.complete('todo-1');
      expect(result!.status).toBe('completed');
    });
  });

  describe('getByCorrelation', () => {
    it('returns all todos for a workflow session', () => {
      store.upsert(makeTodo({ id: 'todo-1', correlationId: 'sess-1' }));
      store.upsert(makeTodo({ id: 'todo-2', correlationId: 'sess-1' }));
      store.upsert(makeTodo({ id: 'todo-3', correlationId: 'sess-2' }));
      const result = store.getByCorrelation('sess-1');
      expect(result.length).toBe(2);
    });
  });

  describe('findBySliceAndCorrelation', () => {
    it('finds existing todo for a slice+session', () => {
      store.upsert(makeTodo({ id: 'todo-1', sliceName: 'approve', correlationId: 'sess-1' }));
      const result = store.findBySliceAndCorrelation('approve', 'sess-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('todo-1');
    });

    it('returns null if no match', () => {
      const result = store.findBySliceAndCorrelation('approve', 'sess-1');
      expect(result).toBeNull();
    });
  });
});
