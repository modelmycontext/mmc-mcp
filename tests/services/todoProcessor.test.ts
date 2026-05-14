import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TodoProcessor } from '../../src/services/todoProcessor.js';
import type { WorkflowDefinition } from '../../src/skill-engine/interaction-slice-trigger-events.js';

vi.mock('@src/utils/logger.js', async () =>
  (await import('../_helpers/loggerMock')).loggerMock(),
);

function makeSlice(overrides: Partial<WorkflowDefinition['slices'][number]>): WorkflowDefinition['slices'][number] {
  // Default the authoritative `pattern` field from `isInterface` + outcomes:
  // an interface-pattern slice carries an interface block + a command (it
  // emits outcomes); a view-pattern slice has no outcomes; everything else
  // is automation. Tests can override `pattern` explicitly when needed.
  const isInterface = overrides.isInterface ?? false;
  const outcomes = overrides.outcomeEventTypes ?? [];
  const inferredPattern: WorkflowDefinition['slices'][number]['pattern'] =
    isInterface
      ? (outcomes.length === 0 ? 'view' : 'interface')
      : 'automation';
  return {
    name: '',
    role: '',
    pattern: inferredPattern,
    isInterface,
    givenEventGroups: [],
    outcomeEventTypes: [],
    scenarios: [],
    factNames: [],
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'manage-procurement',
    slices: [
      makeSlice({
        name: 'request-procurement',
        role: 'procurer',
        isInterface: true,
        givenEventGroups: [],
        outcomeEventTypes: ['procurement-requested'],
      }),
      makeSlice({
        name: 'approve-procurement',
        role: 'system',
        isInterface: false,
        givenEventGroups: [['procurement-requested']],
        outcomeEventTypes: ['procurement-approved'],
      }),
      makeSlice({
        name: 'activate-procurement',
        role: 'system',
        isInterface: false,
        givenEventGroups: [['procurement-approved']],
        outcomeEventTypes: ['procurement-activated'],
      }),
    ],
    automatedTriggerMap: new Map([
      ['procurement-requested', 'approve-procurement'],
      ['procurement-approved', 'activate-procurement'],
    ]),
    factIdToName: new Map(),
    ...overrides,
  };
}

function makePhysioWorkflow(): WorkflowDefinition {
  return {
    name: 'manual-physiotherapy-eligibility-verification',
    slices: [
      makeSlice({
        name: 'receive-member-claim',
        role: 'claims-processor',
        isInterface: true,
        givenEventGroups: [],
        outcomeEventTypes: ['member-physio-claim-received'],
      }),
      makeSlice({
        name: 'review-policy-constraints',
        role: 'policy-analyst',
        isInterface: false,
        givenEventGroups: [['member-physio-claim-received']],
        outcomeEventTypes: ['member-policy-reviewed', 'exception-required-for-policy', 'member-account-suspended'],
      }),
      makeSlice({
        name: 'query-exception-circumstances',
        role: 'claims-processor',
        isInterface: true,
        givenEventGroups: [['exception-required-for-policy']],
        outcomeEventTypes: ['exception-circumstances-queried'],
      }),
      makeSlice({
        name: 'make-eligibility-decision',
        role: 'eligibility-specialist',
        isInterface: false,
        givenEventGroups: [['member-account-suspended'], ['member-policy-reviewed', 'exception-circumstances-queried']],
        outcomeEventTypes: ['eligibility-decision-made'],
      }),
      makeSlice({
        name: 'eligibility-decision-view',
        role: '',
        isInterface: true,
        givenEventGroups: [['eligibility-decision-made']],
        outcomeEventTypes: [],
      }),
    ],
    automatedTriggerMap: new Map([
      ['member-physio-claim-received', 'review-policy-constraints'],
    ]),
    factIdToName: new Map(),
  };
}

