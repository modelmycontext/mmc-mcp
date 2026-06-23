import { logger } from '@src/utils/logger.js';
import type { EventBus, Event } from '@src/events/eventBus.js';
import type { EventStore } from '@src/events/eventStoreTypes.js';
import type { TodoStoreLike } from '@src/services/todoStore.js';
import type { WorkflowDefinition, WorkflowSliceSummary } from '@src/skill-engine/interaction-slice-trigger-events.js';
import { evaluateBusinessRules } from '@src/utils/businessRuleEvaluator.js';
import { ingestScopedFacts } from '@src/services/automatedSliceRunner.js';
import { flattenPayload } from '@src/utils/factValueResolver.js';
import { toKebabCase } from '@src/utils/stringUtils.js';

export interface TodoProcessorDeps {
  eventBus: EventBus;
  eventStore: EventStore;
  /**
   * Test-session isolation is handled by the store itself (TestAwareTodoStore
   * routes test sessions to an in-memory backend), so TodoProcessor runs
   * uniformly for test and production sessions — same todo/completion
   * semantics, no early-return divergence.
   */
  todoStore: TodoStoreLike;
  /** Mutable map — reloaded on resync. The DISK topology (external clients). */
  workflows: Map<string, WorkflowDefinition>;
  /**
   * Is this a session-scoped (workbench Test panel) run? Mirrors the canonical
   * `isSessionScoped` (#73) used by the automated-slice dispatcher. When true,
   * todo eligibility resolves against the INLINE model the run pushed via
   * `register-skills` ({@link getInlineWorkflow}) and NEVER the disk export —
   * exactly as automation/interface dispatch consults `sessionSkills`, never
   * disk. Optional: when unset (unit tests), all sessions take the disk path.
   */
  isSessionScoped?: (correlationId: string | undefined) => boolean;
  /** The inline workflow topology for a session-scoped run, or undefined. */
  getInlineWorkflow?: (correlationId: string) => WorkflowDefinition | undefined;
  /**
   * Surface a NOTABLE "no eligible scenario" outcome to the session's client.
   * Fired only when the triggering event actually matched one of the slice's
   * scenario givens (so the slice IS relevant to this event) but the slice still
   * could not proceed — a prerequisite given event is missing, or a business
   * rule failed. Benign skips (the event is unrelated to the slice) never fire
   * this. This turns the formerly-silent `logger.debug('No scenario eligible')`
   * into an observable signal, so a wiring deadlock (a slice waiting on an event
   * that will never arrive) is visible instead of a silent premature completion.
   */
  onSliceDeferred?: (info: {
    correlationId: string;
    sliceName: string;
    role: string;
    pattern: 'interface' | 'view';
    triggerEventType: string;
    /** Given events this slice still needs but the session hasn't seen. */
    missingGivens: string[];
    /** True if a matched scenario was blocked by a failed business rule. */
    rulesFailed: boolean;
  }) => void;
}

/**
 * Event-sourced todo processor.
 *
 * Subscribes to all events on the bus. On each event:
 * 1. Determines which workflow the session belongs to
 * 2. Reads the current session state (event types present)
 * 3. Walks the workflow's slices in order
 * 4. For interface slices whose preconditions are now met, creates a todo record
 * 5. When a slice's outcome events appear, marks its todo as completed
 */
export class TodoProcessor {
  private deps: TodoProcessorDeps;
  /** Caches correlationId → workflow name for fast lookup. */
  private correlationWorkflowCache = new Map<string, string>();

  constructor(deps: TodoProcessorDeps) {
    this.deps = deps;
  }

  /**
   * Registers the wildcard subscriber on the EventBus.
   * Call once at startup, after the persist subscriber.
   */
  register(): void {
    this.deps.eventBus.subscribe('*', (event) => this.handleEvent(event));
    logger.info('[TodoProcessor] Registered on EventBus');
  }

