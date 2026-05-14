import path from 'path';
import { logger } from '@src/utils/logger.js';
import { EventBus } from '@src/events/eventBus.js';
import type { EventStore } from '@src/events/eventStoreTypes.js';
import { LlmService } from '@src/services/llm.js';
import { evaluateBusinessRules, type LlmRuleEvaluator } from '@src/utils/businessRuleEvaluator.js';
import { flattenPayload, resolveFormulaValue } from '@src/utils/factValueResolver.js';
import { toKebabCase } from '@src/utils/stringUtils.js';
import { extractReturnedValue } from '@src/connectors/connectorOutputKeys.js';
import {
  loadSliceFromMdPath,
  extractEligibleScenarios,
  extractSliceAutomationJob,
  extractSliceCommandInstruction,
  extractSliceOutcomes,
  extractSliceQueries,
  buildScopedFactIdToName,
  type AutomationJob,
  type EligibleScenario,
  type FactSchemaEntry,
} from '@src/skill-engine/interaction-slice-trigger-events.js';
import { resolveJobParams } from '@src/services/sliceEvaluator.js';
import { expandFactTemplate } from '@src/utils/logicUtils.js';

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
  /** The raw slice JSON (one entry from `model.slices`). */
  slice: any;
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
  sliceData: any,
  sliceName: string,
  eventSchemaIndex?: Map<string, FactSchemaEntry[]>,
): SliceData {
  const factIdToName = eventSchemaIndex
    ? buildScopedFactIdToName(sliceData ?? {}, eventSchemaIndex)
    : buildScopedFactIdToName(sliceData ?? {}, new Map());
  return { sliceName, slice: sliceData ?? {}, factIdToName };
}

/**
 * Pulls fact values into a bare-keyed pool that contains ONLY the names
 * declared by the consumer slice's contract, plus `_`-prefixed diagnostic
 * sidecars (e.g. `_tool_errors`) which are internal state, not facts, and
 * must remain visible across slices for stall reporting.
 *
 * Accepts both bare keys (legacy payloads / external triggers) and
 * `<sliceId>:<factName>` keys (slice outcome payloads). Names are unique
 * within a workflow, so the first scoped match wins.
 *
 * This is what stops cross-slice fact leakage: a slice can only see facts
 * its `given` declared, regardless of what previous slices published.
 */
function ingestScopedFacts(
  pool: Record<string, any>,
  contract: Set<string>,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(pool)) {
    if (k.startsWith('_')) out[k] = pool[k];
  }
  for (const name of contract) {
    if (pool[name] !== undefined) { out[name] = pool[name]; continue; }
    const suffix = `:${name}`;
    for (const k of Object.keys(pool)) {
      if (k.endsWith(suffix)) { out[name] = pool[k]; break; }
    }
  }
  return out;
}

/**
 * Apply a tool/connector job result to the in-slice fact pool.
 *
 * Authoritative path: when the job declares `outputMappings`
 * (`toolOutputField → factName`), each declared field is pulled from the
 * result and stored under its mapped fact name — explicit, deterministic,
 * one-to-one. Missing declared fields are recorded as tool errors so the
 * test panel surfaces the schema mismatch.
 *
 * Legacy fallback: when a job has no `outputMappings`, fall back to the
 * pre-migration `returnedFact + extractReturnedValue` fuzzy lookup so
 * existing slice JSONs keep working. A warning is logged so authors
 * migrate the slice in the workbench.
 */
export function applyJobResultToFacts(
  jobResult: any,
  job: AutomationJob,
  allFactValues: Record<string, any>,
  recordToolError: (e: { tool: string; phase: string; name: string; error: string }) => void,
  phase: 'query' | 'automation',
  sliceName: string,
): void {
  const explicit = Object.entries(job.resolvedOutputMappings);
  if (explicit.length > 0) {
    const isObj = jobResult && typeof jobResult === 'object';
    for (const [outputField, factName] of explicit) {
      if (isObj && outputField in jobResult) {
        const v = jobResult[outputField];
        if (v !== undefined) allFactValues[factName] = v;
      } else {
        const keys = isObj ? Object.keys(jobResult).join(', ') : '(non-object result)';
        recordToolError({
          tool: job.toolId,
          phase,
          name: job.name,
          error: `outputMappings declares output field "${outputField}" but it is missing from the tool result (keys: ${keys})`,
        });
      }
    }
    return;
  }

  logger.warn(
    { sliceName, job: job.name, toolId: job.toolId, phase, returnedFactName: job.returnedFact.name },
    '[AutomatedSlice] Job has no outputMappings — using legacy returnedFact + fuzzy lookup. Migrate the slice to declare outputMappings (toolOutputField → factId) for explicit, deterministic extraction.'
  );
  const returnedValue = extractReturnedValue(
    jobResult,
    job.returnedFact.name,
    job.toolId,
    ({ toolId, returnedFactName, resultKeys }) => {
      recordToolError({
        tool: toolId,
        phase,
        name: job.name,
        error: `returnedFact "${returnedFactName}" not found in tool result (keys: ${resultKeys.join(', ')}); the whole result is stored under that name and downstream rules will compare against an object. Fix: declare outputMappings on the job.`,
      });
    },
  );
  if (returnedValue !== undefined) {
    allFactValues[job.returnedFact.name] = returnedValue;
  }
}

