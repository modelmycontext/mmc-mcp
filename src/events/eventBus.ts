import { logger } from '@src/utils/logger.js';

export interface Event {
  id: string;
  type: string;
  source: string;
  payload: any;
  timestamp: Date;
  sequence?: number;
  /**
   * Business workflow-instance identity (#workflow-instance-isolation RFC).
   * Scopes the event log, fact pool, dispatch eligibility, delivery and
   * quiescence to ONE running instance. Minted fresh at instance birth,
   * propagated causally down the outcome chain, and carried through form
   * tokens for external (webhook) rejoin. NEVER derived from the transport
   * session/connection id (`cid`) — `cid` lives in the connection pool, not on
   * the event. (Formerly the overloaded `sessionId` / `workflowSessionId`.)
   */
  correlationId?: string;
}

export type EventHandler = (event: Event) => void | Promise<void>;

export class EventBus {
  private handlers: Map<string, EventHandler[]> = new Map();
  private sequenceCounter: number = 0;
  private initializationPromise: Promise<void> | null = null;
  private publishQueue: Promise<void> = Promise.resolve();

  constructor(initialSequence?: number) {
    if (initialSequence !== undefined) {
      this.sequenceCounter = initialSequence;
    }
  }

  setSequenceCounter(value: number) {
    this.sequenceCounter = Math.max(this.sequenceCounter, value);
  }

  setInitializationPromise(promise: Promise<void>) {
    this.initializationPromise = promise;
  }

  subscribe(type: string, handler: EventHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler);
  }

  async publish(event: Event) {
    // Chain the publish operation onto the queue to ensure strict ordering
    // and atomic sequence assignment.
    const result = this.publishQueue.then(async () => {
      if (this.initializationPromise) {
        await this.initializationPromise;
      }

      // Add sequence number if it's missing
      if (event.sequence === undefined) {
        event.sequence = ++this.sequenceCounter;
      }
      logger.debug({ type: event.type, source: event.source, sequence: event.sequence }, `[EventBus] Publishing event: ${event.type} from ${event.source} (seq: ${event.sequence})`);
      const handlers = this.handlers.get(event.type) || [];
      const allHandlers = [...handlers, ...(this.handlers.get('*') || [])];

      // Execute all handlers for this event.
      // We await them all to ensure the next event doesn't start until this one is fully processed.
      await Promise.all(allHandlers.map(async (handler) => {
        try {
          await handler(event);
        } catch (err: any) {
          logger.error({ type: event.type, error: err.message }, `[EventBus] Error in handler for ${event.type}: ${err.message}`);
        }
      }));
    });

    this.publishQueue = result.catch(() => {}); // Continue queue even if one publish fails
    return result;
  }
}
