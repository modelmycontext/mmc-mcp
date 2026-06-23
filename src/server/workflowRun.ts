/**
 * WorkflowRun — the first-class "workflow run" aggregate (mmc-mcp #73).
 *
 * Before this, four identities were tangled (MCP transport `cid`, the workflow
 * session id, the `testSessions` marker, and `ConnectionState`), and the skill
 * registries + quiescence trackers were written under up to three keys for the
 * same data — with eviction only ever deleting the cid-keyed entry, so every
 * workflow-session-id mirror leaked for the life of the process.
 *
 * A `WorkflowRun` owns that state ONCE. Three genuinely-distinct external ids
 * can name the same run — the transport `cid`, the workbench-supplied
 * `register-skills` sessionId, and the minted `workflowSessionId` that flows on
 * the event bus — so they resolve through a single cheap `runIdByAlias`
 * string→string index. The heavy maps (skills/skillsById/eventSchemaIndex) are
 * NOT duplicated per key; they live on the run, and GC clears all of a run's
 * aliases together because the run owns its own alias set.
 *
 * Durability: in-memory by design, identical to the pre-#73 state. Skills are
 * re-pushed by the workbench on every reconnect (the workbench/disk is their
 * source of truth — persisting them would risk serving stale skills after a
 * model edit); quiescence is transient; the caches are rebuildable from
 * `events.db`. What survives a crash is the event log; run progress is
 * reconstructable by replaying it, never by serializing this aggregate.
 */
import type { FactSchemaEntry, WorkflowDefinition } from '@src/skill-engine/interaction-slice-trigger-events.js';
import { logger } from '@src/utils/logger.js';
import type { SessionSkill } from './sessionState.js';

export interface WorkflowRun {
  /** Canonical run id (the first external id that created the run). */
  id: string;
  /**
   * Every external id that resolves to this run: transport `cid`, the
   * `register-skills` sessionId, and the minted `workflowSessionId`. The
   * canonical `id` is itself a member. GC deletes all of these from
   * `runIdByAlias` at once.
   */
  aliases: Set<string>;
  /** Connection ids currently bound to this run (drives GC). */
  members: Set<string>;
  /** name → SessionSkill (was the per-session `sessionSkills` map). */
  skills: Map<string, SessionSkill>;
  /** sliceId (canvas UUID) → SessionSkill (was `sessionSkillsById`). */
  skillsById: Map<string, SessionSkill>;
  /** Event-schema index built from this run's slices (was `sessionEventSchemaIndex`). */
  eventSchemaIndex: Map<string, FactSchemaEntry[]>;
  /**
   * Workflow topology built from this run's inline slices (the model the
   * workbench Test panel pushed via `register-skills`). `TodoProcessor` resolves
   * session-scoped runs against THIS, never the disk export — so interface/view
   * todos are created for the model under test even when it was never published
   * to disk (or the disk copy is stale). Rebuilt on every `register-skills`.
   * Undefined for disk-scoped (external-client) runs.
   */
  inlineWorkflow?: WorkflowDefinition;
  /** Test-only run: events are NOT persisted to events.db (was `testSessions` membership). */
  isTest: boolean;
  /** Workflow (activity) name once a slice has been dispatched. */
  activeWorkflow?: string;
  // NOTE (workflow-instance-isolation RFC, D6): instance-lifecycle state
  // (inFlight / completionEmitted / awaitingCallbackNotified) was moved OFF the
  // run and onto a per-`correlationId` InstanceLifecycle (below). One connection
  // — hence one run, holding the per-connection skills/eventSchemaIndex — can
  // drive several workflow instances sequentially, and each instance must
  // quiesce and emit `workflow_completed` independently. Keeping these counters
  // on the run made the second instance inherit the first's `completionEmitted`
  // and never complete.
}

/**
 * Per-instance lifecycle, keyed by `correlationId` (the workflow-instance id).
 * Split from `WorkflowRun` by the workflow-instance-isolation RFC (D6): the run
 * is per-connection (skills/registration), this is per-instance (quiescence).
 */
