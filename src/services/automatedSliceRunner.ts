import path from 'path';
import { logger } from '@src/utils/logger.js';
import { EventBus, type Event } from '@src/events/eventBus.js';
import type { EventStore } from '@src/events/eventStoreTypes.js';
import { LlmService } from '@src/services/llm.js';
import { evaluateBusinessRules, type LlmRuleEvaluator } from '@src/utils/businessRuleEvaluator.js';
import type { BusinessRule } from '@src/types/businessRule.js';
import { flattenPayload, resolveFormulaValue } from '@src/utils/factValueResolver.js';
import { toKebabCase } from '@src/utils/stringUtils.js';
import {
  loadSliceFromMdPath,
  extractEligibleScenarios,
  extractSliceAutomationJob,
  extractSliceAutomationInstruction,
  extractSliceOutcomes,
  extractSliceQueries,
  buildScopedFactIdToName,
  type AutomationJob,
  type EligibleScenario,
  type FactSchemaEntry,
} from '@src/skill-engine/interaction-slice-trigger-events.js';
import { resolveJobParams } from '@src/services/sliceEvaluator.js';
import type { Slice, Outcome } from '@src/types/outcomeModel.js';
import { expandFactTemplate } from '@src/utils/logicUtils.js';
import { selectFirstMatch } from '@src/utils/scenarioSelection.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  PATH UNIFICATION — READ BEFORE EDITING                              │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  `createAutomatedSliceHandler` runs for BOTH:                        │
 * │    • production disk-based slices    (build SliceData via            │
 * │                                       `resolveDiskSliceData`)        │
 * │    • workbench test sessions         (build SliceData via            │
 * │                                       `resolveInlineSliceData`)      │
 * │                                                                      │
 * │  The handler consumes plain `SliceData` and is path-agnostic.        │
 * │  Everything inside the handler is shared — diagnostics, LLM          │
 * │  evaluator construction, business-rule evaluation, outcome           │
 * │  publishing.                                                         │
 * │                                                                      │
 * │  If you need path-specific behaviour, do it in the dispatcher        │
 * │  (`src/server/index.ts`) before resolving SliceData. Do NOT branch   │
 * │  on source type inside the handler — that re-introduces the          │
 * │  divergence we removed.                                              │
 * │                                                                      │
 * │  Routing policy (which resolver to call for which event) lives in    │
 * │  `src/server/index.ts` inside the `eventBus.subscribe('*', ...)`     │
 * │  call. See the comment block there for the rules around              │
 * │  test-session isolation, persistence, and todo creation.             │
 * └─────────────────────────────────────────────────────────────────────┘
 */
export interface SliceData {
  /** Logging context — `workflow/slice` for disk, raw slice name for inline. */
  sliceName: string;
  /** Set only for the disk path; logged for traceability. */
  skillMdPath?: string;
  /** The canonical slice (one entry from `model.slices`) — see
   *  `@src/types/outcomeModel.ts` (#72). Disk and inline loaders both
   *  produce this one type; there is no separate loading projection. */
  slice: Slice;
  /** factId → factName lookup the handler passes to rule evaluation. */
  factIdToName: Map<string, string>;
}

/**
 * Loads a slice from disk by walking the activity directory containing
 * `skillMdPath`. Returns null when no model contains a slice with the
 * matching directory name (caller should log and skip).
 */
export async function resolveDiskSliceData(skillMdPath: string): Promise<SliceData | null> {
  const loaded = await loadSliceFromMdPath(skillMdPath);
  if (!loaded) return null;
  const dirName  = path.basename(path.dirname(skillMdPath));
  const workflow = path.basename(path.dirname(path.dirname(skillMdPath)));
  return {
    sliceName: `${workflow}/${dirName}`,
    skillMdPath,
    slice: loaded.slice,
    factIdToName: loaded.factIdToName,
  };
}

/**
 * Builds SliceData from in-memory slice JSON (workbench `register-skills`
 * path). When an `eventSchemaIndex` is provided, the resulting
 * `factIdToName` is the slice's contractually-scoped map: own facts ∪
 * facts on outcome events listed in `scenario.given[]`. Without the index
 * it falls back to slice-only synthesis (no given-events context
 * available — used by direct unit tests).
 */
export function resolveInlineSliceData(
  sliceData: Slice | null | undefined,
  sliceName: string,
  eventSchemaIndex?: Map<string, FactSchemaEntry[]>,
): SliceData {
  // Session trust boundary: workbench-pushed sliceData is cast to the
  // canonical Slice here (mirrors the disk chokepoint in readModel). A
  // missing sliceData degrades to an empty slice carrying only the name.
  const slice: Slice = sliceData ?? ({ name: sliceName } as Slice);
  const factIdToName = eventSchemaIndex
    ? buildScopedFactIdToName(slice, eventSchemaIndex)
    : buildScopedFactIdToName(slice, new Map());
  return { sliceName, slice, factIdToName };
}

/**
 * Translate a factId-keyed event/session pool into a NAME-keyed working set
 * scoped to the consumer slice's contract (#77). `_`-prefixed diagnostic
 * sidecars (e.g. `_tool_errors`) are internal state, not facts, and pass
 * through so stall reporting survives across slices.
 *
 * `factIdToName` IS the contract: only facts the slice declared (own ∪
 * given-event facts) appear in the output, which is what stops cross-slice
 * leakage. factId is the canonical wire key; the bare-name fallback admits
 * external-webhook / log-event-to-bus payloads that arrive name-keyed.
 */
