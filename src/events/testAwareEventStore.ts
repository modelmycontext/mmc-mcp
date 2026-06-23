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
    private isTestCorrelation: (correlationId?: string) => boolean,
  ) {}

  private isTest(correlationId?: string): boolean {
    return !!correlationId && this.isTestCorrelation(correlationId);
  }

  async append(event: Event): Promise<void> {
    if (this.isTest(event.correlationId)) {
      await this.memoryStore.append(event);
    } else {
      await this.sqliteStore.append(event);
    }
  }

  getCorrelationEventTypes(correlationId: string): Set<string> {
    if (this.isTest(correlationId)) {
      return this.memoryStore.getCorrelationEventTypes(correlationId);
    }
    return this.sqliteStore.getCorrelationEventTypes(correlationId);
  }

  getCorrelationFactValues(correlationId: string): Record<string, string> {
    if (this.isTest(correlationId)) {
      return this.memoryStore.getCorrelationFactValues(correlationId);
    }
    return this.sqliteStore.getCorrelationFactValues(correlationId);
  }

  /**
   * Reclaim per-instance state in both backing stores on WorkflowRun GC (#73).
   * Drops the in-memory test event log and the SQLite fact-value cache. Both
   * deletes are idempotent, so it's safe to call without knowing which store
   * the run actually used.
   */
  dropCorrelation(correlationId: string): void {
    this.memoryStore.clearCorrelation(correlationId);
    this.sqliteStore.dropCorrelationCache(correlationId);
  }

  async getPaged(limit?: number, skip?: number, correlationId?: string): Promise<{ events: Event[], total: number }> {
    if (correlationId && this.isTest(correlationId)) {
      return this.memoryStore.getPaged(limit, skip, correlationId);
    }
    return this.sqliteStore.getPaged(limit, skip, correlationId);
  }
}
