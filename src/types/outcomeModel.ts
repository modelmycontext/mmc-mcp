/**
 * Canonical outcome-model domain types — THE slice type (model-contract.md
 * Decision 1 / issue #72).
 *
 * Single source of truth for the slice/scenario/fact/job shapes the runtime
 * reads from an exported `<activity>.json` (the workbench's
 * `ExternalSliceModel`) or receives inline via `register-skills`. Both
 * execution engines (`sliceEvaluator`, `automatedSliceRunner`) and both
 * loaders (`resolveDiskSliceData`, `resolveInlineSliceData`) consume these —
 * there is deliberately no second "loading projection" anymore.
 *
 * Trust boundary: wire JSON enters through exactly two chokepoints — the
 * skill-engine's `readModel` (disk) and `register-skills` (session) — where it
 * is cast to these types without runtime validation. Fields that every real
 * export carries (`name` on slices and outcomes, `id`+`name` on facts) are
 * typed required; load boundaries skip entries missing them. Everything else
 * is optional because older exports legitimately omit it.
 *
 * The pattern (Interface / Automation / View) is structural, never stored:
 * `getSlicePattern` in `../skill-engine/sliceValidation.ts` is the only
 * discriminator (no `pattern` field — it would denormalise the components).
 *
 * Note: a parallel hand-maintained copy still lives in mmc-workbench
 * (`src/lib/slice-validation.ts` and the store model). Promoting these to a
 * shared package both repos consume is a separate, deferred follow-up — until
 * then, keep this in lock-step with the workbench shape.
 */
import type { BusinessRule, BusinessRuleLogic } from './businessRule.js';

export interface Fact {
  id: string;
  name: string;
  valueType?: string;
  defaultValue?: string;
  /** When true, `defaultValue` is a formula (e.g. `TODAY()`) evaluated via
   *  resolveFormulaValue when the fact has no value — a deterministic fallback,
   *  distinct from `isCalculated`/`calculatedValue` (which is always derived). */
  defaultIsFormula?: boolean;
  calculatedValue?: string;
  isCalculated?: boolean;
  expression?: string;
  /** Repeating value — rendered as an add/remove list by the form builder. */
  collection?: boolean;
  /** Sub-fields for a composite value type, embedded inline on the fact.
   *  Each references a value type by NAME. */
  fields?: ValueTypeField[];
  /** Allowed values for an enum value type. Absent in current exports — the
   *  form builder renders a <select> when present (see the workbench export
   *  change that emits these). */
  options?: string[];
}

/** A sub-field of a composite value type. Names a value type (the export uses
 *  `valueType`; the workbench canvas model uses `valueTypeId`). */
export interface ValueTypeField {
  name: string;
  valueType?: string;
  valueTypeId?: string;
}

/** Reference to an outcome event by name — the shape of `scenario.given[]`. */
export interface OutcomeRef {
  id?: string;
  name: string;
}

/** An Interaction Outcome (slice-level `outcomes[]` or a scenario's `then[]`
 *  entry). `then` entries typically carry only `name` + `facts`. */
export interface Outcome {
  id?: string;
  name: string;
  facts?: Fact[];
  role?: string;
  outcomeStream?: string;
}

export interface Scenario {
  id?: string;
  given?: OutcomeRef[];
  givenBusinessRule?: string;
  givenBusinessRules?: BusinessRule[];
  givenBusinessRuleLogic?: BusinessRuleLogic;
  when?: unknown;
  whenBusinessRule?: string;
  whenBusinessRules?: BusinessRule[];
  whenBusinessRuleLogic?: BusinessRuleLogic;
  then?: Outcome[];
  error?: string;
}

/**
 * Wire-format mirror of the workbench's `Job` (entity-only). Reusable
 * tool-callable definition: identifies the tool and its param shape.
 * Per-use bindings (input/output fact mappings) live on
 * the surrounding {@link JobLink}, not here.
 */
export interface JobDef {
  id?: string;
  name?: string;
  toolId: string;
  staticParams?: Record<string, any>;
  dynamicParams?: string[];
  inputFactIds?: string[];
}

/**
 * Wire-format mirror of the workbench's `JobLink`. Pairs a Job entity with
 * its per-use bindings: which fact populates each input param, and which fact
 * (and optional sub-field) each output field stores into.
 *
 * `outputMappings`: tool output field name → `{factId, factName, fieldName?}`.
 * The runner stores `jobResult[outputField]` under `factName` (or, when
 * `fieldName` is set, into that sub-field of a composite fact's value). It is
 * the sole extraction mechanism — there is no `returnedFact` fallback.
 */
export interface JobLink {
  job: JobDef;
  inputMappings?: Record<string, string>;
  outputMappings?: Record<string, { factId: string; factName: string; fieldName?: string }>;
  /** Some exports carry the job's input facts inline on the link; the fact
   *  scope-walker (`addSliceFactsToMap`) includes them in the slice contract. */
  facts?: Fact[];
}

/**
 * Legacy inline job shape (pre-`jobLink` exports carried the bindings and the
 * tool id on one object, directly on `command.job` / `query.job`). Still
 * accepted by `resolveJobParams`; current exports emit `jobLink` instead.
 */
export interface CommandJob {
  id?: string;
  name?: string;
  toolId?: string;
  staticParams?: Record<string, any>;
  dynamicParams?: string[];
  inputMappings?: Record<string, string>;
}

export interface Query {
  id?: string;
  name?: string;
  /** Natural-language instruction for LLM evaluation (ai.eval path) when no
   *  tool-backed job is bound. */
  text?: string;
  facts?: Fact[];
  /** The query's READ SCOPE (which outcome events it reads) — never a trigger
   *  (see slice-patterns.md §Triggering). */
  outcomes?: Outcome[];
  jobLink?: JobLink;
  /** Legacy inline job — see {@link CommandJob}. */
  job?: CommandJob;
}

