/**
 * Slice Evaluator — deterministic scenario evaluation for complete-slice.
 *
 * This module is used by the test panel's complete-slice tool. It takes
 * structured slice data (the same JSON the workbench exports) plus collected
 * facts, evaluates business rules, and returns which scenarios matched and
 * which outcome events should be logged.
 *
 * Kept separate from the core MCP server so test-panel logic doesn't bleed
 * into the main codebase.
 */

import { logger } from '@src/utils/logger.js';
import { evaluateBusinessRules, type LlmRuleEvaluator } from '@src/utils/businessRuleEvaluator.js';
import type { BusinessRule } from '@src/types/businessRule.js';
import type { LlmService } from '@src/services/llm.js';
import { resolvePath, resolveTemplate, expandFactTemplate } from '@src/utils/logicUtils.js';
import { extractReturnedValue } from '@src/connectors/connectorOutputKeys.js';
import { toKebabCase } from '@src/utils/stringUtils.js';
import type { ConnectorExecutor } from '@src/connectors/connectorExecutor.js';
import type { ConnectorContext } from '@sdk/connectorTypes.js';

/**
 * Spread an object's fields into enrichedFacts under kebab-cased keys so
 * outcome facts named after individual record fields (e.g. `customer-name`
 * when json-read returns `{ name }`) resolve in buildEventPayload.
 *
 * When `prefix` is given, fields are exposed as `<prefix>-<field>` (the
 * common case: `returnedFact.name = "customer"` + record field `name` →
 * `customer-name`). Bare fields are also written so unprefixed outcomes still
 * work. Only fills slots that are currently empty (undefined or blank
 * string) so already-meaningful inputs win. Skips arrays and primitives.
 */
function spreadObjectFields(value: any, enrichedFacts: Record<string, any>, prefix?: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const isEmpty = (v: any) => v === undefined || v === '' || v === null;
  const setIfEmpty = (key: string, v: any) => {
    if (isEmpty(enrichedFacts[key])) enrichedFacts[key] = v;
  };
  const pfx = prefix ? toKebabCase(prefix) : '';
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const bareKey = toKebabCase(k);
    setIfEmpty(bareKey, v);
    if (pfx) setIfEmpty(`${pfx}-${bareKey}`, v);

    // Nested plain object → spread its fields as `<k>-<sub>` so a connector
    // result like `{ customer: { id, name, tier } }` populates facts
    // `customer-id`, `customer-name`, `customer-tier` without requiring a
    // returnedFact to be wired on the job.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, any>)) {
        if (v2 === undefined) continue;
        const bareSub = toKebabCase(k2);
        setIfEmpty(`${bareKey}-${bareSub}`, v2);
        if (pfx) setIfEmpty(`${pfx}-${bareKey}-${bareSub}`, v2);
      }
    }
  }
}

// ─── Types mirroring the workbench's ExternalSliceModel ───

interface Fact {
  id: string;
  name: string;
  valueType: string;
  defaultValue: string;
  calculatedValue?: string;
  isCalculated?: boolean;
  expression?: string;
}

interface Outcome {
  id: string;
  name: string;
  facts: Fact[];
  role: string;
  outcomeStream: string;
}

interface Scenario {
  id: string;
  given: Outcome[];
  givenBusinessRule: string;
  givenBusinessRules: BusinessRule[];
  givenBusinessRuleLogic: 'AND' | 'OR';
  when: any;
  whenBusinessRule: string;
  whenBusinessRules: BusinessRule[];
  whenBusinessRuleLogic: 'AND' | 'OR';
  then: Outcome[];
  error: string;
}

interface SliceData {
  id: string;
  name: string;
  index: number;
  outcomes: Outcome[];
  scenarios: Scenario[];
  facts: Fact[];
  role: string;
  interface?: any;
  automation?: any;
  queries?: any[];
}

export interface EvaluationResult {
  sliceId: string;
  sliceName: string;
  matchedScenarios: {
    scenarioId: string;
    scenarioIndex: number;
    events: { type: string; source: string; payload: Record<string, any> }[];
    error?: string;
  }[];
  unmatchedScenarios: number;
  eventsToLog: { type: string; source: string; payload: Record<string, any> }[];
  /** True when scenarios have free-text rules only — model needs structured BusinessRule[] */
  requiresStructuredRules?: boolean;
}

/**
 * Coerce a value to a number for numeric comparisons.
 * Returns NaN if not convertible.
 */
function toNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = Number(val);
    return isNaN(n) ? NaN : n;
  }
  return NaN;
}

/**
 * Evaluate a single business rule against collected facts.
 */
