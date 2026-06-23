// ── Deferred workflow completion (last-branch-closes) ──────────────────────
// A terminus closes a *branch*, not the workflow. First-past-the-post is gone:
// `workflow_completed` is emitted once, only when the session has quiesced —
// no automated branch in flight AND no interface/view todo still open. This is
// what stops the credit-decisioning `show-credit-decision` View from being
// amputated when a sibling automation branch reaches a terminus first.
//
// This module owns the stateful tracker. The pure decision core lives in
// ./workflowCompletion.ts (`evaluateQuiescence`). The tracker is shared by the
// event routers (./routers.ts) AND the MCP CallTool handlers (registerHandlers
// in ./index.ts) — both close branches: automated-branch settle, terminus,
// View render, and resolve-todo all feed scheduleQuiescenceCheck.
import type { Event } from '@src/events/eventBus.js';
import { logger } from '@src/utils/logger.js';
import { testAwareTodoStore, testAwareEventStore } from './composition.js';
import { connectionPool } from './sessionState.js';
import { getRun, getInstance, ensureInstance, incInFlight, decInFlight, maybeGc } from './workflowRun.js';
import { evaluateQuiescence } from './workflowCompletion.js';
import type { WorkflowDefinition } from '@src/skill-engine/interaction-slice-trigger-events.js';

// The in-flight branch counter and the `workflow_completed`-already-emitted flag
// live on the per-instance InstanceLifecycle (workflow-instance-isolation RFC,
// D6), keyed by correlationId so two instances driven by one connection quiesce
// independently. Only the transient debounce timers stay here.
const quiescenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Live accessor for the loaded workflow definitions, injected by main() once
// they are loaded (and reassigned on resync). Kept as a getter — same pattern
// as the routers — so this module has no load-order dependency on index.ts.
let workflowDefsAccessor: (() => Map<string, WorkflowDefinition> | null) | null = null;
export function setQuiescenceWorkflowDefs(accessor: () => Map<string, WorkflowDefinition> | null): void {
  workflowDefsAccessor = accessor;
}

function correlationHasOpenTodo(correlationId: string): boolean {
  return testAwareTodoStore.getByCorrelation(correlationId).some(t => t.status !== 'completed');
}

/**
 * Resolve the workflow an instance belongs to. Prefers the run's `activeWorkflow`
 * (set on the session/agent path); falls back to matching the instance's seen
 * event types against each workflow's known event vocabulary (the disk/webhook
 * path, where no connection carries `activeWorkflow`).
 */
function resolveWorkflowForCorrelation(correlationId: string): WorkflowDefinition | undefined {
  const defs = workflowDefsAccessor?.();
  if (!defs) return undefined;
  const active = getRun(correlationId)?.activeWorkflow;
  if (active) {
    const wf = defs.get(active);
    if (wf) return wf;
  }
  const seen = testAwareEventStore.getCorrelationEventTypes(correlationId);
  if (seen.size === 0) return undefined;
  for (const wf of defs.values()) {
    const known = new Set<string>([...wf.terminalEventTypes, ...wf.externalTriggerEvents]);
    for (const s of wf.slices) {
      for (const group of s.givenEventGroups) for (const e of group) known.add(e);
      for (const o of s.outcomeEventTypes) known.add(o);
    }
    for (const e of seen) if (known.has(e)) return wf;
  }
  return undefined;
}

/**
 * The workflow declares an inbound external event (a webhook callback) that has
 * not yet appeared on this instance's bus — the awaiting-callback obligation.
 * Returns the awaited event names (empty = no open obligation). Registry-derived
 * (the external-event registry, via `WorkflowDefinition.externalTriggerEvents`).
 */
function correlationAwaitingExternalEvents(correlationId: string): string[] {
  const wf = resolveWorkflowForCorrelation(correlationId);
  if (!wf || wf.externalTriggerEvents.size === 0) return [];
  const seen = testAwareEventStore.getCorrelationEventTypes(correlationId);
  return [...wf.externalTriggerEvents].filter(e => !seen.has(e));
}

/** Deliver an event to every connection currently driving this instance. */
export function deliverToCorrelation(correlationId: string, ev: Event): void {
  for (const [, conn] of connectionPool) {
    if (conn.activeCorrelationId !== correlationId) continue;
    if (conn.waitingResolver) {
      const resolve = conn.waitingResolver;
      conn.waitingResolver = null;
      resolve(ev);
    } else {
      conn.queue.push(ev);
    }
  }
}

export function makeRouterEvent(correlationId: string, type: string, original?: Event): Event {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    source: 'event-router',
    correlationId,
    payload: original
      ? { originalEvent: { id: original.id, type: original.type, source: original.source, correlationId: original.correlationId, sequence: (original as any).sequence, timestamp: original.timestamp } }
      : {},
    timestamp: new Date(),
  } as Event;
}

export function noteBranchDispatched(correlationId: string): void {
  incInFlight(correlationId);
}

/** Decrement the in-flight counter for a settled automated branch and re-check. */
export function noteBranchSettled(correlationId: string): void {
  decInFlight(correlationId);
  scheduleQuiescenceCheck(correlationId);
}

/**
 * Re-arm the quiescence check for a session. Debounced: the expensive open-todo
 * scan runs at most once per ~75ms quiet window, and only emits
 * `workflow_completed` when the last branch has closed. Called on every branch
 * close — automated-branch settle, terminus, View render, and resolve-todo.
 */
export function scheduleQuiescenceCheck(correlationId: string): void {
  const existing = quiescenceTimers.get(correlationId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    quiescenceTimers.delete(correlationId);
    const run = getRun(correlationId);
    const inst = getInstance(correlationId);
    // Only evaluate the (cheap) obligation when nothing else is already holding
    // the instance open — mirrors the gate's short-circuit order.
    const otherwiseHeld = (inst?.completionEmitted ?? false) || (inst?.inFlight ?? 0) > 0 || correlationHasOpenTodo(correlationId);
    const awaiting = otherwiseHeld ? [] : correlationAwaitingExternalEvents(correlationId);
    const decision = evaluateQuiescence({
      completionEmitted: inst?.completionEmitted ?? false,
      inFlightCount: inst?.inFlight ?? 0,
      hasOpenTodo: correlationHasOpenTodo(correlationId),
      hasOpenAwaitingCallback: awaiting.length > 0,
    });
    if (decision === 'wait' && awaiting.length > 0 && !(inst?.awaitingCallbackNotified)) {
      // The instance is paused for the outside world. Tell the polling client
      // once, so it shows "awaiting applicant" and keeps polling instead of
      // being told the workflow is done.
      ensureInstance(correlationId).awaitingCallbackNotified = true;
      logger.info({ correlationId, awaiting }, '[QUIESCENCE] awaiting external callback — holding completion');
      const ev = makeRouterEvent(correlationId, 'awaiting_callback');
      ev.payload = { ...ev.payload, awaiting };
      deliverToCorrelation(correlationId, ev);
    }
    if (decision === 'complete') {
      ensureInstance(correlationId).completionEmitted = true;
      logger.info({ correlationId }, '[QUIESCENCE] instance quiesced — emitting deferred workflow_completed');
      deliverToCorrelation(correlationId, makeRouterEvent(correlationId, 'workflow_completed'));
    }
    // Reclaim the run if it is now idle and unowned (no member connection, no
    // branch in flight). A run whose client is still polling keeps a member, so
    // this only collects runs already abandoned — connection eviction is the
    // other GC trigger.
    if (run) maybeGc(run);
  }, 75);
  (t as any).unref?.();
}