export interface Command {
  id?: string;
  /** Command name (e.g. "start-nzta-application") — the user-facing task label. */
  name?: string;
  facts?: Fact[];
  outcomes?: Outcome[];
  /** Legacy: jobs moved to `slice.automation.jobLink`; kept for un-migrated
   *  models (extractSliceAutomationJob warns when it falls back to this). */
  jobLink?: JobLink;
  /** Legacy inline job — see {@link CommandJob}. */
  job?: CommandJob;
  mode?: 'job' | 'instruction' | 'passthrough';
  instruction?: string;
  /** Legacy alias for `instruction`. */
  text?: string;
}

export interface Automation {
  facts?: Fact[];
  jobLink?: JobLink;
  mode?: 'job' | 'instruction';
  instruction?: string;
  /**
   * Authoritative list of the facts this automation contractually produces.
   * When present, readers MUST use it instead of inferring from
   * `slice.outcomes[0].facts`. The inference is only a fallback for legacy
   * models that haven't been re-saved by a workbench that emits this field.
   */
  outputFacts?: Fact[];
}

/** The interface component (human/system input declaration). Presence makes
 *  the slice Interface-pattern (when a command is also present). */
export interface InterfaceDef {
  id?: string;
  name?: string;
  description?: string;
  role?: string;
  facts?: Fact[];
}

/**
 * A single slice (one entry from `model.slices`). The pattern is inferred
 * from shape via `getSlicePattern`:
 *   no `command`        → 'view'
 *   has `interface`     → 'interface'
 *   otherwise           → 'automation'
 */
export interface Slice {
  /** Optional: legacy JSON may omit `id` (mmc-mcp synthesises a fallback). */
  id?: string;
  index?: number;
  name: string;
  role?: string;
  facts?: Fact[];
  outcomes?: Outcome[];
  scenarios?: Scenario[];
  queries?: Query[];
  command?: Command;
  automation?: Automation;
  interface?: InterfaceDef;
}

/**
 * An external outcome — an inbound event a system outside the workflow posts
 * (via the `/external-events/:eventType` webhook). Declared at the activity
 * level; a slice subscribes to it through an `external` {@link ExternalOutcomeLink}.
 */
export interface ExternalOutcome {
  id: string;
  name: string;
  systemId?: string;
  facts?: Fact[];
}

/**
 * An activity-level outcome link. The runtime only routes the `external`
 * variant: `fromId` is an {@link ExternalOutcome} id, `toId` is the id of a
 * slice's {@link Query}. It connects the inbound webhook event to the slice
 * that consumes it — the registry equivalent of a `scenario.given[]`
 * subscription for external events (which the canvas authors here, not in
 * `given[]`).
 */
export interface ExternalOutcomeLink {
  fromId: string;
  toId: string;
  type: string;
  name?: string;
  fromActivityId?: string;
  toActivityId?: string;
}

/** The parsed `<activity>.json` file — the disk wire format. */
export interface OutcomeModel {
  slices?: Slice[];
  /** Activity-level external-event registry (the workbench export emits these
   *  alongside `slices`). Used to route inbound webhook events to the
   *  subscribing slice — see {@link ExternalOutcomeLink}. */
  externalOutcomes?: ExternalOutcome[];
  outcomeLinks?: ExternalOutcomeLink[];
}

// --- Form-spec shapes (consumed by src/ui/formSpec.ts and the ui:// renderer) ---

export type FormControlKind =
  | 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'checkbox' | 'select' | 'composite';

export interface FormControl {
  kind: FormControlKind;
  /** Present for `select`. */
  options?: string[];
  /** Present for `composite` — the resolved sub-field controls. */
  fields?: FormField[];
  /** Original value-type name, for display/debugging. */
  typeName?: string;
}

export interface FormField {
  factId: string;
  /** Kebab fact name — the key used in the `complete-slice` facts payload. */
  name: string;
  label: string;
  control: FormControl;
  collection: boolean;
  readOnly: boolean;
  required?: boolean;
  /** Optional prefilled / context value. */
  value?: unknown;
}

export interface FormSection {
  id: string;
  title: string;
  readOnly: boolean;
  note?: string;
  fields: FormField[];
}

/** A decision button. Each action stamps `set` (kebab fact name → value) into
 *  the collected facts and submits the SAME `complete-slice` payload, letting
 *  the slice's first-match scenarios route to the matching outcome. Emitted in
 *  place of a single submit when an interface slice's sole enum input gates
 *  more than one outcome (e.g. Approve / Decline). */
export interface FormAction {
  label: string;
  /** Kebab fact name → value to stamp before submitting. */
  set: Record<string, unknown>;
  variant?: 'primary' | 'default' | 'danger';
}

/** The full spec the ui:// renderer needs to draw an interface slice as a form
 *  and submit it back via `complete-slice`. */
export interface FormSpec {
  /** slice.id — the `complete-slice` routing key. */
  sliceId: string;
  /** Kebab slice/tool name (display label). */
  toolName: string;
  title: string;
  description: string;
  submitLabel: string;
  /** When present, render these decision buttons instead of the single submit;
   *  each stamps its `set` facts and posts the same complete-slice payload. */
  actions?: FormAction[];
  /** 'interface' = editable + submit; 'view' = read-only display, no submit. */
  kind?: 'interface' | 'view';
  sections: FormSection[];
  submit: { tool: 'complete-slice'; sliceIdArg: string };
}