function evaluateRule(rule: BusinessRule, facts: Record<string, any>, factLookup: Map<string, string>): boolean {
  const factName = factLookup.get(rule.factId) ?? rule.factId;
  const key = rule.factField ? `${factName}.${rule.factField}` : factName;
  // Try kebab-case lookup (facts from LLM come kebab-cased)
  const kebabKey = toKebabCase(key);
  const factValue = facts[kebabKey] ?? facts[key] ?? facts[factName] ?? facts[toKebabCase(factName)];

  logger.info({ factName, kebabKey, factValue, operator: rule.operator, compareValue: rule.value ?? rule.compareToFactId, availableKeys: Object.keys(facts) },
    `[sliceEvaluator] Evaluating rule: ${kebabKey} ${rule.operator} ${rule.value ?? rule.compareToFactId ?? '(unary)'}`);

  // Resolve comparison value
  let compareValue: any;
  if (rule.compareToFactId) {
    const compareName = factLookup.get(rule.compareToFactId) ?? rule.compareToFactId;
    const compareKey = rule.compareToFactField ? `${compareName}.${rule.compareToFactField}` : compareName;
    const kebabCompareKey = toKebabCase(compareKey);
    compareValue = facts[kebabCompareKey] ?? facts[compareKey] ?? facts[compareName] ?? facts[toKebabCase(compareName)];
  } else {
    compareValue = rule.value;
  }

  switch (rule.operator) {
    case 'equals':
      // Try numeric comparison first, fall back to string
      const numA = toNumber(factValue);
      const numB = toNumber(compareValue);
      if (!isNaN(numA) && !isNaN(numB)) return numA === numB;
      return String(factValue ?? '').toLowerCase() === String(compareValue ?? '').toLowerCase();

    case 'does not equal':
      const neA = toNumber(factValue);
      const neB = toNumber(compareValue);
      if (!isNaN(neA) && !isNaN(neB)) return neA !== neB;
      return String(factValue ?? '').toLowerCase() !== String(compareValue ?? '').toLowerCase();

    case 'is greater than':
      return toNumber(factValue) > toNumber(compareValue);

    case 'is greater than or equal to':
      return toNumber(factValue) >= toNumber(compareValue);

    case 'is less than':
      return toNumber(factValue) < toNumber(compareValue);

    case 'is less than or equal to':
      return toNumber(factValue) <= toNumber(compareValue);

    case 'contains':
      return String(factValue ?? '').toLowerCase().includes(String(compareValue ?? '').toLowerCase());

    case 'does not contain':
      return !String(factValue ?? '').toLowerCase().includes(String(compareValue ?? '').toLowerCase());

    case 'starts with':
      return String(factValue ?? '').toLowerCase().startsWith(String(compareValue ?? '').toLowerCase());

    case 'ends with':
      return String(factValue ?? '').toLowerCase().endsWith(String(compareValue ?? '').toLowerCase());

    case 'is empty':
      return factValue === undefined || factValue === null || factValue === '';

    case 'is not empty':
      return factValue !== undefined && factValue !== null && factValue !== '';

    default:
      // The BusinessRuleOperator union is exhaustive, so `rule.operator` is
      // `never` here at type level. The branch stays as a runtime safety net
      // for malformed JSON that might smuggle an unknown operator past the
      // type system — cast to string for logging so pino's overload resolves.
      logger.warn({ operator: rule.operator as string, factName }, `[sliceEvaluator] Unknown operator: ${rule.operator as string}`);
      return false;
  }
}

/**
 * Evaluate a set of business rules with AND/OR logic.
 */
function evaluateRuleSet(
  rules: BusinessRule[] | undefined,
  logic: 'AND' | 'OR',
  facts: Record<string, any>,
  factLookup: Map<string, string>,
): boolean {
  if (!rules || rules.length === 0) return true; // no rules = always true
  if (logic === 'AND') {
    return rules.every(r => evaluateRule(r, facts, factLookup));
  }
  return rules.some(r => evaluateRule(r, facts, factLookup));
}

/**
 * Build the payload for an outcome event from the outcome's facts and collected values.
 */
function buildEventPayload(outcome: Outcome, facts: Record<string, any>, factLookup: Map<string, string>): Record<string, any> {
  const payload: Record<string, any> = {};
  for (const f of outcome.facts ?? []) {
    const kebabName = toKebabCase(f.name);
    if (f.calculatedValue) {
      payload[kebabName] = resolveCalculatedValue(f.calculatedValue, facts);
    } else {
      const factName = factLookup.get(f.id) ?? f.name;
      const val = facts[toKebabCase(factName)] ?? facts[factName] ?? f.defaultValue ?? '';
      payload[kebabName] = val;
    }
  }
  return payload;
}

