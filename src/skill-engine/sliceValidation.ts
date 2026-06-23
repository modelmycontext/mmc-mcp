/**
 * Slice pattern detection + per-pattern composition validation.
 *
 * The canonical, I/O-free rulebook for how slices are composed (Interface /
 * Automation / View). mmc-mcp enforces these at load time
 * (`validateSlice` wired into `loadWorkflowDefinitions`); mmc-workbench
 * maintains a hand-ported copy of the same rules — drift between them is a bug.
 *
 * Extracted from `interaction-slice-trigger-events.ts` so the rulebook has a
 * single focused home; that module re-exports these for backward compatibility.
 */

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
import type { Scenario, Slice } from '../types/outcomeModel.js';

export type SlicePattern = 'interface' | 'automation' | 'view';

export function getSlicePattern(slice: Slice | null | undefined): SlicePattern {
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
  | 'VIEW_HAS_WHEN'
  | 'VIEW_MISSING_QUERIES'
  | 'VIEW_MISSING_SCENARIO';

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
 *   - View: requires 1+ Queries. Forbids Command and emitted Outcomes.
 *     A View MAY carry `given`+`then` scenarios — `then` is the
 *     displayed-facts contract (what the View renders from instance
 *     state), NOT an emitted Interaction Outcome. A View must NOT carry
 *     a `When` guard (whenBusinessRules) — Views make no decision and
 *     cannot reject events.
 *
 * Pure transformation — no I/O. The pattern is inferred from the slice
 * shape via {@link getSlicePattern}, then pattern-specific rules run.
 * Each error carries a stable {@link SliceValidationCode} so tooling can
 * match by code rather than message wording.
 */
export function validateSlice(slice: Slice): SliceValidationResult {
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
    const hasSubscription = scenarios.some((s: Scenario) => Array.isArray(s?.given) && s.given.length > 0);
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
    // A View must declare its trigger via scenario.given (OR-of-ANDs:
    // one scenario per alternative upstream branch). The legacy
    // query.outcomeLinks fallback was removed in the workbench
    // serializer, so a view without any scenarios has no subscription
    // at all — it never fires.
    if (scenarios.length === 0) {
      errors.push({ code: 'VIEW_MISSING_SCENARIO', message: 'View pattern requires at least 1 scenario (its `given` is the subscription).' });
    }
    // A View's scenario.then is the displayed-facts contract (read live
    // from instance state by its query), not an emitted Outcome — so a
    // `then` is allowed. What a View must NOT have is a `When` guard:
    // Views make no decision and cannot reject events.
    const guarded = scenarios.filter((s: Scenario) =>
      (Array.isArray(s?.whenBusinessRules) && s.whenBusinessRules.length > 0) ||
      (typeof s?.whenBusinessRule === 'string' && s.whenBusinessRule.trim().length > 0)
    );
    if (guarded.length > 0) {
      errors.push({ code: 'VIEW_HAS_WHEN', message: 'View pattern scenarios cannot have a `When` guard (Views make no decision).' });
    }
  }

  return { pattern, errors };
}