/**
 * Build the payload for an outcome event from its declared facts plus the
 * runtime fact map. Calculated values are evaluated as formulas; otherwise
 * we look up by exact / kebab-stripped key, falling back to the fact's
 * declared default. Used by both the no-scenario pass-through and the
 * matched-scenario publisher below.
 *
 * Fact entries are emitted under `<sliceId>:<factName>` so downstream
 * slices can ingest them through their own contract filter without
 * collision; `sessionId` and other bookkeeping keys stay un-prefixed.
 */
function buildOutcomePayload(
  outcome: { name: string; facts: { name: string; calculatedValue?: string; defaultValue?: string }[] },
  allFactValues: Record<string, any>,
  sessionId: string,
  sliceId: string,
): Record<string, any> {
  const payload: Record<string, any> = { sessionId };
  for (const fact of outcome.facts) {
    const scopedKey = `${sliceId}:${fact.name}`;
    if (fact.calculatedValue) {
      payload[scopedKey] = resolveFormulaValue(fact.calculatedValue, allFactValues);
    } else {
      const currentVal = allFactValues[fact.name] ?? allFactValues[fact.name.toLowerCase().replace(/-/g, '')];
      if (currentVal !== undefined) {
        payload[scopedKey] = currentVal;
      } else if (fact.defaultValue !== undefined && fact.defaultValue !== '') {
        payload[scopedKey] = fact.defaultValue;
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

/**
 * Silent-stall diagnostic: when no eligible scenario matched, surface
 * which fact values were undefined when rules evaluated. This is the #1
 * cause of "workflow stalled with no events published" debug sessions —
 * a prior step (or this slice's own query/command job) didn't populate a
 * fact a scenario depended on. Pure logging, no side effects on facts.
 */
function logNoMatchDiagnostic(
  sliceName: string,
  eligibleScenarios: EligibleScenario[],
  allFactValues: Record<string, any>,
): void {
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
  if (undefinedFacts.size > 0) {
    const summary = [...undefinedFacts.entries()].map(([name, e]) =>
      `"${name}" (factId=${e.factId}, used in ${e.usedInScenarios.size} scenario(s))`
    ).join('; ');
    logger.warn(
      {
        sliceName,
        undefinedFacts: Object.fromEntries(
          [...undefinedFacts.entries()].map(([k, v]) => [k, { factId: v.factId, factField: v.factField, usedInScenarios: [...v.usedInScenarios] }])
        ),
        availableFactKeys: Object.keys(allFactValues),
      },
      `[AutomatedSlice] No scenarios matched for ${sliceName} — ${undefinedFacts.size} upstream fact(s) were undefined when rules evaluated. Workflow will stall here with no events published. Likely cause: a prior step did not populate these facts (check job returnedFact mapping, fact formula, or whether the LLM generator invented a fact name no upstream step produces). Undefined: ${summary}`
    );
  } else {
    // All referenced facts had values but still nothing matched —
    // that's a pure rule-logic miss (e.g. planType="Member" != "VIP").
    logger.warn(
      { sliceName, availableFactKeys: Object.keys(allFactValues), eligibleScenarioIds: eligibleScenarios.map(s => s.id) },
      `[AutomatedSlice] No scenarios matched for ${sliceName} — all referenced facts had values, so this is a rule-logic miss (no branch covers the current input). Workflow will stall here. Add a default/catch-all scenario or broaden the conditions.`
    );
  }
}

/**
 * Authoring-sanity diagnostics for the matched scenarios:
 *   1. Empty-then: a matched scenario with no outcomes will publish nothing
 *      and stall the workflow.
 *   2. Outcome conflict: when 2+ matched scenarios publish the SAME outcome
 *      event type, they almost certainly encode mutually-exclusive branches
 *      that both evaluated true (common with paired "matches" / "does not
 *      match" LLM rules on ambiguous inputs).
 *
 * Pure logging, no side effects.
 */
function logMatchedScenarioDiagnostics(
  sliceName: string,
  matchingScenarios: EligibleScenario[],
): void {
  for (const s of matchingScenarios) {
    if (!s.error && (!s.thenOutcomes || s.thenOutcomes.length === 0)) {
      logger.warn(
        { sliceName, scenarioId: s.id },
        `[AutomatedSlice] Scenario "${s.id}" matched but has empty thenOutcomes — no events will fire, workflow will stall here. Add at least one outcome event to this scenario in the builder.`
      );
    }
  }

  if (matchingScenarios.length > 1) {
    const countsByOutcome = new Map<string, { scenarioIds: string[] }>();
    for (const s of matchingScenarios) {
      if (s.error) continue;
      for (const outcome of s.thenOutcomes) {
        const key = toKebabCase(outcome.name);
        const entry = countsByOutcome.get(key) ?? { scenarioIds: [] };
        entry.scenarioIds.push(s.id);
        countsByOutcome.set(key, entry);
      }
    }
    for (const [outcomeType, entry] of countsByOutcome) {
      if (entry.scenarioIds.length > 1) {
        logger.warn(
          {
            sliceName,
            outcomeType,
            conflictingScenarioIds: entry.scenarioIds,
            totalMatched: matchingScenarios.length,
          },
          `[AutomatedSlice] Conflicting scenarios matched: ${entry.scenarioIds.length} scenarios will publish "${outcomeType}" — likely an authoring bug (mutually exclusive branches firing together)`
        );
      }
    }
  }
}

export interface AutomatedSliceRunnerDeps {
  eventBus: EventBus;
  eventStore: EventStore;
  skillsDir: string;
  /**
   * Executes a registered connector tool by name with the given params.
   * The caller is responsible for wiring up data sources and context.
   * Returns the full result object from the connector execution.
   * @param sessionId — optional workflow session ID to stamp on TOOL_CALLED events
   */
  executeConnector: (toolId: string, params: Record<string, any>, sessionId?: string) => Promise<Record<string, any>>;
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
  return async (event: any) => {
    const sliceName = data.sliceName;
    const t0 = Date.now();

    logger.info(
      { sliceName, eventType: event.type, sessionId: event.sessionId, sequence: event.sequence },
      '[AutomatedSlice] Handler invoked'
    );

    try {
      // 1. Filter scenarios by given[] event presence on the session bus
      const sessionId = event.sessionId ?? '';

      const t1 = Date.now();
      const sessionEventTypes = deps.eventStore.getSessionEventTypes(sessionId);
      // The triggering event may not yet be persisted (race with the * persist handler),
      // but it is logically present — add it explicitly so scenario given[] gates work.
      sessionEventTypes.add(event.type);
      logger.info(
        { sliceName, ms: Date.now() - t1, sessionEventTypeCount: sessionEventTypes.size, sessionEventTypes: [...sessionEventTypes] },
        '[AutomatedSlice] Step 1a: getSessionEventTypes'
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
        const contract = new Set(data.factIdToName.values());
        const rawPool = { ...deps.eventStore.getSessionFactValues(sessionId), ...flattenPayload(event.payload) };
        const allFactValues = ingestScopedFacts(rawPool, contract);

        for (const outcome of sliceOutcomes.outcomes) {
          const payload = buildOutcomePayload(outcome, allFactValues, sessionId, data.slice.id);
          const eventType = toKebabCase(outcome.name);
          await deps.eventBus.publish({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: eventType,
            source: sliceName,
            sessionId,
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
      const contract = new Set(data.factIdToName.values());
      const rawSessionPool = deps.eventStore.getSessionFactValues(sessionId);
      const sessionFactValues = ingestScopedFacts(rawSessionPool, contract);
      const triggerFactValues = ingestScopedFacts(flattenPayload(event.payload), contract);
      const allFactValues: Record<string, any> = { ...sessionFactValues, ...triggerFactValues };
      logger.info(
        { sliceName, ms: Date.now() - t2, sessionFactCount: Object.keys(sessionFactValues).length, totalFactCount: Object.keys(allFactValues).length, factKeys: Object.keys(allFactValues) },
        '[AutomatedSlice] Step 2: getSessionFactValues'
      );

      // Mirror sliceEvaluator's `_tool_errors` accumulator so a downstream
      // stall can surface these failures to the test panel via the
      // slice-tool-failed event below. Without this, query/command failures
      // here are server-log-only and the user sees a silent stall.
      const recordToolError = (entry: { tool: string; phase: string; name: string; error: string }) => {
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
              const jobResult = await deps.executeConnector(query.job.toolId, params, sessionId);
              applyJobResultToFacts(jobResult, query.job, allFactValues, recordToolError, 'query', sliceName);
              logger.info(
                { sliceName, job: query.job.name, outputFields: Object.keys(query.job.resolvedOutputMappings), legacyReturnedFact: Object.keys(query.job.resolvedOutputMappings).length === 0 ? query.job.returnedFact.name : undefined },
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
          const jobResult = await deps.executeConnector(automationJob.toolId, params, sessionId);
          applyJobResultToFacts(jobResult, automationJob, allFactValues, recordToolError, 'automation', sliceName);
          logger.info(
            { sliceName, job: automationJob.name, outputFields: Object.keys(automationJob.resolvedOutputMappings), legacyReturnedFact: Object.keys(automationJob.resolvedOutputMappings).length === 0 ? automationJob.returnedFact.name : undefined, ms: Date.now() - t25b },
            '[AutomatedSlice] Step 2.5b: automation job executed'
          );
        } else if (deps.llmService) {
          const cmdInstruction = extractSliceCommandInstruction(data.slice);
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
        });
        logger.warn(
          { sliceName, tool: commandJobForError?.toolId, error: jobErr.message, ms: Date.now() - t25b },
          '[AutomatedSlice] Step 2.5b: command failed — aborting scenario evaluation, no Outcomes will be emitted'
        );
      }

      const llmEvaluator = buildLlmEvaluator(eligibleScenarios, sliceName, deps.llmService);

      // 3. Evaluate structured business rules (deterministic + optional LLM).
      // ALL-MATCH semantics: every scenario whose given+when both pass fires
      // its outcomes independently. Scenarios on a slice are NOT an if/else
      // cascade — they are independent rules that can be simultaneously true.
      // When branches must be mutually exclusive (e.g., bypass vs natural
      // route), the conditions themselves must partition the input space.
      // When the Command failed in step 2.5b we skip this loop entirely —
      // matchingScenarios stays empty so step 4 emits nothing.
      // Scenarios on a slice are independent under ALL-MATCH semantics
      // (see comment above), so evaluate them in parallel. Within each
      // scenario, given+when also run in parallel — without this, three
      // scenarios with one ~10s LLM rule each would serialise to ~30s and
      // blow the netlify-dev 30s lambda cap on /api/mcp/rpc.
      const t3 = Date.now();
      const scenariosToEvaluate = commandFailed ? [] : eligibleScenarios;
      const scenarioResults = await Promise.all(
        scenariosToEvaluate.map(async (s) => {
          const ts = Date.now();
          const [givenOk, whenOk] = await Promise.all([
            evaluateBusinessRules(s.givenBusinessRules, allFactValues, s.factIdToName, llmEvaluator, s.givenBusinessRuleLogic),
            evaluateBusinessRules(s.whenBusinessRules, allFactValues, s.factIdToName, llmEvaluator, s.whenBusinessRuleLogic),
          ]);
          const scenarioMs = Date.now() - ts;

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
              ms: scenarioMs,
            },
            '[AutomatedSlice] Step 3: scenario evaluated'
          );

          return { s, matched: givenOk && whenOk };
        })
      );
      const matchingScenarios: typeof eligibleScenarios = scenarioResults
        .filter((r) => r.matched)
        .map((r) => r.s);

      logger.info(
        { sliceName, ms: Date.now() - t3, matchingCount: matchingScenarios.length, totalEligible: eligibleScenarios.length },
        '[AutomatedSlice] Step 3 complete: business rule evaluation'
      );

      // `stalled` means "scenarios were eligible but none matched" — a
      // workflow dead-end the test panel cares about. When the Command
      // failed we don't run the no-match diagnostic: the failure is the
      // root cause and the diagnostic would lie about undefined facts that
      // were simply never produced because the Command aborted.
      const stalled = !commandFailed && matchingScenarios.length === 0 && eligibleScenarios.length > 0;
      if (stalled) {
        logNoMatchDiagnostic(sliceName, eligibleScenarios, allFactValues);
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
        await deps.eventBus.publish({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: 'slice-tool-failed',
          source: sliceName,
          sessionId,
          payload: {
            sliceName,
            stalled,
            toolErrors,
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
      logMatchedScenarioDiagnostics(sliceName, matchingScenarios);

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
          sessionId,
          payload: {
            sliceName,
            reason: 'empty-then-on-matched-scenario',
            scenarioIds: misconfiguredScenarios.map(s => s.id),
            hint: 'Scenario matched but has no outcome events declared. Add at least one outcome event to the scenario in the builder.',
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
          await deps.eventBus.publish({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: 'slice-errored',
            source: sliceName,
            sessionId,
            payload: { sliceName, error: scenario.error, scenarioId: scenario.id },
            timestamp: new Date(),
          });
          logger.info(
            { sliceName, scenarioId: scenario.id, error: scenario.error },
            '[AutomatedSlice] Error scenario — published error event'
          );
          continue;
        }

        for (const outcome of scenario.thenOutcomes) {
          const payload = buildOutcomePayload(outcome, allFactValues, sessionId, data.slice.id);
          const eventType = toKebabCase(outcome.name);
          await deps.eventBus.publish({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: eventType,
            source: sliceName,
            sessionId,
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
