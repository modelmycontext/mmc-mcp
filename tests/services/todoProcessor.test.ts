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
    factIdToName: new Map<string, string>(),
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
        // Contract — declares which facts the slice can resolve. Without
        // this, ingestScopedFacts emits an empty payload (correct strict
        // behavior since 33f421c's intent of preventing cross-slice leakage).
        factIdToName: new Map([['fact-claim-id', 'claim-id']]),
      } as any),
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
      getCorrelationEventTypes: vi.fn().mockReturnValue(new Set<string>()),
      getCorrelationFactValues: vi.fn().mockReturnValue({}),
    },
    todoStore: {
      findBySliceAndCorrelation: vi.fn().mockReturnValue(null),
      findBySliceIdAndSession: vi.fn().mockReturnValue(null),
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
    correlationId: 'sess-1',
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
    it('does not create todos for events without correlationId', async () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);
      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({ correlationId: undefined }));
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
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(new Set(['procurement-requested']));
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
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
        new Set(['member-physio-claim-received', 'exception-required-for-policy'])
      );
      deps.eventStore.getCorrelationFactValues.mockReturnValue({ 'claim-id': 'CLM123' });

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
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
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
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
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
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
        new Set(['exception-required-for-policy', 'exception-circumstances-queried'])
      );
      deps.todoStore.findBySliceAndCorrelation.mockReturnValue({
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

    it("view-payload reads the latest factId value (a later slice's write wins over an earlier one)", async () => {
      // Regression (now under #77 factId keys): when two upstream slices write
      // the SAME fact (factId `fact-cd-decision`) — make-credit-decision →
      // "referred", then resolve-underwriter-decision → "approved" — the view
      // triggered by the second event must read "approved". Under factId keying
      // both writes land on the same key, so getCorrelationFactValues' sequence-
      // ordered fold already yields the latest ("approved"); ingestScopedFacts
      // then translates factId→name for the todo payload. (Pre-#77 this needed
      // sliceId-scoped keys + trigger-merge to beat the stale earlier value.)
      function makeShowDecisionWorkflow(): WorkflowDefinition {
        return {
          name: 'credit-decisioning',
          slices: [
            makeSlice({
              id: 'slice-show',
              name: 'show-credit-decision',
              role: 'loan-officer',
              isInterface: true,
              outcomeEventTypes: [],
              givenEventGroups: [['underwriter-approved']],
              scenarios: [{
                givenEventNames: ['underwriter-approved'],
                givenBusinessRules: [],
                givenBusinessRuleLogic: 'AND' as const,
                error: '',
              }],
              factNames: ['decision', 'decided-by', 'application-id'],
              factIdToName: new Map([
                ['fact-cd-decision', 'decision'],
                ['fact-cd-decidedBy', 'decided-by'],
                ['fact-cd-applicationId', 'application-id'],
              ]),
            } as any),
          ],
          automatedTriggerMap: new Map(),
          factIdToName: new Map(),
        };
      }

      const workflows = new Map([['credit-decisioning', makeShowDecisionWorkflow()]]);
      const deps = makeDeps(workflows);
      // Session pool is factId-keyed (#77). getCorrelationFactValues folds events
      // by sequence, so `fact-cd-decision` already holds the latest write
      // ("approved" from resolve-underwriter-decision). The trigger event
      // re-asserts the same factId values.
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
        new Set(['underwriter-approved'])
      );
      deps.eventStore.getCorrelationFactValues.mockReturnValue({
        'fact-cd-applicationId': 'APP-1002',
        'fact-cd-decision': 'approved',
        'fact-cd-decidedBy': 'underwriter',
      });

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent({
        ...makeEvent({
          type: 'underwriter-approved',
          source: 'credit-decisioning/resolve-underwriter-decision',
        }),
        payload: {
          'fact-cd-decision': 'approved',
          'fact-cd-decidedBy': 'underwriter',
        },
      } as any);

      expect(deps.todoStore.insertPendingIfAbsent).toHaveBeenCalledOnce();
      const created = deps.todoStore.insertPendingIfAbsent.mock.calls[0][0];
      expect(created.payload).toMatchObject({
        decision: 'approved',
        'decided-by': 'underwriter',
        'application-id': 'APP-1002',
      });
    });

    it("does not create a phantom new todo when an UNRELATED downstream event fires", async () => {
      // Broader regression: even when the triggering event is NOT the slice's
      // own outcome — e.g. underwriter-review (given=application-referred,
      // outcome=underwriter-reviewed) processed against underwriter-approved
      // which is resolve-underwriter-decision's outcome — the original
      // narrower guard (isOwnOutcome) failed to catch it because
      // underwriter-approved is not in underwriter-review.outcomeEventTypes.
      // The correct check is that the triggering event must be one of the
      // scenario's givens.
      function makeUwReviewWorkflowWithResolve(): WorkflowDefinition {
        return {
          name: 'credit-decisioning',
          slices: [
            makeSlice({
              id: 'slice-uwreview',
              name: 'underwriter-review',
              role: 'underwriter',
              isInterface: true,
              givenEventGroups: [['application-referred']],
              outcomeEventTypes: ['underwriter-reviewed'],
              scenarios: [{
                givenEventNames: ['application-referred'],
                givenBusinessRules: [],
                givenBusinessRuleLogic: 'AND' as const,
                error: '',
              }],
            }),
          ],
          automatedTriggerMap: new Map(),
          factIdToName: new Map(),
        };
      }

      const workflows = new Map([['credit-decisioning', makeUwReviewWorkflowWithResolve()]]);
      const deps = makeDeps(workflows);
      // All three are in session: the original GIVEN, the slice's own
      // outcome, and the downstream automation's outcome.
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
        new Set(['application-referred', 'underwriter-reviewed', 'underwriter-approved'])
      );
      deps.todoStore.findBySliceIdAndSession.mockReturnValue(null);

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({
        type: 'underwriter-approved',
        source: 'resolve-underwriter-decision',
      }));

      expect(deps.todoStore.insertPendingIfAbsent).not.toHaveBeenCalled();
    });

    it("does not create a phantom new todo when a slice's own outcome event fires", async () => {
      // Regression: when an interface slice's outcome event arrives, the
      // GIVEN event is already in the session set (it fired earlier and
      // created the original todo). Without the isOwnOutcome guard,
      // eligibility passes again and a duplicate pending todo gets created
      // for the same slice — observed as the underwriter-review todo
      // reappearing on the dashboard after the user answered.
      function makeUwReviewWorkflow(): WorkflowDefinition {
        return {
          name: 'credit-decisioning',
          slices: [
            makeSlice({
              id: 'slice-uwreview',
              name: 'underwriter-review',
              role: 'underwriter',
              isInterface: true,
              givenEventGroups: [['application-referred']],
              outcomeEventTypes: ['underwriter-reviewed'],
              scenarios: [{
                givenEventNames: ['application-referred'],
                givenBusinessRules: [],
                givenBusinessRuleLogic: 'AND' as const,
                error: '',
              }],
            }),
          ],
          automatedTriggerMap: new Map(),
          factIdToName: new Map(),
        };
      }

      const workflows = new Map([['credit-decisioning', makeUwReviewWorkflow()]]);
      const deps = makeDeps(workflows);
      // Both GIVEN (from earlier) and OUTCOME (just fired) are in the session set.
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
        new Set(['application-referred', 'underwriter-reviewed'])
      );
      // The original todo has already been resolved & cleared — no existing
      // record. The bug manifests independently of the completion path:
      // even with no claimed todo to complete, the guard must prevent
      // re-insertion on the slice's own outcome fire.
      deps.todoStore.findBySliceIdAndSession.mockReturnValue(null);

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({
        type: 'underwriter-reviewed',
        source: 'underwriter-review',
      }));

      expect(deps.todoStore.insertPendingIfAbsent).not.toHaveBeenCalled();
    });

    it('does not create a todo when preconditions are not met', async () => {
      const workflows = new Map([['physio', makePhysioWorkflow()]]);
      const deps = makeDeps(workflows);
      // Session only has member-physio-claim-received, NOT exception-required-for-policy
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
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

  describe('view fan-in — OR-of-ANDs over multiple single-event scenarios', () => {
    // A View reachable through several mutually-exclusive upstream
    // branches (the credit-decisioning `show-credit-decision` shape):
    // one scenario per terminal outcome, each a single-event given.
    // It must surface when ANY one branch fires — never require all.
    function makeDecisionWorkflow(): WorkflowDefinition {
      const terminals = ['application-approved', 'application-declined', 'underwriter-approved', 'underwriter-declined'];
      return {
        name: 'credit-decisioning',
        slices: [
          makeSlice({
            name: 'show-credit-decision',
            role: 'applicant',
            isInterface: true,
            outcomeEventTypes: [],
            givenEventGroups: terminals.map(t => [t]),
            scenarios: terminals.map(t => ({
              givenEventNames: [t],
              givenBusinessRules: [],
              givenBusinessRuleLogic: 'AND' as const,
              error: '',
            })),
          }),
        ],
        automatedTriggerMap: new Map(),
        terminalEventTypes: new Set(terminals),
        factIdToName: new Map(),
      };
    }

    it('surfaces the view when ANY one terminal branch fires (not requiring all)', async () => {
      const workflows = new Map([['credit-decisioning', makeDecisionWorkflow()]]);
      const deps = makeDeps(workflows);
      // Only the underwriter-declined branch happened this instance.
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
        new Set(['credit-application-submitted', 'underwriter-declined'])
      );

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({
        type: 'underwriter-declined',
        source: 'resolve-underwriter-decision',
      }));

      expect(deps.todoStore.insertPendingIfAbsent).toHaveBeenCalledOnce();
      expect(deps.todoStore.insertPendingIfAbsent.mock.calls[0][0].sliceName).toBe('show-credit-decision');
    });

    it('also surfaces on a different single branch (application-approved)', async () => {
      const workflows = new Map([['credit-decisioning', makeDecisionWorkflow()]]);
      const deps = makeDeps(workflows);
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
        new Set(['credit-application-submitted', 'application-approved'])
      );

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({
        type: 'application-approved',
        source: 'make-credit-decision',
      }));

      expect(deps.todoStore.insertPendingIfAbsent).toHaveBeenCalledOnce();
      expect(deps.todoStore.insertPendingIfAbsent.mock.calls[0][0].sliceName).toBe('show-credit-decision');
    });
  });

  describe('workflow resolution', () => {
    it('resolves workflow by event source (slice name)', async () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(new Set(['procurement-requested']));

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
      await processor.handleEvent(makeEvent({ correlationId: 'sess-1', source: 'request-procurement' }));
      await processor.handleEvent(makeEvent({ correlationId: 'sess-1', source: 'unknown' }));
      // Second event should still resolve via cache
    });

    it('invalidateCache clears the session-to-workflow cache', async () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);

      const processor = new TodoProcessor(deps as any);
      await processor.handleEvent(makeEvent({ correlationId: 'sess-1', source: 'request-procurement' }));
      processor.invalidateCache();
      // After invalidation, an event with unknown source won't resolve
      await processor.handleEvent(makeEvent({ correlationId: 'sess-1', source: 'totally-unknown', type: 'unknown-type' }));
      // No error, just no todos
    });
  });

  describe('error handling', () => {
    it('catches and logs errors without rethrowing', async () => {
      const workflows = new Map([['manage-procurement', makeWorkflow()]]);
      const deps = makeDeps(workflows);
      deps.eventStore.getCorrelationEventTypes.mockImplementation(() => { throw new Error('db failure'); });

      const processor = new TodoProcessor(deps as any);
      await expect(processor.handleEvent(makeEvent())).resolves.toBeUndefined();
    });
  });

  // Session-scoped (workbench Test panel) runs must resolve todos against the
  // INLINE model pushed via register-skills — never the disk export. This is
  // the same test-vs-disk seam the automated-slice dispatcher uses. Regression
  // guard for the bug where TodoProcessor read disk-only `workflows`, so a Test
  // panel created no interface/view todos when the disk export was absent/stale.
  describe('session-scoped (inline) resolution', () => {
    const inlineWorkflow = (): WorkflowDefinition => ({
      name: 'discount-order',
      slices: [
        makeSlice({
          name: 'submit', role: 'customer', isInterface: true,
          givenEventGroups: [], outcomeEventTypes: ['request-submitted'],
        }),
        makeSlice({
          name: 'show-summary', role: 'customer', isInterface: true,
          givenEventGroups: [['result-calculated']],
          outcomeEventTypes: [], // no outcomes → view pattern
          scenarios: [{ givenEventNames: ['result-calculated'], givenBusinessRules: [], givenBusinessRuleLogic: 'AND', error: '' }],
        }),
      ],
      automatedTriggerMap: new Map(),
      factIdToName: new Map(),
    } as WorkflowDefinition);

    it('creates a view todo from the inline model even when the DISK map is empty', async () => {
      const deps: any = makeDeps(new Map()); // disk has NO workflows
      const wf = inlineWorkflow();
      deps.isSessionScoped = (sid?: string) => sid === 'sess-1';
      deps.getInlineWorkflow = () => wf;
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(new Set(['request-submitted', 'result-calculated']));

      const processor = new TodoProcessor(deps);
      await processor.handleEvent(makeEvent({ type: 'result-calculated', source: 'compute' }));

      expect(deps.todoStore.insertPendingIfAbsent).toHaveBeenCalledTimes(1);
      expect(deps.todoStore.insertPendingIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({ sliceName: 'show-summary', role: 'customer', pattern: 'view' }),
      );
    });

    it('ignores the inline model and uses disk when the session is NOT session-scoped', async () => {
      const deps: any = makeDeps(new Map()); // disk empty
      deps.isSessionScoped = () => false; // external client (e.g. mmc-workflow)
      deps.getInlineWorkflow = () => inlineWorkflow(); // present but must be IGNORED
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(new Set(['request-submitted', 'result-calculated']));

      const processor = new TodoProcessor(deps);
      await processor.handleEvent(makeEvent({ type: 'result-calculated', source: 'compute' }));

      // Disk map empty → no workflow resolved → no todo; inline was not consulted.
      expect(deps.todoStore.insertPendingIfAbsent).not.toHaveBeenCalled();
    });
  });

  describe('onSliceDeferred — exposing a "no eligible scenario" deadlock', () => {
    // An interface slice gated on TWO given events. With only one present it
    // can't proceed — the case that, when the missing event never arrives, made
    // the run silently quiesce with the form never appearing.
    function deferralWorkflow(): WorkflowDefinition {
      return {
        name: 'da',
        slices: [
          makeSlice({
            name: 'approve-application',
            role: 'admissions-officer',
            isInterface: true,
            givenEventGroups: [['applicant-age-eligible', 'application-received']],
            outcomeEventTypes: ['application-approved'],
            scenarios: [{
              givenEventNames: ['applicant-age-eligible', 'application-received'],
              givenBusinessRules: [],
              givenBusinessRuleLogic: 'AND',
              error: '',
            }],
          }),
        ],
        automatedTriggerMap: new Map(),
        factIdToName: new Map(),
      } as WorkflowDefinition;
    }

    it('fires onSliceDeferred (with the missing given) when the trigger matches but a prerequisite is absent', async () => {
      const deps: any = makeDeps(new Map([['da', deferralWorkflow()]]));
      const onSliceDeferred = vi.fn();
      deps.onSliceDeferred = onSliceDeferred;
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(new Set(['application-received']));

      const processor = new TodoProcessor(deps);
      await processor.handleEvent(makeEvent({ type: 'application-received', source: 'translate' }));

      expect(deps.todoStore.insertPendingIfAbsent).not.toHaveBeenCalled();
      expect(onSliceDeferred).toHaveBeenCalledWith(expect.objectContaining({
        sliceName: 'approve-application',
        role: 'admissions-officer',
        pattern: 'interface',
        triggerEventType: 'application-received',
        missingGivens: ['applicant-age-eligible'],
        rulesFailed: false,
      }));
    });

    it('does NOT fire onSliceDeferred when the missing given is a branch outcome SOME slice produces (AND-join waiting ≠ deadlock)', async () => {
      // The over/underage case: validate-applicant-age PRODUCES
      // applicant-age-eligible (alongside its over/underage siblings). So
      // approve-application missing applicant-age-eligible on application-received
      // is a normal AND-join wait / a branch that fired elsewhere — NOT a wiring
      // gap. The slice must NOT be surfaced as "pending application-approved".
      const wf = deferralWorkflow();
      wf.slices.push(makeSlice({
        name: 'validate-applicant-age',
        role: 'system',
        isInterface: false, // → pattern 'automation' (TodoProcessor skips it, no todo)
        givenEventGroups: [['application-received']],
        outcomeEventTypes: ['applicant-age-eligible', 'applicant-underage', 'applicant-overage'],
        scenarios: [{ givenEventNames: ['application-received'], givenBusinessRules: [], givenBusinessRuleLogic: 'AND', error: '' }],
      }));
      const deps: any = makeDeps(new Map([['da', wf]]));
      const onSliceDeferred = vi.fn();
      deps.onSliceDeferred = onSliceDeferred;
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(new Set(['application-received']));

      const processor = new TodoProcessor(deps);
      await processor.handleEvent(makeEvent({ type: 'application-received', source: 'translate' }));

      expect(deps.todoStore.insertPendingIfAbsent).not.toHaveBeenCalled();
      expect(onSliceDeferred).not.toHaveBeenCalled();
    });

    it('does NOT fire onSliceDeferred for an event unrelated to the slice\'s givens', async () => {
      const deps: any = makeDeps(new Map([['da', deferralWorkflow()]]));
      const onSliceDeferred = vi.fn();
      deps.onSliceDeferred = onSliceDeferred;
      // application-approved resolves the workflow (it's the slice's outcome) but
      // is NOT one of the approve scenario's givens → benign skip, no signal.
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(new Set(['application-approved']));

      const processor = new TodoProcessor(deps);
      await processor.handleEvent(makeEvent({ type: 'application-approved', source: 'approve-application' }));

      expect(onSliceDeferred).not.toHaveBeenCalled();
    });

    it('does NOT fire onSliceDeferred once the slice becomes eligible (todo created instead)', async () => {
      const deps: any = makeDeps(new Map([['da', deferralWorkflow()]]));
      const onSliceDeferred = vi.fn();
      deps.onSliceDeferred = onSliceDeferred;
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
        new Set(['application-received', 'applicant-age-eligible']),
      );

      const processor = new TodoProcessor(deps);
      await processor.handleEvent(makeEvent({ type: 'applicant-age-eligible', source: 'validate-age' }));

      expect(deps.todoStore.insertPendingIfAbsent).toHaveBeenCalled();
      expect(onSliceDeferred).not.toHaveBeenCalled();
    });
  });

  describe('completes a claimed todo on the slice own-outcome event (Test-panel close fix)', () => {
    function approveWorkflow(): WorkflowDefinition {
      return {
        name: 'da',
        slices: [
          makeSlice({
            name: 'approve-application',
            role: 'admissions-officer',
            isInterface: true,
            givenEventGroups: [['applicant-age-eligible', 'application-received']],
            outcomeEventTypes: ['application-approved'],
            scenarios: [{
              givenEventNames: ['applicant-age-eligible', 'application-received'],
              givenBusinessRules: [],
              givenBusinessRuleLogic: 'AND',
              error: '',
            }],
          }),
        ],
        automatedTriggerMap: new Map(),
        factIdToName: new Map(),
      } as WorkflowDefinition;
    }

    it('completes a CLAIMED todo when the own outcome fires, though the slice is NOT eligible on it', async () => {
      const deps: any = makeDeps(new Map([['da', approveWorkflow()]]));
      deps.todoStore.findBySliceAndCorrelation = vi.fn().mockReturnValue({
        id: 'todo-approve', sliceName: 'approve-application', status: 'claimed',
      });
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
        new Set(['application-received', 'applicant-age-eligible', 'application-approved']),
      );

      const processor = new TodoProcessor(deps);
      // The own-outcome event — the slice is NOT eligible on it (its outcome isn't
      // one of its givens), yet the claimed todo must complete. Pre-fix the
      // completion check sat behind the eligibility gate and was skipped here →
      // the claimed todo leaked → hasOpenTodo stuck → no workflow_completed.
      await processor.handleEvent(makeEvent({ type: 'application-approved', source: 'approve-application' }));

      expect(deps.todoStore.complete).toHaveBeenCalledWith('todo-approve');
      expect(deps.todoStore.insertPendingIfAbsent).not.toHaveBeenCalled();
    });

    it('leaves a PENDING (never-claimed) todo alone on the outcome event', async () => {
      const deps: any = makeDeps(new Map([['da', approveWorkflow()]]));
      deps.todoStore.findBySliceAndCorrelation = vi.fn().mockReturnValue({
        id: 'todo-approve', sliceName: 'approve-application', status: 'pending',
      });
      deps.eventStore.getCorrelationEventTypes.mockReturnValue(
        new Set(['application-received', 'applicant-age-eligible', 'application-approved']),
      );

      const processor = new TodoProcessor(deps);
      await processor.handleEvent(makeEvent({ type: 'application-approved', source: 'approve-application' }));

      expect(deps.todoStore.complete).not.toHaveBeenCalled();
    });
  });
});
