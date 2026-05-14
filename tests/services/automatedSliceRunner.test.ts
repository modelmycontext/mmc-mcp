import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAutomatedSliceHandler, resolveInlineSliceData, type SliceData } from '../../src/services/automatedSliceRunner.js';

vi.mock('@src/utils/logger.js', async () =>
  (await import('../_helpers/loggerMock')).loggerMock(),
);

// Mock evaluateBusinessRules so tests control rule pass/fail
const mockEvaluateBusinessRules = vi.hoisted(() => vi.fn());
vi.mock('@src/utils/businessRuleEvaluator.js', () => ({
  evaluateBusinessRules: mockEvaluateBusinessRules,
}));

const SKILL_PATH = '/skills/my-activity/my-slice/my-slice.md';
const SID = 'slice-test-id';
const sk = (factName: string) => `${SID}:${factName}`;

function makeDeps(overrides: Record<string, any> = {}) {
  return {
    eventBus: { publish: vi.fn() },
    eventStore: {
      getSessionEventTypes: vi.fn().mockReturnValue(new Set<string>()),
      getSessionFactValues: vi.fn().mockReturnValue({}),
    },
    skillsDir: '/skills',
    executeConnector: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

/**
 * Raw scenario JSON shape (matches what comes out of an outcome model JSON
 * file or a workbench-pushed sliceData). `extractEligibleScenarios` projects
 * this into the EligibleScenario shape the handler consumes internally.
 */
function makeRawScenario(overrides: Record<string, any> = {}) {
  return {
    id: 'sc-1',
    given: [] as Array<{ name: string }>,
    givenBusinessRules: [] as any[],
    whenBusinessRules: [] as any[],
    then: [{ name: 'my-outcome', facts: [] }],
    error: '',
    ...overrides,
  };
}

/**
 * Build a SliceData record for the handler under test. Mirrors the shape the
 * production resolvers (`resolveDiskSliceData` / `resolveInlineSliceData`)
 * produce. Tests control the slice JSON directly — no module mocking.
 */
function makeSliceData(opts: {
  scenarios?: any[];
  outcomes?: any[];
  queries?: any[];
  command?: any;
  facts?: any[];
  /** Fact names the slice's contract permits to flow through ingestion. */
  contract?: string[];
} = {}): SliceData {
  const factIdToName = new Map<string, string>();
  for (const name of opts.contract ?? []) factIdToName.set(`f-${name}`, name);
  return {
    sliceName: 'my-activity/my-slice',
    skillMdPath: SKILL_PATH,
    slice: {
      id: SID,
      scenarios: opts.scenarios ?? [],
      outcomes: opts.outcomes ?? [],
      queries: opts.queries ?? [],
      command: opts.command,
      facts: opts.facts ?? [],
    },
    factIdToName,
  };
}

function makeTriggerEvent(overrides: Record<string, any> = {}) {
  return {
    id: 'evt-1',
    type: 'discount-requested',
    source: 'test',
    payload: {},
    timestamp: new Date(),
    sequence: 1,
    sessionId: 'sess-1',
    ...overrides,
  };
}

describe('createAutomatedSliceHandler', () => {
  beforeEach(() => {
    mockEvaluateBusinessRules.mockReset();
    mockEvaluateBusinessRules.mockResolvedValue(true);
  });

  describe('Step 1 — eligibility', () => {
    it('returns early without publishing when slice has no scenarios and no outcomes', async () => {
      const deps = makeDeps();
      const data = makeSliceData();
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(deps.eventBus.publish).not.toHaveBeenCalled();
    });

    it('filters out scenarios whose given[] events are not all present on the session', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionEventTypes.mockReturnValue(new Set(['existing-event']));
      const data = makeSliceData({
        scenarios: [makeRawScenario({ given: [{ name: 'missing-event' }] })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent({ type: 'new-event' }));
      expect(deps.eventBus.publish).not.toHaveBeenCalled();
    });

    it('includes the triggering event type when filtering scenarios (it may not be persisted yet)', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionEventTypes.mockReturnValue(new Set(['existing-event']));
      // Scenario requires both events — only "existing-event" is in the store,
      // but "new-event" is the triggering event so it should be eligible
      const data = makeSliceData({
        scenarios: [makeRawScenario({ given: [{ name: 'existing-event' }, { name: 'new-event' }] })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent({ type: 'new-event' }));
      expect(deps.eventBus.publish).toHaveBeenCalledOnce();
    });
  });

  describe('Step 2 — fact collection', () => {
    it('merges session fact values with triggering event payload', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionFactValues.mockReturnValue({ sessionFact: 'from-session' });
      const data = makeSliceData({ scenarios: [makeRawScenario()], contract: ['sessionFact', 'eventFact'] });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent({ payload: { eventFact: 'from-event' } }));
      const factValues = mockEvaluateBusinessRules.mock.calls[0][1];
      expect(factValues.sessionFact).toBe('from-session');
      expect(factValues.eventFact).toBe('from-event');
    });

    it('triggering event payload overrides session fact values for same key', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionFactValues.mockReturnValue({ tier: 'silver' });
      const data = makeSliceData({ scenarios: [makeRawScenario()], contract: ['tier'] });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent({ payload: { tier: 'gold' } }));
      const factValues = mockEvaluateBusinessRules.mock.calls[0][1];
      expect(factValues.tier).toBe('gold');
    });
  });

  describe('Step 3 — business rule evaluation', () => {
    it('calls evaluateBusinessRules with givenBusinessRules and whenBusinessRules', async () => {
      const deps = makeDeps();
      const givenRules = [{ id: 'r1', factId: 'f1', operator: 'equals', value: 'x' }];
      const whenRules = [{ id: 'r2', factId: 'f2', operator: 'equals', value: 'y' }];
      const data = makeSliceData({
        scenarios: [makeRawScenario({ givenBusinessRules: givenRules, whenBusinessRules: whenRules })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      // Should be called twice (once for given, once for when)
      expect(mockEvaluateBusinessRules).toHaveBeenCalledTimes(2);
    });

    it('skips scenario when givenBusinessRules fails', async () => {
      const deps = makeDeps();
      mockEvaluateBusinessRules.mockResolvedValueOnce(false);
      const data = makeSliceData({ scenarios: [makeRawScenario()] });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(deps.eventBus.publish).not.toHaveBeenCalled();
    });

    it('skips scenario when whenBusinessRules fails', async () => {
      const deps = makeDeps();
      mockEvaluateBusinessRules
        .mockResolvedValueOnce(true)   // given
        .mockResolvedValueOnce(false); // when
      const data = makeSliceData({ scenarios: [makeRawScenario()] });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(deps.eventBus.publish).not.toHaveBeenCalled();
    });

    it('includes scenario when both given and when pass', async () => {
      const deps = makeDeps();
      mockEvaluateBusinessRules.mockResolvedValue(true);
      const data = makeSliceData({ scenarios: [makeRawScenario()] });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(deps.eventBus.publish).toHaveBeenCalledOnce();
    });
  });

  describe('Step 4 — outcome publishing', () => {
    it('publishes an event for each matching scenario then-outcome', async () => {
      const deps = makeDeps();
      const data = makeSliceData({
        scenarios: [makeRawScenario({
          then: [
            { name: 'outcome-a', facts: [] },
            { name: 'outcome-b', facts: [] },
          ],
        })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(deps.eventBus.publish).toHaveBeenCalledTimes(2);
    });

    it('converts outcome name to kebab-case for event type', async () => {
      const deps = makeDeps();
      const data = makeSliceData({
        scenarios: [makeRawScenario({ then: [{ name: 'CustomerTierIdentified', facts: [] }] })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const publishedEvent = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(publishedEvent.type).toBe('customer-tier-identified');
    });

    it('resolves calculatedValue formula for outcome facts', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionFactValues.mockReturnValue({ orderValue: '500' });
      const data = makeSliceData({
        scenarios: [makeRawScenario({
          then: [{
            name: 'discount-calculated',
            facts: [{ id: 'f1', name: 'discount-amount', calculatedValue: 'orderValue * 0.1' }],
          }],
        })],
        contract: ['orderValue'],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const payload = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(payload[sk('discount-amount')]).toBe('50');
    });

    it('uses defaultValue when calculatedValue is absent', async () => {
      const deps = makeDeps();
      const data = makeSliceData({
        scenarios: [makeRawScenario({
          then: [{
            name: 'tier-set',
            facts: [{ id: 'f1', name: 'tier', defaultValue: 'standard' }],
          }],
        })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const payload = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(payload[sk('tier')]).toBe('standard');
    });

    it('prefers session fact over defaultValue when both exist', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionFactValues.mockReturnValue({ 'total-amount': '9000' });
      const data = makeSliceData({
        scenarios: [makeRawScenario({
          then: [{
            name: 'activated',
            facts: [{ id: 'f1', name: 'total-amount', defaultValue: '0' }],
          }],
        })],
        contract: ['total-amount'],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const payload = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(payload[sk('total-amount')]).toBe('9000');
    });

    it('uses calculatedValue even when session fact exists', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionFactValues.mockReturnValue({ approved: 'false' });
      const data = makeSliceData({
        scenarios: [makeRawScenario({
          then: [{
            name: 'approved-event',
            facts: [{ id: 'f1', name: 'approved', calculatedValue: 'true' }],
          }],
        })],
        contract: ['approved'],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const payload = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(payload[sk('approved')]).toBe('true');
    });

    it('copies current fact value when both calculatedValue and defaultValue are empty', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionFactValues.mockReturnValue({ tier: 'gold' });
      const data = makeSliceData({
        scenarios: [makeRawScenario({
          then: [{
            name: 'tier-confirmed',
            facts: [{ id: 'f1', name: 'tier' }],
          }],
        })],
        contract: ['tier'],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const payload = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(payload[sk('tier')]).toBe('gold');
    });

    it('publishes error event for error scenario instead of then-outcomes', async () => {
      const deps = makeDeps();
      const data = makeSliceData({
        scenarios: [makeRawScenario({ error: 'Customer not found', then: [] })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const publishedEvent = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(publishedEvent.type).toBe('slice-errored');
      expect(publishedEvent.payload.sliceName).toBe('my-activity/my-slice');
      expect(publishedEvent.payload.error).toBe('Customer not found');
    });

    it('publishes slice-tool-failed when no scenario matches and _tool_errors are present', async () => {
      // Surfaces upstream connector failures (e.g. missing AZURE_STORAGE_CONNECTION_STRING)
      // to the test panel. Without this event the workflow stalls silently — the WARN log
      // line is server-only and the panel sees nothing, leaving the user without a signal.
      mockEvaluateBusinessRules.mockResolvedValue(false);
      const deps = makeDeps();
      deps.eventStore.getSessionFactValues.mockReturnValue({
        _tool_errors: [
          { tool: 'azure-blob-download', error: 'AZURE_STORAGE_CONNECTION_STRING env var is required' },
        ],
      });
      const data = makeSliceData({
        scenarios: [makeRawScenario({
          givenBusinessRules: [{ id: 'r1', factId: 'f1', operator: '=', value: 'x' }],
        })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const published = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      const stallEvent = published.find(e => e.type === 'slice-tool-failed');
      expect(stallEvent).toBeDefined();
      expect(stallEvent.payload.sliceName).toBe('my-activity/my-slice');
      expect(stallEvent.payload.toolErrors).toHaveLength(1);
      expect(stallEvent.payload.toolErrors[0].error).toMatch(/AZURE_STORAGE_CONNECTION_STRING/);
      expect(stallEvent.sessionId).toBe('sess-1');
    });

    it('does not publish slice-tool-failed when stall has no _tool_errors', async () => {
      // Pure rule-logic miss (no tool failures) should keep the existing silent stall —
      // the WARN log diagnostic is enough; we should not invent error events out of nothing.
      mockEvaluateBusinessRules.mockResolvedValue(false);
      const deps = makeDeps();
      const data = makeSliceData({
        scenarios: [makeRawScenario({
          givenBusinessRules: [{ id: 'r1', factId: 'f1', operator: '=', value: 'x' }],
        })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const published = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      expect(published.find(e => e.type === 'slice-tool-failed')).toBeUndefined();
    });

    it('includes sessionId in all published outcome payloads', async () => {
      const deps = makeDeps();
      const data = makeSliceData({ scenarios: [makeRawScenario()] });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent({ sessionId: 'my-session' }));
      const payload = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(payload.sessionId).toBe('my-session');
    });
  });

  describe('Zero scenarios — pass-through', () => {
    it('publishes slice-level outcomes when no scenarios exist', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionFactValues.mockReturnValue({ 'customer-tier': 'gold' });
      const data = makeSliceData({
        outcomes: [{ name: 'customer-tier-identified', facts: [{ id: 'f1', name: 'customer-tier' }] }],
        contract: ['customer-tier'],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(deps.eventBus.publish).toHaveBeenCalledOnce();
      const published = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(published.type).toBe('customer-tier-identified');
      expect(published.payload[sk('customer-tier')]).toBe('gold');
    });

    it('publishes multiple slice-level outcomes', async () => {
      const deps = makeDeps();
      const data = makeSliceData({
        outcomes: [
          { name: 'outcome-a', facts: [] },
          { name: 'outcome-b', facts: [] },
        ],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(deps.eventBus.publish).toHaveBeenCalledTimes(2);
    });

    it('prefers session fact over defaultValue in slice-level outcomes', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionFactValues.mockReturnValue({ amount: '5000' });
      const data = makeSliceData({
        outcomes: [{
          name: 'pass-through',
          facts: [{ id: 'f1', name: 'amount', defaultValue: '0' }],
        }],
        contract: ['amount'],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const payload = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(payload[sk('amount')]).toBe('5000');
    });

    it('resolves calculatedValue in slice-level outcome facts', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionFactValues.mockReturnValue({ orderValue: '200' });
      const data = makeSliceData({
        outcomes: [{
          name: 'discount-applied',
          facts: [{ id: 'f1', name: 'discount', calculatedValue: 'orderValue * 0.1' }],
        }],
        contract: ['orderValue'],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const payload = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(payload[sk('discount')]).toBe('20');
    });

    it('merges triggering event payload into fact values for slice-level outcomes', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionFactValues.mockReturnValue({ tier: 'silver' });
      const data = makeSliceData({
        outcomes: [{ name: 'echo', facts: [{ id: 'f1', name: 'tier' }] }],
        contract: ['tier'],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent({ payload: { tier: 'platinum' } }));
      const payload = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(payload[sk('tier')]).toBe('platinum');
    });

    it('skips when slice has no scenarios and no outcomes', async () => {
      const deps = makeDeps();
      const data = makeSliceData();
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(deps.eventBus.publish).not.toHaveBeenCalled();
    });

    it('skips when slice has no scenarios and an empty outcomes array', async () => {
      const deps = makeDeps();
      const data = makeSliceData({ outcomes: [] });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(deps.eventBus.publish).not.toHaveBeenCalled();
    });

    it('waits (does not publish) when slice has scenarios but none eligible', async () => {
      // Regression: the handler used to fall through to the "no-scenario pass-through"
      // path whenever eligibleScenarios was empty — even when the slice had scenarios
      // defined but none matched. That caused empty-payload outcome events to be
      // published prematurely. It should now return without publishing.
      const deps = makeDeps();
      deps.eventStore.getSessionEventTypes.mockReturnValue(new Set<string>());
      const data = makeSliceData({
        scenarios: [makeRawScenario({ given: [{ name: 'never-fires' }] })],
        outcomes: [{ name: 'echo', facts: [{ id: 'f1', name: 'tier' }] }],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(deps.eventBus.publish).not.toHaveBeenCalled();
    });
  });

  describe('async publish ordering', () => {
    // These tests catch missing `await` on eventBus.publish() by using an
    // async mock that only records the call after a microtask delay.
    // Without `await`, the handler would resolve before publish completes.

    function makeAsyncPublishDeps() {
      const published: any[] = [];
      const deps = makeDeps({
        eventBus: {
          publish: vi.fn(async (event: any) => {
            // Force a real async gap — a missing `await` will skip past this
            await new Promise(r => setTimeout(r, 5));
            published.push(event);
          }),
        },
      });
      return { deps, published };
    }

    it('awaits publish for scenario outcomes before handler resolves', async () => {
      const { deps, published } = makeAsyncPublishDeps();
      const data = makeSliceData({
        scenarios: [makeRawScenario({ then: [{ name: 'outcome-a', facts: [] }] })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(published.length).toBe(1);
      expect(published[0].type).toBe('outcome-a');
    });

    it('awaits publish for error scenarios before handler resolves', async () => {
      const { deps, published } = makeAsyncPublishDeps();
      const data = makeSliceData({
        scenarios: [makeRawScenario({ error: 'Something went wrong', then: [] })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(published.length).toBe(1);
      expect(published[0].type).toBe('slice-errored');
    });

    it('awaits publish for zero-scenario pass-through before handler resolves', async () => {
      const { deps, published } = makeAsyncPublishDeps();
      const data = makeSliceData({
        outcomes: [{ name: 'terminal-outcome', facts: [] }],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(published.length).toBe(1);
      expect(published[0].type).toBe('terminal-outcome');
    });

    it('awaits all publishes when multiple outcomes exist', async () => {
      const { deps, published } = makeAsyncPublishDeps();
      const data = makeSliceData({
        scenarios: [makeRawScenario({
          then: [
            { name: 'outcome-a', facts: [] },
            { name: 'outcome-b', facts: [] },
          ],
        })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(published.length).toBe(2);
    });
  });

  describe('error handling', () => {
    it('catches and logs errors without rethrowing', async () => {
      const deps = makeDeps();
      // Force an unexpected error by making getSessionEventTypes throw
      deps.eventStore.getSessionEventTypes.mockImplementation(() => {
        throw new Error('unexpected failure');
      });
      const data = makeSliceData({ scenarios: [makeRawScenario()] });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await expect(handler(makeTriggerEvent())).resolves.toBeUndefined();
    });
  });

  describe('slice-tool-failed — surfaces tool errors regardless of match status', () => {
    it('publishes slice-tool-failed with stalled=true when no scenario matches and tool errors exist', async () => {
      mockEvaluateBusinessRules.mockResolvedValue(false);
      const deps = makeDeps();
      // Simulate a query job whose connector throws — recordToolError fires.
      deps.executeConnector.mockRejectedValueOnce(new Error('Collection "x" not found'));
      const data = makeSliceData({
        queries: [{
          id: 'q', name: 'lookup',
          jobLink: {
            job: { id: 'j', name: 'lookup', toolId: 'json-paginated-read' },
            returnedFact: { id: 'f', name: 'rows' },
          },
          facts: [{ name: 'rows' }],
        }],
        scenarios: [makeRawScenario({
          givenBusinessRules: [{ id: 'r', factId: 'f', operator: 'equals', value: 'never' }],
        })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());

      const publish = deps.eventBus.publish as any;
      const failedCall = publish.mock.calls.find((c: any[]) => c[0].type === 'slice-tool-failed');
      expect(failedCall).toBeDefined();
      expect(failedCall[0].payload.stalled).toBe(true);
      expect(failedCall[0].payload.toolErrors).toHaveLength(1);
      expect(failedCall[0].payload.toolErrors[0].error).toContain('Collection "x" not found');
    });

    it('publishes slice-tool-failed with stalled=false when a scenario matches but tool errors exist', async () => {
      mockEvaluateBusinessRules.mockResolvedValue(true);
      const deps = makeDeps();
      deps.executeConnector.mockRejectedValueOnce(new Error('upstream timeout'));
      const data = makeSliceData({
        queries: [{
          id: 'q', name: 'lookup',
          jobLink: {
            job: { id: 'j', name: 'lookup', toolId: 'json-paginated-read' },
            returnedFact: { id: 'f', name: 'rows' },
          },
          facts: [{ name: 'rows' }],
        }],
        scenarios: [makeRawScenario({ then: [{ name: 'fired', facts: [] }] })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());

      const publish = deps.eventBus.publish as any;
      const failedCall = publish.mock.calls.find((c: any[]) => c[0].type === 'slice-tool-failed');
      expect(failedCall).toBeDefined();
      expect(failedCall[0].payload.stalled).toBe(false);
      // The matched outcome STILL fires — tool-failed is informational here,
      // not blocking. The workbench decides whether to abort based on `stalled`.
      const types = publish.mock.calls.map((c: any[]) => c[0].type);
      expect(types).toContain('fired');
    });

    it('routes a connector schema-mismatch into _tool_errors and publishes slice-tool-failed', async () => {
      mockEvaluateBusinessRules.mockResolvedValue(false); // force stall so we can read the payload
      const deps = makeDeps();
      // Connector returns a result with NO key matching the declared returnedFact.
      deps.executeConnector.mockResolvedValueOnce({
        documentRef: 'd', storagePath: 'p', rowCount: 0, sizeBytes: 0,
      });
      const data = makeSliceData({
        queries: [{
          id: 'q', name: 'upload',
          jobLink: {
            job: { id: 'j', name: 'upload', toolId: 'azure-blob-download' },
            returnedFact: { id: 'f', name: 'azure-import-result' },
          },
          facts: [{ name: 'azure-import-result' }],
        }],
        scenarios: [makeRawScenario({
          givenBusinessRules: [{ id: 'r', factId: 'f', operator: 'equals', value: 'never' }],
        })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());

      const publish = deps.eventBus.publish as any;
      const failedCall = publish.mock.calls.find((c: any[]) => c[0].type === 'slice-tool-failed');
      expect(failedCall).toBeDefined();
      const toolErrors = failedCall[0].payload.toolErrors;
      expect(toolErrors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          tool: 'azure-blob-download',
          phase: 'query',
          name: 'upload',
          error: expect.stringContaining('returnedFact "azure-import-result" not found'),
        }),
      ]));
    });
  });

  describe('slice-misconfigured — empty thenOutcomes on a matched scenario', () => {
    it('publishes a slice-misconfigured event when a matched scenario has no thenOutcomes', async () => {
      const deps = makeDeps();
      const data = makeSliceData({
        scenarios: [makeRawScenario({ id: 'sc-empty', then: [] })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());

      const publish = deps.eventBus.publish as any;
      const misconfiguredCall = publish.mock.calls.find(
        (c: any[]) => c[0].type === 'slice-misconfigured',
      );
      expect(misconfiguredCall).toBeDefined();
      const payload = misconfiguredCall[0].payload;
      expect(payload.reason).toBe('empty-then-on-matched-scenario');
      expect(payload.scenarioIds).toEqual(['sc-empty']);
      expect(payload.hint).toContain('outcome event');
    });

    it('does not publish slice-misconfigured when thenOutcomes is non-empty', async () => {
      const deps = makeDeps();
      const data = makeSliceData({
        scenarios: [makeRawScenario({ then: [{ name: 'fired', facts: [] }] })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());

      const publish = deps.eventBus.publish as any;
      const types = publish.mock.calls.map((c: any[]) => c[0].type);
      expect(types).not.toContain('slice-misconfigured');
    });

    it('does not publish slice-misconfigured when the matched scenario is an error scenario', async () => {
      const deps = makeDeps();
      const data = makeSliceData({
        scenarios: [makeRawScenario({ then: [], error: 'expected-failure' })],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());

      const publish = deps.eventBus.publish as any;
      const types = publish.mock.calls.map((c: any[]) => c[0].type);
      expect(types).toContain('slice-errored');
      expect(types).not.toContain('slice-misconfigured');
    });
  });

  describe('AI instruction — contract scoping + missing-fact diagnostics', () => {
    it('scopes evaluateInstruction facts to the slice contract — workflow-wide facts are not visible', async () => {
      // Session has BOTH an in-scope fact (declared on the slice) and an
      // out-of-scope one. Only the in-scope fact should reach the LLM.
      const deps = makeDeps();
      const evaluateInstruction = vi.fn().mockResolvedValue({});
      (deps as any).llmService = { evaluateInstruction };
      deps.eventStore.getSessionFactValues.mockReturnValue({
        'plan-tier': 'gold',
        'unrelated-fact-from-other-slice': 'should-not-leak',
      });

      const data = makeSliceData({
        queries: [{
          id: 'q1', name: 'decide',
          text: 'Decide based on plan-tier.',
          facts: [{ name: 'decision' }],
        }],
        scenarios: [makeRawScenario()],
      });
      data.factIdToName = new Map([
        ['f-tier', 'plan-tier'],
        ['f-decision', 'decision'],
      ]);

      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());

      expect(evaluateInstruction).toHaveBeenCalledOnce();
      const [, factsArg, , inScopeArg] = evaluateInstruction.mock.calls[0];
      expect(factsArg['plan-tier']).toBe('gold');
      expect(factsArg['unrelated-fact-from-other-slice']).toBeUndefined();
      expect(inScopeArg).toEqual(expect.arrayContaining(['plan-tier', 'decision']));
      expect(inScopeArg).not.toContain('unrelated-fact-from-other-slice');
    });

    it('routes _missingFacts from the LLM into the tool-error stream and skips merging the result', async () => {
      // Force a stall (all scenario rules fail) so the runner publishes
      // slice-tool-failed carrying the accumulated _tool_errors. That's the
      // surface the test panel sees when an upstream LLM call declared
      // insufficient input.
      mockEvaluateBusinessRules.mockResolvedValue(false);

      const deps = makeDeps();
      const evaluateInstruction = vi.fn().mockResolvedValue({
        _missingFacts: ['plan-tier'],
        _reason: 'plan-tier is not set',
        decision: 'should-not-be-merged',
      });
      (deps as any).llmService = { evaluateInstruction };

      const data = makeSliceData({
        queries: [{
          id: 'q1', name: 'decide',
          text: 'Decide based on plan-tier.',
          facts: [{ name: 'decision' }],
        }],
        scenarios: [makeRawScenario({
          givenBusinessRules: [{ id: 'r', factId: 'f-decision', operator: 'equals', value: 'approve' }],
        })],
      });
      data.factIdToName = new Map([['f-decision', 'decision']]);

      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());

      const publish = deps.eventBus.publish as any;
      const stallCall = publish.mock.calls.find((c: any[]) => c[0].type === 'slice-tool-failed');
      expect(stallCall).toBeDefined();
      const toolErrors = stallCall[0].payload.toolErrors;
      expect(toolErrors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          tool: 'ai.eval',
          phase: 'query',
          name: 'decide',
          error: expect.stringContaining('plan-tier'),
        }),
      ]));

      // The merged "decision" key must NOT have leaked back into the fact
      // pool — the rule evaluator is therefore working with the unset fact.
      const factValues = mockEvaluateBusinessRules.mock.calls[0][1];
      expect(factValues.decision).toBeUndefined();
    });

    it('strips _-prefixed diagnostic keys when merging an otherwise-valid LLM result', async () => {
      const deps = makeDeps();
      const evaluateInstruction = vi.fn().mockResolvedValue({
        decision: 'approve',
        _internalNote: 'should-not-merge',
      });
      (deps as any).llmService = { evaluateInstruction };

      const data = makeSliceData({
        queries: [{ id: 'q1', name: 'decide', text: 'Decide.', facts: [{ name: 'decision' }] }],
        scenarios: [makeRawScenario({ then: [{ name: 'decision-made', facts: [{ name: 'decision' }, { name: '_internalNote' }] }] })],
      });
      data.factIdToName = new Map([['f-decision', 'decision']]);

      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());

      const publish = deps.eventBus.publish as any;
      const payload = publish.mock.calls[0][0].payload;
      expect(payload[sk('decision')]).toBe('approve');
      expect(payload[sk('_internalNote')]).toBeUndefined();
      expect(payload._internalNote).toBeUndefined();
    });
  });

  describe('command failure aborts scenario evaluation (spec: Command Job failure → no Outcomes)', () => {
    it('does not publish outcomes when command job throws', async () => {
      const deps = makeDeps();
      deps.executeConnector.mockRejectedValueOnce(new Error('connector exploded'));
      const data = makeSliceData({
        scenarios: [makeRawScenario({ given: [{ name: 'discount-requested' }] })],
        outcomes: [{ name: 'my-outcome', facts: [] }],
        command: {
          mode: 'job',
          jobLink: {
            job: { id: 'cmd-job', name: 'do-write', toolId: 'json-write' },
            inputMappings: {},
          },
          outcomes: [{ facts: [] }],
        },
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      // No my-outcome event should be published. slice-tool-failed IS allowed.
      const publishedTypes = deps.eventBus.publish.mock.calls.map((c: any[]) => c[0].type);
      expect(publishedTypes).not.toContain('my-outcome');
      expect(publishedTypes).toContain('slice-tool-failed');
    });

    it('does not publish outcomes when instruction-mode command (LLM) throws', async () => {
      const deps = makeDeps({
        llmService: { evaluateInstruction: vi.fn().mockRejectedValueOnce(new Error('LLM down')) },
      });
      const data = makeSliceData({
        scenarios: [makeRawScenario({ given: [{ name: 'discount-requested' }] })],
        outcomes: [{ name: 'my-outcome', facts: [] }],
        command: {
          mode: 'instruction',
          instruction: 'compute the thing',
          outcomes: [{ facts: [{ id: 'f-r', name: 'result' }] }],
        },
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const publishedTypes = deps.eventBus.publish.mock.calls.map((c: any[]) => c[0].type);
      expect(publishedTypes).not.toContain('my-outcome');
      expect(publishedTypes).toContain('slice-tool-failed');
    });

    it('marks slice-tool-failed payload as not stalled when the cause is a command failure', async () => {
      const deps = makeDeps();
      deps.executeConnector.mockRejectedValueOnce(new Error('connector exploded'));
      const data = makeSliceData({
        scenarios: [makeRawScenario({ given: [{ name: 'discount-requested' }] })],
        outcomes: [{ name: 'my-outcome', facts: [] }],
        command: {
          mode: 'job',
          jobLink: {
            job: { id: 'cmd-job', name: 'do-write', toolId: 'json-write' },
            inputMappings: {},
          },
          outcomes: [{ facts: [] }],
        },
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      const failedEvt = deps.eventBus.publish.mock.calls
        .map((c: any[]) => c[0])
        .find((e: any) => e.type === 'slice-tool-failed');
      // `stalled` means "rules didn't match" — a command failure is a different
      // root cause and shouldn't be conflated with rule-logic stalls.
      expect(failedEvt.payload.stalled).toBe(false);
    });
  });

  describe('@-encoded inputMappings (regression — automated path used to flat-lookup only)', () => {
    // Until the path was unified, the automated runner had its own inline
    // factName lookup that did not understand the `@factName.fieldName`
    // encoding. A workbench-authored command/query with a composite-field
    // reference would fall through to the literal "@..." string and the
    // connector would receive that as a parameter value, manifesting as a
    // "Collection ... not found" error from JsonDataSource.

    it('command-job decodes @factName.fieldName and plucks the composite field', async () => {
      const deps = makeDeps();
      // Composite fact already present on the session bus
      deps.eventStore.getSessionFactValues.mockReturnValue({
        'azure-import-result': { storagePath: '/blobs/abc.json' },
      });
      const data = makeSliceData({
        scenarios: [makeRawScenario()],
        command: {
          mode: 'job',
          jobLink: {
            job: {
              id: 'cmd-job',
              name: 'import-row-count',
              toolId: 'json-read',
            },
            inputMappings: { collection: '@azure-import-result.storagePath' },
          },
          outcomes: [{ facts: [{ id: 'f-rows', name: 'row-count' }] }],
        },
        facts: [{ id: 'f-azure', name: 'azure-import-result' }],
        contract: ['azure-import-result'],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(deps.executeConnector).toHaveBeenCalledWith(
        'json-read',
        expect.objectContaining({ collection: '/blobs/abc.json' }),
        'sess-1',
      );
    });

    it('query-job decodes @factName.fieldName and plucks the composite field', async () => {
      const deps = makeDeps();
      deps.eventStore.getSessionFactValues.mockReturnValue({
        'azure-import-result': { storagePath: '/blobs/abc.json' },
      });
      const data = makeSliceData({
        scenarios: [makeRawScenario()],
        queries: [{
          id: 'q1',
          name: 'preview-rows',
          facts: [{ id: 'f-preview', name: 'preview-rows' }],
          jobLink: {
            job: {
              id: 'q-job',
              name: 'preview-rows',
              toolId: 'json-paginated-read',
            },
            inputMappings: { collection: '@azure-import-result.storagePath' },
            returnedFact: { id: 'f-preview', name: 'preview-rows' },
          },
        }],
        facts: [{ id: 'f-azure', name: 'azure-import-result' }],
        contract: ['azure-import-result'],
      });
      const handler = createAutomatedSliceHandler(data, deps as any);
      await handler(makeTriggerEvent());
      expect(deps.executeConnector).toHaveBeenCalledWith(
        'json-paginated-read',
        expect.objectContaining({ collection: '/blobs/abc.json' }),
        'sess-1',
      );
    });
  });

  describe('resolveInlineSliceData', () => {
    it('builds factIdToName from slice facts, outcomes, queries, command, and scenario thens', () => {
      const sliceData = {
        facts: [{ id: 'f1', name: 'one' }],
        outcomes: [{ facts: [{ id: 'f2', name: 'two' }] }],
        queries: [{ facts: [{ id: 'f3', name: 'three' }] }],
        command: { facts: [{ id: 'f4', name: 'four' }] },
        scenarios: [{ then: [{ facts: [{ id: 'f5', name: 'five' }] }] }],
      };
      const data = resolveInlineSliceData(sliceData, 'my-slice');
      expect(data.sliceName).toBe('my-slice');
      expect(data.slice).toBe(sliceData);
      expect(data.factIdToName.get('f1')).toBe('one');
      expect(data.factIdToName.get('f2')).toBe('two');
      expect(data.factIdToName.get('f3')).toBe('three');
      expect(data.factIdToName.get('f4')).toBe('four');
      expect(data.factIdToName.get('f5')).toBe('five');
    });

    it('tolerates undefined sliceData', () => {
      const data = resolveInlineSliceData(undefined, 'empty');
      expect(data.sliceName).toBe('empty');
      expect(data.factIdToName.size).toBe(0);
    });

    it('expands factIdToName with facts from given-event outcomes when an index is provided', () => {
      const sliceData = {
        facts: [{ id: 'f-own', name: 'own' }],
        scenarios: [{ given: [{ name: 'tier-selected' }], then: [] }],
      };
      const eventSchemaIndex = new Map<string, { id: string; name: string }[]>([
        ['tier-selected', [{ id: 'f-tier', name: 'plan-tier' }]],
      ]);
      const data = resolveInlineSliceData(sliceData, 'slice-b', eventSchemaIndex);
      expect(data.factIdToName.get('f-own')).toBe('own');
      expect(data.factIdToName.get('f-tier')).toBe('plan-tier');
    });

    it('does not expose facts on outcomes the slice has not subscribed to via given', () => {
      const sliceData = {
        facts: [{ id: 'f-own', name: 'own' }],
        scenarios: [{ given: [{ name: 'subscribed' }], then: [] }],
      };
      const eventSchemaIndex = new Map<string, { id: string; name: string }[]>([
        ['subscribed', [{ id: 'f-sub', name: 'sub' }]],
        ['unrelated', [{ id: 'f-other', name: 'other' }]],
      ]);
      const data = resolveInlineSliceData(sliceData, 'slice-b', eventSchemaIndex);
      expect(data.factIdToName.has('f-own')).toBe(true);
      expect(data.factIdToName.has('f-sub')).toBe(true);
      expect(data.factIdToName.has('f-other')).toBe(false);
    });
  });
});
