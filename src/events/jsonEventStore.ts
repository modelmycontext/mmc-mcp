import fs from 'fs/promises';
import path from 'path';
import type { Event } from './eventBus.js';
import { logger } from '@src/utils/logger.js';

export class JsonEventStore {
  private filePath: string;

  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'events.json');
  }

  async append(event: Event): Promise<void> {
    // Basic validation of the event object
    if (!event || typeof event !== 'object') {
      logger.error({ event: JSON.stringify(event) }, `[JsonEventStore] Invalid event object provided`);
      return;
    }

    // Queue the write operation to prevent race conditions during rapid appends
    const result = this.writeQueue.then(async () => {
      try {
        let events: any[] = [];
        try {
          const content = await fs.readFile(this.filePath, 'utf-8');
          if (content.trim()) {
            events = JSON.parse(content);
            if (!Array.isArray(events)) {
              logger.warn(`[JsonEventStore] events.json is not an array. Resetting.`);
              events = [];
            }
          }
        } catch (error: any) {
          if (error.code !== 'ENOENT') {
            logger.error({ error: error.message }, `[JsonEventStore] Error reading/parsing events file: ${error.message}. Resetting to empty array.`);
          }
        }

        const eventToStore = {
          ...event,
          timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp
        };

        // Final check that it can be serialized to JSON
        try {
          JSON.stringify(eventToStore);
        } catch (err: any) {
          logger.error({ error: err.message }, `[JsonEventStore] Event cannot be serialized to JSON: ${err.message}`);
          return;
        }

        events.push(eventToStore);

        const tempFilePath = `${this.filePath}.tmp`;
        const jsonContent = JSON.stringify(events, null, 2);

        // Double check the generated JSON is valid before writing
        try {
          JSON.parse(jsonContent);
        } catch (err: any) {
          logger.error({ error: err.message }, `[JsonEventStore] Failed to generate valid JSON for events file: ${err.message}`);
          return;
        }

        await fs.writeFile(tempFilePath, jsonContent);
        await fs.rename(tempFilePath, this.filePath);
      } catch (error: any) {
        logger.error({ error: error.message }, `[JsonEventStore] Error appending event: ${error.message}`);
      }
    });

    this.writeQueue = result;
    return result;
  }


  async getMaxSequence(): Promise<number> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      if (!content.trim()) return 0;
      const allEvents: any[] = JSON.parse(content);
      if (!Array.isArray(allEvents)) return 0;

      let max = 0;
      for (const e of allEvents) {
        if (typeof e.sequence === 'number' && e.sequence > max) {
          max = e.sequence;
        }
      }
      return max;
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        logger.error({ error: error.message }, `[JsonEventStore] Error reading events for max sequence: ${error.message}`);
      }
      return 0;
    }
  }

  async getPaged(limit: number = 20, skip: number = 0, sessionId?: string): Promise<{ events: Event[], total: number }> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      if (!content.trim()) return { events: [], total: 0 };
      let allEvents: any[] = JSON.parse(content);
      if (!Array.isArray(allEvents)) return { events: [], total: 0 };

      if (sessionId) {
        allEvents = allEvents.filter(e => e.sessionId === sessionId);
      }

      // Reverse to get latest first, but sort properly first
      const sorted = [...allEvents].sort((a, b) => {
        // First try to sort by sequence number if both have it
        if (a.sequence !== undefined && b.sequence !== undefined) {
          return a.sequence - b.sequence;
        }
        // Fallback to timestamp
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        if (timeA !== timeB) return timeA - timeB;
        // Last resort: original order (should be order in file)
        return 0;
      });

      const reversed = sorted.reverse();
      const paged = reversed.slice(skip, skip + limit);

      return {
        events: paged.map((e: any) => ({
          ...e,
          timestamp: new Date(e.timestamp)
        })),
        total: allEvents.length
      };
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        logger.error({ error: error.message }, `[JsonEventStore] Error reading events: ${error.message}`);
      }
      return { events: [], total: 0 };
    }
  }
}