/**
 * Resolve a fact's `calculatedValue` against the current fact map. Supports:
 *   1. Template syntax: "{{customer.name}}" → looks up the path
 *   2. Bare dot-path:    "customer.tier"    → looks up the path via resolvePath
 *   3. Bare fact name:   "orderAmount"      → returns the fact's value
 *   4. Literal string:   "VIP"              → returns unchanged
 *
 * The LLM story generator often emits bare dot-paths (case 2) for facts
 * like `planType = customer.tier`. Before this, bare dot-paths were stored
 * as their literal string, causing downstream rules to fail silently
 * ("customer.tier" !== "VIP") and stalling the workflow.
 */
function resolveCalculatedValue(formula: string, facts: Record<string, any>): any {
  if (!formula) return '';
  // Template syntax wins when present.
  if (/\{\{.*?\}\}/.test(formula)) {
    return resolveTemplate(formula, facts);
  }
  const trimmed = formula.trim();
  // @-prefixed ref (e.g. "@projectListReport.topProjects"): strip @ and treat as path lookup.
  if (trimmed.startsWith('@')) {
    const refPath = trimmed.slice(1).trim();
    const byPath = resolvePath(facts, refPath);
    if (byPath !== undefined && byPath !== null) return byPath;
    const [first, ...rest] = refPath.split('.');
    const kebabFirst = toKebabCase(first);
    if (kebabFirst !== first) {
      const kebabVal = resolvePath(facts, [kebabFirst, ...rest].join('.'));
      if (kebabVal !== undefined && kebabVal !== null) return kebabVal;
    }
    return trimmed; // unresolved — surface original for debugging
  }
  // Bare identifier or dot-path (no spaces, no operators): treat as path lookup.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(trimmed)) {
    const byPath = resolvePath(facts, trimmed);
    if (byPath !== undefined && byPath !== null) return byPath;
    // Kebab-case fallback for top-level names (e.g. "orderAmount" → "order-amount")
    const kebab = toKebabCase(trimmed);
    if (facts[kebab] !== undefined && facts[kebab] !== null) return facts[kebab];
    // Couldn't resolve — fall through to literal so the user can see the
    // original formula in the event payload rather than an empty string.
    return trimmed;
  }
  // Anything else (arithmetic, literals with spaces) — return the formula as-is.
  return formula;
}

// ─── Query execution types ───

interface Job {
  id: string;
  name: string;
  toolId?: string;
  staticParams?: Record<string, any>;
  dynamicParams?: string[];
  inputMappings?: Record<string, string>;
  returnedFact?: { id: string; name: string };
}

interface Query {
  id: string;
  name: string;
  facts: Fact[];
  outcomes: Outcome[];
  job?: Job;
  /**
   * Natural-language query body for the `ai.eval` path — when present and no
   * `job` is bound, the LLM interprets this against the slice's facts.
   */
  text?: string;
}

/**
 * Build a `factId → factName` lookup that covers every fact declared
 * anywhere on the slice — slice-level, query, command, outcome, and
 * scenario-then. Rule and mapping references can target any of these,
 * so the lookup must be union-wide.
 *
 * Pure transformation; no I/O. Shared between `executeSliceQueries`
 * and `evaluateSlice`.
 */
function buildSliceFactLookup(sliceData: SliceData): Map<string, string> {
  const factLookup = new Map<string, string>();
  const addFact = (f: any) => { if (f?.id && f?.name) factLookup.set(f.id, f.name); };
  for (const f of (sliceData as any).facts ?? []) addFact(f);
  for (const o of (sliceData as any).outcomes ?? []) for (const f of o.facts ?? []) addFact(f);
  for (const q of (sliceData as any).queries ?? []) for (const f of q.facts ?? []) addFact(f);
  for (const f of (sliceData as any).command?.facts ?? []) addFact(f);
  for (const s of (sliceData as any).scenarios ?? []) {
    for (const t of s.then ?? []) for (const f of t.facts ?? []) addFact(f);
  }
  return factLookup;
}

/**
 * Resolve the dynamic params of a job from `enrichedFacts`.
 *
 * `inputMappings` values can take three forms:
 *   - `"<factId>"` — legacy: map the whole fact value by id
 *   - `"@<factName>"` — story-mode encoding: map the whole fact value by name
 *   - `"@<factName>.<fieldName>"` — story-mode encoding: pluck one field of a
 *      composite fact. Resolved via the kebab `<fact>-<field>` slot that
 *      `spreadObjectFields` populates when the upstream job returns the composite,
 *      with a fallback to plucking the field off the whole-fact object.
 */
