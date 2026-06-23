import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../src/events/eventBus.js';
import { makeEvent } from '../helpers/fixtures.js';

vi.mock('@src/utils/logger.js', async () =>
  (await import('../_helpers/loggerMock')).loggerMock(),
);

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe('constructor and setSequenceCounter', () => {
    it('starts sequence at 0 by default (first published event gets sequence 1)', async () => {
      const handler = vi.fn();
      bus.subscribe('TEST', handler);
      await bus.publish(makeEvent({ sequence: undefined }));
      expect(handler.mock.calls[0][0].sequence).toBe(1);
    });

    it('starts sequence at provided initialSequence value', async () => {
      const bus2 = new EventBus(10);
      const handler = vi.fn();
      bus2.subscribe('TEST', handler);
      await bus2.publish(makeEvent({ sequence: undefined }));
      expect(handler.mock.calls[0][0].sequence).toBe(11);
    });

    it('setSequenceCounter takes the max of current and provided value', async () => {
      bus.setSequenceCounter(5);
      bus.setSequenceCounter(3); // lower than current — should stay at 5
      const handler = vi.fn();
      bus.subscribe('TEST', handler);
      await bus.publish(makeEvent({ sequence: undefined }));
      expect(handler.mock.calls[0][0].sequence).toBe(6);
    });

    it('setSequenceCounter advances when value is higher', async () => {
      bus.setSequenceCounter(5);
      bus.setSequenceCounter(10); // higher — should advance to 10
      const handler = vi.fn();
      bus.subscribe('TEST', handler);
      await bus.publish(makeEvent({ sequence: undefined }));
      expect(handler.mock.calls[0][0].sequence).toBe(11);
    });
  });

  describe('subscribe and publish', () => {
    it('calls a subscribed handler when matching event type is published', async () => {
      const handler = vi.fn();
      bus.subscribe('FOO', handler);
      await bus.publish(makeEvent({ type: 'FOO' }));
      expect(handler).toHaveBeenCalledOnce();
    });

    it('calls wildcard (*) handler for any event type', async () => {
      const handler = vi.fn();
      bus.subscribe('*', handler);
      await bus.publish(makeEvent({ type: 'ANYTHING' }));
      expect(handler).toHaveBeenCalledOnce();
    });

    it('calls both specific and wildcard handlers for one event', async () => {
      const specific = vi.fn();
      const wildcard = vi.fn();
      bus.subscribe('FOO', specific);
      bus.subscribe('*', wildcard);
      await bus.publish(makeEvent({ type: 'FOO' }));
      expect(specific).toHaveBeenCalledOnce();
      expect(wildcard).toHaveBeenCalledOnce();
    });

    it('does not call handler for different event type', async () => {
      const handler = vi.fn();
      bus.subscribe('FOO', handler);
      await bus.publish(makeEvent({ type: 'BAR' }));
      expect(handler).not.toHaveBeenCalled();
    });

    it('allows multiple handlers for the same type', async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.subscribe('FOO', h1);
      bus.subscribe('FOO', h2);
      await bus.publish(makeEvent({ type: 'FOO' }));
      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
    });
  });

  describe('sequence assignment', () => {
    it('auto-increments sequence numbers starting at 1', async () => {
      const received: number[] = [];
      bus.subscribe('TEST', e => { received.push(e.sequence!); });
      await bus.publish(makeEvent({ sequence: undefined }));
      await bus.publish(makeEvent({ sequence: undefined }));
      expect(received).toEqual([1, 2]);
    });

    it('preserves an already-set sequence number', async () => {
      const handler = vi.fn();
      bus.subscribe('TEST', handler);
      await bus.publish(makeEvent({ sequence: 99 }));
      expect(handler.mock.calls[0][0].sequence).toBe(99);
    });
  });

  describe('ordering guarantee', () => {
    it('delivers events in publish order even when handlers are async', async () => {
      const order: string[] = [];
      bus.subscribe('A', async () => {
        await new Promise(r => setTimeout(r, 20));
        order.push('A');
      });
      bus.subscribe('B', async () => {
        order.push('B');
      });

      // Publish A first, then B — do NOT await between them
      const p1 = bus.publish(makeEvent({ type: 'A' }));
      const p2 = bus.publish(makeEvent({ type: 'B' }));
      await Promise.all([p1, p2]);

      expect(order).toEqual(['A', 'B']);
    });
  });

  describe('handler error isolation', () => {
    it('calls subsequent handlers even when one throws synchronously', async () => {
      const good = vi.fn();
      bus.subscribe('TEST', () => { throw new Error('boom'); });
      bus.subscribe('TEST', good);
      await bus.publish(makeEvent({ type: 'TEST' }));
      expect(good).toHaveBeenCalledOnce();
    });

    it('calls subsequent handlers even when one rejects asynchronously', async () => {
      const good = vi.fn();
      bus.subscribe('TEST', async () => { throw new Error('async boom'); });
      bus.subscribe('TEST', good);
      await bus.publish(makeEvent({ type: 'TEST' }));
      expect(good).toHaveBeenCalledOnce();
    });

    it('continues the publish queue after a handler error', async () => {
      bus.subscribe('TEST', () => { throw new Error('fail'); });
      const handler = vi.fn();
      bus.subscribe('OTHER', handler);
      // Publish TEST (will fail handler), then OTHER
      const p1 = bus.publish(makeEvent({ type: 'TEST' }));
      const p2 = bus.publish(makeEvent({ type: 'OTHER' }));
      await Promise.allSettled([p1, p2]);
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('setInitializationPromise', () => {
    it('delays publish until the initialization promise resolves', async () => {
      let resolveInit!: () => void;
      const initPromise = new Promise<void>(res => { resolveInit = res; });
      bus.setInitializationPromise(initPromise);

      const handler = vi.fn();
      bus.subscribe('TEST', handler);

      const publishPromise = bus.publish(makeEvent({ type: 'TEST' }));
      // Give microtasks a chance to run — handler should NOT yet be called
      await new Promise(r => setTimeout(r, 5));
      expect(handler).not.toHaveBeenCalled();

      // Now resolve init
      resolveInit();
      await publishPromise;
      expect(handler).toHaveBeenCalledOnce();
    });
  });
});
