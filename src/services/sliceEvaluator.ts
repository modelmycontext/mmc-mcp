/**
 * Slice Evaluator — deterministic scenario evaluation for `complete-slice`.
 *
 * Drives the `complete-slice` tool on BOTH execution paths — disk-based
 * (external/production agents) and session-scoped (workbench Test panel) — via
 * `executeSliceQueries` → `evaluateSlice` → `completeSliceFinalize` in
 * `src/server/index.ts`. It takes structured slice data (the same JSON the
 * workbench exports) plus collected facts, runs query/command jobs, evaluates
 * business rules, and returns which scenarios matched and which outcome events
 * should be logged.
 *
 * This is the synchronous, human-driven counterpart to the event-triggered
 * `automatedSliceRunner` (the automation path); the two are intentionally
 * separate execution engines, not one engine with two triggers.
 */

import { logger } from '@src/utils/logger.js';
import { evaluateBusinessRules, type LlmRuleEvaluator } from '@src/utils/businessRuleEvaluator.js';
import type { CommandJob, Fact, Outcome, Query, Scenario, Slice } from '@src/types/outcomeModel.js';
import type { LlmService } from '@src/services/llm.js';
import { resolvePath, resolveTemplate, expandFactTemplate } from '@src/utils/logicUtils.js';
import { toKebabCase } from '@src/utils/stringUtils.js';
import { resolveFormulaValue } from '@src/utils/factValueResolver.js';
import { selectFirstMatch } from '@src/utils/scenarioSelection.js';
import type { ConnectorExecutor } from '@src/connectors/connectorExecutor.js';
import type { ConnectorContext } from '@sdk/connectorTypes.js';

