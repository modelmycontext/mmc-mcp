// Event-bus routers. The three `eventBus.subscribe('*', ...)` dispatchers that
// were inline in index.ts live here as factory functions. Each registers one
// wildcard subscriber; resync only mutates the maps the subscribers close over,
// so no unsubscription is ever required.
//
//   1. registerEventStoreRouter        — persist every event to the right store
//   2. registerAutomatedSliceRouter    — dispatch automated slices (prod + test)
//   3. registerEventDeliveryRouter     — route/deliver events to client conns,
//                                        emit terminus / unexpected_last_event
//
// The deferred-completion tracker they share with the CallTool handlers lives
// in ./quiescence.ts.
import path from 'path';
import type { Event } from '@src/events/eventBus.js';
import { logger } from '@src/utils/logger.js';
import { toKebabCase } from '@src/utils/stringUtils.js';
import {
  getSlicePattern,
  type WorkflowDefinition,
  type FactSchemaEntry,
} from '@src/skill-engine/interaction-slice-trigger-events.js';
import {
  createAutomatedSliceHandler,
  resolveDiskSliceData,
  resolveInlineSliceData,
  type AutomatedSliceRunnerDeps,
} from '@src/services/automatedSliceRunner.js';
import {
  eventBus,
  eventStore,
  inMemoryEventStore,
} from './composition.js';
import { connectionPool } from './sessionState.js';
import { getRun, isSessionScoped } from './workflowRun.js';
import {
  makeRouterEvent,
  noteBranchDispatched,
  noteBranchSettled,
  scheduleQuiescenceCheck,
} from './quiescence.js';

type AutomatedSliceMap = Map<string, string[]>;

/**
 * Log all events and route to the correct store.
 * Test sessions → in-memory store (no disk persistence).
 * Production sessions → SQLite event store.
 *
 * Uses `isSessionScoped` (#73) as the "is-test-session" detector: a WorkflowRun
 * counts as session-scoped when it is flagged isTest OR has registered skills.
 * Treating "skills registered" as session-scoped (not the isTest flag alone)
 * keeps external-webhook events on such a session from silently persisting to
 * the production SQLite store.
 */
export function registerEventStoreRouter(): void {
  eventBus.subscribe('*', async (event) => {
    const isTest = isSessionScoped(event.correlationId);
    logger.info({ eventType: event.type, source: event.source, payload: event.payload, testSession: isTest }, `[EVENT] ${event.type} from ${event.source}`);

    if (isTest) {
      await inMemoryEventStore.append(event);
    } else {
      await eventStore.append(event);
    }
  });
}

export interface AutomatedSliceRouterDeps {
  /** event type → disk slice .md paths (production dispatch). Mutated in-place on resync. */
  automatedSliceMap: AutomatedSliceMap;
  /** Shared runner dependencies handed to every createAutomatedSliceHandler. */
  runnerDeps: AutomatedSliceRunnerDeps;
}

/**
 * AUTOMATED-SLICE DISPATCH (production AND workbench test sessions).
 *
 * Both paths run the SAME `createAutomatedSliceHandler` from
 * src/services/automatedSliceRunner.ts. The only difference is HOW the slice
 * JSON is resolved before being handed to the handler:
 *   • disk path  → `resolveDiskSliceData(skillMdPath)`   reads outcome model
 *                                                        JSON from skills/
 *   • test path  → `resolveInlineSliceData(skill.sliceData, skill.name)`
 *                                                        uses sliceData pushed
 *                                                        via `register-skills`
 *
 * Once `SliceData` is resolved, the handler is path-agnostic (scenario gating,
 * query/command jobs, business-rule eval, diagnostics, outcome publishing).
 *
 * What is DIFFERENT and must remain so — routing policy (this dispatcher): test
 * sessions consult `sessionSkills` first and NEVER fall through to disk;
 * production uses `automatedSliceMap`. Disk automation would run with the wrong
 * model's connectors and silently corrupt a test session. Event persistence
 * (testAwareEventStore) and todo creation (TodoProcessor) are handled elsewhere.
 * If you need path-specific behaviour, do it HERE — never branch on source type
 * inside the handler.
 *
 * Fire-and-forget: automated slice processing runs outside the EventBus publish
 * chain so it cannot block persistence or routing of subsequent events.
 */
