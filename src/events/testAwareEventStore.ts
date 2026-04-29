import type { Event } from './eventBus.js';
import type { EventStore } from './eventStoreTypes.js';
import type { SqliteEventStore } from './sqliteEventStore.js';
import type { InMemoryEventStore } from './inMemoryEventStore.js';

/**
 * Composite event store that routes reads/writes to the correct backing store
 * based on whether the session is a test session.
 *
 * - Test sessions → InMemoryEventStore (no disk persistence)
 * - Production sessions → SqliteEventStore (persistent)
 */
export class TestAwareEventStore implements EventStore {
  constructor(
    private sqliteStore: SqliteEventStore,
    private memoryStore: InMemoryEventStore,
    private testSessions: Set<string>,
  ) {}

  private isTest(sessionId?: string): boolean {
    return !!sessionId && this.testSessions.has(sessionId);
  }

  async append(event: Event): Promise<void> {
    if (this.isTest(event.sessionId)) {
      await this.memoryStore.append(event);
    } else {
      await this.sqliteStore.append(event);
    }
  }

  getSessionEventTypes(sessionId: string): Set<string> {
    if (this.isTest(sessionId)) {
      return this.memoryStore.getSessionEventTypes(sessionId);
    }
    return this.sqliteStore.getSessionEventTypes(sessionId);
  }

  getSessionFactValues(sessionId: string): Record<string, string> {
    if (this.isTest(sessionId)) {
      return this.memoryStore.getSessionFactValues(sessionId);
    }
    return this.sqliteStore.getSessionFactValues(sessionId);
  }

  async getPaged(limit?: number, skip?: number, sessionId?: string): Promise<{ events: Event[], total: number }> {
    if (sessionId && this.isTest(sessionId)) {
      return this.memoryStore.getPaged(limit, skip, sessionId);
    }
    return this.sqliteStore.getPaged(limit, skip, sessionId);
  }
}