// Canonical outcome-model domain types live in `@src/types/outcomeModel.ts`.
// `Slice` is the domain slice shape (formerly the local `SliceData` here — not
// to be confused with `automatedSliceRunner`'s runtime `SliceData` envelope).

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
 * Build the payload for an outcome event from the outcome's facts and collected
 * values. Keyed by factId on the wire (#77); values are still resolved from the
 * name-keyed collected facts. Falls back to the kebab name only when a legacy
 * fact carries no id.
 */
function buildEventPayload(outcome: Outcome, facts: Record<string, any>, factLookup: Map<string, string>): Record<string, any> {
  const payload: Record<string, any> = {};
  for (const f of outcome.facts ?? []) {
    const key = f.id ?? toKebabCase(f.name);
    if (f.calculatedValue) {
      payload[key] = resolveCalculatedValue(f.calculatedValue, facts);
    } else {
      const factName = factLookup.get(f.id) ?? f.name;
      const val = facts[toKebabCase(factName)] ?? facts[factName] ?? f.defaultValue ?? '';
      payload[key] = val;
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

/**
 * Build a `factId → factName` lookup that covers every fact declared
 * anywhere on the slice — slice-level, query, command, outcome, and
 * scenario-then. Rule and mapping references can target any of these,
 * so the lookup must be union-wide.
 *
 * Pure transformation; no I/O. Shared between `executeSliceQueries`
 * and `evaluateSlice`.
 */
function buildSliceFactLookup(sliceData: Slice): Map<string, string> {
  const factLookup = new Map<string, string>();
  const addFact = (f: Fact | undefined) => { if (f?.id && f?.name) factLookup.set(f.id, f.name); };
  for (const f of sliceData.facts ?? []) addFact(f);
  for (const o of sliceData.outcomes ?? []) for (const f of o.facts ?? []) addFact(f);
  for (const q of sliceData.queries ?? []) for (const f of q.facts ?? []) addFact(f);
  for (const f of sliceData.command?.facts ?? []) addFact(f);
  for (const s of sliceData.scenarios ?? []) {
    for (const t of s.then ?? []) for (const f of t.facts ?? []) addFact(f);
  }
  return factLookup;
}

/**
 * Resolve the dynamic params of a job from `enrichedFacts`.
 *
 * `inputMappings` values can take four forms:
 *   - `"<factId>"` — legacy: map the whole fact value by id
 *   - `"@<factName>"` — story-mode encoding: map the whole fact value by name
 *   - `"@<factName>.<fieldName>"` — story-mode encoding: pluck one field of a
 *      composite fact. Resolved via the kebab `<fact>-<field>` slot that
 *      `spreadObjectFields` populates when the upstream job returns the composite,
 *      with a fallback to plucking the field off the whole-fact object.
 *   - anything else — a Formula-mode expression (constant, `TODAY()`/`NOW()`, or
 *      arithmetic over fact names) authored via the builder's FactCalculationPicker.
 *      Evaluated through `resolveFormulaValue`. Parity with THEN-outcome fact
 *      calculations, which the automatedSliceRunner already resolves the same way.
 */
export function resolveJobParams(
  job: CommandJob,
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

    // Known bare factId (legacy) → resolve its value by name. Otherwise the value
    // is a Formula-mode expression (constant, TODAY()/NOW(), arithmetic, or even an
    // @ref) — evaluate it against the slice's facts. Without this branch, anything
    // that wasn't an @ref or a known factId fell through to '', so Formula-mode
    // job-input mappings authored in the builder silently produced empty params.
    const factName = factLookup.get(raw);
    if (factName) {
      const kebabName = toKebabCase(factName);
      params[param] = enrichedFacts[kebabName] ?? enrichedFacts[factName] ?? '';
    } else {
      params[param] = resolveFormulaValue(raw, enrichedFacts);
    }
  }

  // Expand `{{fact-name}}` placeholders inside staticParams against
  // enrichedFacts so authors can compose templated copy (e.g. email bodies
  // containing `{{enrolment-link-url}}`) without a separate Query Job. The
  // downstream `connectorExecutor.createExecutor` also runs resolveTemplate,
  // but the automated-slice dispatcher invokes it with `input = {}` — the
  // slice's fact pool only exists here.
  //
  // Recurses into object/array values so an object-valued param (e.g.
  // `prefilled: { "<factId>": "{{application-id}}" }`) can be wired from facts.
  // Without this, the only templated params would be top-level strings, and a
  // connector advertising a fact-mappable object param (send-eform-link's
  // `prefilled`) could never actually be fed from the model.
  for (const [k, v] of Object.entries(params)) {
    params[k] = deepResolveTemplate(v, enrichedFacts);
  }

  return params;
}

/** Recursively expand `{{fact}}` templates through nested objects/arrays. Scalars
 *  other than strings pass through; strings without `{{` are returned unchanged. */
function deepResolveTemplate(v: any, enrichedFacts: Record<string, any>): any {
  if (typeof v === 'string') return v.includes('{{') ? resolveTemplate(v, enrichedFacts) : v;
  if (Array.isArray(v)) return v.map((x) => deepResolveTemplate(x, enrichedFacts));
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[k] = deepResolveTemplate(val, enrichedFacts);
    return out;
  }
  return v;
}

/**
 * Run the slice's text-only AI-eval queries for a slice.
 * **Mutates `enrichedFacts`** with the LLM-evaluated values. Tool errors
 * accumulate in `enrichedFacts._tool_errors` for downstream surfacing.
 *
 * Connector-backed query jobs are NOT executed here. They run at slice
 * dispatch time via `runSliceQueryPrefetch` (src/server/mcpHandlers.ts),
 * which presents their results to the agent. The previous duplicate
 * execution path in this function was dead for the current export shape
 * (queries carry `jobLink`, not the resolved `.job` this read expected) and
 * diverged from the single fact-applier (`applyJobResultToFacts`); it was
 * removed so there is exactly one connector-result → fact code path.
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
        const queryFactNames = (query.facts ?? []).map(f => f.name).filter(Boolean);
        const returnedFactArg: string | string[] = queryFactNames.length > 1
          ? queryFactNames
          : queryFactNames[0] ?? query.name ?? '';
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
    // Connector-backed query jobs are intentionally not executed here — see the
    // function doc. They run at dispatch via runSliceQueryPrefetch.
  }
}

/**
 * Execute the slice's command per its mode.
 *   mode="job"         → obsolete (Commands are pure emitters); no-ops with a warning
 *   mode="instruction" → run LLM instruction to compute output facts (transform/logic)
 *   mode="passthrough" → no-op; facts from the triggering event already flow through
 *   (missing mode)     → infer from shape: toolId ⇒ job, instruction/text ⇒ instruction,
 *                        else passthrough. Keeps older models working.
 *
 * **Mutates `enrichedFacts`** in the same way `runSliceQueryJobs` does.
 */
async function runSliceCommand(
  sliceData: Slice,
  enrichedFacts: Record<string, any>,
  factLookup: Map<string, string>,
  connectorExecutor: ConnectorExecutor,
  connectorContext: ConnectorContext,
  llmService: LlmService | undefined,
): Promise<void> {
  const command = sliceData.command;
  if (!command) return;

  const commandJob: CommandJob | undefined = command.job;
  const instructionText: string | undefined = command.instruction ?? command.text;
  const declaredMode: 'job' | 'instruction' | 'passthrough' | undefined = command.mode;
  const effectiveMode: 'job' | 'instruction' | 'passthrough' =
    declaredMode
      ?? (commandJob?.toolId ? 'job'
        : instructionText ? 'instruction'
        : 'passthrough');

  if (effectiveMode === 'job') {
    // Command Jobs on interface slices are obsolete — Commands are now pure
    // outcome emitters (the exporter emits no command jobLink). The previous
    // connector-execution branch here was dead for the current export shape
    // and diverged from the single fact-applier (`applyJobResultToFacts`), so
    // it was removed. A legacy model that still declares mode="job" on a
    // command no-ops here rather than running a second, divergent applier.
    logger.warn(
      { sliceName: sliceData.name },
      '[sliceEvaluator] Command mode="job" is no longer executed (Commands are pure emitters). Re-save the model in the workbench to migrate.',
    );
  } else if (effectiveMode === 'instruction' && instructionText && llmService) {
    // Prefer the explicit `automation.outputFacts` contract written by the
    // workbench; fall back to the old "every fact on the first outcome plus
    // slice-level facts" inference for legacy on-disk models. Once authors
    // re-save in the workbench, the explicit list takes over and the warning
    // disappears.
    const explicit = sliceData.automation?.outputFacts;
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
  sliceData: Slice,
  collectedFacts: Record<string, any>,
  connectorExecutor: ConnectorExecutor,
  connectorContext: ConnectorContext,
  llmService?: LlmService,
  factLookupOverride?: Map<string, string>,
): Promise<Record<string, any>> {
  const enrichedFacts = { ...collectedFacts };
  const queries: Query[] = sliceData.queries ?? [];
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
  sliceData: Slice,
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

  // FIRST-MATCH selection (model-contract.md Decision 3 / #78): scenarios are
  // evaluated in AUTHORED ORDER and the FIRST whose given+when both pass
  // executes — exactly one scenario fires. A no-rule catch-all placed last is
  // the `otherwise` branch. A scenario carrying only legacy free-text rules
  // can't be evaluated deterministically, so it never matches (and flags
  // requiresStructuredRules). Evaluation runs in parallel; selection is by
  // authored index over collected results (see selectFirstMatch), so a fast
  // later scenario never beats a slow earlier one.
  result.requiresStructuredRules = scenarios.some(s =>
    ((s.givenBusinessRules?.length ?? 0) === 0 && !!s.givenBusinessRule) ||
    ((s.whenBusinessRules?.length ?? 0) === 0 && !!s.whenBusinessRule),
  ) || undefined;

  const scenarioMatches = async (scenario: Scenario): Promise<boolean> => {
    const givenRules = scenario.givenBusinessRules ?? [];
    if (givenRules.length > 0) {
      const ok = await evaluateBusinessRules(givenRules, collectedFacts, factLookup, llmEvaluator, scenario.givenBusinessRuleLogic ?? 'AND');
      if (!ok) return false;
    } else if (scenario.givenBusinessRule) {
      return false; // free-text only — not deterministically evaluable
    }
    const whenRules = scenario.whenBusinessRules ?? [];
    if (whenRules.length > 0) {
      return await evaluateBusinessRules(whenRules, collectedFacts, factLookup, llmEvaluator, scenario.whenBusinessRuleLogic ?? 'AND');
    } else if (scenario.whenBusinessRule) {
      return false;
    }
    return true; // no (or all-passing) rules
  };

  const winner = await selectFirstMatch(scenarios, scenarioMatches);

  if (winner) {
    const { scenario, index: i } = winner;
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
      scenarioId: scenario.id ?? `scenario-${i}`,
      scenarioIndex: i,
      events: scenarioEvents,
      error: scenario.error || undefined,
    });
    result.unmatchedScenarios = scenarios.length - 1;
  } else {
    result.unmatchedScenarios = scenarios.length;
  }

  // Silent-stall diagnostic: when no scenario matched, surface which rule
  // factIds resolved to undefined. This is the most common cause of a workflow
  // stalling silently — a prior step didn't populate the fact that a later
  // scenario's condition depends on (e.g. job outputMappings missing,
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
        entry.usedInScenarios.add(scenario.id ?? '');
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
        `[sliceEvaluator] No scenarios matched for ${sliceId} — ${undefinedFacts.size} upstream fact(s) were undefined when rules evaluated. Workflow will stall here with no events. Likely cause: a prior step did not populate these facts (check job outputMappings, fact formula, or whether the LLM generator invented a fact name no upstream step produces). Undefined: ${summary}`
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
