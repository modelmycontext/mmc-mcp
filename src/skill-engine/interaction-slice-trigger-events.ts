import fs from 'fs/promises';
import path from 'path';
import { logger } from '@src/utils/logger.js';
import type { BusinessRule, BusinessRuleLogic } from '@src/types/businessRule.js';

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

interface OutcomeRef { name: string }

interface ThenFact {
  id: string
  name: string
  calculatedValue?: string
  defaultValue?: string
}

interface ThenOutcome {
  name: string         // event type (kebab-case outcome name)
  facts: ThenFact[]
}

interface Scenario {
  id?: string
  given: OutcomeRef[]
  givenBusinessRule?: string
  givenBusinessRules?: BusinessRule[]
  givenBusinessRuleLogic?: BusinessRuleLogic
  whenBusinessRule?: string
  whenBusinessRules?: BusinessRule[]
  whenBusinessRuleLogic?: BusinessRuleLogic
  then?: ThenOutcome[]
  error?: string
}

interface ModelFact {
  id: string
  name: string
}

/**
 * Wire-format mirror of the workbench's `Job` (entity-only). Reusable
 * tool-callable definition: identifies the tool and its param shape.
 * Per-use bindings (input/output fact mappings, returnedFact) live on
 * the surrounding {@link AutomationJobLink}, not here.
 */
interface AutomationJobDef {
  id?: string
  name?: string
  toolId: string
  staticParams?: Record<string, any>
  dynamicParams?: string[]
  inputFactIds?: string[]
}

/**
 * Wire-format mirror of the workbench's `JobLink`. Pairs a Job entity
 * with its per-use bindings: which fact populates each input param,
 * which fact each output field stores into, and the composite shape
 * the tool returns.
 *
 * Authoritative output mapping (`outputMappings`): tool output field
 * name → `@factName` (kebab) | bare factId. When present, the runner
 * stores `jobResult[outputField]` under the mapped fact's name. When
 * absent, the runner falls back to `returnedFact` + fuzzy lookup and
 * emits a warning.
 */
interface AutomationJobLink {
  job: AutomationJobDef
  returnedFact?: { id: string; name: string }
  inputMappings?: Record<string, string>
  outputMappings?: Record<string, string>
}

interface Slice {
  name?: string
  role?: string
  interface?: unknown
  scenarios?: Scenario[]
  outcomes?: Array<{ name?: string; facts?: ModelFact[] }>
  queries?: Array<{ facts?: ModelFact[]; outcomes?: Array<{ facts?: ModelFact[] }>; jobLink?: AutomationJobLink }>
  command?: { facts?: ModelFact[]; outcomes?: Array<{ facts?: ModelFact[] }>; jobLink?: AutomationJobLink; mode?: string; instruction?: string }
  facts?: ModelFact[]
  automation?: {
    facts?: ModelFact[]
    jobLink?: AutomationJobLink
    mode?: string
    instruction?: string
    /**
     * Authoritative list of the facts this automation contractually produces.
     * When present, readers MUST use it instead of inferring from
     * `slice.outcomes[0].facts`. The inference is only a fallback for legacy
     * models that haven't been re-saved by a workbench that emits this field.
     */
    outputFacts?: ModelFact[]
  }
}

interface OutcomeModel { slices?: Slice[] }

/**
 * The three slice patterns recognised by Event Modeling. The pattern is
 * inferred from the slice's component shape — there is intentionally no
 * `pattern` field on the slice, because that would denormalise the truth
 * (the components themselves) and could drift.
 *
 *   - `interface`  — slice has an `interface` component (user/system input)
 *   - `view`       — slice has no `command` (read-only projection)
 *   - `automation` — anything else (subscribes to outcomes, runs a command)
 *
 * This helper is the single canonical source for pattern detection. Every
 * call site that needs to branch on pattern MUST go through it; do not
 * inline `slice.interface` checks.
 */
export type SlicePattern = 'interface' | 'automation' | 'view';

export function getSlicePattern(slice: any): SlicePattern {
  // `command` is the discriminator: a slice without a Command can never be
  // a starting/executable task — it has nothing to commit. Views often DO
  // carry an `interface` block (to declare which facts they render), so
  // matching on `interface` first miscategorises those as Interface slices,
  // which then surface to TodoProcessor as entry-point todos in mmc-workflow
  // and as a "Test" task in the workbench test panel. Check command absence
  // first so the View invariant ("a view can never be a starting slice")
  // holds for every downstream consumer.
  if (!slice?.command) return 'view';
  if (slice?.interface) return 'interface';
  return 'automation';
}

/**
 * Validation error codes. Stable identifiers so tooling and tests can
 * pattern-match without coupling to message wording.
 */