export function ingestScopedFacts(
  pool: Record<string, any>,
  factIdToName: Map<string, string>,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(pool)) {
    if (k.startsWith('_')) out[k] = pool[k];
  }
  // #77: event payloads are keyed by factId on the wire. This is the single
  // translation point — produce a NAME-keyed working set scoped to the slice's
  // contract, so every downstream consumer (rules, job params, formulas, LLM)
  // keeps working name-based and unchanged. factId is the canonical key;
  // the bare-name fallback covers external-webhook / log-event-to-bus payloads
  // that still arrive name-keyed (the documented Translation boundary).
  for (const [factId, name] of factIdToName) {
    const v = pool[factId] !== undefined ? pool[factId] : pool[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * Apply a tool/connector job result to the in-slice fact pool.
 *
 * `outputMappings` (`toolOutputField → {factName, fieldName?}`) is the sole
 * extraction path: each declared field is pulled from the result and stored
 * under its mapped fact name (or, when `fieldName` is set, into that
 * sub-field of a composite fact's value) — explicit, deterministic,
 * one-to-one. A declared field that is absent from the result is a FATAL
 * mapping error: the slice's output contract claims a field the tool does not
 * return, so the slice fails rather than emit an outcome built on a missing
 * value. The error names the offending field and the keys the tool actually
 * returned, so the author can fix or remove the bad mapping — the job-link
 * editor surfaces such mappings (keys that aren't declared returned-fact
 * fields, e.g. a stale `record` left over from the old connector-outputParam
 * dialog) as removable "stale" rows. A connector that fails outright is caught
 * earlier by the `{ ok: false }` envelope branch above.
 *
 * A job with no `outputMappings` declares no output facts — there is nothing
 * to extract.
 */
export function applyJobResultToFacts(
  jobResult: any,
  job: AutomationJob,
  allFactValues: Record<string, any>,
  recordToolError: (e: { tool: string; phase: string; name: string; error: string; rawResponse?: unknown; fatal?: boolean }) => void,
  phase: 'query' | 'automation',
  sliceName: string,
): void {
  // Capture the raw tool response so the workbench test panel can show what the
  // tool ACTUALLY returned underneath any error.
  const rawResponse = jobResult

  // GENUINE FAILURE — a `{ ok: false, error }` envelope (Slack Web API
  // convention) means the call failed and produced no outputs. This is the ONLY
  // path that records a fatal tool error (→ slice-tool-failed, scenarios
  // skipped).
  if (jobResult && typeof jobResult === 'object' && jobResult.ok === false) {
    const connectorError =
      typeof jobResult.error === 'string' && jobResult.error.trim()
        ? jobResult.error
        : 'connector reported failure (ok: false)';
    recordToolError({
      tool: job.toolId,
      phase,
      name: job.name,
      error: `${job.toolId} failed: ${connectorError}`,
      rawResponse,
      fatal: true,
    });
    return;
  }

  const explicit = Object.entries(job.resolvedOutputMappings);
  if (explicit.length === 0) return;

  const isObj = jobResult && typeof jobResult === 'object';
  for (const [outputField, mapping] of explicit) {
    if (isObj && outputField in jobResult) {
      const v = jobResult[outputField];
      if (v === undefined) continue;
      if (mapping.fieldName) {
        allFactValues[mapping.factName] = { ...(allFactValues[mapping.factName] ?? {}), [mapping.fieldName]: v };
      } else {
        allFactValues[mapping.factName] = v;
      }
    } else {
      const keys = isObj ? Object.keys(jobResult).join(', ') : '(non-object result)';
      recordToolError({
        tool: job.toolId,
        phase,
        name: job.name,
        error: `invalid output mapping: field "${outputField}" (→ fact "${mapping.factName}") is not returned by ${job.toolId} — it returned: ${keys}. Remove this stale mapping or map a field the tool returns.`,
        rawResponse,
        fatal: true,
      });
    }
  }
}

/**
 * Build the payload for an outcome event from its declared facts plus the
 * runtime fact map. Calculated values are evaluated as formulas; otherwise
 * we look up by exact / kebab-stripped key, falling back to the fact's
 * declared default. Used by both the no-scenario pass-through and the
 * matched-scenario publisher below.
 *
 * Fact entries are emitted keyed by `factId` (#77) — rename-safe and
 * collision-free — replacing the old `<sliceId>:<factName>` scoping.
 * Downstream slices translate id→name through their own contract filter in
 * `ingestScopedFacts`. `correlationId` is no longer copied into the payload; it
 * travels on the event envelope.
 */
function buildOutcomePayload(
  outcome: Outcome,
  allFactValues: Record<string, any>,
): Record<string, any> {
  // #77: emit keyed by factId (rename-safe, collision-free) — replaces the old
  // `<sliceId>:<factName>` scoped key. correlationId is no longer copied into the
  // payload; it travels on the event envelope. Values are still read from the
  // name-keyed working pool / resolved from name-based formulas.
  const payload: Record<string, any> = {};
  for (const fact of outcome.facts ?? []) {
    const key = fact.id ?? toKebabCase(fact.name);
    if (fact.calculatedValue) {
      payload[key] = resolveFormulaValue(fact.calculatedValue, allFactValues);
    } else {
      const currentVal = allFactValues[fact.name] ?? allFactValues[fact.name.toLowerCase().replace(/-/g, '')];
      if (currentVal !== undefined) {
        payload[key] = currentVal;
      } else if (fact.defaultValue !== undefined && fact.defaultValue !== '') {
        // A formula default (e.g. `TODAY()`) is resolved deterministically when
        // the fact has no value; a plain default is used literally.
        payload[key] = fact.defaultIsFormula
          ? resolveFormulaValue(fact.defaultValue, allFactValues)
          : fact.defaultValue;
      }
    }
  }
  return payload;
}

/**
 * If any eligible scenario carries an `llm`-mode rule, build an LLM
 * evaluator the rule engine can call to evaluate them. Returns undefined
 * when no LLM rules are present, or when LLM rules ARE present but no
 * `LlmService` is configured (after warning-logging the fallback).
 */
function buildLlmEvaluator(
  eligibleScenarios: EligibleScenario[],
  sliceName: string,
  llmService: LlmService | undefined,
): LlmRuleEvaluator | undefined {
  const hasLlmRules = eligibleScenarios.some(s =>
    [...s.givenBusinessRules, ...s.whenBusinessRules].some(r => r.evaluationMode === 'llm')
  );
  if (!hasLlmRules) return undefined;
  logger.info({ sliceName, hasLlmService: !!llmService }, '[AutomatedSlice] LLM-mode rules detected');
  if (!llmService) {
    logger.warn({ sliceName }, '[AutomatedSlice] LLM rules present but no LlmService configured — falling back to deterministic');
    return undefined;
  }
  return (rule, factName, factValue, allFacts) =>
    llmService.evaluateRule(factName, factValue, rule.llmPrompt ?? '', allFacts);
}

/** Structured no-match diagnostic — logged AND published as `slice-stalled`. */
interface NoMatchDiagnostic {
  reason: 'undefined-facts' | 'rule-logic-miss';
  message: string;
  undefinedFacts?: Record<string, { factId: string; factField?: string; usedInScenarios: string[] }>;
  availableFactKeys: string[];
  /** Human-readable rule text per eligible scenario, for the test-panel card. */
  scenarios: Array<{ id: string; rules: string[] }>;
}

/** Render a rule as readable text, e.g. `applicant-age is less than 16 [llm]`. */
function describeRule(rule: BusinessRule, factIdToName: Map<string, string>): string {
  const factName = factIdToName.get(rule.factId) ?? rule.factId;
  const lhs = rule.factField ? `${factName}.${rule.factField}` : factName;
  const rhs = rule.compareToFactId
    ? (factIdToName.get(rule.compareToFactId) ?? rule.compareToFactId) + (rule.compareToFactField ? `.${rule.compareToFactField}` : '')
    : (rule.value ?? '');
  const llm = rule.evaluationMode === 'llm' ? ' [llm]' : '';
  return `${lhs} ${rule.operator}${rhs !== '' ? ` ${rhs}` : ''}${llm}`.trim();
}

/**
 * Silent-stall diagnostic: when no eligible scenario matched, surface
 * which fact values were undefined when rules evaluated. This is the #1
 * cause of "workflow stalled with no events published" debug sessions —
 * a prior step (or this slice's own query/command job) didn't populate a
 * fact a scenario depended on. Logs the warning and returns the structured
 * diagnostic so the caller can publish it to the session timeline
 * (`slice-stalled`) — the log line alone proved invisible to operators.
 */
function logNoMatchDiagnostic(
  sliceName: string,
  eligibleScenarios: EligibleScenario[],
  allFactValues: Record<string, any>,
): NoMatchDiagnostic {
  const undefinedFacts = new Map<string, { factId: string; factField?: string; usedInScenarios: Set<string> }>();
  for (const s of eligibleScenarios) {
    const allRules = [...s.givenBusinessRules, ...s.whenBusinessRules];
    for (const rule of allRules) {
      const factName = s.factIdToName.get(rule.factId);
      if (!factName) continue; // orphan factId — already warned by businessRuleEvaluator
      const kebab = factName.toLowerCase().replace(/-/g, '');
      const val = allFactValues[factName] ?? allFactValues[kebab] ?? allFactValues[toKebabCase(factName)];
      const isEmpty = val === undefined || val === null || val === '';
      if (!isEmpty) continue;
      const key = `${factName}${rule.factField ? '.' + rule.factField : ''}`;
      let entry = undefinedFacts.get(key);
      if (!entry) {
        entry = { factId: rule.factId, factField: rule.factField, usedInScenarios: new Set() };
        undefinedFacts.set(key, entry);
      }
      entry.usedInScenarios.add(s.id);
    }
  }
  const scenarios = eligibleScenarios.map(s => ({
    id: s.id,
    rules: [...s.givenBusinessRules, ...s.whenBusinessRules].map(r => describeRule(r, s.factIdToName)),
  }));
  const availableFactKeys = Object.keys(allFactValues).filter(k => !k.startsWith('_'));
  if (undefinedFacts.size > 0) {
    const summary = [...undefinedFacts.entries()].map(([name, e]) =>
      `"${name}" (factId=${e.factId}, used in ${e.usedInScenarios.size} scenario(s))`
    ).join('; ');
    const undefinedFactsWire = Object.fromEntries(
      [...undefinedFacts.entries()].map(([k, v]) => [k, { factId: v.factId, factField: v.factField, usedInScenarios: [...v.usedInScenarios] }])
    );
    const message = `No scenarios matched for ${sliceName} — ${undefinedFacts.size} upstream fact(s) were undefined when rules evaluated. Workflow stalls here with no events published. Likely cause: a prior step did not populate these facts (check job outputMappings, fact formula, or whether the fact name matches what upstream steps produce). Undefined: ${summary}`;
    logger.warn(
      { sliceName, undefinedFacts: undefinedFactsWire, availableFactKeys },
      `[AutomatedSlice] ${message}`
    );
    return { reason: 'undefined-facts', message, undefinedFacts: undefinedFactsWire, availableFactKeys, scenarios };
  }
  // All referenced facts had values but still nothing matched —
  // that's a pure rule-logic miss (e.g. planType="Member" != "VIP").
  const message = `No scenarios matched for ${sliceName} — all referenced facts had values, so this is a rule-logic miss (no branch covers the current input). Workflow stalls here. Add a default/catch-all scenario or broaden the conditions.`;
  logger.warn(
    { sliceName, availableFactKeys, eligibleScenarioIds: eligibleScenarios.map(s => s.id) },
    `[AutomatedSlice] ${message}`
  );
  return { reason: 'rule-logic-miss', message, availableFactKeys, scenarios };
}


export interface AutomatedSliceRunnerDeps {
  eventBus: EventBus;
  eventStore: EventStore;
  skillsDir: string;
  /**
   * Executes a registered connector tool by name with the given params.
   * The caller is responsible for wiring up data sources and context.
   * Returns the full result object from the connector execution.
   * @param correlationId — optional workflow session ID to stamp on TOOL_CALLED events
   */
  executeConnector: (toolId: string, params: Record<string, any>, correlationId?: string) => Promise<Record<string, any>>;
  llmService?: LlmService; // optional — required only when scenarios contain llm-mode rules
}

/**
 * Factory that creates a deterministic EventHandler for a specific automated slice.
 *
 * **Used by BOTH the disk path (production) and the inline path (workbench
 * test sessions).** The caller pre-resolves the slice JSON via
 * {@link resolveDiskSliceData} or {@link resolveInlineSliceData} and passes
 * it in as `data`. Any change you make here affects both paths.
 *
 * On each triggering event:
 * 1. Filters scenarios by given[] event presence (extractEligibleScenarios)
 * 2. Collects all fact values from session event payloads + the triggering event payload
 * 3. Runs query/command jobs and LLM instructions to enrich those facts (Step 2.5a/b)
 * 4. Evaluates structured BusinessRule[] conditions (givenBusinessRules + whenBusinessRules)
 * 5. For each matching scenario, directly publishes then[] outcome events to the event bus
 *
 * Evaluation is deterministic except where business rules opt into LLM mode.
 */
export function createAutomatedSliceHandler(data: SliceData, deps: AutomatedSliceRunnerDeps) {
  return async (event: Event) => {
    const sliceName = data.sliceName;
    const t0 = Date.now();

    logger.info(
      { sliceName, eventType: event.type, correlationId: event.correlationId, sequence: event.sequence },
      '[AutomatedSlice] Handler invoked'
    );

    try {
      // 1. Filter scenarios by given[] event presence on the session bus
      const correlationId = event.correlationId ?? '';

      const t1 = Date.now();
      const sessionEventTypes = deps.eventStore.getCorrelationEventTypes(correlationId);
      // The triggering event may not yet be persisted (race with the * persist handler),
      // but it is logically present — add it explicitly so scenario given[] gates work.
      sessionEventTypes.add(event.type);
      logger.info(
        { sliceName, ms: Date.now() - t1, sessionEventTypeCount: sessionEventTypes.size, sessionEventTypes: [...sessionEventTypes] },
        '[AutomatedSlice] Step 1a: getCorrelationEventTypes'
      );

      const t1b = Date.now();
      const eligibleScenarios = extractEligibleScenarios(data.slice, data.factIdToName, sessionEventTypes);
      logger.info(
        { sliceName, ms: Date.now() - t1b, eligibleCount: eligibleScenarios.length, scenarioIds: eligibleScenarios.map(s => s.id) },
        '[AutomatedSlice] Step 1b: loadEligibleScenariosForSlice'
      );

      if (eligibleScenarios.length === 0) {
        // Two cases to distinguish:
        //   (a) The slice has scenarios but NONE are eligible on the current session —
        //       we must wait for more events. Publishing the outcomes here would fire
        //       the slice's outcome event with an empty payload (none of the scenario
        //       `then` facts are populated yet), leading to silent downstream corruption.
        //   (b) The slice genuinely defines zero scenarios — treat as "always true" and
        //       pass through the slice outcomes.
        const sliceOutcomes = extractSliceOutcomes(data.slice);
        if (!sliceOutcomes || sliceOutcomes.outcomes.length === 0) {
          logger.info({ sliceName, eventType: event.type, totalMs: Date.now() - t0 }, '[AutomatedSlice] No scenarios and no slice outcomes — skipping');
          return;
        }
        if (sliceOutcomes.totalScenarios > 0) {
          logger.info(
            { sliceName, eventType: event.type, totalScenarios: sliceOutcomes.totalScenarios, totalMs: Date.now() - t0 },
            '[AutomatedSlice] Scenarios defined but none eligible — waiting for more events'
          );
          return;
        }

        // Filter session + trigger facts through this slice's contract.
        // Strips `<sliceId>:` prefixes and excludes anything the slice
        // didn't declare via `given` (cross-slice leak fix).
        const rawPool = { ...deps.eventStore.getCorrelationFactValues(correlationId), ...flattenPayload(event.payload) };
        const allFactValues = ingestScopedFacts(rawPool, data.factIdToName);

        for (const outcome of sliceOutcomes.outcomes) {
          const payload = buildOutcomePayload(outcome, allFactValues);
          const eventType = toKebabCase(outcome.name);
          await deps.eventBus.publish({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: eventType,
            source: sliceName,
            correlationId,
            payload,
            timestamp: new Date(),
          });

          logger.info(
            { sliceName, eventType, payloadKeys: Object.keys(payload) },
            '[AutomatedSlice] Published slice outcome (no scenarios — always true)'
          );
        }

        logger.info(
          { sliceName, eventType: event.type, totalMs: Date.now() - t0, outcomeCount: sliceOutcomes.outcomes.length },
          '[AutomatedSlice] Handler complete (no-scenario pass-through)'
        );
        return;
      }

      // 2. Build fact value map: session history merged with triggering event payload,
      //    filtered through this slice's contract. Later events override earlier ones;
      //    triggering event has highest priority. Contract filtering strips
      //    `<sliceId>:` prefixes and drops anything not declared via `given`.
      const t2 = Date.now();
      const rawSessionPool = deps.eventStore.getCorrelationFactValues(correlationId);
      const sessionFactValues = ingestScopedFacts(rawSessionPool, data.factIdToName);
      const triggerFactValues = ingestScopedFacts(flattenPayload(event.payload), data.factIdToName);
      const allFactValues: Record<string, any> = { ...sessionFactValues, ...triggerFactValues };
      logger.info(
        { sliceName, ms: Date.now() - t2, sessionFactCount: Object.keys(sessionFactValues).length, totalFactCount: Object.keys(allFactValues).length, factKeys: Object.keys(allFactValues) },
        '[AutomatedSlice] Step 2: getCorrelationFactValues'
      );

      // Mirror sliceEvaluator's `_tool_errors` accumulator so a downstream
      // stall can surface these failures to the test panel via the
      // slice-tool-failed event below. Without this, query/command failures
      // here are server-log-only and the user sees a silent stall.
      //
      // `rawResponse` carries the actual tool reply (success or error envelope)
      // when extraction fails. Surfacing it in the slice-tool-failed payload
      // lets the workbench show the truth (`{ok:false, error:"channel_not_found"}`)
      // rather than only the extraction-diagnostic ("invalid output mapping:
      // field 'X' is not returned by ..."), which historically pointed users
      // at the wrong layer. Stringification happens on emit (below) so we
      // don't pay for it when the slice succeeds.
      const recordToolError = (entry: { tool: string; phase: string; name: string; error: string; rawResponse?: unknown; fatal?: boolean }) => {
        const existing = Array.isArray(allFactValues._tool_errors) ? allFactValues._tool_errors : [];
        allFactValues._tool_errors = [...existing, entry];
      };

      // 2.5a Execute all query jobs (reads) and text instructions before
      //      scenario evaluation so their returned facts are available for
      //      business rules.
      const t25a = Date.now();
      const factIdToName = eligibleScenarios[0].factIdToName;

      // Slice's contract — fact NAMES the slice is permitted to resolve.
      // De-duplicated; used to project `allFactValues` down to a contract-
      // scoped view before any AI instruction sees them. Without this, the
      // LLM would receive workflow-wide facts the slice never subscribed to,
      // re-introducing the cross-slice visibility we removed for rules.
      const inScopeFactNames = [...new Set(factIdToName.values())];
      const inScopeSet = new Set(inScopeFactNames);
      const scopeFactsToContract = (full: Record<string, any>): Record<string, any> => {
        const scoped: Record<string, any> = {};
        for (const k of inScopeSet) {
          if (full[k] !== undefined) scoped[k] = full[k];
        }
        return scoped;
      };

      // After an AI instruction returns, surface any `_missingFacts`
      // diagnostic into the tool-error stream so the operator sees an unmet
      // precondition instead of a silently degraded result. Returns the
      // values to merge back into the fact pool (`_`-prefixed keys are
      // skipped).
      //
      // Beyond _missingFacts, two contract checks run here:
      //
      //   - Scope: keys outside the slice's `inScopeSet` are rejected and
      //     recorded as a tool error. Without this, an LLM hallucination
      //     ("here's an extra fact you didn't ask for") would silently
      //     pollute the workflow fact pool with values no slice ever
      //     declared.
      //
      //   - Output completeness: when `expectedOutputs` is given, any
      //     declared output fact that is absent from the result (or comes
      //     back null/empty) is recorded as a tool error. Without this, a
      //     casing mismatch or schema drift would silently leave the fact
      //     unset and the next scenario would evaluate against an empty
      //     value, almost always falsy — a stall the operator couldn't
      //     diagnose.
      const applyInstructionResult = (
        result: Record<string, any>,
        opts: {
          tool: string;
          phase: 'query' | 'command';
          name: string;
          expectedOutputs?: string[];
        },
      ) => {
        const missing = Array.isArray(result._missingFacts) ? result._missingFacts : null;
        if (missing && missing.length > 0) {
          const reason = typeof result._reason === 'string' && result._reason ? ` — ${result._reason}` : '';
          recordToolError({
            tool: opts.tool,
            phase: opts.phase,
            name: opts.name,
            error: `LLM reported missing facts: ${missing.join(', ')}${reason}`,
            fatal: true,
          });
          logger.warn(
            { sliceName, tool: opts.tool, name: opts.name, missingFacts: missing },
            '[AutomatedSlice] LLM instruction declared missing facts — skipping merge',
          );
          return;
        }
        const expectedSet = new Set(opts.expectedOutputs ?? []);
        const outOfScope: string[] = [];
        for (const [k, v] of Object.entries(result)) {
          if (k.startsWith('_')) continue;
          if (v === undefined || v === null) continue;
          // Expected outputs are in-scope by construction; the explicit
          // membership check covers everything else the slice declared.
          if (!expectedSet.has(k) && !inScopeSet.has(k)) {
            outOfScope.push(k);
            continue;
          }
          allFactValues[k] = v;
        }
        if (outOfScope.length > 0) {
          recordToolError({
            tool: opts.tool,
            phase: opts.phase,
            name: opts.name,
            error: `LLM returned out-of-scope facts (not in slice contract): ${outOfScope.join(', ')}`,
          });
          logger.warn(
            { sliceName, tool: opts.tool, name: opts.name, outOfScope, contractSize: inScopeSet.size },
            '[AutomatedSlice] Rejected out-of-scope keys from LLM result',
          );
        }
        if (opts.expectedOutputs && opts.expectedOutputs.length > 0) {
          const absent = opts.expectedOutputs.filter(name => {
            const v = result[name];
            return v === undefined || v === null || v === '';
          });
          if (absent.length > 0) {
            recordToolError({
              tool: opts.tool,
              phase: opts.phase,
              name: opts.name,
              error: `LLM result is missing declared output fact(s): ${absent.join(', ')}`,
              fatal: true,
            });
            logger.warn(
              { sliceName, tool: opts.tool, name: opts.name, absent, returnedKeys: Object.keys(result).filter(k => !k.startsWith('_')) },
              '[AutomatedSlice] LLM omitted declared output facts — downstream scenarios will see them as unset',
            );
          }
        }
      };

      try {
        const queries = extractSliceQueries(data.slice, factIdToName);
        for (const query of queries) {
          if (query.job) {
            // Connector-backed query
            try {
              const params = resolveJobParams(query.job, factIdToName, allFactValues);
              const jobResult = await deps.executeConnector(query.job.toolId, params, correlationId);
              applyJobResultToFacts(jobResult, query.job, allFactValues, recordToolError, 'query', sliceName);
              logger.info(
                { sliceName, job: query.job.name, outputFields: Object.keys(query.job.resolvedOutputMappings) },
                '[AutomatedSlice] Step 2.5a: query job executed'
              );
            } catch (qErr: any) {
              recordToolError({ tool: query.job.toolId, phase: 'query', name: query.job.name, error: qErr.message });
              logger.warn(
                { sliceName, job: query.job.name, error: qErr.message },
                '[AutomatedSlice] Step 2.5a: query job failed — continuing'
              );
            }
          } else if (query.text && deps.llmService) {
            // Text-only query: ai.eval path — LLM interprets the natural
            // language instruction using the current facts. Facts are scoped
            // to the slice's contract so the LLM cannot resolve cross-slice
            // facts the slice didn't subscribe to via `given`.
            try {
              const returnedFactName = query.factNames[0] ?? query.name;
              const scopedFacts = scopeFactsToContract(allFactValues);
              const expandedQueryText = expandFactTemplate(
                query.text,
                scopedFacts,
                `query "${query.name}"`,
              );
              const result = await deps.llmService.evaluateInstruction(
                expandedQueryText,
                scopedFacts,
                returnedFactName,
                inScopeFactNames,
              );
              applyInstructionResult(result, {
                tool: 'ai.eval',
                phase: 'query',
                name: query.name,
                expectedOutputs: [returnedFactName],
              });
              logger.info(
                { sliceName, queryName: query.name, text: query.text.slice(0, 80), resultKeys: Object.keys(result) },
                '[AutomatedSlice] Step 2.5a: text instruction evaluated via LLM'
              );
            } catch (tErr: any) {
              recordToolError({ tool: 'ai.eval', phase: 'query', name: query.name, error: tErr.message });
              logger.warn(
                { sliceName, queryName: query.name, error: tErr.message },
                '[AutomatedSlice] Step 2.5a: text instruction evaluation failed — continuing'
              );
            }
          }
        }
      } catch (err: any) {
        recordToolError({ tool: 'loadSliceQueries', phase: 'query', name: '(load)', error: err.message });
        logger.warn(
          { sliceName, error: err.message, ms: Date.now() - t25a },
          '[AutomatedSlice] Step 2.5a: loadSliceQueries failed'
        );
      }
      logger.info({ sliceName, ms: Date.now() - t25a }, '[AutomatedSlice] Step 2.5a complete');

      // 2.5b Execute command write job (if defined) before scenario evaluation
      const t25b = Date.now();
      // Hoisted so the catch can attribute the failure to the actual connector
      // (e.g. "json-paginated-read") instead of a generic "command" label.
      let commandJobForError: { toolId: string; name: string } | undefined;
      // Per spec: when the Command (Job or instruction-mode LLM call) fails,
      // the Command does not execute and no Outcomes are emitted. Scenario
      // evaluation is skipped — without the Command's contributed facts the
      // scenarios would evaluate against partial state and may match
      // spuriously, silently emitting Outcomes that should never have fired.
      // The `slice-tool-failed` event still publishes (see below) so the
      // workbench sees the failure instead of a silent stall.
      let commandFailed = false;
      try {
        const automationJob = extractSliceAutomationJob(data.slice, factIdToName);
        if (automationJob) {
          commandJobForError = { toolId: automationJob.toolId, name: automationJob.name };
          const params = resolveJobParams(automationJob, factIdToName, allFactValues);
          const jobResult = await deps.executeConnector(automationJob.toolId, params, correlationId);
          applyJobResultToFacts(jobResult, automationJob, allFactValues, recordToolError, 'automation', sliceName);
          logger.info(
            { sliceName, job: automationJob.name, outputFields: Object.keys(automationJob.resolvedOutputMappings), ms: Date.now() - t25b },
            '[AutomatedSlice] Step 2.5b: automation job executed'
          );
        } else if (deps.llmService) {
          const cmdInstruction = extractSliceAutomationInstruction(data.slice);
          if (cmdInstruction) {
            // Same contract scoping as the query.text path above: the LLM
            // sees only facts the slice's `given`/own declarations admit.
            const scopedFacts = scopeFactsToContract(allFactValues);
            const expandedInstruction = expandFactTemplate(
              cmdInstruction.instruction,
              scopedFacts,
              'command instruction',
            );
            // Pass the full output list when present so the LLM produces one
            // key per declared output (its schema already supports the array
            // form); fall back to a single name for older callers.
            const promptOutputArg: string | string[] =
              cmdInstruction.outputFactNames.length > 1
                ? cmdInstruction.outputFactNames
                : cmdInstruction.outputFactNames[0];
            const result = await deps.llmService.evaluateInstruction(
              expandedInstruction,
              scopedFacts,
              promptOutputArg,
              inScopeFactNames,
            );
            applyInstructionResult(result, {
              tool: 'ai.eval',
              phase: 'command',
              name: 'command-instruction',
              expectedOutputs: cmdInstruction.outputFactNames,
            });
            logger.info(
              { sliceName, instruction: cmdInstruction.instruction.slice(0, 80), outputFacts: cmdInstruction.outputFactNames, resultKeys: Object.keys(result), ms: Date.now() - t25b },
              '[AutomatedSlice] Step 2.5b: instruction-mode command evaluated via LLM'
            );
          }
        }
      } catch (jobErr: any) {
        commandFailed = true;
        recordToolError({
          tool: commandJobForError?.toolId ?? 'command',
          phase: 'command',
          name: commandJobForError?.name ?? 'command-job',
          error: jobErr.message,
          fatal: true,
        });
        logger.warn(
          { sliceName, tool: commandJobForError?.toolId, error: jobErr.message, ms: Date.now() - t25b },
          '[AutomatedSlice] Step 2.5b: command failed — aborting scenario evaluation, no Outcomes will be emitted'
        );
      }

      // Contract-violation guard: a Command step can record a fatal tool
      // error without throwing — e.g. the LLM produced a result missing a
      // declared output fact, or a connector reply lacked a field that an
      // outputMapping promised. Without this, the command appears to
      // "succeed", scenarios with vacuous (empty-rule) given/when still
      // match, and Outcomes fire with partial state — exactly the
      // budget-report bug where slack-message-posted emitted on a missing
      // `report-message`. Treat any fatal command/automation-phase error
      // as a command failure so scenarios are skipped.
      if (!commandFailed) {
        const recordedErrors = Array.isArray(allFactValues._tool_errors) ? allFactValues._tool_errors : [];
        const hasFatalCommandError = recordedErrors.some((e: any) =>
          e && e.fatal === true && (e.phase === 'command' || e.phase === 'automation')
        );
        if (hasFatalCommandError) {
          commandFailed = true;
          logger.warn(
            { sliceName, ms: Date.now() - t25b },
            '[AutomatedSlice] Step 2.5b: command produced fatal tool error — aborting scenario evaluation, no Outcomes will be emitted'
          );
        }
      }

      const llmEvaluator = buildLlmEvaluator(eligibleScenarios, sliceName, deps.llmService);

      // 3. Evaluate structured business rules (deterministic + optional LLM).
      // FIRST-MATCH semantics (model-contract.md Decision 3 / #78): scenarios
      // are evaluated in AUTHORED ORDER and only the FIRST whose given+when
      // both pass fires — exactly one scenario executes. A no-rule catch-all
      // placed last is the `otherwise` branch; mutually exclusive branches no
      // longer need to partition the input space by hand.
      // Predicates are side-effect-free, so all scenarios are evaluated in
      // PARALLEL and the winner is chosen by authored index over the collected
      // results (selectFirstMatch) — a fast later scenario never beats a slow
      // earlier one, and multi-LLM-rule latency is preserved (sequential would
      // re-serialise past the 30s lambda cap). Within a scenario, given+when
      // also run in parallel. When the Command failed in step 2.5b we evaluate
      // nothing, so matchingScenarios stays empty and step 4 emits nothing.
      const t3 = Date.now();
      const scenariosToEvaluate = commandFailed ? [] : eligibleScenarios;
      const selected = await selectFirstMatch(scenariosToEvaluate, async (s) => {
        const ts = Date.now();
        const [givenOk, whenOk] = await Promise.all([
          evaluateBusinessRules(s.givenBusinessRules, allFactValues, s.factIdToName, llmEvaluator, s.givenBusinessRuleLogic),
          evaluateBusinessRules(s.whenBusinessRules, allFactValues, s.factIdToName, llmEvaluator, s.whenBusinessRuleLogic),
        ]);
        logger.info(
          {
            sliceName,
            scenarioId: s.id,
            scenarioIndex: s.index,
            givenRuleCount: s.givenBusinessRules.length,
            whenRuleCount: s.whenBusinessRules.length,
            givenOk,
            whenOk,
            matched: givenOk && whenOk,
            ms: Date.now() - ts,
          },
          '[AutomatedSlice] Step 3: scenario evaluated'
        );
        return givenOk && whenOk;
      });
      // First-match → at most one scenario fires. Kept as an array so the
      // downstream emit/diagnostic code is unchanged.
      const matchingScenarios: typeof eligibleScenarios = selected ? [selected.scenario] : [];

      logger.info(
        { sliceName, ms: Date.now() - t3, selectedScenarioId: selected?.scenario.id, selectedIndex: selected?.index, totalEligible: eligibleScenarios.length },
        '[AutomatedSlice] Step 3 complete: first-match selection'
      );

      // `stalled` means "scenarios were eligible but none matched" — a
      // workflow dead-end the test panel cares about. When the Command
      // failed we don't run the no-match diagnostic: the failure is the
      // root cause and the diagnostic would lie about undefined facts that
      // were simply never produced because the Command aborted.
      const stalled = !commandFailed && matchingScenarios.length === 0 && eligibleScenarios.length > 0;
      if (stalled) {
        const diag = logNoMatchDiagnostic(sliceName, eligibleScenarios, allFactValues);
        // Surface the silent stall on the session timeline. The log warning
        // alone proved invisible — operators watched runs "complete" with a
        // branch missing and no clue why. Persisting a `slice-stalled` event
        // puts a red diagnostic card in the test panel (the timeline renders
        // every session event; `errors[]` triggers the error styling). The
        // delivery router exempts this type (like TOOL_CALLED) so it is never
        // routed, never classified terminus/wiring-gap, and cannot change
        // completion semantics.
        await deps.eventBus.publish({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: 'slice-stalled',
          source: sliceName,
          correlationId,
          payload: {
            sliceName,
            reason: diag.reason,
            errors: [{ phase: 'scenario-evaluation', name: sliceName, error: diag.message }],
            undefinedFacts: diag.undefinedFacts,
            availableFactKeys: diag.availableFactKeys,
            scenarios: diag.scenarios,
          },
          timestamp: new Date(),
        });
      }

      // Always surface tool failures to the EventBus when there are any —
      // a scenario matching despite an upstream tool failure does NOT mean
      // the failure was harmless: it may have stored an object under a key
      // the rule then compared against, silently passing or failing. The
      // test panel needs to see the error either way. The `stalled` flag
      // lets the workbench decide whether to abort polling (true) or just
      // surface a non-blocking warning (false).
      const toolErrors = Array.isArray(allFactValues._tool_errors) ? allFactValues._tool_errors : [];
      if (toolErrors.length > 0) {
        // Normalise each entry for the wire: stringify rawResponse (if present)
        // so the payload survives JSON serialisation through the event bus, the
        // SSE stream, and the test panel renderer. Truncate to bound payload
        // size — a tool that returns megabytes shouldn't be able to inflate
        // every slice-tool-failed event. The full response is still in mmc-mcp
        // logs for deep debugging.
        const RAW_RESPONSE_TRUNCATE = 8192;
        const wireToolErrors = toolErrors.map((e: any) => {
          const out: Record<string, unknown> = {
            tool: e.tool,
            phase: e.phase,
            name: e.name,
            error: e.error,
          };
          if (e.rawResponse !== undefined) {
            let s: string;
            try { s = typeof e.rawResponse === 'string' ? e.rawResponse : JSON.stringify(e.rawResponse, null, 2); }
            catch { s = String(e.rawResponse); }
            if (s.length > RAW_RESPONSE_TRUNCATE) s = s.slice(0, RAW_RESPONSE_TRUNCATE) + '\n…[truncated]';
            out.rawResponse = s;
          }
          return out;
        });
        await deps.eventBus.publish({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: 'slice-tool-failed',
          source: sliceName,
          correlationId,
          payload: {
            sliceName,
            stalled,
            toolErrors: wireToolErrors,
            undefinedFactsHint: stalled
              ? 'see [AutomatedSlice] No scenarios matched warn for fact list'
              : 'a scenario matched despite the upstream tool error; verify the rule outcome is still correct',
          },
          timestamp: new Date(),
        });
        logger.info(
          { sliceName, stalled, toolErrorCount: toolErrors.length },
          stalled
            ? '[AutomatedSlice] Stall + tool errors — published slice-tool-failed event'
            : '[AutomatedSlice] Tool errors despite matched scenario — published slice-tool-failed (non-stalled)'
        );
      }

      // Surface "matched but empty thenOutcomes" to the workbench. Without
      // this the workflow stalls silently — a scenario passed its rules but
      // declares no outcome events, so nothing fires and the operator has
      // no idea why. Distinct from slice-tool-failed (which is for upstream
      // tool failures) because the failure mode is purely model design.
      const misconfiguredScenarios = matchingScenarios.filter(
        s => !s.error && (!s.thenOutcomes || s.thenOutcomes.length === 0),
      );
      if (misconfiguredScenarios.length > 0) {
        await deps.eventBus.publish({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: 'slice-misconfigured',
          source: sliceName,
          correlationId,
          payload: {
            sliceName,
            reason: 'empty-then-on-matched-scenario',
            scenarioIds: misconfiguredScenarios.map(s => s.id),
            hint: 'Scenario matched but declares neither an outcome event nor an error message. Add at least one outcome event — or, for an error guard, an error message — to the scenario in the builder.',
          },
          timestamp: new Date(),
        });
        logger.info(
          { sliceName, scenarioIds: misconfiguredScenarios.map(s => s.id) },
          '[AutomatedSlice] Published slice-misconfigured (empty thenOutcomes on matched scenario)',
        );
      }

      // 4. Fire outcomes for each matching scenario
      const t4 = Date.now();
      for (const scenario of matchingScenarios) {
        if (scenario.error) {
          // Resolve the error message the SAME way outcome fact values resolve
          // (resolveFormulaValue): an `@fact[.field]` ref pulls the live fact
          // value, a formula/literal is returned as-is. This lets an author
          // surface a tool's returned error — e.g. map send-eform-link's `error`
          // output to a fact and reference it here — instead of a static string.
          const resolvedError = resolveFormulaValue(scenario.error, allFactValues);
          await deps.eventBus.publish({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: 'slice-errored',
            source: sliceName,
            correlationId,
            payload: { sliceName, error: resolvedError, scenarioId: scenario.id },
            timestamp: new Date(),
          });
          logger.info(
            { sliceName, scenarioId: scenario.id, error: resolvedError },
            '[AutomatedSlice] Error scenario — published error event'
          );
          continue;
        }

        for (const outcome of scenario.thenOutcomes) {
          const payload = buildOutcomePayload(outcome, allFactValues);
          const eventType = toKebabCase(outcome.name);
          await deps.eventBus.publish({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: eventType,
            source: sliceName,
            correlationId,
            payload,
            timestamp: new Date(),
          });

          logger.info(
            { sliceName, scenarioId: scenario.id, eventType, payloadKeys: Object.keys(payload) },
            '[AutomatedSlice] Step 4: published outcome event'
          );
        }
      }

      logger.info(
        { sliceName, ms: Date.now() - t4, outcomeCount: matchingScenarios.reduce((n, s) => n + s.thenOutcomes.length, 0) },
        '[AutomatedSlice] Step 4 complete: outcome publishing'
      );

      logger.info(
        { sliceName, eventType: event.type, totalMs: Date.now() - t0 },
        '[AutomatedSlice] Handler complete'
      );
    } catch (err: any) {
      logger.error(
        { error: err.message, sliceName, eventType: event.type, totalMs: Date.now() - t0 },
        '[AutomatedSlice] Error in deterministic evaluation'
      );
    }
  };
}
