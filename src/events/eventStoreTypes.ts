import type { Event } from './eventBus.js';

/**
 * Common interface for event stores.
 * Implemented by SqliteEventStore (production) and InMemoryEventStore (test).
 */
export interface EventStoreReader {
  getCorrelationEventTypes(correlationId: string): Set<string>;
  getCorrelationFactValues(correlationId: string): Record<string, any>;
  getPaged(limit?: number, skip?: number, correlationId?: string): Promise<{ events: Event[], total: number }>;
}

export interface EventStore extends EventStoreReader {
  append(event: Event): Promise<void>;
}
