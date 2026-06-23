import { type BusinessRule, type BusinessRuleLogic, UNARY_OPERATORS } from '@src/types/businessRule.js';
import { logger } from '@src/utils/logger.js';

export type LlmRuleEvaluator = (
  rule: BusinessRule,
  factName: string,
  factValue: string,
  /** Full map of fact name → current value, for LLM prompts that reference multiple facts. */
  allFacts: Record<string, any>
) => Promise<boolean>;

/**
 * Evaluates an array of BusinessRule objects against a flat map of fact values.
 *
 * When logic is "AND" (default), all rules must pass — returns false on the first
 * failing rule. When logic is "OR", at least one rule must pass — returns true on
 * the first passing rule.
 *
 * Returns true if rules is empty or undefined (permissive default).
 *
 * Rules with evaluationMode === "llm" are routed to the optional llmEvaluator
 * callback. If no callback is provided, LLM rules fall back to deterministic
 * evaluation (treating llmPrompt as a fixed-value comparison against the fact).
 *
 * @param rules          Structured rules from the outcome model scenario
 * @param factValues     Flat map of factName (kebab-case) → current string value
 * @param factIdToName   Map of factId → factName, built from the outcome model
 * @param llmEvaluator   Optional async callback for LLM-mode rules
 * @param logic          "AND" (all must pass) or "OR" (any must pass), defaults to "AND"
 */
export async function evaluateBusinessRules(
  rules: BusinessRule[] | undefined,
  factValues: Record<string, any>,
  factIdToName: Map<string, string>,
  llmEvaluator?: LlmRuleEvaluator,
  logic: BusinessRuleLogic = 'AND'
): Promise<boolean> {
  if (!rules || rules.length === 0) {
    logger.debug({ ruleCount: 0 }, '[BusinessRuleEvaluator] Empty rules array — vacuous true (scenario will always match)');
    return true;
  }

  const normalizedIndex = buildNormalizedIndex(factValues);
  const isOr = logic === 'OR';

  for (const rule of rules) {
    const t = Date.now();
    const isLlm = rule.evaluationMode === 'llm';
    const mappedName = factIdToName.get(rule.factId);
    const factName = mappedName ?? rule.factId;
    if (mappedName === undefined) {
      logger.warn(
        { factId: rule.factId, operator: rule.operator, compareValue: rule.compareToFactId ?? rule.value },
        `[BusinessRuleEvaluator] Rule references orphan factId "${rule.factId}" — not declared in any slice.facts/outcomes/queries/command/then. Rule will never resolve a value and will evaluate against undefined.`
      );
    }
    const resolvedValue = resolveFactValue(rule.factId, rule.factField, factValues, factIdToName, normalizedIndex);

    const passes = await evaluateSingleRule(rule, factValues, factIdToName, llmEvaluator, normalizedIndex);
    const ms = Date.now() - t;

    logger.debug(
      {
        factId: rule.factId,
        factName,
        factField: rule.factField,
        operator: rule.operator,
        compareValue: rule.compareToFactId ?? rule.value,
        resolvedFactValue: resolvedValue,
        evaluationMode: isLlm ? 'llm' : 'deterministic',
        logic,
        passes,
        ms,
      },
      `[BusinessRuleEvaluator] Rule: "${factName}${rule.factField ? '.' + rule.factField : ''} ${rule.operator} ${rule.compareToFactId ?? rule.value ?? ''}" → ${passes}${isLlm ? ' (LLM)' : ''} [${logic}]`
    );

    if (isLlm) {
      logger.info(
        { factId: rule.factId, factName, resolvedFactValue: resolvedValue, llmPrompt: rule.llmPrompt, passes, ms },
        '[BusinessRuleEvaluator] LLM rule evaluated'
      );
    }

    if (isOr && passes) return true;
    if (!isOr && !passes) return false;
  }
  // AND: all passed → true. OR: none passed → false.
  return !isOr;
}

function resolveFactValue(
  factId: string,
  factField: string | undefined,
  factValues: Record<string, any>,
  factIdToName: Map<string, string>,
  normalizedIndex?: Map<string, any>
): any {
  const name = factIdToName.get(factId);
  let val: any;
  if (name !== undefined) {
    val = lookupValue(name, factValues, normalizedIndex);
  }
  if (val === undefined) {
    val = lookupValue(factId, factValues, normalizedIndex);
  }
  if (val === undefined) return undefined;
  if (factField && val !== null && typeof val === 'object') {
    return drillIntoObject(val, factField);
  }
  return val;
}

function drillIntoObject(obj: any, field: string): any {
  if (!field || obj === null || typeof obj !== 'object') return undefined;
  const parts = field.split('.');
  let cur: any = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (cur[part] !== undefined) { cur = cur[part]; continue; }
    const lower = part.toLowerCase();
    const matchKey = Object.keys(cur).find(k => k.toLowerCase() === lower);
    if (matchKey !== undefined) { cur = cur[matchKey]; continue; }
    // Fallback: strip non-alphanumerics so "Account Status" matches "accountStatus",
    // "account_status", "account-status", etc. Query results frequently come back
    // camelCased while the outcome model stores the human label with spaces.
    const fuzzy = normalizeKey(part);
    const fuzzyMatch = Object.keys(cur).find(k => normalizeKey(k) === fuzzy);
    if (fuzzyMatch === undefined) return undefined;
    cur = cur[fuzzyMatch];
  }
  return cur;
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Builds a normalized lookup index from factValues so that every lookup is O(1).
 * Maps normalized keys (lowercase, no hyphens) → value, with original keys taking priority.
 */
