import fs from 'fs/promises';
import path from 'path';
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
  automation?: { jobLink?: AutomationJobLink }
}

interface OutcomeModel { slices?: Slice[] }

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
          if (!slice.interface) continue; // only interface-bearing slices need agent notification
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

          const outcomeEventTypes = (slice.outcomes ?? [])
            .filter(o => o.name)
            .map(o => o.name!);

          const factNames = (slice.facts ?? [])
            .map(f => f.name)
            .filter((n): n is string => !!n);

          slices.push({
            name: slice.name,
            role: slice.role ?? '',
            isInterface: !!slice.interface,
            givenEventGroups,
            outcomeEventTypes,
            scenarios,
            factNames,
            factIdToName: buildScopedFactIdToName(slice, eventSchemaIndex),
          });
        }

        // Build automated trigger map from .md frontmatter
        const activityDir = path.dirname(full);
        try {
          const dirEntries = await fs.readdir(activityDir, { withFileTypes: true });
          for (const de of dirEntries) {
            if (!de.isDirectory()) continue;
            const mdPath = path.join(activityDir, de.name, `${de.name}.md`);
            try {
              const content = await fs.readFile(mdPath, 'utf-8');
              const match = content.match(/^triggers_on_event:\s*(.+)$/m);
              if (!match) continue;
              const raw = match[1].trim().replace(/^"|"$/g, '');
              for (const et of raw.split('|').map(s => s.trim()).filter(Boolean)) {
                automatedTriggerMap.set(et, de.name);
              }
            } catch { /* skip missing .md files */ }
          }
        } catch { /* skip */ }

        workflows.set(activityName, { name: activityName, slices, automatedTriggerMap });
      } catch { /* skip malformed JSON */ }
    }
  }

  await walk(skillsDir);
  return workflows;
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
          if (slice.interface && slice.name) names.add(slice.name);
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
  }
  for (const f of slice?.command?.facts ?? []) add(f);
  for (const o of slice?.command?.outcomes ?? []) for (const f of o?.facts ?? []) add(f);
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
 * @deprecated Use loadSliceCommandJob or loadSliceQueryJobs instead.
 */
export async function loadSliceJob(
  skillMdPath: string,
  factIdToName: Map<string, string>
): Promise<AutomationJob | null> {
  // Try command job first, fall back to automation job for backward compatibility
  const commandJob = await loadSliceCommandJob(skillMdPath, factIdToName);
  if (commandJob) return commandJob;

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
 * Resolves the slice's command job (write operation) into an AutomationJob,
 * or returns null when no command job is defined. Pure transformation — no I/O.
 */
export function extractSliceCommandJob(
  slice: Slice,
  factIdToName: Map<string, string>,
): AutomationJob | null {
  if (!slice.command?.jobLink) return null;
  const inferredReturnedFact = slice.command.jobLink.returnedFact
    ?? slice.command.outcomes?.[0]?.facts?.[0]
    ?? slice.outcomes?.[0]?.facts?.[0]
    ?? { id: '', name: '' };
  return resolveJobDef({ ...slice.command.jobLink, returnedFact: inferredReturnedFact }, factIdToName);
}

/**
 * Loads the command job definition for a slice (write operation).
 * Returns null if no command job is defined.
 */
export async function loadSliceCommandJob(
  skillMdPath: string,
  factIdToName: Map<string, string>
): Promise<AutomationJob | null> {
  const loaded = await loadSliceFromMdPath(skillMdPath);
  if (!loaded) return null;
  return extractSliceCommandJob(loaded.slice, factIdToName);
}

/**
 * Resolves an instruction-mode command's prompt and the name of the fact
 * it should populate, or returns null when the command has no
 * instruction (e.g. it is a job-mode command or no command at all).
 * Pure transformation — no I/O.
 */
export function extractSliceCommandInstruction(
  slice: Slice,
): { instruction: string; outputFactName: string } | null {
  if (!slice.command?.instruction || slice.command.mode !== 'instruction') return null;
  const outputFactName =
    slice.command.outcomes?.[0]?.facts?.[0]?.name
    ?? slice.outcomes?.[0]?.facts?.[0]?.name
    ?? '';
  if (!outputFactName) return null;
  return { instruction: slice.command.instruction, outputFactName };
}

/**
 * Returns the LLM instruction for an instruction-mode command, along with
 * the name of the output fact it should produce. Returns null when the command
 * has no instruction (e.g. it is a job-mode command or has no command at all).
 */
export async function loadSliceCommandInstruction(
  skillMdPath: string
): Promise<{ instruction: string; outputFactName: string } | null> {
  const loaded = await loadSliceFromMdPath(skillMdPath);
  if (!loaded) return null;
  return extractSliceCommandInstruction(loaded.slice);
}

/**
 * Scans skill .md files and returns a map of trigger event type → skill file path
 * for automated (non-interface) slices. Reads `triggers_on_event` from frontmatter.
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
      if (!e.name.endsWith('.md')) continue;
      const dirName = path.basename(path.dirname(full));
      if (dirName === path.basename(skillsDir)) continue;  // root-level skill
      if (interfaceSliceNames.has(dirName)) continue;       // interface slice
      try {
        const content = await fs.readFile(full, 'utf-8');
        const match = content.match(/^triggers_on_event:\s*(.+)$/m);
        if (!match) continue;
        const raw = match[1].trim().replace(/^"|"$/g, '');
        for (const et of raw.split('|').map(s => s.trim()).filter(Boolean)) {
          const existing = map.get(et);
          if (existing) { existing.push(full); } else { map.set(et, [full]); }
        }
      } catch { /* skip */ }
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
