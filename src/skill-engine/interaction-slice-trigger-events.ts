import fs from 'fs/promises';
import path from 'path';
import { logger } from '@src/utils/logger.js';
import type { BusinessRule, BusinessRuleLogic } from '@src/types/businessRule.js';
// Canonical wire types (model-contract.md Decision 1 / #72). This module's
// former local "loading projection" (all-optional Slice/Scenario/ThenOutcome/…)
// is gone — the one Slice type serves loaders and both engines.
import type {
  Slice,
  Outcome,
  OutcomeRef,
  Fact,
  JobLink,
  OutcomeModel,
} from '@src/types/outcomeModel.js';

// In-memory cache of parsed outcome model JSON files, keyed by absolute path.
// Populated on first access, cleared by calling invalidateOutcomeModelCache().
const modelCache = new Map<string, OutcomeModel>();

/** Clear the cached outcome model data. Call this after a resync. */
export function invalidateOutcomeModelCache(): void {
  modelCache.clear();
}

async function readModel(filePath: string): Promise<OutcomeModel> {
  const cached = modelCache.get(filePath);
  if (cached) return cached;
  const model: OutcomeModel = JSON.parse(await fs.readFile(filePath, 'utf-8'));
  modelCache.set(filePath, model);
  return model;
}

// Pattern detection + per-pattern validation now live in `./sliceValidation.ts`.
// Imported for internal use here and re-exported so existing consumers
// (server, sliceEvaluator, automatedSliceRunner, todoStore, viewSliceRunner)
// keep importing them from this module unchanged.
import {
  getSlicePattern,
  validateSlice,
  type SlicePattern,
  type SliceValidationCode,
  type SliceValidationError,
  type SliceValidationResult,
} from './sliceValidation.js';

export { getSlicePattern, validateSlice };
export type { SlicePattern, SliceValidationCode, SliceValidationError, SliceValidationResult };

/**
 * Scans outcome model JSON files in the skills directory and returns the set of
 * event type names that should trigger an agent notification.
 *
 * Rule: any slice that carries an `interface` property requires human interaction.
 * The events listed in its scenarios' `given` arrays are published by the preceding
 * automated slice — when those events fire, the agent must be notified so it can
 * present the interface to the user.
 */
export async function loadInteractionSliceTriggerEvents(skillsDir: string): Promise<string[]> {
  const eventTypes = new Set<string>();

  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith('.json')) continue;
      try {
        const model = await readModel(full);
        for (const slice of model.slices ?? []) {
          if (getSlicePattern(slice) !== 'interface') continue; // only interface-pattern slices need agent notification
          for (const scenario of slice.scenarios ?? []) {
            for (const given of scenario.given ?? []) {
              if (given.name) eventTypes.add(given.name);
            }
          }
        }
      } catch { /* skip malformed or non-model JSON files */ }
    }
  }

  await walk(skillsDir);
  return [...eventTypes];
}

/**
 * External-event triggers for an activity.
 *
 * An external outcome (an inbound webhook event) is connected to a slice's
 * Query by an `external` outcomeLink: `link.fromId` is the externalOutcome id,
 * `link.toId` is the query id. The canvas authors the subscription this way —
 * NOT as a `scenario.given[]` entry — so the disk dispatcher (`automatedSliceMap`)
 * and the TodoProcessor (`loadWorkflowDefinitions`) must both fold these in,
 * otherwise the slice never fires when its external event arrives (the
 * external-events-workbench-only gap).
 *
 * Returns sliceName → external event names (the externalOutcome `name`, which
 * matches the `eventType` the webhook publishes). Pure transformation — no I/O.
 */
export function buildExternalTriggerMap(model: OutcomeModel): Map<string, string[]> {
  const bySlice = new Map<string, string[]>();
  const links = model.outcomeLinks ?? [];
  if (links.length === 0) return bySlice;

  const eoNameById = new Map<string, string>();
  for (const eo of model.externalOutcomes ?? []) {
    if (eo?.id && eo?.name) eoNameById.set(eo.id, eo.name);
  }
  const queryIdToSlice = new Map<string, string>();
  for (const slice of model.slices ?? []) {
    if (!slice.name) continue;
    for (const q of slice.queries ?? []) {
      if (q?.id) queryIdToSlice.set(q.id, slice.name);
    }
  }

  for (const link of links) {
    if (link?.type !== 'external') continue;
    const eventName = eoNameById.get(link.fromId);
    const sliceName = queryIdToSlice.get(link.toId);
    if (!eventName || !sliceName) continue;
    const arr = bySlice.get(sliceName);
    if (arr) { if (!arr.includes(eventName)) arr.push(eventName); }
    else bySlice.set(sliceName, [eventName]);
  }
  return bySlice;
}

/** Per-scenario summary used to evaluate slice eligibility. */
export interface WorkflowSliceScenarioSummary {
  /** Event names that must be present on the session for this scenario to match */
  givenEventNames: string[];
  /** Structured business rules evaluated against session fact values */
  givenBusinessRules: BusinessRule[];
  /** AND/OR logic for givenBusinessRules (defaults to AND) */
  givenBusinessRuleLogic: BusinessRuleLogic;
  /** Error message if this scenario represents a failure/validation case (not a valid precondition for a todo) */
  error: string;
}