export function resolveJobParams(
  job: Job,
  factLookup: Map<string, string>,
  enrichedFacts: Record<string, any>,
): Record<string, any> {
  const params: Record<string, any> = { ...(job.staticParams ?? {}) };
  if (!job.inputMappings) return params;

  for (const [param, raw] of Object.entries(job.inputMappings)) {
    if (typeof raw !== 'string' || raw === '') {
      params[param] = '';
      continue;
    }

    if (raw.startsWith('@')) {
      const dotAt = raw.indexOf('.', 1);
      const factName = dotAt >= 0 ? raw.slice(1, dotAt) : raw.slice(1);
      const fieldName = dotAt >= 0 ? raw.slice(dotAt + 1) : undefined;
      const kebabName = toKebabCase(factName);

      if (fieldName) {
        const kebabField = toKebabCase(fieldName);
        const composite = enrichedFacts[kebabName] ?? enrichedFacts[factName];
        const pluck = composite && typeof composite === 'object' && !Array.isArray(composite)
          ? (composite[fieldName] ?? composite[kebabField])
          : undefined;
        params[param] = enrichedFacts[`${kebabName}-${kebabField}`] ?? pluck ?? '';
      } else {
        params[param] = enrichedFacts[kebabName] ?? enrichedFacts[factName] ?? '';
      }
      continue;
    }

    // Legacy bare-factId form.
    const factName = factLookup.get(raw) ?? raw;
    const kebabName = toKebabCase(factName);
    params[param] = enrichedFacts[kebabName] ?? enrichedFacts[factName] ?? '';
  }

  return params;
}

/**
 * Run all query jobs (and text-only AI-eval queries) for a slice.
 * **Mutates `enrichedFacts`** with extracted return values and
 * spread object fields. Tool errors accumulate in
 * `enrichedFacts._tool_errors` for downstream surfacing.
 */
async function runSliceQueryJobs(
  queries: Query[],
  enrichedFacts: Record<string, any>,
  factLookup: Map<string, string>,
  connectorExecutor: ConnectorExecutor,
  connectorContext: ConnectorContext,
  llmService: LlmService | undefined,
): Promise<void> {
  for (const query of queries) {
    // Text-only query: ai.eval path
    if (!query.job?.toolId && query.text && llmService) {
      try {
        const queryFactNames = (query.facts ?? []).map((f: any) => f.name).filter(Boolean) as string[];
        const returnedFactArg: string | string[] = queryFactNames.length > 1
          ? queryFactNames
          : queryFactNames[0] ?? query.name;
        const expandedText = expandFactTemplate(query.text, enrichedFacts, `query "${query.name}"`);
        const result = await llmService.evaluateInstruction(expandedText, enrichedFacts, returnedFactArg);
        for (const [k, v] of Object.entries(result)) {
          if (v !== undefined && v !== null) enrichedFacts[toKebabCase(k)] = v;
        }
        logger.info({ queryName: query.name, text: (query.text as string).slice(0, 80) }, '[sliceEvaluator] Text instruction evaluated via LLM');
      } catch (err: any) {
        logger.warn({ queryName: query.name, error: err.message }, '[sliceEvaluator] Text instruction failed — continuing');
      }
      continue;
    }
    if (!query.job?.toolId) continue;

    const job = query.job;
    // Narrowed by the guard above — `job.toolId` is necessarily a string here.
    const toolId: string = job.toolId!;
    const params = resolveJobParams(job, factLookup, enrichedFacts);

    try {
      const executor = connectorExecutor.createExecutor(toolId, params);
      const result = await executor(connectorContext, enrichedFacts);

      if (job.returnedFact) {
        // Store the extracted (un-enveloped) value under the returnedFact name.
        // Avoids the envelope bloat from connectorExecutor's {...input, ...result} merge.
        const returnKey = toKebabCase(job.returnedFact.name);
        const extracted = extractReturnedValue(
          result,
          job.returnedFact.name,
          toolId,
          ({ returnedFactName, resultKeys }) => {
            enrichedFacts._tool_errors = [
              ...(Array.isArray(enrichedFacts._tool_errors) ? enrichedFacts._tool_errors : []),
              {
                tool: toolId,
                phase: 'query',
                reason: 'returned-fact-not-found',
                message: `returnedFact "${returnedFactName}" not found in tool result (keys: ${resultKeys.join(', ')}); whole result stored under that name`,
              },
            ];
          },
        );
        if (extracted !== undefined) {
          enrichedFacts[returnKey] = extracted;
          spreadObjectFields(extracted, enrichedFacts, job.returnedFact.name);
          logger.info({ toolId, returnKey, spreadKeys: extracted && typeof extracted === 'object' ? Object.keys(extracted) : [] }, '[sliceEvaluator] Query result stored (extracted + spread)');
        }
      } else {
        // No returnedFact declared — we do NOT auto-spread arbitrary connector
        // output into facts because different tools have very different return
        // shapes and silent merges can clobber unrelated facts. We only log
        // this as a warning; surfacing it as a published tool-error would
        // flag terminal steps (where no mapping is actually needed) as
        // failures. If a downstream scenario depends on a fact that's missing
        // because of this, the "No scenarios matched — undefined facts"
        // diagnostic will point at it anyway.
        const returnedKeys = result && typeof result === 'object' && !Array.isArray(result)
          ? Object.keys(result)
          : [typeof result];
        logger.warn({ toolId, returnedKeys }, '[sliceEvaluator] Query tool result not spread — no returnedFact mapping (advisory; only matters if a downstream step needs these facts)');
      }
    } catch (err: any) {
      enrichedFacts._tool_errors = [
        ...(Array.isArray(enrichedFacts._tool_errors) ? enrichedFacts._tool_errors : []),
        { tool: toolId, reason: 'execution-failed', message: err.message },
      ];
      logger.warn({ toolId, error: err.message }, '[sliceEvaluator] Query job failed — continuing with available facts');
    }
  }
}

