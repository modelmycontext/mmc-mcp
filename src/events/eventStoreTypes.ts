import type { Event } from './eventBus.js';

/**
 * Common interface for event stores.
 * Implemented by SqliteEventStore (production) and InMemoryEventStore (test).
 */
export interface EventStoreReader {
  getSessionEventTypes(sessionId: string): Set<string>;
  getSessionFactValues(sessionId: string): Record<string, any>;
  getPaged(limit?: number, skip?: number, sessionId?: string): Promise<{ events: Event[], total: number }>;
}

export interface EventStore extends EventStoreReader {
  append(event: Event): Promise<void>;
}