/** Summary of a slice within a workflow, used by TodoProcessor. */
export interface WorkflowSliceSummary {
  name: string;
  /** Command name driving this slice (e.g. "start-nzta-application"); the
   *  user-facing task label. Empty string if the slice declares no command. */
  command: string;
  role: string;
  /**
   * Authoritative pattern classification from {@link getSlicePattern}. Replaces
   * the old `isInterface` boolean for downstream code that needs to distinguish
   * view-pattern slices (which still surface as todos so the user sees the
   * read-only display, but require a different render path on the client) from
   * interface-pattern slices (interactive forms).
   */
  pattern: SlicePattern;
  /** True iff `pattern === 'interface'`. Kept for callers that only need the
   *  binary distinction (e.g. the `/workflows` entry-point filter and
   *  handle-latest-event's interface event lookup). */
  isInterface: boolean;
  /**
   * Per-scenario given event groups. A slice activates when ANY group is fully
   * satisfied (OR of ANDs). Each inner array is one scenario's given[] events.
   */
  givenEventGroups: string[][];
  /** Event types this slice publishes (outcome names) */
  outcomeEventTypes: string[];
  /** Per-scenario details for fact-based eligibility checks. */
  scenarios: WorkflowSliceScenarioSummary[];
  /** Kebab-case fact names declared on this slice (used to filter todo payloads). */
  factNames: string[];
  /**
   * Per-slice scoped factId → factName map: own facts ∪ facts on outcome
   * events the slice subscribes to via `scenario.given[]`. Used when
   * evaluating this slice's business rules. A slice never sees workflow-wide
   * facts that aren't on one of its given events.
   */
  factIdToName: Map<string, string>;
}

/** A workflow is one outcome model with its ordered list of slices. */
export interface WorkflowDefinition {
  /** Activity name (e.g. "manage-procurement") */
  name: string;
  slices: WorkflowSliceSummary[];
  /** Maps event type → slice name that triggers on it (automated slices via triggers_on_event) */
  automatedTriggerMap: Map<string, string>;
  /**
   * Outcome events published by this workflow that are not consumed by any
   * slice within the same workflow. Reaching one of these is the *expected*
   * end of the chain — distinct from a stray event that nothing should have
   * published.
   */
  terminalEventTypes: Set<string>;
  /**
   * Inbound external event types this workflow consumes (a slice's query is
   * linked to an externalOutcome via an `external` outcomeLink). The workflow
   * is not complete while one of these is still expected but unseen — the
   * awaiting-callback obligation (see `evaluateQuiescence`). Registry-derived,
   * via {@link buildExternalTriggerMap}.
   */
  externalTriggerEvents: Set<string>;
}

/**
 * Loads all workflow definitions from outcome model JSON files.
 * Returns a map of activity name → WorkflowDefinition.
 */
export async function loadWorkflowDefinitions(skillsDir: string): Promise<Map<string, WorkflowDefinition>> {
  const workflows = new Map<string, WorkflowDefinition>();

  async function walk(dir: string) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith('.json')) continue;
      try {
        const model = await readModel(full);
        const activityName = model.slices?.[0]?.name
          ? path.basename(e.name, '.json')
          : undefined;
        if (!activityName || !model.slices?.length) continue;

        workflows.set(activityName, buildWorkflowDefinition(activityName, model));
      } catch { /* skip malformed JSON */ }
    }
  }

  await walk(skillsDir);
  return workflows;
}

/**
 * Build a {@link WorkflowDefinition} from a single outcome model. The one place
 * that turns model slices into the runtime topology (slice summaries +
 * automatedTriggerMap + terminal/external events). Shared by both execution
 * paths so they can never diverge:
 *   - disk-scoped: {@link loadWorkflowDefinitions} per model file (external
 *     MCP clients, e.g. mmc-workflow).
 *   - session-scoped: `register-skills` builds it from the inline model the
 *     workbench Test panel pushes (so `TodoProcessor` creates interface/view
 *     todos against the model under test, never a stale disk export — mirroring
 *     how the automated-slice dispatcher consults `sessionSkills`, never disk).
 *
 * Pure (logging aside): no I/O, safe to call per `register-skills`.
 */
export function buildWorkflowDefinition(activityName: string, model: OutcomeModel): WorkflowDefinition {
  const slices: WorkflowSliceSummary[] = [];
  const automatedTriggerMap = new Map<string, string>();
  const eventSchemaIndex = buildEventSchemaIndex(model.slices ?? []);
  // External-event subscriptions live in the activity-level registry
  // (externalOutcomes + external outcomeLinks), not in scenario.given[].
  const externalTriggers = buildExternalTriggerMap(model);

  for (const slice of model.slices ?? []) {
    if (!slice.name) continue;

    const extEvents = externalTriggers.get(slice.name) ?? [];

    // Surface spec violations at load time so authors see them in the
    // server log without blocking startup. Validation is non-fatal —
    // an invalid slice still loads and runs (potentially incorrectly);
    // operators decide whether to fix or proceed.
    const validation = validateSlice(slice);
    // AUTOMATION_MISSING_SUBSCRIPTION only inspects scenario.given[]. A
    // slice triggered by an external event subscribes via the registry
    // instead, so suppress that one code when an external trigger exists.
    const reportedErrors = extEvents.length > 0
      ? validation.errors.filter(e => e.code !== 'AUTOMATION_MISSING_SUBSCRIPTION')
      : validation.errors;
    if (reportedErrors.length > 0) {
      logger.warn(
        {
          workflow: activityName,
          slice: slice.name,
          pattern: validation.pattern,
          errors: reportedErrors,
        },
        `[SkillEngine] Slice "${slice.name}" violates ${validation.pattern} pattern rules: ${reportedErrors.map(e => e.code).join(', ')}`,
      );
    }

    const pattern = getSlicePattern(slice);

    const givenEventGroups: string[][] = [];
    const scenarios: WorkflowSliceScenarioSummary[] = [];
    for (const scenario of slice.scenarios ?? []) {
      const givenEventNames = (scenario.given ?? [])
        .map((g: OutcomeRef) => g.name)
        .filter((n): n is string => !!n);
      scenarios.push({
        givenEventNames,
        givenBusinessRules: scenario.givenBusinessRules ?? [],
        givenBusinessRuleLogic: scenario.givenBusinessRuleLogic ?? 'AND',
        error: scenario.error ?? '',
      });
      if (givenEventNames.length > 0) givenEventGroups.push(givenEventNames);
    }
    // External-event triggers are subscriptions too: each becomes its own
    // single-event group (OR-of-ANDs) so resolveWorkflow, terminal-event
    // computation, and entry-point detection all treat the slice as
    // consuming its external event.
    for (const ev of extEvents) givenEventGroups.push([ev]);
    // Views derive their trigger from `scenarios[].given[]` exactly
    // like every other pattern (OR-of-ANDs: one group per scenario).
    // A View's query.outcomes are its READ SCOPE (what instance
    // state to read), never its trigger — the old `query.outcomes`→
    // single-AND-group synthesis was the credit-decisioning bug:
    // mutually-exclusive branch outcomes can never all be present.

    const outcomeEventTypes = (slice.outcomes ?? [])
      .filter(o => o.name)
      .map(o => o.name!);

    const factNames = (slice.facts ?? [])
      .map(f => f.name)
      .filter((n): n is string => !!n);
    slices.push({
      name: slice.name,
      command: slice.command?.name ?? '',
      role: slice.role ?? '',
      pattern,
      isInterface: pattern === 'interface',
      givenEventGroups,
      outcomeEventTypes,
      scenarios,
      factNames,
      factIdToName: buildScopedFactIdToName(slice, eventSchemaIndex),
    });
  }

  // Build automatedTriggerMap from the JSON outcome model — for every
  // Automation pattern slice, register each distinct scenario.given[]
  // event name → slice name. The JSON is the single source of truth
  // for slice topology (the .md `triggers_on_event` frontmatter the
  // workbench publishes is a legacy view of the same data and may be
  // empty for workbench-published placeholders). MD files still drive
  // Interface and View slice prompts; they just no longer drive
  // automation routing.
  for (const slice of model.slices ?? []) {
    if (!slice.name) continue;
    if (getSlicePattern(slice) !== 'automation') continue;
    for (const scenario of slice.scenarios ?? []) {
      for (const given of scenario.given ?? []) {
        if (given.name) automatedTriggerMap.set(given.name, slice.name);
      }
    }
    // External-event triggers route the same way as scenario.given.
    for (const ev of externalTriggers.get(slice.name) ?? []) {
      automatedTriggerMap.set(ev, slice.name);
    }
  }

  // Terminal events: outcome events that no slice in this workflow consumes.
  // Reaching one is the expected end of the chain.
  const consumedEventTypes = new Set<string>();
  for (const s of slices) {
    for (const group of s.givenEventGroups) {
      for (const et of group) consumedEventTypes.add(et);
    }
  }
  const terminalEventTypes = new Set<string>();
  for (const s of slices) {
    for (const et of s.outcomeEventTypes) {
      if (!consumedEventTypes.has(et)) terminalEventTypes.add(et);
    }
  }

  const externalTriggerEvents = new Set<string>();
  for (const events of externalTriggers.values()) {
    for (const ev of events) externalTriggerEvents.add(ev);
  }

  return { name: activityName, slices, automatedTriggerMap, terminalEventTypes, externalTriggerEvents };
}