export function registerAutomatedSliceRouter(deps: AutomatedSliceRouterDeps): void {
  const { automatedSliceMap, runnerDeps } = deps;
  eventBus.subscribe('*', (event) => {
    // TEST SESSION PATH — session-registered skills take precedence over
    // any matching disk slice. Disk slices may be stale snapshots of a
    // different model whose command jobs reference connectors not present
    // in this session — running them silently corrupts the test.
    //
    // `isSessionScoped` (#73) is the load-bearing signal: a run with skills
    // registered (or flagged isTest) IS a session-scoped workflow, so dispatch
    // must use its skills. Gating on skills-registered — not isTest alone —
    // stops external-webhook events on such a session from silently falling
    // through to the disk path after a mid-session source edit.
    if (isSessionScoped(event.correlationId)) {
      // isSessionScoped guarantees event.correlationId is defined; the `!` just
      // re-states that to the type-checker (the helper's return doesn't narrow).
      const sessionMap = getRun(event.correlationId!)?.skills;
      if (sessionMap) {
        let handled = false;
        const eventSchemaIndex = getRun(event.correlationId!)?.eventSchemaIndex;
        for (const skill of sessionMap.values()) {
          if (!skill.triggersOnSet.has(event.type) || !skill.sliceData) continue;
          // Only AUTOMATION slices are server-driven. Interface and View
          // slices are CLIENT-driven and must never be auto-completed here —
          // their outcome is published exclusively by the human's
          // `complete-slice` (interface) or rendered by viewSliceRunner (view).
          // This is the single-writer contract for interface-slice outcomes.
          //
          // Why this matters (the referred→underwriter race): when the
          // automated handler ran the `underwriter-review` INTERFACE slice on
          // `application-referred`, it fired the `underwriter-review` outcome
          // immediately — carrying the upstream `decision` forward verbatim,
          // BEFORE the human underwriter ever saw the form — which then
          // cascaded into explain + view. With interface slices excluded, the
          // TodoProcessor still creates the pending todo (the test panel claims
          // it and renders the form); the human's submission is the sole writer
          // of the outcome, so the decision they pick is the one that flows
          // downstream. View auto-run would also wrongly publish
          // `slice-misconfigured` (a view's matched scenario has an empty
          // `then`). The disk path already restricts dispatch to automation
          // slices via `automatedSliceMap` (loadAutomatedSliceMap skips
          // non-automation); the session path now matches.
          if (getSlicePattern(skill.sliceData) !== 'automation') continue;
          // No cross-workflow check here: all session-registered skills
          // belong to the single workflow the test panel pushed; consulting
          // the disk `sliceWorkflowMap` by slice-name causes false negatives
          // when the same slice name exists under a different workflow on
          // disk (common with the AI story builder's generic slice names).
          const sliceDataResolved = resolveInlineSliceData(skill.sliceData, skill.name, eventSchemaIndex);
          noteBranchDispatched(event.correlationId!);
          createAutomatedSliceHandler(sliceDataResolved, runnerDeps)(event)
            .catch((err) => {
              logger.error({ error: err.message, eventType: event.type, skill: skill.name }, '[SERVER] Session automated slice handler failed');
            })
            .finally(() => noteBranchSettled(event.correlationId!));
          handled = true;
        }
        if (handled) return;
      }
      // No session skill matched — test sessions do NOT fall through to disk
      // slices, because disk automation would run with the wrong model's jobs.
      return;
    }

    // Production path: disk-based automated slices.
    const skillMdPaths = automatedSliceMap.get(event.type);
    if (skillMdPaths) {
      const sourceWorkflow = event.source?.includes('/')
        ? event.source.split('/')[0]
        : null;
      for (const skillMdPath of skillMdPaths) {
        if (sourceWorkflow) {
          const targetWorkflow = path.basename(path.dirname(path.dirname(skillMdPath)));
          if (sourceWorkflow !== targetWorkflow) {
            logger.debug({ sourceWorkflow, targetWorkflow, eventType: event.type }, '[SERVER] Cross-workflow disk dispatch skipped');
            continue;
          }
        }
        if (event.correlationId) noteBranchDispatched(event.correlationId);
        resolveDiskSliceData(skillMdPath)
          .then(data => {
            if (!data) {
              logger.warn({ skillMdPath, eventType: event.type }, '[SERVER] Could not resolve disk slice data — skipping');
              return;
            }
            return createAutomatedSliceHandler(data, runnerDeps)(event);
          })
          .catch((err) => {
            logger.error({ error: err.message, eventType: event.type }, '[SERVER] Automated slice handler failed (fire-and-forget)');
          })
          .finally(() => { if (event.correlationId) noteBranchSettled(event.correlationId); });
      }
    }
  });
}

export interface EventDeliveryRouterDeps {
  /** Interface-slice trigger events (routed to client). Mutated in-place on resync. */
  triggerEventSet: Set<string>;
  /** event type → disk slice .md paths. Mutated in-place on resync. */
  automatedSliceMap: AutomatedSliceMap;
  /** Live accessor for the loaded workflow definitions (null until main() sets them). */
  getWorkflowDefs: () => Map<string, WorkflowDefinition> | null;
}

/**
 * Route qualifying events to the connection that owns the matching workflow
 * session. Registered after the automated-slice subscriber so automatedSliceMap
 * is available. Also implements the terminus / unexpected_last_event logic and
 * feeds the deferred-completion quiescence gate.
 */
