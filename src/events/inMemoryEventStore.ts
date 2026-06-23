import type { Event } from './eventBus.js';
import { logger } from '@src/utils/logger.js';

/**
 * In-memory event store for test sessions.
 * Same interface as SqliteEventStore but backed by a Map — no disk writes.
 * Events are scoped per correlationId (workflow instance) and discarded when
 * the instance is reclaimed.
 */
export class InMemoryEventStore {
  private instances = new Map<string, Event[]>();

  async append(event: Event): Promise<void> {
    const cid = event.correlationId ?? '__default__';
    if (!this.instances.has(cid)) this.instances.set(cid, []);
    this.instances.get(cid)!.push(event);
  }

  getCorrelationEventTypes(correlationId: string): Set<string> {
    const events = this.instances.get(correlationId) ?? [];
    return new Set(events.map(e => e.type));
  }

  getCorrelationFactValues(correlationId: string): Record<string, any> {
    const events = this.instances.get(correlationId) ?? [];
    const result: Record<string, any> = {};
    // Assign a value to the fact map. Empty strings and empty arrays must NOT
    // overwrite an already-populated value: outcome events routinely fire with
    // unresolved facts (buildEventPayload defaults missing facts to "") and those
    // empty payloads would otherwise wipe real data gathered from TOOL_CALLED events.
    const assign = (key: string, val: any) => {
      if (val === null || val === undefined) return;
      const isEmpty = val === '' || (Array.isArray(val) && val.length === 0);
      if (isEmpty && result[key] !== undefined && result[key] !== '' && !(Array.isArray(result[key]) && result[key].length === 0)) {
        return;
      }
      result[key] = typeof val === 'object' ? val : String(val);
    };

    for (const event of events) {
      const payload = event.payload;
      if (!payload || typeof payload !== 'object') continue;
      // TOOL_CALLED payloads wrap the tool output in an envelope {tool, params, input, result}.
      // Skip the envelope keys but propagate the fields of `result` — that's where the
      // connector's actual output data lives, and downstream slices depend on it.
      if (event.type === 'TOOL_CALLED') {
        const toolResult = (payload as any).result;
        if (toolResult && typeof toolResult === 'object') {
          for (const [key, val] of Object.entries(toolResult)) assign(key, val);
        }
        continue;
      }
      for (const [key, val] of Object.entries(payload)) assign(key, val);
    }
    return result;
  }

  async getPaged(limit: number = 20, skip: number = 0, correlationId?: string): Promise<{ events: Event[], total: number }> {
    let allEvents: Event[];
    if (correlationId) {
      allEvents = this.instances.get(correlationId) ?? [];
    } else {
      allEvents = [];
      for (const events of this.instances.values()) allEvents.push(...events);
    }
    // Sort descending by sequence (matching SqliteEventStore behaviour)
    const sorted = [...allEvents].sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0));
    return {
      events: sorted.slice(skip, skip + limit),
      total: sorted.length,
    };
  }

  /** Drop all events for an instance (called on disconnect). */
  clearCorrelation(correlationId: string): void {
    this.instances.delete(correlationId);
    logger.info({ correlationId }, '[InMemoryEventStore] Cleared instance');
  }
}