/**
 * Execute the slice's command per its mode.
 *   mode="job"         → run connector tool (AI-builder automation steps)
 *   mode="instruction" → run LLM instruction to compute output facts (transform/logic)
 *   mode="passthrough" → no-op; facts from the triggering event already flow through
 *   (missing mode)     → infer from shape: toolId ⇒ job, instruction/text ⇒ instruction,
 *                        else passthrough. Keeps older models working.
 *
 * **Mutates `enrichedFacts`** in the same way `runSliceQueryJobs` does.
 */
async function runSliceCommand(
  sliceData: SliceData,
  enrichedFacts: Record<string, any>,
  factLookup: Map<string, string>,
  connectorExecutor: ConnectorExecutor,
  connectorContext: ConnectorContext,
  llmService: LlmService | undefined,
): Promise<void> {
  const command: any = (sliceData as any).command;
  if (!command) return;

  const commandJob: Job | undefined = command.job;
  const instructionText: string | undefined = command.instruction ?? command.text;
  const declaredMode: 'job' | 'instruction' | 'passthrough' | undefined = command.mode;
  const effectiveMode: 'job' | 'instruction' | 'passthrough' =
    declaredMode
      ?? (commandJob?.toolId ? 'job'
        : instructionText ? 'instruction'
        : 'passthrough');

  if (effectiveMode === 'job' && commandJob?.toolId) {
    const params = resolveJobParams(commandJob, factLookup, enrichedFacts);
    try {
      const executor = connectorExecutor.createExecutor(commandJob.toolId, params);
      const result = await executor(connectorContext, enrichedFacts);
      if (commandJob.returnedFact) {
        const returnKey = toKebabCase(commandJob.returnedFact.name);
        const extracted = extractReturnedValue(
          result,
          commandJob.returnedFact.name,
          commandJob.toolId,
          ({ returnedFactName, resultKeys }) => {
            enrichedFacts._tool_errors = [
              ...(Array.isArray(enrichedFacts._tool_errors) ? enrichedFacts._tool_errors : []),
              {
                tool: commandJob.toolId,
                phase: 'command',
                reason: 'returned-fact-not-found',
                message: `returnedFact "${returnedFactName}" not found in tool result (keys: ${resultKeys.join(', ')}); whole result stored under that name`,
              },
            ];
          },
        );
        if (extracted !== undefined) {
          enrichedFacts[returnKey] = extracted;
          spreadObjectFields(extracted, enrichedFacts, commandJob.returnedFact.name);
          logger.info({ toolId: commandJob.toolId, returnKey, spreadKeys: extracted && typeof extracted === 'object' ? Object.keys(extracted) : [] }, '[sliceEvaluator] Command job result stored (extracted + spread)');
        }
      } else {
        // No returnedFact declared — do not auto-spread (see query path for
        // rationale). Log-only; terminal steps don't need a mapping, so we
        // don't publish a tool-error here.
        const returnedKeys = result && typeof result === 'object' && !Array.isArray(result)
          ? Object.keys(result)
          : [typeof result];
        logger.warn({ toolId: commandJob.toolId, returnedKeys }, '[sliceEvaluator] Command tool result not spread — no returnedFact mapping (advisory; only matters if a downstream step needs these facts)');
      }
    } catch (err: any) {
      enrichedFacts._tool_errors = [
        ...(Array.isArray(enrichedFacts._tool_errors) ? enrichedFacts._tool_errors : []),
        { tool: commandJob.toolId, reason: 'execution-failed', message: err.message },
      ];
      logger.warn({ toolId: commandJob.toolId, error: err.message }, '[sliceEvaluator] Command job failed — continuing with available facts');
    }
  } else if (effectiveMode === 'instruction' && instructionText && llmService) {
    // Prefer the explicit `automation.outputFacts` contract written by the
    // workbench; fall back to the old "every fact on the first outcome plus
    // slice-level facts" inference for legacy on-disk models. Once authors
    // re-save in the workbench, the explicit list takes over and the warning
    // disappears.
    const explicit = (sliceData as any).automation?.outputFacts as Array<{ name?: string }> | undefined;
    const explicitNames = Array.isArray(explicit)
      ? explicit.map(f => f?.name).filter((n): n is string => !!n)
      : [];
    const uniqueOutputFacts = Array.from(new Set(
      explicitNames.length > 0
        ? explicitNames
        : [
            ...((sliceData.outcomes?.[0]?.facts ?? []).map(f => f.name).filter(Boolean) as string[]),
            ...((sliceData.facts ?? []).map(f => f.name).filter(Boolean) as string[]),
          ]
    ));
    if (explicitNames.length === 0 && uniqueOutputFacts.length > 0) {
      logger.warn(
        { sliceName: sliceData.name, fallback: uniqueOutputFacts },
        '[sliceEvaluator] slice.automation.outputFacts absent — using legacy outcome/slice inference. Re-save the model in the workbench to migrate.',
      );
    }
    try {
      const expandedInstruction = expandFactTemplate(instructionText, enrichedFacts, 'command instruction');
      const result = await llmService.evaluateInstruction(
        expandedInstruction,
        enrichedFacts,
        uniqueOutputFacts.length > 1 ? uniqueOutputFacts : uniqueOutputFacts[0],
      );
      for (const [k, v] of Object.entries(result ?? {})) {
        if (v !== undefined && v !== null) enrichedFacts[toKebabCase(k)] = v;
      }
      logger.info({ instruction: instructionText.slice(0, 80), resultKeys: Object.keys(result ?? {}) }, '[sliceEvaluator] Command instruction evaluated via LLM');
    } catch (err: any) {
      logger.warn({ instruction: instructionText.slice(0, 80), error: err.message }, '[sliceEvaluator] Command instruction failed — continuing with available facts');
    }
  } else if (effectiveMode === 'passthrough') {
    logger.info({ sliceName: sliceData.name }, '[sliceEvaluator] Command passthrough — no command execution');
  }
}