export type SliceValidationCode =
  | 'INTERFACE_MISSING_COMMAND'
  | 'INTERFACE_MISSING_OUTCOMES'
  | 'INTERFACE_MISSING_SCENARIO'
  | 'AUTOMATION_QUERY_CARDINALITY'
  | 'AUTOMATION_MISSING_SUBSCRIPTION'
  | 'AUTOMATION_MISSING_OUTCOMES'
  | 'VIEW_HAS_COMMAND'
  | 'VIEW_HAS_OUTCOMES'
  | 'VIEW_HAS_THEN'
  | 'VIEW_MISSING_QUERIES';

export interface SliceValidationError {
  code: SliceValidationCode;
  message: string;
}

export interface SliceValidationResult {
  pattern: SlicePattern;
  errors: SliceValidationError[];
}

/**
 * Validates a slice against the per-pattern composition rules:
 *
 *   - Interface: requires Command + at least one Outcome + at least one
 *     scenario. Queries 0+. The scenario MAY have an empty `given[]`
 *     (entry-point trigger), but `when` + `then` make the trigger and
 *     emitted Outcome explicit and editable.
 *   - Automation: requires Command + exactly 1 Query + at least one
 *     scenario with non-empty `given` (subscription) + at least one
 *     Outcome.
 *   - View: requires 1+ Queries. Forbids Command, Outcomes, and any
 *     scenario with a `then` (Views never emit Interaction Outcomes).
 *
 * Pure transformation — no I/O. The pattern is inferred from the slice
 * shape via {@link getSlicePattern}, then pattern-specific rules run.
 * Each error carries a stable {@link SliceValidationCode} so tooling can
 * match by code rather than message wording.
 */