export interface InstanceLifecycle {
  /** Automated branches dispatched but not yet settled. */
  inFlight: number;
  /** `workflow_completed` already emitted for this instance — never twice. */
  completionEmitted: boolean;
  /**
   * `awaiting_callback` progress already delivered for the current wait — avoids
   * re-notifying the client on every debounced quiescence re-arm while the
   * instance is paused for an inbound external event.
   */
  awaitingCallbackNotified: boolean;
}

/** Canonical store: correlationId → InstanceLifecycle. */
const instances = new Map<string, InstanceLifecycle>();

/** Canonical store: runId → WorkflowRun. Heavy data lives here exactly once. */
const runs = new Map<string, WorkflowRun>();
/** The single lookup table: any alias (cid / regSessionId / workflowSessionId) → runId. */
const runIdByAlias = new Map<string, string>();

/** Hooks fired once, just before a run is GC'd, for each of its aliases. */
type RunGcHook = (run: WorkflowRun, aliases: string[]) => void;
const gcHooks: RunGcHook[] = [];

/**
 * Register a callback invoked when a run is garbage-collected. Used by the
 * server to drop the per-session caches that live outside this module
 * (`sessionWorkflowCache` in TodoProcessor, `sessionFactCache` in
 * SqliteEventStore). Kept as a hook to avoid an import cycle.
 */
export function registerRunGcHook(hook: RunGcHook): void {
  gcHooks.push(hook);
}

/** Resolve any external id to its run, or undefined. */
export function getRun(id: string | undefined): WorkflowRun | undefined {
  if (!id) return undefined;
  const runId = runIdByAlias.get(id);
  return runId ? runs.get(runId) : undefined;
}

/**
 * Get-or-create the run for `id`. `id` becomes the canonical id (and a
 * self-alias) when the run is new. `isTest` only ever flips false→true: a run
 * that has been marked test stays test even if a later touch omits the flag.
 */
export function ensureRun(id: string, opts?: { isTest?: boolean }): WorkflowRun {
  let run = getRun(id);
  if (!run) {
    run = {
      id,
      aliases: new Set([id]),
      members: new Set(),
      skills: new Map(),
      skillsById: new Map(),
      eventSchemaIndex: new Map(),
      isTest: !!opts?.isTest,
    };
    runs.set(id, run);
    runIdByAlias.set(id, id);
    logger.info({ runId: id, isTest: run.isTest }, '[WorkflowRun] created');
  } else if (opts?.isTest) {
    run.isTest = true;
  }
  return run;
}

/** Point an additional external id at an existing run (idempotent). */
export function addAlias(run: WorkflowRun, alias: string): void {
  if (!alias) return;
  const existing = runIdByAlias.get(alias);
  if (existing === run.id) return;
  run.aliases.add(alias);
  runIdByAlias.set(alias, run.id);
}

/** Bind a connection to a run (membership drives GC). */
export function addMember(run: WorkflowRun, cid: string): void {
  run.members.add(cid);
}

/**
 * Remove a connection from whatever run it belonged to and GC the run if it is
 * now empty and quiesced. Called from connection eviction. Returns true if a
 * run was reclaimed.
 */
export function removeMemberAndMaybeGc(cid: string): boolean {
  const run = getRun(cid);
  if (!run) return false;
  run.members.delete(cid);
  return maybeGc(run);
}

/**
 * GC a run once no connection is bound AND no automated branch is in flight.
 * Open todos do not block GC: production todos persist in their own store and
 * test todos are reclaimed with the in-memory stores; this aggregate only holds
 * routing/skill/quiescence state, all of which is dead once the run is idle.
 */
export function maybeGc(run: WorkflowRun): boolean {
  if (run.members.size > 0) return false;
  // Block GC while ANY instance driven by this run still has a branch in flight.
  // Instance-lifecycle counters are now keyed by correlationId (D6), and a run's
  // correlationIds are exactly its aliases.
  for (const alias of run.aliases) {
    const inst = instances.get(alias);
    if (inst && inst.inFlight > 0) return false;
  }
  const aliases = [...run.aliases];
  for (const hook of gcHooks) {
    try { hook(run, aliases); } catch (err: any) {
      logger.error({ runId: run.id, error: err?.message }, '[WorkflowRun] GC hook threw');
    }
  }
  for (const alias of aliases) {
    runIdByAlias.delete(alias);
    instances.delete(alias); // reclaim the per-instance lifecycle with the run
  }
  runs.delete(run.id);
  logger.info({ runId: run.id, aliases }, '[WorkflowRun] garbage-collected');
  return true;
}