/**
 * Execute query jobs and the slice's command, in order, against the
 * collected facts. Returns an enriched fact map ready for scenario
 * evaluation by {@link evaluateSlice}.
 *
 * Decomposes into three private helpers above:
 *   - {@link buildSliceFactLookup} — factId → factName lookup
 *   - {@link runSliceQueryJobs}    — query-side enrichment (mutates facts)
 *   - {@link runSliceCommand}      — command-side enrichment (mutates facts)
 */
export async function executeSliceQueries(
  sliceData: SliceData,
  collectedFacts: Record<string, any>,
  connectorExecutor: ConnectorExecutor,
  connectorContext: ConnectorContext,
  llmService?: LlmService,
  factLookupOverride?: Map<string, string>,
): Promise<Record<string, any>> {
  const enrichedFacts = { ...collectedFacts };
  const queries: Query[] = (sliceData as any).queries ?? [];
  const factLookup = factLookupOverride ?? buildSliceFactLookup(sliceData);

  await runSliceQueryJobs(queries, enrichedFacts, factLookup, connectorExecutor, connectorContext, llmService);
  await runSliceCommand(sliceData, enrichedFacts, factLookup, connectorExecutor, connectorContext, llmService);

  return enrichedFacts;
}

/**
 * Evaluate all scenarios in a slice against collected facts.
 * Returns which scenarios matched and the events to log.
 */