  async handleEvent(event: Event): Promise<void> {
    if (!event.correlationId) return;
    const correlationId = event.correlationId;

    try {
      const workflow = this.resolveWorkflow(event);
      if (!workflow) return; // event doesn't belong to any known workflow

      // Current session state: all event types present
      const sessionEventTypes = this.deps.eventStore.getCorrelationEventTypes(correlationId);
      sessionEventTypes.add(event.type); // include triggering event (may not be persisted yet)

      const sessionFactValues = this.deps.eventStore.getCorrelationFactValues(correlationId);

      for (const slice of workflow.slices) {
        // Automation slices run server-side via AutomatedSliceRunner and never
        // surface as todos. Interface AND view slices both need todos: interface
        // collects user input via complete-slice, view renders an upstream
        // event payload as a read-only display. The todo's `pattern` field
        // tells the client which render path to take.
        if (slice.pattern === 'automation') continue;

        // ── Complete a finished step ────────────────────────────────────────
        // A CLAIMED todo whose slice OUTCOME has now arrived on the bus is done.
        // Runs BEFORE the eligibility evaluation below, and that ordering is the
        // whole point of this fix: a slice is NEVER "eligible" on its own
        // outcome event (the outcome is not one of its givens), so gating this
        // behind `anyScenarioEligible` — as it used to be — made it unreachable
        // on the exact event that should close the todo. A claimed interface
        // todo then never completed → `hasOpenTodo` stuck → the run never
        // quiesced → no `workflow_completed` and the form re-presented. The Test
        // panel relies on this server-side close (it claims via claim-todo but
        // never calls resolve-todo; the disk/agent path resolves explicitly,
        // which is why this only ever bit the Test-panel e2e).
        //
        // Safe to run unconditionally: no-op unless a CLAIMED todo for THIS
        // slice exists AND its outcome is present (so the slice genuinely
        // emitted); re-runs are no-ops once status flips to 'completed'. Must
        // stay BEFORE the insertPendingIfAbsent dedup below (a claimed sibling
        // is treated as a live duplicate there). NOTE: this completes on outcome
        // presence regardless of which event triggered — if two slices ever
        // share an outcome event type, revisit (todos are matched per-slice, so
        // only THIS slice's claim is touched).
        const existing = this.deps.todoStore.findBySliceAndCorrelation(slice.name, correlationId);
        if (existing && existing.status === 'claimed' && slice.outcomeEventTypes.length > 0) {
          const allOutcomesPresent = slice.outcomeEventTypes.some(ot =>
            sessionEventTypes.has(ot) || sessionEventTypes.has(toKebabCase(ot))
          );
          if (allOutcomesPresent) {
            this.deps.todoStore.complete(existing.id);
            logger.info(
              { sliceName: slice.name, correlationId, todoId: existing.id },
              '[TodoProcessor] Marked todo as completed'
            );
          }
        }

        // Check preconditions: at least one scenario must have BOTH its given[] events
        // present AND its givenBusinessRules evaluate to true against session facts.
        // This prevents todos from being created for slices whose business rules
        // (e.g. "amount >= threshold") are not satisfied by the current session state.
        let anyScenarioEligible = false;
        // Deferral diagnostics: did THIS event match a scenario's given (so the
        // slice is genuinely relevant to it), and if so why couldn't it proceed?
        let triggerRelevant = false;
        let rulesFailed = false;
        const missingGivens = new Set<string>();
        if (slice.scenarios.length === 0) {
          // Legacy fallback: no scenario details — fall back to event-groups check
          anyScenarioEligible = slice.givenEventGroups.length === 0 ||
            slice.givenEventGroups.some(group => group.every(et => sessionEventTypes.has(et)));
        } else {
          for (const scenario of slice.scenarios) {
            // Error scenarios describe failure/validation branches — they must not
            // contribute to todo eligibility. Otherwise an "always-eligible" error
            // scenario (empty given + empty rules) would create phantom todos at
            // workflow start for every slice that defines such an error case.
            if (scenario.error) continue;
            if (scenario.givenEventNames.length > 0) {
              // The triggering event must be one of THIS scenario's givens.
              // If unrelated, the scenario was either already eligible before
              // this event (any todo it deserves already exists) or still
              // ineligible (other givens missing). Re-evaluating on an
              // unrelated event creates phantom duplicates — observed when a
              // downstream automation's outcome event (e.g. underwriter-approved
              // from resolve-underwriter-decision) re-fired an upstream
              // interface slice (underwriter-review) whose given
              // (application-referred) was still in the session set.
              const triggerKebab = toKebabCase(event.type);
              const matchesScenario = scenario.givenEventNames.some(
                et => et === event.type || toKebabCase(et) === triggerKebab,
              );
              if (!matchesScenario) continue;
              // This event IS one of the slice's triggers. If the slice can't
              // proceed it's a notable deferral, not a benign unrelated skip.
              triggerRelevant = true;
              const missing = scenario.givenEventNames.filter(
                et => !sessionEventTypes.has(et) && !sessionEventTypes.has(toKebabCase(et)),
              );
              if (missing.length > 0) {
                missing.forEach(m => missingGivens.add(m));
                continue;
              }
            }
            if (scenario.givenBusinessRules.length === 0) {
              anyScenarioEligible = true;
              break;
            }
            const rulesPass = await evaluateBusinessRules(
              scenario.givenBusinessRules,
              sessionFactValues,
              slice.factIdToName,
              undefined, // no LLM evaluator — deterministic rules only for todo eligibility
              scenario.givenBusinessRuleLogic,
            );
            if (rulesPass) {
              anyScenarioEligible = true;
              break;
            }
            rulesFailed = true;
          }
        }
        if (!anyScenarioEligible) {
          logger.debug(
            { sliceName: slice.name, correlationId, eventType: event.type, triggerRelevant, missingGivens: [...missingGivens], rulesFailed },
            '[TodoProcessor] No scenario eligible — skipping todo creation'
          );
          // Expose the NOTABLE case to the client. The event triggered this slice
          // but it can't advance. This is meant to reveal a WIRING GAP — a slice
          // gated on an outcome that NO slice in the workflow produces, so it
          // would wait forever.
          //
          // Crucial distinction (an AND-join is NOT a deadlock): a missing given
          // that some slice DOES produce is just normal in-progress waiting, OR a
          // mutually-exclusive branch that fired elsewhere this run. Example: the
          // DA `application-approved` slice is an AND-join on
          // [applicant-age-eligible, application-received]. When an OVER/UNDERAGE
          // applicant's `application-received` arrives, `applicant-age-eligible`
          // is "missing" — but it is produced by `validate-applicant-age` (which
          // emitted the overage/underage sibling instead), so the slice is simply
          // not applicable, not deadlocked. Surfacing it as "pending
          // application-approved" is a false positive. Only count a missing given
          // as notable when NO slice produces it (a true wiring gap).
          const notableMissing = [...missingGivens].filter(g => {
            const gk = toKebabCase(g);
            return !workflow.slices.some(s =>
              s.outcomeEventTypes.some(o => o === g || toKebabCase(o) === gk),
            );
          });
          if (triggerRelevant && (notableMissing.length > 0 || rulesFailed)) {
            this.deps.onSliceDeferred?.({
              correlationId,
              sliceName: slice.name,
              role: slice.role,
              pattern: slice.pattern === 'view' ? 'view' : 'interface',
              triggerEventType: event.type,
              missingGivens: notableMissing,
              rulesFailed,
            });
          }
          continue;
        }

        // If the triggering event is one of THIS slice's outcome events, the
        // slice just emitted — do not loop back to create another todo. The
        // completion check at the top of the loop already handled any active
        // claim (it now runs unconditionally, ahead of eligibility). Without
        // this guard, eligibility passes (the slice's GIVEN event is still
        // in the session set from earlier) and a phantom pending todo gets
        // created on every outcome fire.
        const isOwnOutcome = slice.outcomeEventTypes.some(
          ot => ot === event.type || toKebabCase(ot) === event.type
        );
        if (isOwnOutcome) continue;

        // Entry-point interface slices (no given[] events) don't need todos —
        // they're triggered directly by the user/agent connecting.
        if (slice.givenEventGroups.length === 0) continue;

        // Create a new pending todo — resolve the slice's read-model from
        // the triggering event's payload, falling back to session-wide
        // values for facts not carried by this event (typically bare-key
        // identifiers like application-id emitted earlier in the workflow).
        //
        // Why this shape:
        //   • Per Event Modeling, a slice's `scenario.given[]` declares the
        //     events whose facts it may resolve; `slice.factIdToName` is the
        //     authoritative contract built by `buildScopedFactIdToName`.
        //   • Outcome events publish facts under `<sliceId>:<factName>`
        //     scoped keys. `ingestScopedFacts` strips that prefix against the
        //     contract and drops anything outside it (prevents cross-slice
        //     leakage — the original intent of commit 33f421c, which the
        //     prior `factNames.includes(k)` filter was silently failing to
        //     achieve because session keys are scoped while factNames are
        //     bare).
        //   • We run `ingestScopedFacts` separately on session and on the
        //     triggering event, then merge with the trigger spread LAST.
        //     Each call resolves to bare-name keys, so the merge happens at
        //     the bare-name level — the trigger event's value overrides any
        //     stale value the session resolved from an earlier scoped key
        //     under the same name. This is what fixes the `referred` vs
        //     `approved` collision: even if session's first-match-wins picks
        //     up make-credit-decision's `decision = referred`, the trigger
        //     event (underwriter-approved) overrides it with `approved`.
        //   • Mirrors automatedSliceRunner.ts:558–561, so views and
        //     automations resolve facts identically.
        const todoId = `todo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const sessionResolved = ingestScopedFacts(sessionFactValues, slice.factIdToName);
        const triggerResolved = ingestScopedFacts(flattenPayload(event.payload), slice.factIdToName);
        const filteredPayload: Record<string, any> = { ...sessionResolved, ...triggerResolved };
        const inserted = this.deps.todoStore.insertPendingIfAbsent({
          id: todoId,
          correlationId: correlationId,
          sliceName: slice.name,
          role: slice.role,
          status: 'pending',
          triggerEventType: event.type,
          payload: filteredPayload,
          createdAt: new Date().toISOString(),
          pattern: slice.pattern === 'view' ? 'view' : 'interface',
        });
        if (!inserted) continue;

        logger.info(
          { sliceName: slice.name, role: slice.role, pattern: slice.pattern, correlationId, todoId, triggerEventType: event.type },
          `[TodoProcessor] Created pending todo for ${slice.pattern} slice`
        );
      }
    } catch (err: any) {
      logger.error(
        { error: err.message, eventType: event.type, correlationId },
        '[TodoProcessor] Error processing event'
      );
    }
  }

  /**
   * Resolves which workflow a session belongs to.
   * Uses the event's source (slice name) to find the parent workflow,
   * or falls back to checking all workflows for matching event/outcome types.
   */
  private resolveWorkflow(event: Event): WorkflowDefinition | null {
    const correlationId = event.correlationId!;

    // Session-scoped (workbench Test panel) runs: resolve against the INLINE
    // model the run pushed via register-skills — never the disk export, and
    // never the disk cache below. This is the same test-vs-disk seam the
    // automated-slice dispatcher uses (`isSessionScoped` → sessionSkills, never
    // disk): a test session must create interface/view todos for the model
    // UNDER TEST, even if it was never published to disk or the disk copy is
    // stale. Not cached — a Rebuild replaces the run's inlineWorkflow and the
    // next event must see the new topology.
    if (this.deps.isSessionScoped?.(correlationId)) {
      return this.deps.getInlineWorkflow?.(correlationId) ?? null;
    }

    // Disk-scoped (external clients, e.g. mmc-workflow). Check cache first.
    const cached = this.correlationWorkflowCache.get(correlationId);
    if (cached) return this.deps.workflows.get(cached) ?? null;

    // Try to match by event source (slice name)
    for (const [name, wf] of this.deps.workflows) {
      const sourceName = event.source?.includes('/') ? event.source.split('/').pop() : event.source;
      const matchBySource = wf.slices.some(s => s.name === sourceName);
      if (matchBySource) {
        this.correlationWorkflowCache.set(correlationId, name);
        return wf;
      }
    }

    // Try to match by event type (as a trigger or outcome)
    for (const [name, wf] of this.deps.workflows) {
      const matchByTrigger = wf.automatedTriggerMap.has(event.type);
      const matchByOutcome = wf.slices.some(s =>
        s.outcomeEventTypes.some(ot => ot === event.type || toKebabCase(ot) === event.type)
      );
      const matchByGiven = wf.slices.some(s =>
        s.givenEventGroups.some(group => group.includes(event.type))
      );
      if (matchByTrigger || matchByOutcome || matchByGiven) {
        this.correlationWorkflowCache.set(correlationId, name);
        return wf;
      }
    }

    return null;
  }

  /** Clear the session-workflow cache (e.g. on resync). */
  invalidateCache(): void {
    this.correlationWorkflowCache.clear();
  }

  /** Drop one session's cached workflow resolution on WorkflowRun GC (#73). */
  dropCorrelation(correlationId: string): void {
    this.correlationWorkflowCache.delete(correlationId);
  }
}
