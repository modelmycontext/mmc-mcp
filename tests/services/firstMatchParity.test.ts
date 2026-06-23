import { describe, it, expect, vi } from 'vitest';
import { evaluateSlice } from '../../src/services/sliceEvaluator.js';
import { createAutomatedSliceHandler, resolveInlineSliceData } from '../../src/services/automatedSliceRunner.js';
import type { Slice } from '../../src/types/outcomeModel.js';

vi.mock('@src/utils/logger.js', async () =>
  (await import('../_helpers/loggerMock')).loggerMock(),
);

// Real evaluateBusinessRules (NOT mocked here) — this file proves both engines
// select the SAME scenario for the same model + facts under first-match (#78).

// Two scenarios in authored order: a specific tier==gold branch, then a
// no-rule catch-all. Under all-match BOTH would fire on tier=gold; under
// first-match only the specific one does.
const SLICE: Slice = {
  id: 'slice-parity',
  name: 'assess-tier',
  facts: [{ id: 'f-tier', name: 'tier' }],
  scenarios: [
    {
      id: 'specific',
      given: [],
      givenBusinessRules: [],
      whenBusinessRules: [{ id: 'r1', factId: 'f-tier', operator: 'equals', value: 'gold' }],
      whenBusinessRuleLogic: 'AND',
      then: [{ name: 'gold-confirmed', facts: [] }],
    },
    {
      id: 'catch-all',
      given: [],
      givenBusinessRules: [],
      whenBusinessRules: [],
      then: [{ name: 'default-applied', facts: [] }],
    },
  ],
  outcomes: [],
};

const factLookup = new Map<string, string>([['f-tier', 'tier']]);

function makeHandlerDeps() {
  return {
    eventBus: { publish: vi.fn() },
    eventStore: {
      getCorrelationEventTypes: vi.fn().mockReturnValue(new Set<string>()),
      getCorrelationFactValues: vi.fn().mockReturnValue({}),
    },
    skillsDir: '/skills',
    executeConnector: vi.fn().mockResolvedValue({}),
  };
}

async function automationOutcomeTypes(tier: string): Promise<string[]> {
  const deps = makeHandlerDeps();
  const data = resolveInlineSliceData(SLICE, 'assess-tier');
  await createAutomatedSliceHandler(data, deps as any)({
    id: 'e1', type: 'tier-evaluated', source: 'test',
    payload: { tier }, timestamp: new Date(), sequence: 1, correlationId: 's1',
  });
  return deps.eventBus.publish.mock.calls.map(c => c[0].type);
}

describe('first-match parity across both engines (#78)', () => {
  it('tier=gold: the specific scenario wins on BOTH engines (catch-all does NOT also fire)', async () => {
    const evalRes = await evaluateSlice(SLICE, { tier: 'gold' }, undefined, factLookup);
    expect(evalRes.matchedScenarios).toHaveLength(1);
    expect(evalRes.matchedScenarios[0].scenarioIndex).toBe(0);
    expect(evalRes.eventsToLog.map(e => e.type)).toEqual(['gold-confirmed']);

    expect(await automationOutcomeTypes('gold')).toEqual(['gold-confirmed']);
  });

  it('tier=silver: the trailing catch-all wins on BOTH engines', async () => {
    const evalRes = await evaluateSlice(SLICE, { tier: 'silver' }, undefined, factLookup);
    expect(evalRes.matchedScenarios).toHaveLength(1);
    expect(evalRes.matchedScenarios[0].scenarioIndex).toBe(1);
    expect(evalRes.eventsToLog.map(e => e.type)).toEqual(['default-applied']);

    expect(await automationOutcomeTypes('silver')).toEqual(['default-applied']);
  });
});

describe('evaluateSlice first-match (#78)', () => {
  it('selects exactly one scenario even when multiple would match', async () => {
    const slice: Slice = {
      id: 's', name: 'multi',
      facts: [{ id: 'f-a', name: 'a' }],
      scenarios: [
        { id: 'one', given: [], whenBusinessRules: [], then: [{ name: 'first-out', facts: [] }] },
        { id: 'two', given: [], whenBusinessRules: [], then: [{ name: 'second-out', facts: [] }] },
      ],
      outcomes: [],
    };
    const res = await evaluateSlice(slice, {});
    expect(res.matchedScenarios).toHaveLength(1);
    expect(res.matchedScenarios[0].scenarioIndex).toBe(0);
    expect(res.eventsToLog.map(e => e.type)).toEqual(['first-out']);
    expect(res.unmatchedScenarios).toBe(1);
  });
});
