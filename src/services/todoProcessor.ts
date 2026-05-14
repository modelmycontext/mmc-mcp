import { logger } from '@src/utils/logger.js';
import type { EventBus, Event } from '@src/events/eventBus.js';
import type { EventStore } from '@src/events/eventStoreTypes.js';
import type { TodoStore } from '@src/services/todoStore.js';
import type { WorkflowDefinition, WorkflowSliceSummary } from '@src/skill-engine/interaction-slice-trigger-events.js';
import { evaluateBusinessRules } from '@src/utils/businessRuleEvaluator.js';
import { toKebabCase } from '@src/utils/stringUtils.js';

export interface TodoProcessorDeps {
  eventBus: EventBus;
  eventStore: EventStore;
  todoStore: TodoStore;
  /** Mutable map — reloaded on resync. */
  workflows: Map<string, WorkflowDefinition>;
  /** Sessions marked as test-only — skip todo creation/completion for these. */
  testSessions?: Set<string>;
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
  /** Caches sessionId → workflow name for fast lookup. */
  private sessionWorkflowCache = new Map<string, string>();

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
    if (!event.sessionId) return;
    if (this.deps.testSessions?.has(event.sessionId)) return; // skip test sessions
    const sessionId = event.sessionId;

    try {
      const workflow = this.resolveWorkflow(event);
      if (!workflow) return; // event doesn't belong to any known workflow

      // Current session state: all event types present
      const sessionEventTypes = this.deps.eventStore.getSessionEventTypes(sessionId);
      sessionEventTypes.add(event.type); // include triggering event (may not be persisted yet)

      const sessionFactValues = this.deps.eventStore.getSessionFactValues(sessionId);

      for (const slice of workflow.slices) {
        // Automation slices run server-side via AutomatedSliceRunner and never
        // surface as todos. Interface AND view slices both need todos: interface
        // collects user input via complete-slice, view renders an upstream
        // event payload as a read-only display. The todo's `pattern` field
        // tells the client which render path to take.
        if (slice.pattern === 'automation') continue;

        // Check preconditions: at least one scenario must have BOTH its given[] events
        // present AND its givenBusinessRules evaluate to true against session facts.
        // This prevents todos from being created for slices whose business rules
        // (e.g. "amount >= threshold") are not satisfied by the current session state.
        let anyScenarioEligible = false;
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
            if (scenario.givenEventNames.length > 0 &&
                !scenario.givenEventNames.every(et => sessionEventTypes.has(et))) continue;
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
          }
        }
        if (!anyScenarioEligible) {
          logger.debug(
            { sliceName: slice.name, sessionId, eventType: event.type },
            '[TodoProcessor] No scenario eligible — skipping todo creation'
          );
          continue;
        }

        // Auto-complete any already-claimed todo whose outcome events have
        // arrived on the bus. This must run BEFORE the atomic-insert dedup
        // below, since insertPendingIfAbsent treats a claimed sibling as a
        // live duplicate. (A pending one is also treated as a duplicate, so
        // the second event in a cascade never creates a second todo — the
        // race window between separate event-bus handlers can't open one.)
        const existing = this.deps.todoStore.findBySliceAndSession(slice.name, sessionId);
        if (existing && existing.status === 'claimed' && slice.outcomeEventTypes.length > 0) {
          const allOutcomesPresent = slice.outcomeEventTypes.some(ot =>
            sessionEventTypes.has(ot) || sessionEventTypes.has(toKebabCase(ot))
          );
          if (allOutcomesPresent) {
            this.deps.todoStore.complete(existing.id);
            logger.info(
              { sliceName: slice.name, sessionId, todoId: existing.id },
              '[TodoProcessor] Marked todo as completed'
            );
          }
        }

        // Entry-point interface slices (no given[] events) don't need todos —
        // they're triggered directly by the user/agent connecting.
        if (slice.givenEventGroups.length === 0) continue;

        // Create a new pending todo — filter payload to slice-relevant facts only
        const todoId = `todo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const filteredPayload = slice.factNames.length > 0
          ? Object.fromEntries(
              Object.entries(sessionFactValues).filter(([k]) => slice.factNames.includes(k))
            )
          : sessionFactValues;
        const inserted = this.deps.todoStore.insertPendingIfAbsent({
          id: todoId,
          workflowSessionId: sessionId,
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
          { sliceName: slice.name, role: slice.role, pattern: slice.pattern, sessionId, todoId, triggerEventType: event.type },
          `[TodoProcessor] Created pending todo for ${slice.pattern} slice`
        );
      }
    } catch (err: any) {
      logger.error(
        { error: err.message, eventType: event.type, sessionId },
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
    const sessionId = event.sessionId!;

    // Check cache first
    const cached = this.sessionWorkflowCache.get(sessionId);
    if (cached) return this.deps.workflows.get(cached) ?? null;

    // Try to match by event source (slice name)
    for (const [name, wf] of this.deps.workflows) {
      const sourceName = event.source?.includes('/') ? event.source.split('/').pop() : event.source;
      const matchBySource = wf.slices.some(s => s.name === sourceName);
      if (matchBySource) {
        this.sessionWorkflowCache.set(sessionId, name);
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
        this.sessionWorkflowCache.set(sessionId, name);
        return wf;
      }
    }

    return null;
  }

  /** Clear the session-workflow cache (e.g. on resync). */
  invalidateCache(): void {
    this.sessionWorkflowCache.clear();
  }
}
