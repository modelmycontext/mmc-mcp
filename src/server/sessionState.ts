/**
 * Per-connection and per-session runtime state for the MCP server.
 *
 * Extracted from `index.ts` as the first step of the server split. Holds the
 * push-delivery connection pool, the test-session marker set, and the
 * session-scoped skill registries — plus the canonical `isSessionScoped`
 * predicate that several dispatch/persistence paths share.
 *
 * No dependency on `index.ts` (avoids an import cycle): it only needs the
 * logger, the `Event` type, and `FactSchemaEntry`.
 */
import type { Event } from '@src/events/eventBus.js';
import { logger } from '@src/utils/logger.js';
import { removeMemberAndMaybeGc } from './workflowRun.js';

/** Sentinel sessionId for stdio / sessions with no ID. */
export const DEFAULT_SESSION_ID = 'default';
export const CONNECTION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const CONNECTION_EVICTION_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export interface ConnectionState {
  /**
   * The workflow-instance id (`event.correlationId`) currently being driven on
   * this connection (workflow-instance-isolation RFC). Delivery routes events
   * to a connection by this. Re-pointed at instance birth — a connection that
   * starts a second workflow gets a fresh correlationId, so two instances on
   * one transport connection stay isolated. Was `activeWorkflowSessionId`.
   * NEVER seeded from the transport `cid`.
   */
  activeCorrelationId: string | undefined;
  /** Workflow this connection is executing (e.g. 'activity-2'). Set when a skill is dispatched. */
  activeWorkflow?: string;
  /** Roles assigned to this connection via register-agent. */
  roles: string[];
  /** Username registered via register-agent. */
  username: string | undefined;
  /** Events pushed to this connection that haven't been consumed yet. */
  queue: Event[];
  /** Resolve function parked by a waiting get-next-event call. */
  waitingResolver: ((event: Event | null) => void) | null;
  /**
   * True once this connection has called `register-skills`. Locks the
   * connection into session-isolated mode: `tools/list` hides disk slice
   * tools so a stale disk skill from a different workflow with the same
   * slice name can't be picked up by accident. The connection's WorkflowRun
   * (#73) holds those skills and is GC'd only when this connection (its last
   * member) evicts, so an isolated connection always has its skills available
   * for the duration of its lifetime.
   */
  sessionIsolated: boolean;
  lastSeen: number;
  /** The WorkflowRun this connection is bound to (#73); used for GC on evict. */
  runId?: string;
}

/** One session-registered skill (pushed by a test panel via `register-skills`). */
export interface SessionSkill {
  id: string;
  name: string;
  description: string;
  body: string;
  triggersOn: string;
  triggersOnSet: Set<string>;
  publishes: string;
  sliceData?: any;
  hidden?: boolean;
}

export const connectionPool = new Map<string, ConnectionState>();

// The per-session skill registries (sessionSkills / sessionSkillsById /
// sessionEventSchemaIndex), the test-session marker (testSessions), and the
// `isSessionScoped` predicate have moved onto the WorkflowRun aggregate (#73,
// ./workflowRun.ts). Reach them via getRun(id) / isSessionScoped(id) there.
// connectionPool stays here — a connection is the transport-level object; it
// now carries a `runId` pointing at its WorkflowRun.

/**
 * Resolve the connection's bound workflow-instance id (`correlationId`), or
 * throw. Instance-scoped operations — connector exec, view render, fact/todo
 * mutation — MUST run against a bound instance. A missing one means
 * `start-workflow` (or an entry-point slice) never ran: an invariant violation
 * we surface loudly instead of silently scoping to the wrong bucket or to the
 * transport `cid` (workflow-instance-isolation RFC). NEVER falls back to cid.
 *
 * Read-only pre-start fetches (an entry slice's body/prefetch, which legitimately
 * precede the first instance) should NOT use this — they read an empty pool.
 */
export function requireActiveCorrelation(conn: ConnectionState | undefined, op: string): string {
  const id = conn?.activeCorrelationId;
  if (!id) {
    throw new Error(`[${op}] No active workflow instance — start-workflow (or an entry-point slice) must run before instance-scoped operations.`);
  }
  return id;
}

export function getOrCreateConnection(cid: string): ConnectionState {
  let conn = connectionPool.get(cid);
  if (!conn) {
    conn = { activeCorrelationId: undefined, roles: [], username: undefined, queue: [], waitingResolver: null, sessionIsolated: false, lastSeen: Date.now() };
    connectionPool.set(cid, conn);
    logger.info({ cid }, '[CONNECTION] New connection state created');
  }
  conn.lastSeen = Date.now();
  return conn;
}

export function evictStaleConnections() {
  const cutoff = Date.now() - CONNECTION_TTL_MS;
  for (const [cid, conn] of connectionPool) {
    if (conn.lastSeen < cutoff) {
      if (conn.waitingResolver) conn.waitingResolver(null);
      connectionPool.delete(cid);
      // Release this connection from its WorkflowRun and GC the run if it was
      // the last member with no automated branch in flight (#73). This is the
      // single place a run's skills, eventSchemaIndex, isTest flag, quiescence
      // state and per-session caches are reclaimed — replacing the old
      // cid-keyed-only delete that leaked every workflow-session-id mirror.
      removeMemberAndMaybeGc(cid);
      logger.info({ cid }, '[CONNECTION] Evicted stale connection');
    }
  }
}