/**
 * Scans outcome model JSON files and returns the set of slice names whose
 * pattern is View — i.e. read-only projections that should be exposed as
 * MCP tools so the agent can invoke them on demand. Views never carry a
 * Command and never emit Interaction Outcomes; the server runs their
 * Queries and returns the projection synchronously.
 */
export async function loadViewSliceNames(skillsDir: string): Promise<Set<string>> {
  const names = new Set<string>();

  async function walk(dir: string) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith('.json')) continue;
      try {
        const model = await readModel(full);
        for (const slice of model.slices ?? []) {
          if (getSlicePattern(slice) === 'view' && slice.name) names.add(slice.name);
        }
      } catch { /* skip malformed JSON */ }
    }
  }

  await walk(skillsDir);
  return names;
}

/**
 * Scans outcome model JSON files and returns the set of slice names that carry
 * an `interface` property (i.e. require human interaction).
 *
 * The slice `name` matches the directory name of its corresponding skill `.md`
 * file, so this set can be used to filter the tools list.
 */
export async function loadInterfaceSliceNames(skillsDir: string): Promise<Set<string>> {
  const names = new Set<string>();

  async function walk(dir: string) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith('.json')) continue;
      try {
        const model = await readModel(full);
        for (const slice of model.slices ?? []) {
          if (getSlicePattern(slice) === 'interface' && slice.name) names.add(slice.name);
        }
      } catch { /* skip malformed JSON */ }
    }
  }

  await walk(skillsDir);
  return names;
}

export interface EligibleScenario {
  id: string
  index: number
  /** Legacy free-form rule string (informational only) */
  whenBusinessRule: string
  /** Structured rules for given (prerequisite) fact conditions */
  givenBusinessRules: BusinessRule[]
  /** Logic for given business rules: "AND" (all must pass) or "OR" (any must pass) */
  givenBusinessRuleLogic: BusinessRuleLogic
  /** Structured rules for when (command/trigger) fact conditions */
  whenBusinessRules: BusinessRule[]
  /** Logic for when business rules: "AND" (all must pass) or "OR" (any must pass) */
  whenBusinessRuleLogic: BusinessRuleLogic
  /** Event names that must be present on the session bus */
  givenNames: string[]
  /** Outcomes to publish when this scenario matches */
  thenOutcomes: Outcome[]
  /** Error description if scenario represents an error condition */
  error: string
  /** Maps factId → factName for all facts defined in this model */
  factIdToName: Map<string, string>
}

/** Minimal fact schema entry indexed by event name. */
export interface FactSchemaEntry { id: string; name: string }

/**
 * Adds every fact a slice owns directly (slice/query/command/outcome/scenario.then)
 * to the provided map. Used both by the per-slice scoper and by the event-schema
 * indexer (which needs to enumerate every outcome event's declared facts).
 *
 * Pure transformation; mutates the passed map.
 */
