import { describe, it, expect, vi } from 'vitest';
import { resolveJobParams, evaluateSlice } from '../../src/services/sliceEvaluator.js';

vi.mock('@src/utils/logger.js', async () =>
  (await import('../_helpers/loggerMock')).loggerMock(),
);

describe('resolveJobParams', () => {
  const factLookup = new Map<string, string>([
    ['fact-customer', 'customer'],
    ['fact-order-id', 'orderId'],
  ]);

  it('starts with staticParams and extends them with mappings', () => {
    const params = resolveJobParams(
      { id: 'j', name: 'j', staticParams: { region: 'eu' } },
      factLookup,
      {},
    );
    expect(params).toEqual({ region: 'eu' });
  });

  it('resolves a legacy bare-factId mapping to the whole fact value', () => {
    const params = resolveJobParams(
      { id: 'j', name: 'j', inputMappings: { customer: 'fact-customer' } },
      factLookup,
      { customer: { id: 'c1', tier: 'gold' } },
    );
    expect(params.customer).toEqual({ id: 'c1', tier: 'gold' });
  });

  it('resolves @factName encoding to the whole fact value (kebab key)', () => {
    const params = resolveJobParams(
      { id: 'j', name: 'j', inputMappings: { orderId: '@orderId' } },
      factLookup,
      { 'order-id': 'O-42' },
    );
    expect(params.orderId).toBe('O-42');
  });

  it('plucks composite field via the kebab "<fact>-<field>" slot', () => {
    const params = resolveJobParams(
      { id: 'j', name: 'j', inputMappings: { tierName: '@customer.tier' } },
      factLookup,
      { 'customer-tier': 'gold' },
    );
    expect(params.tierName).toBe('gold');
  });

  it('falls back to plucking the field from the whole-fact object', () => {
    const params = resolveJobParams(
      { id: 'j', name: 'j', inputMappings: { tierName: '@customer.tier' } },
      factLookup,
      { customer: { id: 'c1', tier: 'gold' } },
    );
    expect(params.tierName).toBe('gold');
  });

  it('handles kebab-cased composite field names in the encoding', () => {
    const params = resolveJobParams(
      { id: 'j', name: 'j', inputMappings: { discount: '@customer.discountRate' } },
      factLookup,
      { 'customer-discount-rate': 0.1 },
    );
    expect(params.discount).toBe(0.1);
  });

  it('returns empty string for an unknown @fact reference', () => {
    const params = resolveJobParams(
      { id: 'j', name: 'j', inputMappings: { x: '@missing' } },
      factLookup,
      {},
    );
    expect(params.x).toBe('');
  });

  it('returns empty string for an unknown composite field', () => {
    const params = resolveJobParams(
      { id: 'j', name: 'j', inputMappings: { x: '@customer.missing' } },
      factLookup,
      { customer: { id: 'c1' } },
    );
    expect(params.x).toBe('');
  });

  it('treats empty mapping value as empty string', () => {
    const params = resolveJobParams(
      { id: 'j', name: 'j', staticParams: { region: 'eu' }, inputMappings: { x: '' } },
      factLookup,
      { region: 'us' },
    );
    expect(params).toEqual({ region: 'eu', x: '' });
  });

  it('mixes legacy and @-encoded mappings in a single job', () => {
    const params = resolveJobParams(
      {
        id: 'j',
        name: 'j',
        inputMappings: {
          legacyParam: 'fact-customer',
          newParam: '@customer.tier',
        },
      },
      factLookup,
      { customer: { id: 'c1', tier: 'gold' }, 'customer-tier': 'gold' },
    );
    expect(params.legacyParam).toEqual({ id: 'c1', tier: 'gold' });
    expect(params.newParam).toBe('gold');
  });
});

describe('evaluateSlice — slice-misconfigured for matched scenarios with empty then[]', () => {
  it('emits a slice-misconfigured event into eventsToLog when a matched scenario has no then[]', async () => {
    const sliceData: any = {
      name: 'review',
      index: 0,
      scenarios: [{
        id: 's-empty',
        whenBusinessRules: [],
        whenBusinessRuleLogic: 'AND',
        givenBusinessRules: [],
        givenBusinessRuleLogic: 'AND',
        given: [],
        then: [],
      }],
      outcomes: [],
    };
    const result = await evaluateSlice(sliceData, {});
    const misconfigured = result.eventsToLog.find((e: any) => e.type === 'slice-misconfigured');
    expect(misconfigured).toBeDefined();
    expect(misconfigured!.payload.reason).toBe('empty-then-on-matched-scenario');
    expect(misconfigured!.payload.scenarioIds).toEqual(['s-empty']);
    expect(misconfigured!.payload.sliceName).toBe('review');
  });

  it('does not emit slice-misconfigured when then[] is non-empty', async () => {
    const sliceData: any = {
      name: 'review',
      index: 0,
      scenarios: [{
        id: 's', whenBusinessRules: [], givenBusinessRules: [],
        given: [], then: [{ name: 'fired', facts: [] }],
      }],
      outcomes: [],
    };
    const result = await evaluateSlice(sliceData, {});
    const types = result.eventsToLog.map((e: any) => e.type);
    expect(types).not.toContain('slice-misconfigured');
    expect(types).toContain('fired');
  });
});

describe('evaluateSlice — factLookupOverride honours given-event scoping', () => {
  it('without override, a rule referencing a factId not declared on the slice does not match', async () => {
    // Slice B's scenario references `f-tier` (declared on slice A's outcome).
    // Without an override map, evaluateSlice synthesises a slice-only lookup
    // — `f-tier` is unknown, so the rule cannot be evaluated against the
    // collected `plan-tier=gold` fact value.
    const sliceData: any = {
      name: 'check-tier',
      index: 1,
      scenarios: [{
        id: 's',
        whenBusinessRules: [
          { factId: 'f-tier', operator: 'equals', value: 'gold', mode: 'deterministic' },
        ],
        whenBusinessRuleLogic: 'AND',
        givenBusinessRules: [],
        givenBusinessRuleLogic: 'AND',
        given: [{ name: 'tier-selected' }],
        then: [{ name: 'gold-confirmed', facts: [] }],
      }],
      outcomes: [],
    };
    const result = await evaluateSlice(sliceData, { 'plan-tier': 'gold' });
    expect(result.matchedScenarios).toHaveLength(0);
  });

  it('with a scoped override that resolves f-tier to plan-tier, the rule matches', async () => {
    const sliceData: any = {
      name: 'check-tier',
      index: 1,
      scenarios: [{
        id: 's',
        whenBusinessRules: [
          { factId: 'f-tier', operator: 'equals', value: 'gold', mode: 'deterministic' },
        ],
        whenBusinessRuleLogic: 'AND',
        givenBusinessRules: [],
        givenBusinessRuleLogic: 'AND',
        given: [{ name: 'tier-selected' }],
        then: [{ name: 'gold-confirmed', facts: [] }],
      }],
      outcomes: [],
    };
    const override = new Map<string, string>([['f-tier', 'plan-tier']]);
    const result = await evaluateSlice(sliceData, { 'plan-tier': 'gold' }, undefined, override);
    expect(result.matchedScenarios).toHaveLength(1);
    expect(result.eventsToLog[0]?.type).toBe('gold-confirmed');
  });
});