function buildNormalizedIndex(factValues: Record<string, any>): Map<string, any> {
  const index = new Map<string, any>();
  // First pass: normalized keys (lower priority)
  for (const [key, val] of Object.entries(factValues)) {
    const norm = key.toLowerCase().replace(/-/g, '');
    if (!index.has(norm)) index.set(norm, val);
    const lower = key.toLowerCase();
    if (!index.has(lower)) index.set(lower, val);
  }
  // Second pass: exact keys (highest priority — overwrites normalized collisions)
  for (const [key, val] of Object.entries(factValues)) {
    index.set(key, val);
  }
  return index;
}

/**
 * Case-insensitive, hyphen-tolerant value lookup using a pre-built index.
 * Falls back to the raw factValues for exact matches first.
 */
function lookupValue(key: string, factValues: Record<string, any>, normalizedIndex?: Map<string, any>): any {
  if (factValues[key] !== undefined) return factValues[key];
  if (normalizedIndex) {
    const lower = key.toLowerCase();
    const fromLower = normalizedIndex.get(lower);
    if (fromLower !== undefined) return fromLower;
    const noHyphen = lower.replace(/-/g, '');
    return normalizedIndex.get(noHyphen);
  }
  // Fallback without index (shouldn't normally be reached)
  const lower = key.toLowerCase();
  if (factValues[lower] !== undefined) return factValues[lower];
  const noHyphen = lower.replace(/-/g, '');
  if (factValues[noHyphen] !== undefined) return factValues[noHyphen];
  const found = Object.keys(factValues).find(k => k.toLowerCase().replace(/-/g, '') === noHyphen);
  return found !== undefined ? factValues[found] : undefined;
}

async function evaluateSingleRule(
  rule: BusinessRule,
  factValues: Record<string, any>,
  factIdToName: Map<string, string>,
  llmEvaluator?: LlmRuleEvaluator,
  normalizedIndex?: Map<string, any>
): Promise<boolean> {
  const op = rule.operator;

  // LLM evaluation path
  if (rule.evaluationMode === 'llm') {
    const factName = factIdToName.get(rule.factId) ?? rule.factId;
    const rawValue = resolveFactValue(rule.factId, rule.factField, factValues, factIdToName, normalizedIndex);
    const factValue = coerceToString(rawValue);
    const prompt = rule.llmPrompt ?? '';

    if (llmEvaluator && prompt) {
      const tLlm = Date.now();
      logger.info({ factId: rule.factId, factName, factValue, promptPreview: prompt.slice(0, 120) }, '[BusinessRuleEvaluator] Calling LLM evaluator');
      const result = await llmEvaluator(rule, factName, factValue, factValues);
      logger.info({ factId: rule.factId, factName, result, ms: Date.now() - tLlm }, '[BusinessRuleEvaluator] LLM evaluator returned');
      return result;
    }
    // No evaluator or no prompt — fall through to deterministic evaluation
    logger.warn({ factId: rule.factId, hasEvaluator: !!llmEvaluator, hasPrompt: !!prompt }, '[BusinessRuleEvaluator] LLM rule has no evaluator/prompt — falling back to deterministic');
  }

  // Deterministic evaluation
  const leftVal = resolveFactValue(rule.factId, rule.factField, factValues, factIdToName, normalizedIndex);

  if (op === 'is empty') {
    if (leftVal === undefined || leftVal === null || leftVal === '') return true;
    if (typeof leftVal === 'object') {
      return Array.isArray(leftVal) ? leftVal.length === 0 : Object.keys(leftVal).length === 0;
    }
    return false;
  }
  if (op === 'is not empty') {
    if (leftVal === undefined || leftVal === null || leftVal === '') return false;
    if (typeof leftVal === 'object') {
      return Array.isArray(leftVal) ? leftVal.length > 0 : Object.keys(leftVal).length > 0;
    }
    return true;
  }

  if (leftVal === undefined || leftVal === null) return false;

  let rightRaw: any;
  if (rule.compareToFactId) {
    rightRaw = resolveFactValue(rule.compareToFactId, undefined, factValues, factIdToName, normalizedIndex);
  } else {
    rightRaw = rule.value ?? '';
  }

  const left = coerceToString(leftVal).trim();
  const right = coerceToString(rightRaw).trim();

  switch (op) {
    case 'equals':
      return left.toLowerCase() === right.toLowerCase();

    case 'does not equal':
      return left.toLowerCase() !== right.toLowerCase();

    case 'contains':
      return left.toLowerCase().includes(right.toLowerCase());

    case 'does not contain':
      return !left.toLowerCase().includes(right.toLowerCase());

    case 'starts with':
      return left.toLowerCase().startsWith(right.toLowerCase());

    case 'ends with':
      return left.toLowerCase().endsWith(right.toLowerCase());

    case 'is greater than':
    case 'is greater than or equal to':
    case 'is less than':
    case 'is less than or equal to': {
      const lNum = parseFloat(left);
      const rNum = parseFloat(right);
      if (isNaN(lNum) || isNaN(rNum)) return false;
      if (op === 'is greater than') return lNum > rNum;
      if (op === 'is greater than or equal to') return lNum >= rNum;
      if (op === 'is less than') return lNum < rNum;
      if (op === 'is less than or equal to') return lNum <= rNum;
      return false;
    }

    default:
      return false;
  }
}

function coerceToString(val: any): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    try { return JSON.stringify(val); } catch { return String(val); }
  }
  return String(val);
}