export function addSliceFactsToMap(map: Map<string, string>, slice: Slice | null | undefined): void {
  const add = (f: Fact | undefined) => {
    if (f?.id && f?.name) map.set(f.id, f.name);
  };
  // Facts a job's outputMappings write into are brought into the slice's
  // scope by the job itself — no `given` subscription required.
  const addOutputMappings = (jobLink: any) => {
    for (const m of Object.values(jobLink?.outputMappings ?? {})) {
      const mapping = m as any;
      if (mapping?.factId && mapping?.factName) map.set(mapping.factId, mapping.factName);
    }
  };
  for (const f of slice?.facts ?? []) add(f);
  for (const o of slice?.outcomes ?? []) for (const f of o?.facts ?? []) add(f);
  for (const q of slice?.queries ?? []) {
    for (const f of q?.facts ?? []) add(f);
    for (const o of q?.outcomes ?? []) for (const f of o?.facts ?? []) add(f);
    addOutputMappings(q?.jobLink);
  }
  for (const f of slice?.command?.facts ?? []) add(f);
  for (const o of slice?.command?.outcomes ?? []) for (const f of o?.facts ?? []) add(f);
  // The command's job is the slice's "trigger" — facts it consumes (input
  // mappings) and produces (outputMappings) belong to the slice's contract.
  // Scenarios on a command-anchored slice may have empty `given` and still
  // legitimately reference these facts in their rules. Without this, the
  // unmapped-fact detector flags every command-job fact as unmapped and
  // forces the author to add a redundant `given` subscription.
  addOutputMappings(slice?.command?.jobLink);
  for (const f of slice?.command?.jobLink?.facts ?? []) add(f);
  // Same treatment for the automation block — its job fields carry facts
  // into scope when the automation runs.
  addOutputMappings(slice?.automation?.jobLink);
  for (const f of slice?.automation?.facts ?? []) add(f);
  for (const f of slice?.automation?.jobLink?.facts ?? []) add(f);
  for (const s of slice?.scenarios ?? []) {
    for (const t of s?.then ?? []) for (const f of t?.facts ?? []) add(f);
  }
}

/**
 * Builds an `eventName → fact[]` index from a bundle of slices. Used to
 * project a slice's `scenario.given` references into resolvable fact ids.
 *
 * Sources walked: `slice.outcomes`, `slice.command.outcomes`,
 * `slice.scenarios[].then[]`. Last writer wins on name collisions.
 */
export function buildEventSchemaIndex(slices: Slice[]): Map<string, FactSchemaEntry[]> {
  const index = new Map<string, FactSchemaEntry[]>();
  const collect = (name: unknown, facts: Fact[] | undefined) => {
    if (typeof name !== 'string' || !name) return;
    if (!facts || facts.length === 0) {
      if (!index.has(name)) index.set(name, []);
      return;
    }
    const entries: FactSchemaEntry[] = facts
      .filter(f => f?.id && f?.name)
      .map(f => ({ id: f.id, name: f.name }));
    index.set(name, entries);
  };
  for (const slice of slices ?? []) {
    for (const o of slice?.outcomes ?? []) collect(o?.name, o?.facts);
    for (const o of slice?.command?.outcomes ?? []) collect(o?.name, o?.facts);
    for (const s of slice?.scenarios ?? []) {
      for (const t of s?.then ?? []) collect(t?.name, t?.facts);
    }
  }
  return index;
}

/**
 * Per-slice scoped factId → factName map. Per Event Modeling rules a slice
 * may only resolve facts it owns plus facts declared on outcome events
 * listed in its `scenario.given[]`. Workflow-wide facts are NOT visible.
 */
export function buildScopedFactIdToName(
  slice: Slice | null | undefined,
  eventSchemaIndex: Map<string, FactSchemaEntry[]>,
): Map<string, string> {
  const map = new Map<string, string>();
  addSliceFactsToMap(map, slice);
  for (const s of slice?.scenarios ?? []) {
    for (const given of s?.given ?? []) {
      const entries = eventSchemaIndex.get(given?.name);
      if (!entries) continue;
      for (const e of entries) map.set(e.id, e.name);
    }
  }
  return map;
}

/** A factId reference somewhere on a slice — used for design-time validation. */
export interface UnmappedFactRef {
  location: string;
  factId: string;
  /**
   * Index into `slice.scenarios` of the scenario whose rule referenced this
   * factId. Set only for scenario-rule violations; unset for query/command
   * input-mapping violations (those aren't scoped to a specific scenario).
   */
  scenarioIndex?: number;
  /**
   * Name of an outcome event (somewhere in the registered bundle / model)
   * whose declared facts include this factId. When set, the workbench can
   * offer a one-click action to add the event to the slice's `given` —
   * fixing the contract without auto-populating workflow state.
   */
  suggestedGiven?: string;
}

/**
 * Find every factId referenced by the slice's rules and bare-factId input
 * mappings, and return the ones that are NOT in the slice's scoped fact
 * lookup. An "unmapped" factId means the slice references a fact it has not
 * declared and that does not appear on any outcome event listed in
 * `scenario.given[]` — a design-time violation of the Event Modeling
 * contract.
 *
 * Sources walked:
 *   - `scenario.givenBusinessRules[*].factId`
 *   - `scenario.whenBusinessRules[*].factId`
 *   - `command.jobLink.inputMappings.<param>` (bare-factId form, value
 *     not prefixed with `@`)
 *   - `queries[*].jobLink.inputMappings.<param>` (bare-factId form)
 *
 * When an `eventSchemaIndex` is supplied, each unmapped ref is augmented
 * with a `suggestedGiven` pointing to the producing event (if any). The
 * scoping rule is unchanged — slices still cannot resolve facts unless the
 * author explicitly subscribes via `given`. The suggestion just tells the
 * UI what `given` event would fix the violation.
 *
 * Pure transformation; no I/O.
 */