/**
 * Canonical "is this a session-scoped (workbench test panel) run?" predicate —
 * the replacement for the old `isSessionScoped`. A run counts as session-scoped
 * when it is marked test OR has registered skills; bare production runs (created
 * only to track quiescence for a disk-driven session) do not.
 */
export function isSessionScoped(id: string | undefined): boolean {
  const run = getRun(id);
  return !!run && (run.isTest || run.skills.size > 0);
}

/**
 * Bind a connection to the run named by `sessionId`, reusing the run the
 * connection already belongs to (via `cid`) if one exists so a newly-minted
 * `workflowSessionId` becomes an alias of the SAME run rather than a second
 * run. This is the single place the three external ids are stitched together.
 */
export function attachSession(
  cid: string,
  sessionId: string | undefined,
  opts?: { isTest?: boolean },
): WorkflowRun {
  const current = getRun(cid);
  // Prefer an EXISTING run already named by sessionId: if the workflow session
  // has its own run, the connection joins (migrates to) it. Otherwise the new
  // sessionId becomes another alias of the connection's current run. Only when
  // neither exists do we create one. (current-first would steal sessionId's
  // alias and orphan its run — the migration case below relies on this order.)
  const bySession = sessionId ? getRun(sessionId) : undefined;
  const target = bySession ?? current ?? ensureRun(sessionId || cid, opts);
  if (current && current !== target) {
    // The connection is migrating to a different run (e.g. an explicit session
    // switch). Release it from the old run so that run can be GC'd instead of
    // retaining a phantom member forever — exactly the leak this aggregate fixes.
    current.members.delete(cid);
    current.aliases.delete(cid);
    runIdByAlias.delete(cid); // re-pointed at `target` by addAlias below
    maybeGc(current);
  }
  if (sessionId) addAlias(target, sessionId);
  addAlias(target, cid);
  addMember(target, cid);
  if (opts?.isTest) target.isTest = true;
  return target;
}

// ── Per-instance lifecycle (keyed by correlationId, D6) ───────────────────────

/** Resolve an instance's lifecycle, or undefined if none has been created. */
export function getInstance(correlationId: string | undefined): InstanceLifecycle | undefined {
  return correlationId ? instances.get(correlationId) : undefined;
}

/** Get-or-create the lifecycle for an instance. */
export function ensureInstance(correlationId: string): InstanceLifecycle {
  let inst = instances.get(correlationId);
  if (!inst) {
    inst = { inFlight: 0, completionEmitted: false, awaitingCallbackNotified: false };
    instances.set(correlationId, inst);
  }
  return inst;
}

/** Increment the in-flight branch counter for an instance (creates it if absent). */
export function incInFlight(correlationId: string): void {
  ensureInstance(correlationId).inFlight += 1;
}

/**
 * Decrement the in-flight branch counter for an instance. Returns the lifecycle
 * (so the caller can re-check quiescence) or undefined if none exists.
 */
export function decInFlight(correlationId: string): InstanceLifecycle | undefined {
  const inst = instances.get(correlationId);
  if (!inst) return undefined;
  inst.inFlight = Math.max(0, inst.inFlight - 1);
  return inst;
}

// ── Test-only introspection ───────────────────────────────────────────────────

/** Visible for tests: current run count (asserting bounded memory after GC). */
export function _runCount(): number {
  return runs.size;
}

/** Visible for tests: current alias-index size. */
export function _aliasCount(): number {
  return runIdByAlias.size;
}

/** Visible for tests: reset all run state (and GC hooks) between cases. */
export function _resetRuns(): void {
  runs.clear();
  runIdByAlias.clear();
  instances.clear();
  gcHooks.length = 0;
}
