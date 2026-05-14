import { describe, it, expect, vi } from 'vitest';
import { evaluateBusinessRules } from '../../src/utils/businessRuleEvaluator.js';
import { makeBusinessRule, makeFactIdToName } from '../helpers/fixtures.js';

vi.mock('@src/utils/logger.js', async () =>
  (await import('../_helpers/loggerMock')).loggerMock(),
);

describe('evaluateBusinessRules', () => {
  it('returns true for empty rules array (vacuous truth)', async () => {
    expect(await evaluateBusinessRules([], {}, new Map())).toBe(true);
  });

  it('returns true for undefined rules (vacuous truth)', async () => {
    expect(await evaluateBusinessRules(undefined, {}, new Map())).toBe(true);
  });

  it('returns true when all rules pass', async () => {
    const rules = [
      makeBusinessRule({ factId: 'f1', operator: 'equals', value: 'gold' }),
      makeBusinessRule({ id: 'r2', factId: 'f2', operator: 'equals', value: 'active' }),
    ];
    const factIdToName = makeFactIdToName(['f1', 'tier'], ['f2', 'status']);
    const factValues = { tier: 'gold', status: 'active' };
    expect(await evaluateBusinessRules(rules, factValues, factIdToName)).toBe(true);
  });

  it('returns false on the first failing rule (short-circuit)', async () => {
    const rules = [
      makeBusinessRule({ factId: 'f1', operator: 'equals', value: 'gold' }),
      makeBusinessRule({ id: 'r2', factId: 'f2', operator: 'equals', value: 'active' }),
    ];
    const factIdToName = makeFactIdToName(['f1', 'tier'], ['f2', 'status']);
    const factValues = { tier: 'gold', status: 'inactive' };
    expect(await evaluateBusinessRules(rules, factValues, factIdToName)).toBe(false);
  });

  describe('operator: equals', () => {
    it('passes when fact value equals comparison value (case-insensitive)', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'equals', value: 'Gold' })];
      const factIdToName = makeFactIdToName(['f1', 'customer-tier']);
      expect(await evaluateBusinessRules(rules, { 'customer-tier': 'gold' }, factIdToName)).toBe(true);
    });

    it('fails when values differ', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'equals', value: 'Gold' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      expect(await evaluateBusinessRules(rules, { tier: 'silver' }, factIdToName)).toBe(false);
    });

    it('fails when fact is not in factValues', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'equals', value: 'gold' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      expect(await evaluateBusinessRules(rules, {}, factIdToName)).toBe(false);
    });
  });

  describe('operator: does not equal', () => {
    it('passes when values differ', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'does not equal', value: 'silver' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      expect(await evaluateBusinessRules(rules, { tier: 'gold' }, factIdToName)).toBe(true);
    });

    it('fails when values are equal', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'does not equal', value: 'gold' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      expect(await evaluateBusinessRules(rules, { tier: 'gold' }, factIdToName)).toBe(false);
    });
  });

  describe('operator: contains', () => {
    it('passes when left value contains right (case-insensitive)', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'contains', value: 'member' })];
      const factIdToName = makeFactIdToName(['f1', 'role']);
      expect(await evaluateBusinessRules(rules, { role: 'Premium Member' }, factIdToName)).toBe(true);
    });

    it('fails when left does not contain right', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'contains', value: 'admin' })];
      const factIdToName = makeFactIdToName(['f1', 'role']);
      expect(await evaluateBusinessRules(rules, { role: 'user' }, factIdToName)).toBe(false);
    });
  });

  describe('operator: does not contain', () => {
    it('passes when left value does not contain right', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'does not contain', value: 'admin' })];
      const factIdToName = makeFactIdToName(['f1', 'role']);
      expect(await evaluateBusinessRules(rules, { role: 'user' }, factIdToName)).toBe(true);
    });
  });

  describe('operator: starts with', () => {
    it('passes when left starts with right', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'starts with', value: 'pre' })];
      const factIdToName = makeFactIdToName(['f1', 'code']);
      expect(await evaluateBusinessRules(rules, { code: 'premium' }, factIdToName)).toBe(true);
    });

    it('fails otherwise', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'starts with', value: 'post' })];
      const factIdToName = makeFactIdToName(['f1', 'code']);
      expect(await evaluateBusinessRules(rules, { code: 'premium' }, factIdToName)).toBe(false);
    });
  });

  describe('operator: ends with', () => {
    it('passes when left ends with right', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'ends with', value: 'ium' })];
      const factIdToName = makeFactIdToName(['f1', 'code']);
      expect(await evaluateBusinessRules(rules, { code: 'premium' }, factIdToName)).toBe(true);
    });
  });

  describe('operator: is empty', () => {
    it('passes when fact is missing from factValues', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'is empty' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      expect(await evaluateBusinessRules(rules, {}, factIdToName)).toBe(true);
    });

    it('passes when fact value is empty string', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'is empty' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      expect(await evaluateBusinessRules(rules, { tier: '' }, factIdToName)).toBe(true);
    });

    it('fails when fact has a non-empty value', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'is empty' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      expect(await evaluateBusinessRules(rules, { tier: 'gold' }, factIdToName)).toBe(false);
    });
  });

  describe('operator: is not empty', () => {
    it('passes when fact has a non-empty value', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'is not empty' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      expect(await evaluateBusinessRules(rules, { tier: 'gold' }, factIdToName)).toBe(true);
    });

    it('fails when fact is missing', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'is not empty' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      expect(await evaluateBusinessRules(rules, {}, factIdToName)).toBe(false);
    });
  });

  describe('numeric operators', () => {
    it('is greater than: passes when left > right', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'is greater than', value: '100' })];
      const factIdToName = makeFactIdToName(['f1', 'order-value']);
      expect(await evaluateBusinessRules(rules, { 'order-value': '150' }, factIdToName)).toBe(true);
    });

    it('is greater than: fails when left <= right', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'is greater than', value: '100' })];
      const factIdToName = makeFactIdToName(['f1', 'order-value']);
      expect(await evaluateBusinessRules(rules, { 'order-value': '100' }, factIdToName)).toBe(false);
    });

    it('is greater than or equal to: passes when equal', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'is greater than or equal to', value: '100' })];
      const factIdToName = makeFactIdToName(['f1', 'order-value']);
      expect(await evaluateBusinessRules(rules, { 'order-value': '100' }, factIdToName)).toBe(true);
    });

    it('is less than: passes correctly', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'is less than', value: '100' })];
      const factIdToName = makeFactIdToName(['f1', 'order-value']);
      expect(await evaluateBusinessRules(rules, { 'order-value': '50' }, factIdToName)).toBe(true);
    });

    it('is less than or equal to: passes correctly', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'is less than or equal to', value: '100' })];
      const factIdToName = makeFactIdToName(['f1', 'order-value']);
      expect(await evaluateBusinessRules(rules, { 'order-value': '100' }, factIdToName)).toBe(true);
    });

    it('returns false when operand cannot be parsed as number', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'is greater than', value: '100' })];
      const factIdToName = makeFactIdToName(['f1', 'order-value']);
      expect(await evaluateBusinessRules(rules, { 'order-value': 'abc' }, factIdToName)).toBe(false);
    });
  });

  describe('compareToFactId', () => {
    it('resolves right-hand side from another fact in factValues', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'equals', compareToFactId: 'f2', value: undefined })];
      const factIdToName = makeFactIdToName(['f1', 'x'], ['f2', 'y']);
      expect(await evaluateBusinessRules(rules, { x: '50', y: '50' }, factIdToName)).toBe(true);
      expect(await evaluateBusinessRules(rules, { x: '50', y: '60' }, factIdToName)).toBe(false);
    });
  });

  describe('lookup tolerance', () => {
    it('resolves fact value when factValues key uses different case', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'equals', value: 'gold' })];
      const factIdToName = makeFactIdToName(['f1', 'customerTier']);
      expect(await evaluateBusinessRules(rules, { CUSTOMERTIER: 'gold' }, factIdToName)).toBe(true);
    });

    it('resolves fact value when factValues key omits hyphens', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'equals', value: 'gold' })];
      const factIdToName = makeFactIdToName(['f1', 'customer-tier']);
      // factValues uses camelCase without hyphen
      expect(await evaluateBusinessRules(rules, { customertier: 'gold' }, factIdToName)).toBe(true);
    });
  });

  describe('OR logic', () => {
    it('returns true when at least one rule passes', async () => {
      const rules = [
        makeBusinessRule({ factId: 'f1', operator: 'equals', value: 'gold' }),
        makeBusinessRule({ id: 'r2', factId: 'f2', operator: 'equals', value: 'active' }),
      ];
      const factIdToName = makeFactIdToName(['f1', 'tier'], ['f2', 'status']);
      // tier is silver (fails) but status is active (passes) → OR should pass
      const factValues = { tier: 'silver', status: 'active' };
      expect(await evaluateBusinessRules(rules, factValues, factIdToName, undefined, 'OR')).toBe(true);
    });

    it('returns false when no rules pass', async () => {
      const rules = [
        makeBusinessRule({ factId: 'f1', operator: 'equals', value: 'gold' }),
        makeBusinessRule({ id: 'r2', factId: 'f2', operator: 'equals', value: 'active' }),
      ];
      const factIdToName = makeFactIdToName(['f1', 'tier'], ['f2', 'status']);
      const factValues = { tier: 'silver', status: 'inactive' };
      expect(await evaluateBusinessRules(rules, factValues, factIdToName, undefined, 'OR')).toBe(false);
    });

    it('returns true for empty rules with OR logic (vacuous truth)', async () => {
      expect(await evaluateBusinessRules([], {}, new Map(), undefined, 'OR')).toBe(true);
    });

    it('short-circuits on first passing rule in OR mode', async () => {
      const rules = [
        makeBusinessRule({ factId: 'f1', operator: 'equals', value: 'gold' }),
        makeBusinessRule({ id: 'r2', factId: 'f2', operator: 'equals', value: 'active' }),
      ];
      const factIdToName = makeFactIdToName(['f1', 'tier'], ['f2', 'status']);
      // First rule passes → should return true without evaluating second
      const factValues = { tier: 'gold', status: 'inactive' };
      expect(await evaluateBusinessRules(rules, factValues, factIdToName, undefined, 'OR')).toBe(true);
    });
  });

  describe('LLM evaluation mode', () => {
    it('calls llmEvaluator callback when evaluationMode is llm and prompt provided', async () => {
      const llmEvaluator = vi.fn().mockResolvedValue(true);
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'equals', evaluationMode: 'llm', llmPrompt: 'Is the tier premium?' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      const result = await evaluateBusinessRules(rules, { tier: 'gold' }, factIdToName, llmEvaluator);
      expect(result).toBe(true);
      expect(llmEvaluator).toHaveBeenCalledOnce();
    });

    it('returns false when llmEvaluator returns false', async () => {
      const llmEvaluator = vi.fn().mockResolvedValue(false);
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'equals', evaluationMode: 'llm', llmPrompt: 'Is the tier premium?' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      expect(await evaluateBusinessRules(rules, { tier: 'gold' }, factIdToName, llmEvaluator)).toBe(false);
    });

    it('falls back to deterministic evaluation when no evaluator provided', async () => {
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'equals', value: 'gold', evaluationMode: 'llm', llmPrompt: 'Is the tier gold?' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      // No llmEvaluator → deterministic: tier === 'gold' → true
      expect(await evaluateBusinessRules(rules, { tier: 'gold' }, factIdToName)).toBe(true);
    });

    it('falls back when llmPrompt is empty', async () => {
      const llmEvaluator = vi.fn().mockResolvedValue(true);
      const rules = [makeBusinessRule({ factId: 'f1', operator: 'equals', value: 'gold', evaluationMode: 'llm', llmPrompt: '' })];
      const factIdToName = makeFactIdToName(['f1', 'tier']);
      // Empty prompt → falls back to deterministic
      expect(await evaluateBusinessRules(rules, { tier: 'gold' }, factIdToName, llmEvaluator)).toBe(true);
      expect(llmEvaluator).not.toHaveBeenCalled();
    });
  });
});