export function collectUnmappedFactIds(
  slice: Slice | null | undefined,
  scopedFactIdToName: Map<string, string>,
  eventSchemaIndex?: Map<string, FactSchemaEntry[]>,
): UnmappedFactRef[] {
  const unmapped: UnmappedFactRef[] = [];

  // Build a reverse lookup `factId → first event name that declares it` so
  // we can suggest a `given` event for each unmapped reference. Only the
  // first match is reported — authors can investigate alternatives if there
  // are multiple producers.
  let factIdToEvent: Map<string, string> | undefined;
  if (eventSchemaIndex) {
    factIdToEvent = new Map();
    for (const [eventName, facts] of eventSchemaIndex) {
      for (const f of facts) {
        if (!factIdToEvent.has(f.id)) factIdToEvent.set(f.id, eventName);
      }
    }
  }

  const check = (location: string, factId: unknown, scenarioIndex?: number) => {
    if (typeof factId !== 'string' || !factId) return;
    if (scopedFactIdToName.has(factId)) return;
    const ref: UnmappedFactRef = { location, factId };
    if (scenarioIndex !== undefined) ref.scenarioIndex = scenarioIndex;
    const suggested = factIdToEvent?.get(factId);
    if (suggested) ref.suggestedGiven = suggested;
    unmapped.push(ref);
  };

  const scenarios = slice?.scenarios ?? [];
  for (let si = 0; si < scenarios.length; si++) {
    const sc = scenarios[si];
    const givenRules = sc?.givenBusinessRules ?? [];
    for (let ri = 0; ri < givenRules.length; ri++) {
      check(`scenario[${si}].givenBusinessRules[${ri}]`, givenRules[ri]?.factId, si);
    }
    const whenRules = sc?.whenBusinessRules ?? [];
    for (let ri = 0; ri < whenRules.length; ri++) {
      check(`scenario[${si}].whenBusinessRules[${ri}]`, whenRules[ri]?.factId, si);
    }
  }

  const checkInputMappings = (basePath: string, mappings: Record<string, unknown> | undefined) => {
    for (const [param, raw] of Object.entries(mappings ?? {})) {
      if (typeof raw !== 'string' || !raw || raw.startsWith('@')) continue;
      // Only a legacy bare-factId mapping is a factId reference. Anything that
      // isn't a single identifier-like token is a Formula-mode expression — a
      // constant, TODAY()/NOW(), arithmetic, or a {{template}} — that
      // resolveJobParams resolves via resolveFormulaValue at runtime, NOT a
      // factId. Reporting those as "unmapped facts" is a false positive (it
      // mirrors the resolver's own bare-factId-vs-formula split). A factId has
      // no whitespace, braces, dots, or operators, so a slug test cleanly
      // separates the two without needing the full fact universe here.
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw)) continue;
      check(`${basePath}.${param}`, raw);
    }
  };
  const queries = slice?.queries ?? [];
  for (let qi = 0; qi < queries.length; qi++) {
    checkInputMappings(`queries[${qi}].jobLink.inputMappings`, queries[qi]?.jobLink?.inputMappings);
  }
  checkInputMappings('automation.jobLink.inputMappings', slice?.automation?.jobLink?.inputMappings);
  // Legacy: jobs used to live on command — keep checking until all models migrated.
  checkInputMappings('command.jobLink.inputMappings', slice?.command?.jobLink?.inputMappings);

  return unmapped;
}

/**
 * Locates the slice by name in any JSON outcome model in its activity
 * directory. Returns the parsed slice together with a per-slice scoped
 * `factId → factName` map covering only the facts the slice is contractually
 * entitled to resolve (own facts ∪ facts on outcome events listed in
 * `scenario.given[]`). Returns null when no matching slice is found or the
 * activity directory cannot be read.
 */
export async function loadSliceFromMdPath(
  skillMdPath: string,
): Promise<{ slice: Slice; factIdToName: Map<string, string> } | null> {
  const sliceName = path.basename(path.dirname(skillMdPath));
  const activityDir = path.dirname(path.dirname(skillMdPath));

  let entries;
  try {
    entries = await fs.readdir(activityDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const e of entries) {
    if (!e.name.endsWith('.json')) continue;
    try {
      const model = await readModel(path.join(activityDir, e.name));
      const slice = (model.slices ?? []).find(s => s.name === sliceName);
      if (!slice) continue;
      const eventSchemaIndex = buildEventSchemaIndex(model.slices ?? []);
      const factIdToName = buildScopedFactIdToName(slice, eventSchemaIndex);
      // Attach the model-level value-type registry so the form renderer can
      // resolve NESTED composites (e.g. application-form → emergency-contact),
      // whose field definitions live at model level, not inline on the slice.
      const vts = (model as any).valueTypes;
      const sliceWithVts = vts ? ({ ...slice, valueTypes: vts } as Slice) : slice;
      return { slice: sliceWithVts, factIdToName };
    } catch { /* skip malformed JSON */ }
  }

  return null;
}

/**
 * Locates a slice by its canonical `slice.id` across every outcome-model JSON
 * under `skillsDir`. This is the post-identity-refactor disk resolver for
 * `complete-slice`: the canonical `sliceId` the client passes back is the
 * slice's opaque `id` (slice-patterns.md "Slice identity"), the SAME value the
 * session path resolves via `register-skills` — NOT the kebab tool name or the
 * `.md` `skill_id`. Names are display/tool-label only and MUST NOT be routing
 * keys, so resolving by directory/frontmatter name (the legacy `resolveSkillPath`
 * path) cannot find a slice whose `id` differs from its name.
 *
 * Returns the parsed slice, its scoped `factId → factName` map, and a
 * synthesized `skillMdPath`
 * (`{skillsDir}/{activity}/{slice.name}/{slice.name}.md`) so callers can derive
 * the activity workflow name from the directory layout exactly as they do for
 * {@link loadSliceFromMdPath}. Returns null when no slice with that id exists.
 */
export async function loadSliceFromSliceId(
  skillsDir: string,
  sliceId: string,
): Promise<{ slice: Slice; factIdToName: Map<string, string>; skillMdPath: string } | null> {
  let result: { slice: Slice; factIdToName: Map<string, string>; skillMdPath: string } | null = null;

  async function walk(dir: string): Promise<boolean> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return false; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (await walk(full)) return true; continue; }
      if (!e.name.endsWith('.json')) continue;
      try {
        const model = await readModel(full);
        const slice = (model.slices ?? []).find(s => s.id === sliceId);
        if (!slice || !slice.name) continue;
        const eventSchemaIndex = buildEventSchemaIndex(model.slices ?? []);
        const activityDir = path.dirname(full);
        result = {
          slice,
          factIdToName: buildScopedFactIdToName(slice, eventSchemaIndex),
          skillMdPath: path.join(activityDir, slice.name, `${slice.name}.md`),
        };
        return true;
      } catch { /* skip malformed or non-model JSON */ }
    }
    return false;
  }

  await walk(skillsDir);
  return result;
}