export function validateSlice(slice: any): SliceValidationResult {
  const pattern = getSlicePattern(slice);
  const errors: SliceValidationError[] = [];
  const queries = Array.isArray(slice?.queries) ? slice.queries : [];
  const outcomes = Array.isArray(slice?.outcomes) ? slice.outcomes : [];
  const scenarios = Array.isArray(slice?.scenarios) ? slice.scenarios : [];

  if (pattern === 'interface') {
    if (!slice?.command) {
      errors.push({ code: 'INTERFACE_MISSING_COMMAND', message: 'Interface pattern requires a command.' });
    }
    if (outcomes.length === 0) {
      errors.push({ code: 'INTERFACE_MISSING_OUTCOMES', message: 'Interface pattern must emit at least one Interaction Outcome.' });
    }
    if (scenarios.length === 0) {
      errors.push({
        code: 'INTERFACE_MISSING_SCENARIO',
        message: 'Interface pattern requires at least one scenario (given may be empty for entry-point triggers, but when + then are required).',
      });
    }
  }

  if (pattern === 'automation') {
    if (queries.length !== 1) {
      errors.push({
        code: 'AUTOMATION_QUERY_CARDINALITY',
        message: `Automation pattern requires exactly 1 Query (got ${queries.length}).`,
      });
    }
    const hasSubscription = scenarios.some((s: any) => Array.isArray(s?.given) && s.given.length > 0);
    if (!hasSubscription) {
      errors.push({
        code: 'AUTOMATION_MISSING_SUBSCRIPTION',
        message: 'Automation pattern requires at least one scenario.given subscription.',
      });
    }
    if (outcomes.length === 0) {
      errors.push({ code: 'AUTOMATION_MISSING_OUTCOMES', message: 'Automation pattern must emit at least one Interaction Outcome.' });
    }
  }

  if (pattern === 'view') {
    // `command` absence is the discriminator, so VIEW_HAS_COMMAND is
    // unreachable via getSlicePattern. The check is kept defensively in
    // case the helper changes — a View must never carry a Command.
    if (slice?.command) {
      errors.push({ code: 'VIEW_HAS_COMMAND', message: 'View pattern cannot have a command.' });
    }
    if (queries.length < 1) {
      errors.push({ code: 'VIEW_MISSING_QUERIES', message: 'View pattern requires at least 1 Query.' });
    }
    if (outcomes.length > 0) {
      errors.push({ code: 'VIEW_HAS_OUTCOMES', message: 'View pattern cannot emit Interaction Outcomes.' });
    }
    const emitting = scenarios.filter((s: any) => Array.isArray(s?.then) && s.then.length > 0);
    if (emitting.length > 0) {
      errors.push({ code: 'VIEW_HAS_THEN', message: 'View pattern scenarios cannot have a `then` (no Outcome emission).' });
    }
  }

  return { pattern, errors };
}

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

        const slices: WorkflowSliceSummary[] = [];
        const automatedTriggerMap = new Map<string, string>();
        const eventSchemaIndex = buildEventSchemaIndex(model.slices);

        for (const slice of model.slices) {
          if (!slice.name) continue;

          // Surface spec violations at load time so authors see them in the
          // server log without blocking startup. Validation is non-fatal —
          // an invalid slice still loads and runs (potentially incorrectly);
          // operators decide whether to fix or proceed.
          const validation = validateSlice(slice);
          if (validation.errors.length > 0) {
            logger.warn(
              {
                workflow: activityName,
                slice: slice.name,
                pattern: validation.pattern,
                errors: validation.errors,
              },
              `[SkillEngine] Slice "${slice.name}" violates ${validation.pattern} pattern rules: ${validation.errors.map(e => e.code).join(', ')}`,
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
              error: (scenario as any).error ?? '',
            });
            if (givenEventNames.length > 0) givenEventGroups.push(givenEventNames);
          }
          // View slices declare their trigger events on `queries[].outcomes[]`,
          // not on `scenarios[].given[]`. The Event Modeling contract: a View
          // is a read-only projection that joins the outcomes its queries
          // reference — it must wait until ALL subscribed events have landed
          // before rendering, otherwise the user sees a half-empty summary
          // (e.g. order facts present, discount facts still being computed).
          // Push all triggers as ONE group so TodoProcessor's eligibility
          // check (`group.every(et => sessionEventTypes.has(et))`) enforces
          // AND semantics across the join.
          if (pattern === 'view') {
            const viewTriggers = new Set<string>();
            for (const query of slice.queries ?? []) {
              for (const out of (query as any).outcomes ?? []) {
                if (typeof out?.name === 'string' && out.name) viewTriggers.add(out.name);
              }
            }
            if (viewTriggers.size > 0) givenEventGroups.push([...viewTriggers]);
          }

          const outcomeEventTypes = (slice.outcomes ?? [])
            .filter(o => o.name)
            .map(o => o.name!);

          const factNames = (slice.facts ?? [])
            .map(f => f.name)
            .filter((n): n is string => !!n);
          slices.push({
            name: slice.name,
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
        for (const slice of model.slices) {
          if (!slice.name) continue;
          if (getSlicePattern(slice) !== 'automation') continue;
          for (const scenario of slice.scenarios ?? []) {
            for (const given of scenario.given ?? []) {
              if (given.name) automatedTriggerMap.set(given.name, slice.name);
            }
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

        workflows.set(activityName, { name: activityName, slices, automatedTriggerMap, terminalEventTypes });
      } catch { /* skip malformed JSON */ }
    }
  }

  await walk(skillsDir);
  return workflows;
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
  thenOutcomes: ThenOutcome[]
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
export function addSliceFactsToMap(map: Map<string, string>, slice: any): void {
  const add = (f: any) => {
    if (f?.id && f?.name) map.set(f.id, f.name);
  };
  for (const f of slice?.facts ?? []) add(f);
  for (const o of slice?.outcomes ?? []) for (const f of o?.facts ?? []) add(f);
  for (const q of slice?.queries ?? []) {
    for (const f of q?.facts ?? []) add(f);
    for (const o of q?.outcomes ?? []) for (const f of o?.facts ?? []) add(f);
    // Include facts the query's job produces (returnedFact) — these are
    // brought into the slice's scope by the query itself, no `given`
    // subscription required.
    add(q?.jobLink?.returnedFact);
  }
  for (const f of slice?.command?.facts ?? []) add(f);
  for (const o of slice?.command?.outcomes ?? []) for (const f of o?.facts ?? []) add(f);
  // The command's job is the slice's "trigger" — facts it consumes (input
  // mappings) and produces (returnedFact) belong to the slice's contract.
  // Scenarios on a command-anchored slice may have empty `given` and still
  // legitimately reference these facts in their rules. Without this, the
  // unmapped-fact detector flags every command-job fact as unmapped and
  // forces the author to add a redundant `given` subscription.
  add(slice?.command?.jobLink?.returnedFact);
  for (const f of slice?.command?.jobLink?.facts ?? []) add(f);
  // Same treatment for the automation block — its job fields carry facts
  // into scope when the automation runs.
  add(slice?.automation?.jobLink?.returnedFact);
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
export function buildEventSchemaIndex(slices: any[]): Map<string, FactSchemaEntry[]> {
  const index = new Map<string, FactSchemaEntry[]>();
  const collect = (name: unknown, facts: any[] | undefined) => {
    if (typeof name !== 'string' || !name) return;
    if (!facts || facts.length === 0) {
      if (!index.has(name)) index.set(name, []);
      return;
    }
    const entries: FactSchemaEntry[] = facts
      .filter((f: any) => f?.id && f?.name)
      .map((f: any) => ({ id: f.id, name: f.name }));
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
  slice: any,
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
  slice: any,
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
      return { slice, factIdToName: buildScopedFactIdToName(slice, eventSchemaIndex) };
    } catch { /* skip malformed JSON */ }
  }

  return null;
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
): { outcomes: ThenOutcome[]; totalScenarios: number } {
  const outcomes: ThenOutcome[] = (slice.outcomes ?? [])
    .filter(o => o.name)
    .map(o => ({
      name: o.name!,
      facts: (o.facts ?? []).map(f => ({
        id: f.id,
        name: f.name,
        calculatedValue: (f as any).calculatedValue,
        defaultValue: (f as any).defaultValue,
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
): Promise<{ outcomes: ThenOutcome[]; factIdToName: Map<string, string>; totalScenarios: number } | null> {
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
  returnedFact: { id: string; name: string }
  /** Raw outputField → factId map as authored on the slice. */
  outputMappings: Record<string, string>
  /** outputField → resolved fact name (fact IDs already resolved via factIdToName) */
  resolvedOutputMappings: Record<string, string>
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

function resolveJobDef(rawLink: AutomationJobLink, factIdToName: Map<string, string>): AutomationJob {
  const { job, inputMappings, outputMappings, returnedFact } = rawLink;
  const resolvedInputMappings: Record<string, string> = {};
  for (const [param, value] of Object.entries(inputMappings ?? {})) {
    // Preserve the raw value when no lookup hits — downstream `resolveJobParams`
    // decodes `@factName` itself, so the un-decoded string still works there.
    resolvedInputMappings[param] = decodeMappingValue(value, factIdToName) ?? value;
  }
  const resolvedOutputMappings: Record<string, string> = {};
  for (const [outputField, value] of Object.entries(outputMappings ?? {})) {
    const factName = decodeMappingValue(value, factIdToName);
    if (factName) resolvedOutputMappings[outputField] = factName;
  }
  return {
    id: job.id ?? '',
    name: job.name ?? '',
    toolId: job.toolId,
    staticParams: job.staticParams ?? {},
    inputMappings: inputMappings ?? {},
    resolvedInputMappings,
    returnedFact: returnedFact ?? { id: '', name: '' },
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
      .map((f: any) => f.name)
      .filter((n: any): n is string => !!n);
    const inferredReturnedFact = query.jobLink?.returnedFact
      ?? query.outcomes?.[0]?.facts?.[0]
      ?? query.facts?.[0]
      ?? { id: '', name: '' };
    queries.push({
      id: (query as any).id ?? '',
      name: (query as any).name ?? '',
      factNames,
      job: query.jobLink ? resolveJobDef({ ...query.jobLink, returnedFact: inferredReturnedFact }, factIdToName) : null,
      text: (query as any).text ?? null,
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
        const inferredReturnedFact = query.jobLink.returnedFact
          ?? query.outcomes?.[0]?.facts?.[0]
          ?? query.facts?.[0]
          ?? { id: '', name: '' };
        jobs.push(resolveJobDef({ ...query.jobLink, returnedFact: inferredReturnedFact }, factIdToName));
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
    const inferredReturnedFact = slice.automation.jobLink.returnedFact
      ?? slice.outcomes?.[0]?.facts?.[0]
      ?? { id: '', name: '' };
    return resolveJobDef({ ...slice.automation.jobLink, returnedFact: inferredReturnedFact }, factIdToName);
  }
  if (slice.command?.jobLink) {
    console.warn('[deprecated] slice.command.jobLink is set; jobs now live on slice.automation.jobLink. Re-save the model in the workbench to migrate.');
    const inferredReturnedFact = slice.command.jobLink.returnedFact
      ?? slice.command.outcomes?.[0]?.facts?.[0]
      ?? slice.outcomes?.[0]?.facts?.[0]
      ?? { id: '', name: '' };
    return resolveJobDef({ ...slice.command.jobLink, returnedFact: inferredReturnedFact }, factIdToName);
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
 */
export async function loadAutomatedSliceMap(
  skillsDir: string,
  interfaceSliceNames: Set<string>
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
        for (const slice of model.slices) {
          if (!slice.name) continue;
          // Only Automation pattern slices are dispatched via the event bus.
          // Interface slices are handled by the agent via triggerEventSet;
          // View slices are read-only and never event-driven.
          if (getSlicePattern(slice) !== 'automation') continue;
          if (interfaceSliceNames.has(slice.name)) continue;
          const skillMdPath = path.join(activityDir, slice.name, `${slice.name}.md`);
          for (const scenario of slice.scenarios ?? []) {
            for (const given of scenario.given ?? []) {
              if (!given.name) continue;
              const existing = map.get(given.name);
              if (existing) {
                if (!existing.includes(skillMdPath)) existing.push(skillMdPath);
              } else {
                map.set(given.name, [skillMdPath]);
              }
            }
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