export async function evaluateSlice(
  sliceData: SliceData,
  collectedFacts: Record<string, any>,
  llmEvaluator?: LlmRuleEvaluator,
  factLookupOverride?: Map<string, string>,
): Promise<EvaluationResult> {
  const sliceId = toKebabCase(sliceData.name);

  // Caller-supplied lookup wins. When absent we fall back to the per-slice
  // synthesis (own facts only) — but production callers should supply a
  // scoped map (own ∪ given-events) per Event Modeling rules.
  const factLookup = factLookupOverride ?? buildSliceFactLookup(sliceData);

  const scenarios = sliceData.scenarios ?? [];

  logger.info({ sliceId, collectedFacts, factNames: [...factLookup.values()] },
    `[sliceEvaluator] Starting evaluation for ${sliceId}`);

  const result: EvaluationResult = {
    sliceId,
    sliceName: sliceData.name,
    matchedScenarios: [],
    unmatchedScenarios: 0,
    eventsToLog: [],
  };

  if (scenarios.length === 0) {
    // No scenarios = unconditional outcomes
    for (const outcome of sliceData.outcomes ?? []) {
      const event = {
        type: toKebabCase(outcome.name),
        source: sliceId,
        payload: buildEventPayload(outcome, collectedFacts, factLookup),
      };
      result.eventsToLog.push(event);
    }
    result.matchedScenarios.push({
      scenarioId: 'unconditional',
      scenarioIndex: 0,
      events: result.eventsToLog,
    });
    return result;
  }

  // A "default case" scenario has no rules at all (empty given + empty when,
  // and no free-text rules) — it always matches and would fire on every trigger
  // unless deferred. We evaluate non-default scenarios first; defaults only
  // fire when no other scenario matched. This matches common rule-system
  // semantics (switch-case / else) and prevents the LLM-generated catch-all
  // from publishing a premature "0" payload on the upstream trigger before the
  // data-producing scenarios (e.g. tier=Member) have had a chance to evaluate.
  const isDefaultScenario = (s: Scenario): boolean => {
    const hasGivenRules = (s.givenBusinessRules?.length ?? 0) > 0;
    const hasGivenText = !!s.givenBusinessRule;
    const hasWhenRules = (s.whenBusinessRules?.length ?? 0) > 0;
    const hasWhenText = !!s.whenBusinessRule;
    return !hasGivenRules && !hasGivenText && !hasWhenRules && !hasWhenText;
  };
  const nonDefaultIndices = scenarios.map((s, i) => [s, i] as const).filter(([s]) => !isDefaultScenario(s));
  const defaultIndices = scenarios.map((s, i) => [s, i] as const).filter(([s]) => isDefaultScenario(s));
  const orderedScenarioEntries = [...nonDefaultIndices, ...defaultIndices];

  // Evaluate each scenario independently (multi-scenario: more than one can match)
  for (const [scenario, i] of orderedScenarioEntries) {
    // Skip defaults if any non-default already matched.
    if (isDefaultScenario(scenario) && result.matchedScenarios.length > 0) {
      logger.info(
        { sliceId, scenarioId: scenario.id, scenarioIndex: i },
        '[sliceEvaluator] Skipping default scenario — a specific scenario already matched'
      );
      continue;
    }

    // Evaluate "given" rules
    const givenRules = scenario.givenBusinessRules ?? [];
    const givenLogic = scenario.givenBusinessRuleLogic ?? 'AND';
    let givenMatch: boolean;
    if (givenRules.length > 0) {
      givenMatch = await evaluateBusinessRules(givenRules, collectedFacts, factLookup, llmEvaluator, givenLogic);
    } else if (scenario.givenBusinessRule) {
      // Free-text only — cannot evaluate deterministically
      result.requiresStructuredRules = true;
      logger.warn({ scenarioId: scenario.id, givenText: scenario.givenBusinessRule },
        '[sliceEvaluator] Scenario has free-text givenBusinessRule — cannot evaluate deterministically');
      result.unmatchedScenarios++;
      continue;
    } else {
      givenMatch = true; // no given = always true
    }

    // Evaluate "when" rules
    const whenRules = scenario.whenBusinessRules ?? [];
    const whenLogic = scenario.whenBusinessRuleLogic ?? 'AND';
    let whenMatch: boolean;
    if (whenRules.length > 0) {
      whenMatch = await evaluateBusinessRules(whenRules, collectedFacts, factLookup, llmEvaluator, whenLogic);
    } else if (scenario.whenBusinessRule) {
      // Free-text only — cannot evaluate deterministically
      result.requiresStructuredRules = true;
      logger.warn({ scenarioId: scenario.id, whenText: scenario.whenBusinessRule },
        '[sliceEvaluator] Scenario has free-text whenBusinessRule — cannot evaluate deterministically');
      result.unmatchedScenarios++;
      continue;
    } else {
      whenMatch = true;
    }

    if (givenMatch && whenMatch) {
      const scenarioEvents: { type: string; source: string; payload: Record<string, any> }[] = [];
      const thenOutcomes = scenario.then ?? [];
      if (thenOutcomes.length === 0) {
        logger.warn(
          { sliceId, scenarioId: scenario.id, scenarioIndex: i },
          `[sliceEvaluator] Scenario matched but has empty then[] — no outcome events will fire, workflow will stall here. Add at least one outcome event to the scenario in the builder.`
        );
        // Emit a slice-misconfigured event so the workbench surfaces the
        // silent stall instead of leaving the operator wondering why no
        // event arrived. Mirrors the same diagnostic in the automated path.
        result.eventsToLog.push({
          type: 'slice-misconfigured',
          source: sliceId,
          payload: {
            sliceName: sliceData.name,
            reason: 'empty-then-on-matched-scenario',
            scenarioIds: [scenario.id ?? `scenario-${i}`],
            hint: 'Scenario matched but has no outcome events declared. Add at least one outcome event to the scenario in the builder.',
          },
        });
      }
      for (const outcome of thenOutcomes) {
        const event = {
          type: toKebabCase(outcome.name),
          source: sliceId,
          payload: buildEventPayload(outcome, collectedFacts, factLookup),
        };
        scenarioEvents.push(event);
        result.eventsToLog.push(event);
      }
      result.matchedScenarios.push({
        scenarioId: scenario.id,
        scenarioIndex: i,
        events: scenarioEvents,
        error: scenario.error || undefined,
      });
    } else {
      result.unmatchedScenarios++;
    }
  }

  // Silent-stall diagnostic: when no scenario matched, surface which rule
  // factIds resolved to undefined. This is the most common cause of a workflow
  // stalling silently — a prior step didn't populate the fact that a later
  // scenario's condition depends on (e.g. job returnedFact mapping missing,
  // formula didn't resolve, or the LLM generator invented a fact name that no
  // upstream step produces). Without this log, the evaluator reports
  // "matched: 0" with no clue why.
  if (result.matchedScenarios.length === 0 && scenarios.length > 0) {
    const undefinedFacts = new Map<string, { factId: string; factField?: string; operator: string; usedInScenarios: Set<string> }>();
    for (const scenario of scenarios) {
      const allRules = [
        ...(scenario.givenBusinessRules ?? []),
        ...(scenario.whenBusinessRules ?? []),
      ];
      for (const rule of allRules) {
        const factName = factLookup.get(rule.factId);
        if (!factName) continue; // orphan factId already warned by businessRuleEvaluator
        const kebab = toKebabCase(factName);
        const val = collectedFacts[kebab] ?? collectedFacts[factName];
        const isEmpty = val === undefined || val === null || val === '';
        if (!isEmpty) continue;
        const key = `${factName}${rule.factField ? '.' + rule.factField : ''}`;
        let entry = undefinedFacts.get(key);
        if (!entry) {
          entry = { factId: rule.factId, factField: rule.factField, operator: rule.operator, usedInScenarios: new Set() };
          undefinedFacts.set(key, entry);
        }
        entry.usedInScenarios.add(scenario.id);
      }
    }
    if (undefinedFacts.size > 0) {
      const summary = [...undefinedFacts.entries()].map(([name, e]) =>
        `"${name}" (factId=${e.factId}, used in ${e.usedInScenarios.size} scenario(s))`
      ).join('; ');
      logger.warn(
        {
          sliceId,
          undefinedFacts: Object.fromEntries(
            [...undefinedFacts.entries()].map(([k, v]) => [k, { factId: v.factId, factField: v.factField, usedInScenarios: [...v.usedInScenarios] }])
          ),
          collectedFactKeys: Object.keys(collectedFacts),
        },
        `[sliceEvaluator] No scenarios matched for ${sliceId} — ${undefinedFacts.size} upstream fact(s) were undefined when rules evaluated. Workflow will stall here with no events. Likely cause: a prior step did not populate these facts (check job returnedFact mapping, fact formula, or whether the LLM generator invented a fact name no upstream step produces). Undefined: ${summary}`
      );
    }
  }

  logger.info({
    sliceId,
    totalScenarios: scenarios.length,
    matched: result.matchedScenarios.length,
    unmatched: result.unmatchedScenarios,
    eventsToLog: result.eventsToLog.length,
  }, `[sliceEvaluator] Evaluation complete for ${sliceId}`);

  return result;
}