/**
 * Filters and projects the slice's scenarios into evaluator-ready form,
 * dropping any whose `given[]` events are not all present on the session.
 * Pure transformation — no I/O.
 */
export function extractEligibleScenarios(
  slice: Slice,
  factIdToName: Map<string, string>,
  sessionEventTypes: Set<string>,
): EligibleScenario[] {
  return (slice.scenarios ?? [])
    .map((scenario, index): EligibleScenario => {
      const givenNames = (scenario.given ?? [])
        .map((g: OutcomeRef) => g.name)
        .filter(Boolean);

      return {
        id: scenario.id ?? '',
        index,
        whenBusinessRule: scenario.whenBusinessRule ?? '',
        givenBusinessRules: scenario.givenBusinessRules ?? [],
        givenBusinessRuleLogic: scenario.givenBusinessRuleLogic ?? 'AND',
        whenBusinessRules: scenario.whenBusinessRules ?? [],
        whenBusinessRuleLogic: scenario.whenBusinessRuleLogic ?? 'AND',
        givenNames,
        thenOutcomes: scenario.then ?? [],
        error: scenario.error ?? '',
        factIdToName,
      };
    })
    .filter(s => s.givenNames.every(name => sessionEventTypes.has(name)));
}

/**
 * Given a slice skill .md path and the set of event types currently on the session bus,
 * returns the scenarios from the outcome model JSON that are eligible to be evaluated.
 *
 * A scenario is eligible (by given[] gating) when every event named in its `given[]`
 * array is present in `sessionEventTypes`. An empty `given[]` means always eligible.
 *
 * The returned objects include structured business rules and then-outcomes so the
 * caller can perform full deterministic evaluation and outcome publishing without
 * further JSON loading.
 */
export async function loadEligibleScenariosForSlice(
  skillMdPath: string,
  sessionEventTypes: Set<string>
): Promise<EligibleScenario[]> {
  const loaded = await loadSliceFromMdPath(skillMdPath);
  if (!loaded) return [];
  return extractEligibleScenarios(loaded.slice, loaded.factIdToName, sessionEventTypes);
}

/**
 * Returns the slice's `outcomes` projected into the evaluator's shape, plus
 * the total scenario count (so callers can distinguish "always-true
 * pass-through" from "scenarios defined but none matched yet").
 * Pure transformation — no I/O.
 */
export function extractSliceOutcomes(
  slice: Slice,
): { outcomes: Outcome[]; totalScenarios: number } {
  const outcomes: Outcome[] = (slice.outcomes ?? [])
    .filter(o => o.name)
    .map(o => ({
      name: o.name,
      facts: (o.facts ?? []).map(f => ({
        id: f.id,
        name: f.name,
        calculatedValue: f.calculatedValue,
        defaultValue: f.defaultValue,
      })),
    }));
  const totalScenarios = (slice.scenarios ?? []).length;
  return { outcomes, totalScenarios };
}

/**
 * Loads the slice-level outcomes and factIdToName from the outcome model.
 * Also reports `totalScenarios` so callers can distinguish a slice that
 * genuinely defines no scenarios ("always-true" pass-through) from a slice
 * that has scenarios but none matched this run (the handler should wait).
 */
export async function loadSliceOutcomes(
  skillMdPath: string
): Promise<{ outcomes: Outcome[]; factIdToName: Map<string, string>; totalScenarios: number } | null> {
  const loaded = await loadSliceFromMdPath(skillMdPath);
  if (!loaded) return null;
  const { outcomes, totalScenarios } = extractSliceOutcomes(loaded.slice);
  return { outcomes, factIdToName: loaded.factIdToName, totalScenarios };
}

export interface AutomationJob {
  id: string
  name: string
  toolId: string
  staticParams: Record<string, any>
  /**
   * Raw paramName → mapping value as authored on the slice. Values can be a
   * factId, an `@factName`, or `@factName.fieldName`. Preserved so the runtime
   * can route through {@link import('@src/services/sliceEvaluator.js').resolveJobParams},
   * which is the one place that knows how to decode the `@`-encoding.
   */
  inputMappings: Record<string, string>
  /** paramName → resolved fact name (fact IDs already resolved via factIdToName) */
  resolvedInputMappings: Record<string, string>
  /** Raw outputField → {factId, factName, fieldName?} map as authored on the slice. */
  outputMappings: Record<string, { factId: string; factName: string; fieldName?: string }>
  /** outputField → {factName, fieldName?} (already fully resolved at export time) */
  resolvedOutputMappings: Record<string, { factName: string; fieldName?: string }>
}

/**
 * Loads the automation job definition for a slice, if one exists.
 * @deprecated Use loadSliceAutomationJob or loadSliceQueryJobs instead.
 */
export async function loadSliceJob(
  skillMdPath: string,
  factIdToName: Map<string, string>
): Promise<AutomationJob | null> {
  const automationJob = await loadSliceAutomationJob(skillMdPath, factIdToName);
  if (automationJob) return automationJob;

  const sliceName = path.basename(path.dirname(skillMdPath));
  const activityDir = path.dirname(path.dirname(skillMdPath));

  let entries;
  try {
    entries = await fs.readdir(activityDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const e of entries) {
    if (!e.name.endsWith('.json')) continue;
    try {
      const model = await readModel(path.join(activityDir, e.name));
      const slice = (model.slices ?? []).find(s => s.name === sliceName);
      if (!slice?.automation?.jobLink) continue;

      return resolveJobDef(slice.automation.jobLink, factIdToName);
    } catch { /* skip malformed JSON */ }
  }

  return null;
}

/**
 * Decode a mapping value into its target fact name. Accepts either:
 *   - `"@factName"` / `"@factName.fieldName"` — workbench wire format;
 *      we strip the `@` and (when present) keep just the head fact name,
 *      matching how downstream `resolveJobParams` decodes the same form.
 *   - bare factId — legacy form, look up via `factIdToName`.
 *
 * Returns the resolved fact name, or `undefined` when neither lookup hits
 * (caller decides whether to drop the entry).
 */
function decodeMappingValue(
  raw: string,
  factIdToName: Map<string, string>,
): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  if (raw.startsWith('@')) {
    const dotAt = raw.indexOf('.', 1);
    return dotAt >= 0 ? raw.slice(1, dotAt) : raw.slice(1);
  }
  return factIdToName.get(raw);
}

