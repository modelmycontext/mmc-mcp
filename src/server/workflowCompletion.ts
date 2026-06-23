/**
 * Pure decision core for last-branch-closes workflow completion.
 *
 * Extracted from the `eventBus.subscribe('*')` router in `server/index.ts` so
 * the completion semantics can be unit-tested without standing up the server
 * (same rationale as `dispatchLatestEvent`). The router shell only gathers
 * inputs (terminus sets, in-flight count, open todos) and performs side
 * effects (deliver to connections, `setTimeout`); ALL branching lives here.
 *
 * Model: a terminus closes a *branch*, not the workflow. First-past-the-post
 * is gone — `workflow_completed` is emitted once, only when the session has
 * quiesced (no automated branch in flight AND no interface branch still owed).
 *
 * See mmc-knowledge architecture/workflow-execution.md.
 */

export type TerminusKind = 'terminus' | 'wiring-gap';

export interface ClassifyTerminusInput {
  eventType: string;
  /**
   * Union of every workflow's `terminalEventTypes` — outcome event types no
   * slice in the workflow consumes. Structural; a cross-workflow/external
   * consumer is invisible here (that distinction only matters for the
   * deferred awaiting-callback work, not for branch-close classification).
   */
  terminalEventTypes: Set<string>;
  /**
   * True if a session-registered skill *publishes* this event type. Session
   * workflows aren't on disk, so this is how a session-scoped terminus is
   * recognised.
   */
  sessionPublishesType: boolean;
}

/**
 * An unhandled event (no interface/automated consumer) is either a known
 * terminus — a branch endpoint — or a genuine wiring gap (a stray publish
 * from a misconfigured slice). A wiring gap stops the agent; a terminus does
 * not (it is delivered as `branch_completed` progress).
 */
export function classifyTerminus(input: ClassifyTerminusInput): TerminusKind {
  if (input.terminalEventTypes.has(input.eventType)) return 'terminus';
  if (input.sessionPublishesType) return 'terminus';
  return 'wiring-gap';
}

export type QuiescenceDecision = 'complete' | 'wait';

export interface QuiescenceInput {
  /** `workflow_completed` already emitted for this session — never emit twice. */
  completionEmitted: boolean;
  /** Automated slice handlers dispatched but not yet settled for this session. */
  inFlightCount: number;
  /** Any pending/claimed interface or view todo for this session. */
  hasOpenTodo: boolean;
  /**
   * The workflow declares an inbound external event (e.g. a form-submission
   * webhook) that has not yet arrived on this session's bus — an open
   * awaiting-callback obligation. The run is paused waiting for the outside
   * world (the applicant), not done. Registry-derived; see
   * workflow-execution.md fixpoint point 3. Optional so existing callers that
   * predate the obligation keep compiling (treated as `false`).
   */
  hasOpenAwaitingCallback?: boolean;
}

/**
 * Deferred quiescence decision. The workflow is complete only when the last
 * branch has closed: no automated branch in flight AND no interface branch
 * still owed. Until then a terminus is just a branch close and we wait — a
 * still-running sibling branch re-arms this check when it ends.
 *
 * This is what fixes the credit-decisioning decline amputation: on a decline
 * the single `application-declined` event fans out to `record-decision`
 * (→ `decision-recorded`), `issue-adverse-action` (→ `adverse-action-issued`)
 * and the `show-credit-decision` interface slice. The first automated
 * terminus no longer ends the run while the other branch / the applicant's
 * `show-credit-decision` todo are still outstanding.
 */
export function evaluateQuiescence(input: QuiescenceInput): QuiescenceDecision {
  if (input.completionEmitted) return 'wait';
  if (input.inFlightCount > 0) return 'wait';
  if (input.hasOpenTodo) return 'wait';
  // The run reached a branch end but the model still expects an inbound
  // external event (the applicant's form). Hold — the webhook re-arms this
  // check when it arrives.
  if (input.hasOpenAwaitingCallback) return 'wait';
  return 'complete';
}
