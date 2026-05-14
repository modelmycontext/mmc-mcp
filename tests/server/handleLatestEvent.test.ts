import { describe, it, expect } from 'vitest';
import { dispatchLatestEvent, type HandleLatestEventDeps } from '../../src/server/handleLatestEvent.js';

function makeDeps(overrides: Partial<{
  triggerEventSet: Set<string>;
  workflowDefs: Map<string, any> | null;
  automatedSliceMap: Map<string, any>;
}> = {}): HandleLatestEventDeps & {
  triggerEventSet: Set<string>;
  workflowDefs: Map<string, any> | null;
  automatedSliceMap: Map<string, any>;
} {
  const state = {
    triggerEventSet: overrides.triggerEventSet ?? new Set<string>(),
    workflowDefs: overrides.workflowDefs ?? null,
    automatedSliceMap: overrides.automatedSliceMap ?? new Map<string, any>(),
  };
  return {
    ...state,
    getTriggerEventSet: () => state.triggerEventSet,
    getWorkflowDefs: () => state.workflowDefs,
    getAutomatedSliceMap: () => state.automatedSliceMap,
  };
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

describe('dispatchLatestEvent', () => {
  describe('terminal/system events', () => {
    it('returns the legacy skill body when no event is provided', () => {
      const deps = makeDeps();
      const result = dispatchLatestEvent({}, deps);
      expect(text(result)).toContain('Skill/Slice: handle-latest-event');
    });

    it('returns the workflow_completed message for the synthetic completion event', () => {
      const deps = makeDeps();
      const result = dispatchLatestEvent({ type: 'workflow_completed' }, deps);
      expect(text(result)).toContain('completed cleanly');
      expect(text(result)).toContain('do NOT call get-next-event');
    });

    it('returns the unexpected_last_event message with the original event type', () => {
      const deps = makeDeps();
      const result = dispatchLatestEvent(
        { type: 'unexpected_last_event', payload: { originalEvent: { type: 'stray-event' } } },
        deps,
      );
      expect(text(result)).toContain('stray-event');
      expect(text(result)).toContain('wiring gap');
    });
  });

  describe('interface routing path', () => {
    it('locates the slice whose givenEventGroups include the event type', () => {
      const wf = {
        name: 'order-flow',
        slices: [
          {
            name: 'place-order',
            isInterface: true,
            givenEventGroups: [['order-placed', 'order-resubmitted']],
          },
          {
            name: 'cancel-order',
            isInterface: true,
            givenEventGroups: [['order-cancelled']],
          },
        ],
      };
      const deps = makeDeps({
        triggerEventSet: new Set(['order-placed']),
        workflowDefs: new Map([['order-flow', wf]]),
      });

      const result = dispatchLatestEvent({ type: 'order-placed' }, deps);
      expect(text(result)).toContain('Interface event `order-placed`');
      expect(text(result)).toContain('"place-order"');
      expect(text(result)).toContain('"order-flow"');
    });

    it('skips automation slices (isInterface=false) when matching interface events', () => {
      const wf = {
        name: 'wf',
        slices: [
          { name: 'auto-slice', isInterface: false, givenEventGroups: [['trigger']] },
          { name: 'manual-slice', isInterface: true, givenEventGroups: [['trigger']] },
        ],
      };
      const deps = makeDeps({
        triggerEventSet: new Set(['trigger']),
        workflowDefs: new Map([['wf', wf]]),
      });

      const result = dispatchLatestEvent({ type: 'trigger' }, deps);
      expect(text(result)).toContain('"manual-slice"');
      expect(text(result)).not.toContain('"auto-slice"');
    });

    it('falls back to a defensive message when trigger is registered but no slice matches', () => {
      const deps = makeDeps({
        triggerEventSet: new Set(['orphan-event']),
        workflowDefs: new Map(),
      });

      const result = dispatchLatestEvent({ type: 'orphan-event' }, deps);
      expect(text(result)).toContain('registered but no matching slice was found');
    });

    it('tolerates a null workflowDefs map (server still initialising)', () => {
      const deps = makeDeps({
        triggerEventSet: new Set(['some-event']),
        workflowDefs: null,
      });

      const result = dispatchLatestEvent({ type: 'some-event' }, deps);
      expect(text(result)).toContain('registered but no matching slice was found');
    });
  });

  describe('automation routing path', () => {
    it('returns the automation acknowledgement for events in automatedSliceMap', () => {
      const deps = makeDeps({
        automatedSliceMap: new Map([['payment-processed', ['/skills/wf/auto-slice/auto-slice.md']]]),
      });

      const result = dispatchLatestEvent({ type: 'payment-processed' }, deps);
      expect(text(result)).toContain('Automation event `payment-processed`');
      expect(text(result)).toContain('server has already evaluated');
    });

    it('falls through to the "no registered handler" message when neither map matches', () => {
      const deps = makeDeps();
      const result = dispatchLatestEvent({ type: 'mystery-event' }, deps);
      expect(text(result)).toContain('Event `mystery-event` has no registered handler');
    });
  });

  describe('resync semantics — accessors observe live state', () => {
    // Each test simulates the real production sequence: registerHandlers is
    // called once (the deps object is built once), but the routing structures
    // mutate later — either because main() finishes initialising them after
    // the stdio registerHandlers call, or because /resync clears+repopulates
    // them. The handler MUST see the new state without re-registration.

    it('sees a trigger event added AFTER deps were created (late init)', () => {
      const triggerEventSet = new Set<string>();
      const workflowDefs = new Map<string, any>();
      const automatedSliceMap = new Map<string, any>();
      const deps: HandleLatestEventDeps = {
        getTriggerEventSet: () => triggerEventSet,
        getWorkflowDefs: () => workflowDefs,
        getAutomatedSliceMap: () => automatedSliceMap,
      };

      // Before init: event is unknown
      let result = dispatchLatestEvent({ type: 'late-event' }, deps);
      expect(text(result)).toContain('no registered handler');

      // Simulate main() finishing initialisation AFTER registerHandlers ran
      triggerEventSet.add('late-event');
      workflowDefs.set('wf', {
        name: 'wf',
        slices: [{ name: 'late-slice', isInterface: true, givenEventGroups: [['late-event']] }],
      });

      result = dispatchLatestEvent({ type: 'late-event' }, deps);
      expect(text(result)).toContain('Interface event `late-event`');
      expect(text(result)).toContain('"late-slice"');
    });

    it('sees automation map entries added AFTER deps were created', () => {
      const automatedSliceMap = new Map<string, any>();
      const deps: HandleLatestEventDeps = {
        getTriggerEventSet: () => new Set<string>(),
        getWorkflowDefs: () => null,
        getAutomatedSliceMap: () => automatedSliceMap,
      };

      let result = dispatchLatestEvent({ type: 'auto-event' }, deps);
      expect(text(result)).toContain('no registered handler');

      automatedSliceMap.set('auto-event', ['/skills/wf/auto/auto.md']);

      result = dispatchLatestEvent({ type: 'auto-event' }, deps);
      expect(text(result)).toContain('Automation event `auto-event`');
    });

    it('reflects an in-place resync that swaps an interface event for an automation event', () => {
      // Simulates /resync: clear + repopulate on the SAME Set/Map references.
      const triggerEventSet = new Set<string>(['shared-event']);
      const automatedSliceMap = new Map<string, any>();
      const workflowDefs = new Map<string, any>([
        ['wf-v1', { name: 'wf-v1', slices: [{ name: 'manual', isInterface: true, givenEventGroups: [['shared-event']] }] }],
      ]);
      const deps: HandleLatestEventDeps = {
        getTriggerEventSet: () => triggerEventSet,
        getWorkflowDefs: () => workflowDefs,
        getAutomatedSliceMap: () => automatedSliceMap,
      };

      // Pre-resync: interface path
      let result = dispatchLatestEvent({ type: 'shared-event' }, deps);
      expect(text(result)).toContain('Interface event');
      expect(text(result)).toContain('"manual"');

      // Resync flips it to automation (same Set/Map references, in-place mutation)
      triggerEventSet.clear();
      workflowDefs.clear();
      automatedSliceMap.set('shared-event', ['/skills/wf-v2/auto/auto.md']);

      result = dispatchLatestEvent({ type: 'shared-event' }, deps);
      expect(text(result)).toContain('Automation event `shared-event`');
    });

    it('reflects a workflowDefs reassignment from null to a populated Map', () => {
      // Mirrors `_workflowDefs` being declared as `let ... = null` and assigned later.
      let workflowDefs: Map<string, any> | null = null;
      const triggerEventSet = new Set<string>(['evt']);
      const deps: HandleLatestEventDeps = {
        getTriggerEventSet: () => triggerEventSet,
        getWorkflowDefs: () => workflowDefs,
        getAutomatedSliceMap: () => new Map(),
      };

      // Before _workflowDefs is assigned: defensive fallback
      let result = dispatchLatestEvent({ type: 'evt' }, deps);
      expect(text(result)).toContain('registered but no matching slice was found');

      // Late assignment
      workflowDefs = new Map([
        ['wf', { name: 'wf', slices: [{ name: 'sl', isInterface: true, givenEventGroups: [['evt']] }] }],
      ]);

      result = dispatchLatestEvent({ type: 'evt' }, deps);
      expect(text(result)).toContain('"sl"');
    });
  });
});