function resolveJobDef(rawLink: JobLink, factIdToName: Map<string, string>): AutomationJob {
  const { job, inputMappings, outputMappings } = rawLink;
  const resolvedInputMappings: Record<string, string> = {};
  for (const [param, value] of Object.entries(inputMappings ?? {})) {
    // Preserve the raw value when no lookup hits — downstream `resolveJobParams`
    // decodes `@factName` itself, so the un-decoded string still works there.
    resolvedInputMappings[param] = decodeMappingValue(value, factIdToName) ?? value;
  }
  const resolvedOutputMappings: Record<string, { factName: string; fieldName?: string }> = {};
  for (const [outputField, mapping] of Object.entries(outputMappings ?? {})) {
    if (!mapping?.factName) continue;
    resolvedOutputMappings[outputField] = mapping.fieldName
      ? { factName: mapping.factName, fieldName: mapping.fieldName }
      : { factName: mapping.factName };
  }
  return {
    id: job.id ?? '',
    name: job.name ?? '',
    toolId: job.toolId,
    staticParams: job.staticParams ?? {},
    inputMappings: inputMappings ?? {},
    resolvedInputMappings,
    outputMappings: outputMappings ?? {},
    resolvedOutputMappings,
  };
}

export interface SliceQuery {
  id: string;
  name: string;
  /** Kebab-case fact names declared on this query. */
  factNames: string[];
  /** Tool-backed fetch; when absent the query is a fact-snapshot only. */
  job: AutomationJob | null;
  /** Natural-language instruction for LLM evaluation (ai.eval path). */
  text: string | null;
}

/**
 * Projects the slice's queries into the evaluator's shape.
 * Pure transformation — no I/O.
 */
export function extractSliceQueries(
  slice: Slice,
  factIdToName: Map<string, string>,
): SliceQuery[] {
  const queries: SliceQuery[] = [];
  for (const query of slice.queries ?? []) {
    const factNames = (query.facts ?? [])
      .map(f => f.name)
      .filter(n => !!n);
    queries.push({
      id: query.id ?? '',
      name: query.name ?? '',
      factNames,
      job: query.jobLink ? resolveJobDef(query.jobLink, factIdToName) : null,
      text: query.text ?? null,
    });
  }
  return queries;
}

/**
 * Loads all queries for a slice (read operations). Unlike
 * {@link loadSliceQueryJobs} this also returns queries without a `job`,
 * so callers can surface their declared facts as a session snapshot.
 */
export async function loadSliceQueries(
  skillMdPath: string,
  factIdToName: Map<string, string>
): Promise<SliceQuery[]> {
  const loaded = await loadSliceFromMdPath(skillMdPath);
  if (!loaded) return [];
  return extractSliceQueries(loaded.slice, factIdToName);
}

/**
 * Loads all query jobs for a slice (read operations).
 * Returns an array of resolved AutomationJob objects.
 */
export async function loadSliceQueryJobs(
  skillMdPath: string,
  factIdToName: Map<string, string>
): Promise<AutomationJob[]> {
  const sliceName = path.basename(path.dirname(skillMdPath));
  const activityDir = path.dirname(path.dirname(skillMdPath));

  let entries;
  try {
    entries = await fs.readdir(activityDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const e of entries) {
    if (!e.name.endsWith('.json')) continue;
    try {
      const model = await readModel(path.join(activityDir, e.name));
      const slice = (model.slices ?? []).find(s => s.name === sliceName);
      if (!slice) continue;

      const jobs: AutomationJob[] = [];
      for (const query of slice.queries ?? []) {
        if (!query.jobLink) continue;
        jobs.push(resolveJobDef(query.jobLink, factIdToName));
      }
      return jobs;
    } catch { /* skip malformed JSON */ }
  }

  return [];
}

/**
 * Resolves the slice's automation job (write operation) into an AutomationJob,
 * or returns null when no automation job is defined. Pure transformation — no I/O.
 *
 * Prefers `slice.automation.jobLink`. Falls back to legacy `slice.command.jobLink`
 * for models authored before jobs were moved off Command — a deprecation warning
 * is emitted so the migration can be tracked. Drop the fallback once all on-disk
 * models have been re-saved by a migrated workbench.
 */
export function extractSliceAutomationJob(
  slice: Slice,
  factIdToName: Map<string, string>,
): AutomationJob | null {
  if (slice.automation?.jobLink) {
    return resolveJobDef(slice.automation.jobLink, factIdToName);
  }
  if (slice.command?.jobLink) {
    console.warn('[deprecated] slice.command.jobLink is set; jobs now live on slice.automation.jobLink. Re-save the model in the workbench to migrate.');
    return resolveJobDef(slice.command.jobLink, factIdToName);
  }
  return null;
}

/**
 * Loads the automation job definition for a slice (write operation).
 * Returns null if no automation job is defined.
 */
export async function loadSliceAutomationJob(
  skillMdPath: string,
  factIdToName: Map<string, string>
): Promise<AutomationJob | null> {
  const loaded = await loadSliceFromMdPath(skillMdPath);
  if (!loaded) return null;
  return extractSliceAutomationJob(loaded.slice, factIdToName);
}

/**
 * Resolves an instruction-mode automation's prompt and the names of the facts
 * it should populate, or returns null when the slice has no automation
 * instruction. Pure transformation — no I/O.
 *
 * Precedence for the output contract:
 *   1. Explicit `slice.automation.outputFacts` written by the workbench.
 *      Authoritative — multi-fact, position-independent.
 *   2. Convention fallback (deprecated): every fact on every outcome the
 *      slice publishes, then every fact on the command's outcomes. Kept so
 *      legacy on-disk models keep evaluating until re-saved, but emits a
 *      `[deprecated]` warning identifying the slice so authors can migrate.
 *
 * Falls back to the legacy `slice.command.{mode,instruction}` shape too, for
 * models authored before instructions moved off Command.
 */
export function extractSliceAutomationInstruction(
  slice: Slice,
): { instruction: string; outputFactNames: string[] } | null {
  let instruction: string | undefined
  if (slice.automation?.instruction && slice.automation.mode === 'instruction') {
    instruction = slice.automation.instruction
  } else if (slice.command?.instruction && slice.command.mode === 'instruction') {
    console.warn('[deprecated] slice.command.instruction is set; instructions now live on slice.automation. Re-save the model in the workbench to migrate.')
    instruction = slice.command.instruction
  }
  if (!instruction) return null

  const explicit = slice.automation?.outputFacts
  if (Array.isArray(explicit) && explicit.length > 0) {
    const names = explicit.map(f => f?.name).filter((n): n is string => !!n)
    if (names.length > 0) return { instruction, outputFactNames: dedupe(names) }
  }

  // Convention fallback — deprecated. Gather every published-outcome fact so
  // multi-fact slices don't silently lose data the way the old "first of first"
  // rule did. Warn so the operator can see which slice still needs re-saving.
  const fallback = collectFallbackOutputFactNames(slice)
  if (fallback.length === 0) return null
  console.warn(`[deprecated] slice "${slice.name ?? '(unnamed)'}" has no slice.automation.outputFacts; falling back to inferred outcome facts (${fallback.join(', ')}). Re-save the model in the workbench to migrate.`)
  return { instruction, outputFactNames: fallback }
}

function collectFallbackOutputFactNames(slice: Slice): string[] {
  const out: string[] = []
  for (const o of slice.outcomes ?? []) {
    for (const f of o.facts ?? []) if (f?.name) out.push(f.name)
  }
  for (const o of slice.command?.outcomes ?? []) {
    for (const f of o.facts ?? []) if (f?.name) out.push(f.name)
  }
  return dedupe(out)
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) { if (!seen.has(x)) { seen.add(x); out.push(x) } }
  return out
}