export function registerEventDeliveryRouter(deps: EventDeliveryRouterDeps): void {
  const { triggerEventSet, automatedSliceMap, getWorkflowDefs } = deps;
  eventBus.subscribe('*', async (event) => {
    if (!event.correlationId) return;
    // Internal diagnostic events (e.g. connector TOOL_CALLED) are not part of
    // the workflow and must never be wrapped as unexpected_last_event or
    // delivered to clients — they would prematurely terminate the test view.
    if (event.type === 'TOOL_CALLED') return;
    // slice-stalled is a pure timeline diagnostic (no scenario matched — see
    // automatedSliceRunner's logNoMatchDiagnostic). It persists to the session
    // log so the test panel renders the red card, but it must never be routed
    // or classified as terminus/wiring-gap.
    if (event.type === 'slice-stalled') return;

    let isRouted = triggerEventSet.has(event.type);
    let isAutomated = automatedSliceMap.has(event.type);

    // For test sessions, also check session-scoped skills for routing/automation matches.
    // `isSessionScoped` (#73) is the canonical detector — see the event-store router.
    if (!isRouted && !isAutomated && isSessionScoped(event.correlationId)) {
      const sessionMap = getRun(event.correlationId)?.skills;
      if (sessionMap) {
        for (const skill of sessionMap.values()) {
          if (skill.triggersOnSet.has(event.type)) {
            // Session skill triggers on this event — classify via the canonical
            // pattern helper (B5), not an inline `automation`-block check, so
            // interface/view both route to the client and only true automation
            // slices are treated as server-dispatched.
            if (getSlicePattern(skill.sliceData) === 'automation') {
              isAutomated = true;
            } else {
              isRouted = true;
            }
            break;
          }
        }
      }
    }

    // If no downstream slice (interface or automated) handles this event,
    // distinguish two cases so the client agent can react correctly:
    //   - workflow_completed: the event is the *expected* terminus of its
    //     workflow (an outcome no slice in the same workflow consumes).
    //   - unexpected_last_event: the event has no listener AND isn't a known
    //     terminus — likely a stray publish from a misconfigured slice.
    if (!isRouted && !isAutomated) {
      let isWorkflowComplete = false;
      for (const wf of getWorkflowDefs()?.values() ?? []) {
        if (wf.terminalEventTypes.has(event.type)) { isWorkflowComplete = true; break; }
      }
      // Session-scoped workflows aren't on disk, so the disk lookup above
      // misses them. We already know no session skill *triggers* on this
      // event (otherwise isRouted/isAutomated would be true). If some
      // session skill *publishes* it, it's the expected terminus of a
      // session-registered workflow — emit `workflow_completed` instead of
      // the alarming `unexpected_last_event`.
      if (!isWorkflowComplete && isSessionScoped(event.correlationId)) {
        const sessionMap = getRun(event.correlationId)?.skills;
        if (sessionMap) {
          for (const skill of sessionMap.values()) {
            if (skill.publishes && toKebabCase(skill.publishes) === event.type) {
              isWorkflowComplete = true;
              break;
            }
          }
        }
      }
      if (isWorkflowComplete) {
        // Terminus = branch close, NOT workflow close. Defer workflow_completed
        // to the quiescence gate, which fires once the session has no automated
        // branch in flight and no open interface/view todo. This is what stops
        // a sibling View (e.g. show-credit-decision) from being amputated by a
        // faster automation branch reaching its terminus first.
        logger.info({ originalEventType: event.type, correlationId: event.correlationId }, '[EVENT_ROUTER] terminus — branch closed; scheduling quiescence check');
        scheduleQuiescenceCheck(event.correlationId);
        return;
      }
      // Genuine wiring gap (no consumer AND not a known terminus) — surface it
      // immediately so the agent stops rather than polling forever. Payload is
      // stripped; the agent can call get-session-events for detail.
      const fallback = makeRouterEvent(event.correlationId, 'unexpected_last_event', event);
      for (const [cid, conn] of connectionPool) {
        if (conn.activeCorrelationId !== event.correlationId) continue;
        if (conn.waitingResolver) {
          const resolve = conn.waitingResolver;
          conn.waitingResolver = null;
          logger.info({ cid, originalEventType: event.type, correlationId: event.correlationId }, '[EVENT_ROUTER] No downstream handler — delivering unexpected_last_event');
          resolve(fallback);
        } else {
          conn.queue.push(fallback);
          logger.info({ cid, originalEventType: event.type, queueLength: conn.queue.length, correlationId: event.correlationId }, '[EVENT_ROUTER] No downstream handler — queued unexpected_last_event');
        }
      }
      return;
    }

    // In test sessions, also deliver automation-trigger events as progress notifications
    // so the client can display each step rather than only receiving unexpected_last_event.
    if (!isRouted && !(getRun(event.correlationId)?.isTest ?? false)) return;
    for (const [cid, conn] of connectionPool) {
      if (conn.activeCorrelationId !== event.correlationId) continue;
      if (conn.waitingResolver) {
        const resolve = conn.waitingResolver;
        conn.waitingResolver = null;
        logger.info({ cid, eventType: event.type, correlationId: event.correlationId }, '[EVENT_ROUTER] Delivering event to waiting connection');
        resolve(event);
      } else {
        conn.queue.push(event);
        logger.info({ cid, eventType: event.type, queueLength: conn.queue.length, correlationId: event.correlationId }, '[EVENT_ROUTER] Queued event for connection');
      }
    }
  });
}