function makeDeps(workflows: Map<string, WorkflowDefinition>) {
  return {
    eventBus: { subscribe: vi.fn(), publish: vi.fn() },
    eventStore: {
      getSessionEventTypes: vi.fn().mockReturnValue(new Set<string>()),
      getSessionFactValues: vi.fn().mockReturnValue({}),
    },
    todoStore: {
      findBySliceAndSession: vi.fn().mockReturnValue(null),
      upsert: vi.fn(),
      insertPendingIfAbsent: vi.fn().mockReturnValue(true),
      complete: vi.fn(),
    },
    workflows,
  };
}

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    id: 'evt-1',
    type: 'procurement-requested',
    source: 'request-procurement',
    payload: {},
    timestamp: new Date(),
    sessionId: 'sess-1',
    ...overrides,
  };
}

describe('TodoProcessor', () => {
  describe('register', () => {
    it('subscribes to wildcard events on the EventBus', () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);
      const processor = new TodoProcessor(deps as any);
      processor.register();
      expect(deps.eventBus.subscribe).toHaveBeenCalledWith('*', expect.any(Function));
    });
  });

  describe('handleEvent — procurement workflow', () => {
    it('does not create todos for events without sessionId', async () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);
      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({ sessionId: undefined }));
      expect(deps.todoStore.insertPendingIfAbsent).not.toHaveBeenCalled();
    });

    it('does not create todos for events from unknown workflows', async () => {
      const workflows = new Map<string, WorkflowDefinition>();
      const deps = makeDeps(workflows);
      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({ source: 'unknown-slice' }));
      expect(deps.todoStore.insertPendingIfAbsent).not.toHaveBeenCalled();
    });

    it('does not create todos for automated slices', async () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);
      // Session has procurement-requested event
      deps.eventStore.getSessionEventTypes.mockReturnValue(new Set(['procurement-requested']));
      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({ type: 'procurement-requested' }));
      // approve-procurement is automated, should NOT create a todo
      expect(deps.todoStore.insertPendingIfAbsent).not.toHaveBeenCalled();
    });

    it('does not create todos for entry-point interface slices (no given events)', async () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);
      const processor = new TodoProcessor(deps as any);
      // Even when request-procurement's preconditions are met (they're always met — no givens),
      // we don't create a todo because it's the entry point
      await processor.handleEvent(makeEvent({ type: 'some-event' }));
      expect(deps.todoStore.insertPendingIfAbsent).not.toHaveBeenCalled();
    });
  });

  describe('handleEvent — physiotherapy workflow (multi-role)', () => {
    it('creates a todo for query-exception-circumstances when exception-required-for-policy fires', async () => {
      const workflows = new Map([['physio', makePhysioWorkflow()]]);
      const deps = makeDeps(workflows);
      deps.eventStore.getSessionEventTypes.mockReturnValue(
        new Set(['member-physio-claim-received', 'exception-required-for-policy'])
      );
      deps.eventStore.getSessionFactValues.mockReturnValue({ 'claim-id': 'CLM123' });

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({
        type: 'exception-required-for-policy',
        source: 'review-policy-constraints',
      }));

      expect(deps.todoStore.insertPendingIfAbsent).toHaveBeenCalledOnce();
      const created = deps.todoStore.insertPendingIfAbsent.mock.calls[0][0];
      expect(created.sliceName).toBe('query-exception-circumstances');
      expect(created.role).toBe('claims-processor');
      expect(created.status).toBe('pending');
      expect(created.triggerEventType).toBe('exception-required-for-policy');
      expect(created.payload).toEqual({ 'claim-id': 'CLM123' });
    });

    it('creates a todo for eligibility-decision-view when eligibility-decision-made fires', async () => {
      const workflows = new Map([['physio', makePhysioWorkflow()]]);
      const deps = makeDeps(workflows);
      deps.eventStore.getSessionEventTypes.mockReturnValue(
        new Set(['eligibility-decision-made'])
      );

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({
        type: 'eligibility-decision-made',
        source: 'make-eligibility-decision',
      }));

      expect(deps.todoStore.insertPendingIfAbsent).toHaveBeenCalledOnce();
      const created = deps.todoStore.insertPendingIfAbsent.mock.calls[0][0];
      expect(created.sliceName).toBe('eligibility-decision-view');
      expect(created.role).toBe('');
    });

    it('does not create duplicate todos for the same slice+session', async () => {
      const workflows = new Map([['physio', makePhysioWorkflow()]]);
      const deps = makeDeps(workflows);
      deps.eventStore.getSessionEventTypes.mockReturnValue(
        new Set(['exception-required-for-policy'])
      );
      // Atomic dedup: when a pending/claimed sibling exists, the SQL guard
      // in `insertPendingIfAbsent` returns false (changes === 0) and the
      // handler short-circuits before logging "Created pending todo".
      // The previous expectation that `upsert` is never called still
      // holds — TodoProcessor never writes via the bare upsert for the
      // pending-creation path.
      deps.todoStore.insertPendingIfAbsent.mockReturnValue(false);

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({
        type: 'exception-required-for-policy',
        source: 'review-policy-constraints',
      }));

      expect(deps.todoStore.upsert).not.toHaveBeenCalled();
    });

    it('marks todo as completed when outcome event appears', async () => {
      const workflows = new Map([['physio', makePhysioWorkflow()]]);
      const deps = makeDeps(workflows);
      deps.eventStore.getSessionEventTypes.mockReturnValue(
        new Set(['exception-required-for-policy', 'exception-circumstances-queried'])
      );
      deps.todoStore.findBySliceAndSession.mockReturnValue({
        id: 'todo-1',
        sliceName: 'query-exception-circumstances',
        status: 'claimed',
      });

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({
        type: 'exception-circumstances-queried',
        source: 'query-exception-circumstances',
      }));

      expect(deps.todoStore.complete).toHaveBeenCalledWith('todo-1');
    });

    it('does not create a todo when preconditions are not met', async () => {
      const workflows = new Map([['physio', makePhysioWorkflow()]]);
      const deps = makeDeps(workflows);
      // Session only has member-physio-claim-received, NOT exception-required-for-policy
      deps.eventStore.getSessionEventTypes.mockReturnValue(
        new Set(['member-physio-claim-received'])
      );

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({
        type: 'member-physio-claim-received',
        source: 'receive-member-claim',
      }));

      // query-exception-circumstances requires exception-required-for-policy — not met
      // eligibility-decision-view requires eligibility-decision-made — not met
      expect(deps.todoStore.insertPendingIfAbsent).not.toHaveBeenCalled();
    });
  });

  describe('workflow resolution', () => {
    it('resolves workflow by event source (slice name)', async () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);
      deps.eventStore.getSessionEventTypes.mockReturnValue(new Set(['procurement-requested']));

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({ source: 'request-procurement' }));
      // Should resolve to manage-procurement workflow (no error thrown)
      // No todos created because procurement has no non-entry interface slices with given events
    });

    it('resolves workflow by event type (trigger map)', async () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({ source: 'some-other-source', type: 'procurement-requested' }));
      // Should resolve via automatedTriggerMap
    });

    it('caches session-to-workflow mapping', async () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({ sessionId: 'sess-1', source: 'request-procurement' }));
      await processor.handleEvent(makeEvent({ sessionId: 'sess-1', source: 'unknown' }));
      // Second event should still resolve via cache
    });

    it('invalidateCache clears the session-to-workflow cache', async () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({ sessionId: 'sess-1', source: 'request-procurement' }));
      processor.invalidateCache();
      // After invalidation, an event with unknown source won't resolve
      await processor.handleEvent(makeEvent({ sessionId: 'sess-1', source: 'totally-unknown', type: 'unknown-type' }));
      // No error, just no todos
    });
  });

  describe('error handling', () => {
    it('catches and logs errors without rethrowing', async () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);
      deps.eventStore.getSessionEventTypes.mockImplementation(() => { throw new Error('db failure'); });

      const processor = new TodoProcessor(deps as any);
      await expect(processor.handleEvent(makeEvent())).resolves.toBeUndefined();
    });
  });
});