/** @deprecated Use extractSliceAutomationInstruction. */
export const extractSliceCommandInstruction = extractSliceAutomationInstruction

/**
 * Returns the LLM instruction for an instruction-mode automation, along with
 * the name of the output fact it should produce. Returns null when the slice
 * has no instruction (e.g. it runs a job, or has no automation at all).
 */
export async function loadSliceAutomationInstruction(
  skillMdPath: string
): Promise<{ instruction: string; outputFactNames: string[] } | null> {
  const loaded = await loadSliceFromMdPath(skillMdPath);
  if (!loaded) return null;
  return extractSliceAutomationInstruction(loaded.slice);
}

/** @deprecated Use loadSliceAutomationInstruction. */
export const loadSliceCommandInstruction = loadSliceAutomationInstruction

/**
 * Returns a map of trigger event type → skill MD file paths for automated
 * (non-interface) slices.
 *
 * Source of truth is the workflow JSON: each slice's `scenario.given[].name`
 * lists the events that activate it. Skill MD files are not consulted because
 * the workbench may publish them as empty placeholders; the actual chain
 * topology lives in the JSON. The returned MD paths are synthetic
 * `{skillsDir}/{workflow}/{slice}/{slice}.md` strings used by the disk
 * dispatcher to navigate back to the workflow JSON via `loadSliceFromMdPath`,
 * which itself reads from JSON, not the MD body.
 *
 * Inclusion is decided per-slice by `getSlicePattern` (read from each slice's
 * own JSON), so it is independent of any global, name-keyed slice set.
 */
export async function loadAutomatedSliceMap(
  skillsDir: string,
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();

  async function walk(dir: string) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith('.json')) continue;
      try {
        const model = await readModel(full);
        if (!model.slices?.length) continue;
        const activityDir = path.dirname(full);
        const externalTriggers = buildExternalTriggerMap(model);
        const addTrigger = (eventName: string, skillMdPath: string) => {
          const existing = map.get(eventName);
          if (existing) {
            if (!existing.includes(skillMdPath)) existing.push(skillMdPath);
          } else {
            map.set(eventName, [skillMdPath]);
          }
        };
        for (const slice of model.slices) {
          if (!slice.name) continue;
          // Only Automation pattern slices are dispatched via the event bus.
          // Interface slices are handled by the agent via triggerEventSet;
          // View slices are read-only and never event-driven. Classification is
          // per-slice via getSlicePattern (collision-proof). Do NOT additionally
          // gate on a global slice-name set: names are not unique across
          // activities, so a name-set check would wrongly skip an automation
          // slice that shares a name with an interface slice in another activity.
          if (getSlicePattern(slice) !== 'automation') continue;
          const skillMdPath = path.join(activityDir, slice.name, `${slice.name}.md`);
          for (const scenario of slice.scenarios ?? []) {
            for (const given of scenario.given ?? []) {
              if (!given.name) continue;
              addTrigger(given.name, skillMdPath);
            }
          }
          // External-event triggers (registry-driven) dispatch identically.
          for (const ev of externalTriggers.get(slice.name) ?? []) {
            addTrigger(ev, skillMdPath);
          }
        }
      } catch { /* skip malformed or non-model JSON */ }
    }
  }

  await walk(skillsDir);
  return map;
}

export async function loadSliceWorkflowMap(skillsDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  async function walk(dir: string) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      const dirName  = path.basename(path.dirname(full));
      const workflow = path.basename(path.dirname(path.dirname(full)));
      if (workflow === path.basename(skillsDir)) continue; // skip root-level skills
      map.set(dirName, workflow);
      try {
        const content = await fs.readFile(full, 'utf-8');
        const m = content.match(/^name:\s*(.+)$/m);
        if (m) map.set(m[1].trim().replace(/^["']|["']$/g, ''), workflow);
      } catch { /* skip */ }
    }
  }
  await walk(skillsDir);
  return map;
}
