import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { EventBus } from '@src/events/eventBus.js';
import type { Event } from '@src/events/eventBus.js';
import { SqliteEventStore } from '@src/events/sqliteEventStore.js';
import { InMemoryEventStore } from '@src/events/inMemoryEventStore.js';
import { TestAwareEventStore } from '@src/events/testAwareEventStore.js';
import { SqliteDataSource } from '@src/data-sources/sqliteDataSource.js';
import { JsonDataSource } from '@src/data-sources/jsonDataSource.js';
import { LlmService } from '@src/services/llm.js';
import { ExternalMcpManager, type ExternalMcpConfig } from "./externalMcpManager.js";
import fs from 'fs';
import fsAsync from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Hono } from "hono";
import 'dotenv/config';
import { logger } from '@src/utils/logger.js';
import { formatEventLog } from '@src/utils/eventFormatter.js';
import { readAppConfig, syncSkillsOnStartup } from '@src/skill-engine/skillSyncStartup.js';
import { connectors } from '@connectors/index.js';
import { ConnectorExecutor } from '@src/connectors/connectorExecutor.js';
import { toKebabCase } from '@src/utils/stringUtils.js';
import { loadInteractionSliceTriggerEvents, loadInterfaceSliceNames, loadAutomatedSliceMap, loadSliceWorkflowMap, loadWorkflowDefinitions, invalidateOutcomeModelCache, loadSliceOutcomes, loadSliceQueries, loadSliceFromMdPath, buildEventSchemaIndex, buildScopedFactIdToName, collectUnmappedFactIds, type FactSchemaEntry } from '@src/skill-engine/interaction-slice-trigger-events.js';
import { createAutomatedSliceHandler, resolveDiskSliceData, resolveInlineSliceData } from '@src/services/automatedSliceRunner.js';
import { evaluateSlice, executeSliceQueries } from '@src/services/sliceEvaluator.js';
import { flattenPayload, resolveFormulaValue } from '@src/utils/factValueResolver.js';
import { TodoStore } from '@src/services/todoStore.js';
import { TodoProcessor } from '@src/services/todoProcessor.js';
import { parseSkillFrontmatter, listSkillPaths, resolveSkillPath } from '@src/utils/skillUtils.js';
import { HANDLE_LATEST_EVENT_SKILL } from './systemSkills.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = process.env.MCP_PROJECT_ROOT ?? path.join(__dirname, '..', '..');
const skillsDir = path.join(projectRoot, 'skills');

const eventBus = new EventBus();
const eventStore = new SqliteEventStore(path.join(projectRoot, 'data'));
const inMemoryEventStore = new InMemoryEventStore();
const todoStore = new TodoStore(path.join(projectRoot, 'data'));

// Per-connection state for push-based get-next-event delivery.
// Each MCP transport session (HTTP connection or stdio) gets its own entry.
const DEFAULT_SESSION_ID = 'default'; // sentinel for stdio / sessions with no ID
const CONNECTION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CONNECTION_EVICTION_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

interface ConnectionState {
  /** The workflow session ID (event.sessionId) currently active on this connection. */
  activeWorkflowSessionId: string | undefined;
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
  lastSeen: number;
}

const connectionPool = new Map<string, ConnectionState>();

// Sessions marked as test-only — events from these sessions are NOT persisted to events.db.
const testSessions = new Set<string>();

// Composite store that routes to in-memory or SQLite based on test session membership.
// Pass this to any service that needs to read/write events session-aware.
const testAwareEventStore = new TestAwareEventStore(eventStore, inMemoryEventStore, testSessions);

function getOrCreateConnection(cid: string): ConnectionState {
  let conn = connectionPool.get(cid);
  if (!conn) {
    conn = { activeWorkflowSessionId: undefined, roles: [], username: undefined, queue: [], waitingResolver: null, lastSeen: Date.now() };
    connectionPool.set(cid, conn);
    logger.info({ cid }, '[CONNECTION] New connection state created');
  }
  conn.lastSeen = Date.now();
  return conn;
}

function evictStaleConnections() {
  const cutoff = Date.now() - CONNECTION_TTL_MS;
  for (const [cid, conn] of connectionPool) {
    if (conn.lastSeen < cutoff) {
      if (conn.waitingResolver) conn.waitingResolver(null);
      connectionPool.delete(cid);
      logger.info({ cid }, '[CONNECTION] Evicted stale connection');
    }
  }
}

// Run eviction every 30 minutes.
setInterval(evictStaleConnections, CONNECTION_EVICTION_INTERVAL_MS).unref();

// Ensure EventBus starts with the correct sequence number from the store
eventBus.setInitializationPromise((async () => {
  try {
    const maxSeq = await eventStore.getMaxSequence();
    eventBus.setSequenceCounter(maxSeq);
    logger.info({ maxSeq }, `[SERVER] Initialized EventBus with sequence: ${maxSeq}`);
  } catch (err: any) {
    logger.error({ error: err.message }, `[SERVER] Error initializing EventBus sequence: ${err.message}`);
  }
})());

// Log all events and route to the correct store.
// Test sessions → in-memory store (no disk persistence).
// Production sessions → SQLite event store.
eventBus.subscribe('*', async (event) => {
  const isTest = event.sessionId && testSessions.has(event.sessionId);
  logger.info({ eventType: event.type, source: event.source, payload: event.payload, testSession: !!isTest }, `[EVENT] ${event.type} from ${event.source}`);

  if (isTest) {
    await inMemoryEventStore.append(event);
  } else {
    await eventStore.append(event);
  }
});

const jsonData = new JsonDataSource(path.join(projectRoot, 'data'));
const sqliteData = new SqliteDataSource(path.join(projectRoot, 'data'));

const llmService = new LlmService();

// Load external MCP configs from config/config.json
let externalConfigs: ExternalMcpConfig[] = [];
const configPath = path.join(projectRoot, 'config', 'config.json');
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    externalConfigs = config.externalServers ?? [];
  } catch (err: any) {
    logger.error({ error: err.message }, `[SERVER] Error reading config.json: ${err.message}`);
  }
}

const externalMcpManager = new ExternalMcpManager(externalConfigs);
const connectorExecutor = new ConnectorExecutor(connectors);

const tools: Record<string, (params: any, input: any) => Promise<any>> = {
  'events-dump': async (params, input) => {
    let limit = parseInt(params.limit && !params.limit.includes('{{') ? params.limit : '20');
    let skip = parseInt(params.skip && !params.skip.includes('{{') ? params.skip : '0');
    const sessionId = params.sessionId;

    if (isNaN(limit)) limit = 20;
    if (isNaN(skip)) skip = 0;

    try {
      const { events, total } = await testAwareEventStore.getPaged(limit, skip, sessionId);
      const formattedEvents = formatEventLog(events);

      const nextSkip = skip + limit;
      const hasMore = nextSkip < total;

      const summary = `Showing events ${skip + 1} to ${Math.min(skip + limit, total)} of ${total}.\n\n${formattedEvents}\n\n` +
        (hasMore ? `To see more, run with skip=${nextSkip}` : 'End of log.');

      return {
        ...input,
        eventLogDump: summary,
        nextSkip: hasMore ? nextSkip : null,
        totalEvents: total
      };
    } catch (err: any) {
      logger.error({ error: err.message, stack: err.stack }, `[Tool:events-dump] Error: ${err.message}`);
      return { ...input, eventLogDump: `Error dumping events: ${err.message}` };
    }
  },

};

// Re-export for consumers that previously imported directly from this module.
export { parseSkillFrontmatter, listSkillPaths, resolveSkillPath };

// Cached tool definitions list — invalidated on resync.
let cachedToolDefs: Awaited<ReturnType<typeof buildToolDefs>> | null = null;

/**
 * Session-scoped dynamic skills — registered at runtime by test panels.
 * Keyed by sessionId → Map of skillName → { description, body (markdown) }.
 * Isolated per session so other users of the MCP server are unaffected.
 */
const sessionSkills = new Map<string, Map<string, { name: string; description: string; body: string; triggersOn: string; triggersOnSet: Set<string>; publishes: string; sliceData?: any; hidden?: boolean }>>();

/**
 * Session-scoped event-schema index built from the slices registered in this
 * session. Used at slice-resolve time to project each slice's contractually
 * scoped `factIdToName` (own facts ∪ facts on outcome events listed in its
 * `scenario.given[]`). Lifetime mirrors `sessionSkills`.
 */
const sessionEventSchemaIndex = new Map<string, Map<string, FactSchemaEntry[]>>();

function parseTriggers(raw: string): Set<string> {
  return new Set(raw.split('|').map(s => s.trim()).filter(Boolean));
}

/**
 * Builds the full MCP tool definitions list.
 * When interfaceSliceNames is non-empty, only interface slices are included (no root-level skills).
 * When interfaceSliceNames is empty (runner mode), ALL slice skills are included.
 */
async function buildToolDefs(skillsDir: string, interfaceSliceNames: Set<string>) {
  const filePaths = await listSkillPaths(skillsDir);
  const sliceTools = (await Promise.all(filePaths.map(async (fp) => {
    const raw = await fsAsync.readFile(fp, 'utf-8');
    const { name, skill_id, description } = parseSkillFrontmatter(raw);
    if (!name) return null;
    const dirName = path.basename(path.dirname(fp));
    if (interfaceSliceNames.size > 0 && !interfaceSliceNames.has(dirName)) {
      return null;
    }
    // Derive the tool name: prefer skill_id, then prefix with workflow dir if nested.
    // MCP tool names must match ^[a-zA-Z0-9_-]{1,128}$, so use "--" as workflow separator
    // (e.g. skills/activity-2/request-top-projects-report/... → "activity-2--slice-1-...")
    // Internal event sources keep the "/" format; only the exposed tool name uses "--".
    const workflowDir = path.basename(path.dirname(path.dirname(fp)));
    const isNestedInWorkflow = workflowDir !== path.basename(skillsDir);
    const toolName = skill_id || (isNestedInWorkflow ? `${workflowDir}--${name}` : name);
    // Extract triggers_on_event for LLM routing
    const triggersMatch = raw.match(/^triggers_on_event:\s*"?([^"\n]+)"?/m);
    const publishesMatch = raw.match(/^publishes_event:\s*"?([^"\n]+)"?/m);
    const triggerInfo = triggersMatch ? ` | triggers_on_event: ${triggersMatch[1].trim()}` : '';
    const publishInfo = publishesMatch ? ` | publishes_event: ${publishesMatch[1].trim()}` : '';
    return {
      name: toolName,
      description: `[Skill/Slice] ${description || 'No description available.'}${triggerInfo}${publishInfo}`,
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string", description: "The collection name to query if applicable" },
          find: { type: "string", description: "The value to search for, supports {{template}} syntax" },
          returns: { type: "string", description: "The variable name to assign the result to" },
          mappings: { type: "object", description: "Optional property aliases used during execution" }
        }
      }
    };
  }))).filter((t): t is NonNullable<typeof t> => t !== null);

  return [
    ...connectors.flatMap(tool => [{
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: "object",
        properties: tool.inputParams.reduce((acc, param) => {
          acc[param.name] = { type: param.type, description: param.description };
          return acc;
        }, {} as Record<string, any>),
        required: tool.inputParams.filter(p => p.required).map(p => p.name)
      }
    }]),
    {
      name: "get-github-methods",
      description: "List all available GitHub MCP methods (tools).",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "register-agent",
      description: "Register this agent with a username. The server looks up the roles assigned to that username and binds them to this connection. Must be called before list-todos or claim-todo.",
      inputSchema: {
        type: "object",
        properties: {
          username: { type: "string", description: "The username to register (e.g. 'arjan'). Roles are looked up from the server's role configuration." },
          testMode: { type: "boolean", description: "If true, this is a test session. Events will NOT be persisted to the event store." }
        },
        required: ["username"]
      }
    },
    {
      name: "log-event-to-bus",
      description: "Log a custom event into the event store. Use this to record observations, decisions, or notable moments during a session.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "The event type (e.g. 'member-claim-received'). Must be kebab-case; other formats are auto-normalized." },
          source: { type: "string", description: "Source identifier for the event. Defaults to 'llm'." },
          sessionId: { type: "string", description: "REQUIRED session ID to isolate events for a specific claim or workflow. Must be unique!" },
          payload: { type: "object", description: "Arbitrary key-value data to include with the event." }
        },
        required: ["type"]
      }
    },
    {
      name: "events-dump",
      description: " ONLY USE AT USER REQUEST OR SKILL DEFINED TOOL CALL!!! Displays a formatted, paginated dump of the event log. Use to review recorded events in the session.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "string", description: "Max number of events to return (default: 20)." },
          skip: { type: "string", description: "Number of events to skip for pagination (default: 0)." },
          timezone: { type: "string", description: "IANA timezone for timestamp display (e.g. 'America/New_York'). Optional." },
          sessionId: { type: "string", description: "Filter events by session ID. Optional." }
        }
      }
    },
    {
      name: "get-next-event",
      description: "Long-poll for the next qualifying workflow event. The server manages the sequence cursor internally. Returns { event } when an event arrives, or { event: null } after ~60s if none arrives. Re-call immediately either way — no arguments needed.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "handle-latest-event",
      description: "Dispatcher skill. Invoke this after receiving any non-null event from get-next-event, passing the event as context. • Interface event (has a matching skill with triggers_on_event): route to and execute that slice using complete-slice. • Automation / background event (no matching interface skill — the server handled it automatically): acknowledge the completed step, report it briefly to the user, then immediately call get-next-event to continue. • unexpected_last_event: the workflow has completed — summarise what happened and stop polling.",
      inputSchema: {
        type: "object",
        properties: {
          event: { type: "object", description: "The event object returned by get-next-event." }
        }
      }
    },
    {
      name: "list-todos",
      description: "List pending work items (todos) created by the workflow engine. Filter by role to see only items relevant to your role.",
      inputSchema: {
        type: "object",
        properties: {
          role: { type: "string", description: "Filter by role (e.g. 'claims-processor'). Omit to see all pending todos." },
          status: { type: "string", description: "Filter by status: 'pending' (default), 'claimed', or 'completed'." }
        }
      }
    },
    {
      name: "claim-todo",
      description: "Claim a pending todo work item and join its workflow session. Returns the todo's payload (accumulated fact values) and sessionId so you can continue the workflow.",
      inputSchema: {
        type: "object",
        properties: {
          todoId: { type: "string", description: "The ID of the todo to claim." }
        },
        required: ["todoId"]
      }
    },
    {
      name: "resolve-todo",
      description: "Mark a claimed todo as completed/resolved. The todo is removed from the active task list.",
      inputSchema: {
        type: "object",
        properties: {
          todoId: { type: "string", description: "The ID of the todo to resolve." }
        },
        required: ["todoId"]
      }
    },
    {
      name: "unclaim-todo",
      description: "Release a claimed todo back to pending status so it can be picked up again.",
      inputSchema: {
        type: "object",
        properties: {
          todoId: { type: "string", description: "The ID of the todo to unclaim." }
        },
        required: ["todoId"]
      }
    },
    {
      name: "get-session-events",
      description: "Return the full structured event list for a workflow session (oldest first). Used by UIs that render a session timeline.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The workflow session ID to load events for." }
        },
        required: ["sessionId"]
      }
    },
    {
      name: "register-skills",
      description: "Register skill/slice definitions for this session. Skills are session-scoped and isolated from other users. Typically called by the workbench test panel to push the current model's slices.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The session ID to register skills for" },
          skills: {
            type: "array",
            description: "Array of skill definitions, each with name, markdown content, and optional structured sliceData",
          }
        },
        required: ["sessionId", "skills"]
      }
    },
    {
      name: "complete-slice",
      description: "Complete a workflow slice by evaluating its business rules against collected facts. The server evaluates scenarios deterministically, logs matching outcome events to the event bus, and advances the workflow. Call this after collecting all required facts for a slice.",
      inputSchema: {
        type: "object",
        properties: {
          sliceId: { type: "string", description: "The slice tool name (e.g. 'slice-1-intake-request')" },
          sessionId: { type: "string", description: "The workflow session ID" },
          facts: { type: "object", description: "Collected fact key-value pairs (kebab-case keys)" }
        },
        required: ["sliceId", "sessionId", "facts"]
      }
    },
    {
      name: "describe-data-sources",
      description: "Returns the available JSON collections (files in data/) with a sample record from each. Plan authors call this at design time so the LLM uses the actual field names of the data — preventing invented fact names that the tool will never populate.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    ...sliceTools
  ];
}

/**
 * Resolves the slice JSON for a `complete-slice` call. Mirrors the
 * automated-slice dispatch's two-source pattern (see {@link resolveDiskSliceData}
 * and {@link resolveInlineSliceData}): test-session skills first, disk-based
 * skills as fallback. Returns null when neither source has the slice.
 *
 * Keep this aligned with the `eventBus.subscribe('*', ...)` dispatcher in this
 * file — both routes consume the same `sliceData` shape and the same
 * downstream pipeline (`executeSliceQueries` → `evaluateSlice` →
 * `completeSliceFinalize`).
 */
async function resolveSliceForCompletion(
  sliceId: string,
  cid: string,
): Promise<{
  source: 'session' | 'disk';
  sliceData: any;
  /** Per-slice scoped factId → factName (own ∪ given-events). */
  factIdToName: Map<string, string>;
  /** Set only for the session source; carries the registered skill metadata
   *  (used for action-slice detection — entry-point slices that should mint a
   *  fresh session ID to defeat hallucinated session IDs from interface LLMs). */
  skill?: { name: string; triggersOnSet: Set<string>; sliceData?: any };
  /** Set only for the disk source; used to derive the activity workflow name. */
  skillMdPath?: string;
} | null> {
  // 1. Test-session skills (registered via the `register-skills` tool).
  const sessSkills = sessionSkills.get(cid);
  if (sessSkills) {
    let skill = sessSkills.get(sliceId);
    if (!skill?.sliceData) {
      // The test panel sometimes pushes a slice keyed by its sliceId but the
      // client agent calls back with the slice's `name` instead — match
      // against either.
      for (const s of sessSkills.values()) {
        if (s.name === sliceId && s.sliceData) { skill = s; break; }
      }
    }
    if (skill?.sliceData) {
      const eventSchemaIndex =
        sessionEventSchemaIndex.get(cid) ?? new Map<string, FactSchemaEntry[]>();
      const factIdToName = buildScopedFactIdToName(skill.sliceData, eventSchemaIndex);
      return { source: 'session', sliceData: skill.sliceData, skill, factIdToName };
    }
  }

  // 2. Disk-based outcome model JSON.
  const skillMdPath = await resolveSkillPath(skillsDir, sliceId);
  if (!fs.existsSync(skillMdPath)) return null;
  // `loadSliceFromMdPath` returns the slice JSON together with its scoped
  // factId map (own ∪ given-events), so disk-side `complete-slice` honours
  // the same Event Modeling contract as the inline path.
  const loaded = await loadSliceFromMdPath(skillMdPath);
  if (!loaded) return null;
  return {
    source: 'disk',
    sliceData: loaded.slice,
    factIdToName: loaded.factIdToName,
    skillMdPath,
  };
}

/**
 * Finalize a complete-slice call: log events to bus and return result.
 * Separated from the handler to avoid duplication between the two lookup paths.
 */
async function completeSliceFinalize(
  evalResult: ReturnType<typeof evaluateSlice>,
  workflowSessionId: string,
  cid: string,
  conn: ConnectionState,
) {
  // Bind connection to workflow session
  if (workflowSessionId && conn.activeWorkflowSessionId !== workflowSessionId) {
    conn.activeWorkflowSessionId = workflowSessionId;
    conn.queue = [];
    logger.info({ cid, workflowSessionId }, '[complete-slice] Joined workflow session');
  }

  // Propagate test-session flag to the workflow session ID so downstream
  // automated slices and the event router can identify events as test-only.
  // Also mirror the session skill map so the event router can find skills
  // when events arrive keyed by workflow session ID instead of MCP session ID.
  if (testSessions.has(cid) && workflowSessionId) {
    testSessions.add(workflowSessionId);
    if (!sessionSkills.has(workflowSessionId)) {
      const cidSkills = sessionSkills.get(cid);
      if (cidSkills) sessionSkills.set(workflowSessionId, cidSkills);
    }
    // Mirror the event-schema index so automated slices firing under the
    // workflow session ID can still scope facts via given-events.
    if (!sessionEventSchemaIndex.has(workflowSessionId)) {
      const cidIndex = sessionEventSchemaIndex.get(cid);
      if (cidIndex) sessionEventSchemaIndex.set(workflowSessionId, cidIndex);
    }
  }

  // Log all matched outcome events to the event bus
  for (const event of evalResult.eventsToLog) {
    const eventId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const prefixedSource = (conn.activeWorkflow && event.source && !event.source.includes('/'))
      ? `${conn.activeWorkflow}/${event.source}`
      : event.source;
    logger.info({ eventType: event.type, source: prefixedSource, sessionId: workflowSessionId, cid }, '[complete-slice] Logging event');
    await eventBus.publish({
      id: eventId,
      type: event.type,
      source: prefixedSource,
      sessionId: workflowSessionId,
      payload: event.payload,
      timestamp: new Date(),
    });
  }

  const hasError = evalResult.matchedScenarios.some(s => s.error);
  logger.info({
    cid,
    sliceId: evalResult.sliceId,
    matched: evalResult.matchedScenarios.length,
    eventsLogged: evalResult.eventsToLog.length,
    hasError,
  }, '[complete-slice] Slice completed');

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        sliceId: evalResult.sliceId,
        sliceName: evalResult.sliceName,
        matchedScenarios: evalResult.matchedScenarios.length,
        unmatchedScenarios: evalResult.unmatchedScenarios,
        eventsLogged: evalResult.eventsToLog.map(e => e.type),
        errors: evalResult.matchedScenarios.filter(s => s.error).map(s => s.error),
        ...(evalResult.requiresStructuredRules ? {
          warning: 'Some scenarios have only free-text business rules and could not be evaluated deterministically. Add structured BusinessRule conditions in the builder for accurate evaluation.',
        } : {}),
        // Ghost-sync: advance to next slice
        slice_actions: [{ action: 'scroll-next' }],
      }, null, 2),
    }],
  };
}

function registerHandlers(
  server: Server,
  interfaceSliceNames: Set<string>,
  isResyncing: () => boolean
) {
  server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => {
    const skillsDir = path.join(projectRoot, 'skills');
    if (isResyncing()) {
      logger.warn('[SERVER] tools/list requested during resync — waiting for resync to complete');
      // Spin-wait up to 10s for the resync to finish before scanning files.
      const start = Date.now();
      while (isResyncing() && Date.now() - start < 10_000) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    if (!cachedToolDefs) {
      cachedToolDefs = await buildToolDefs(skillsDir, interfaceSliceNames);
    }

    // Only expose session-scoped skills registered by THIS session.
    // Non-test sessions have no registered skills and see disk tools only.
    const callerSessionId = (extra as any)?.sessionId ?? DEFAULT_SESSION_ID;
    const callerSkillMap = sessionSkills.get(callerSessionId);
    const allSessionToolDefs: typeof cachedToolDefs = [];
    const seenSessionSkills = new Set<string>();
    if (callerSkillMap) {
      for (const s of callerSkillMap.values()) {
        if (s.hidden) continue; // automation slices: server-run only, not LLM-callable
        seenSessionSkills.add(s.name);
        const triggerInfo = s.triggersOn ? ` | triggers_on_event: ${s.triggersOn}` : '';
        const publishInfo = s.publishes ? ` | publishes_event: ${s.publishes}` : '';
        allSessionToolDefs.push({
          name: s.name,
          description: `[Skill/Slice] ${s.description || 'No description available.'}${triggerInfo}${publishInfo}`,
          inputSchema: {
            type: "object",
            properties: {
              collection: { type: "string", description: "The collection name to query if applicable" },
              find: { type: "string", description: "The value to search for, supports {{template}} syntax" },
              returns: { type: "string", description: "The variable name to assign the result to" },
              mappings: { type: "object", description: "Optional property aliases used during execution" }
            }
          }
        });
      }
    }

    const exposedExternalDefs = externalMcpManager.getExposedToolDefinitions().map(d => ({
      name: d.name,
      description: `[External MCP] ${d.description ?? ''}`,
      inputSchema: d.inputSchema,
    }));

    // Session skills override disk skills with the same name
    const mergedTools = [
      ...cachedToolDefs.filter(t => !seenSessionSkills.has(t.name)),
      ...allSessionToolDefs,
      ...exposedExternalDefs,
    ];

    const toolNames = mergedTools.map(t => t.name).join(', ');
    logger.info({ toolCount: mergedTools.length, toolNames }, `[SERVER] tools/list requested. Available tools: ${toolNames}`);
    return { tools: mergedTools };
  });

  // Inline tool handlers. Declared inside `registerHandlers` so they close
  // over the local services (eventBus, sessionSkills, jsonData, todoStore,
  // connectorExecutor, ...). The request handler dispatches to this table
  // first; tools not listed here fall through to connector / external-tool
  // / session-skill / disk-skill resolution.
  type ToolResult = { content: unknown[] };
  type InlineToolHandler = (
    args: Record<string, any>,
    extra: { sessionId?: string; [k: string]: any },
  ) => Promise<ToolResult>;
  const inlineToolHandlers: Record<string, InlineToolHandler> = {
    'describe-data-sources': async () => {
      // List JSON collections in data/ and return a sample record from each so
      // plan synthesis can use real field names instead of inventing them.
      const dataDir = path.join(projectRoot, 'data');
      let entries: string[] = [];
      try {
        entries = (await fsAsync.readdir(dataDir)).filter(f => f.endsWith('.json'));
      } catch (err: any) {
        logger.warn({ error: err.message }, '[describe-data-sources] Failed to list data dir');
      }
      const collections = await Promise.all(entries.map(async (file) => {
        const collectionName = file.replace(/\.json$/, '');
        try {
          const items = await jsonData.read(collectionName);
          const sampleRecord = Array.isArray(items) && items.length > 0 ? items[0] : null;
          const sampleFields = sampleRecord && typeof sampleRecord === 'object'
            ? Object.keys(sampleRecord)
            : [];
          return {
            name: collectionName,
            recordCount: Array.isArray(items) ? items.length : 0,
            sampleFields,
            sampleRecord,
          };
        } catch {
          return { name: collectionName, recordCount: 0, sampleFields: [], sampleRecord: null };
        }
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ collections }, null, 2) }]
      };
    },

    'register-agent': async (args, extra) => {
      const { username, testMode } = args as { username: string; testMode?: boolean };
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;
      const conn = getOrCreateConnection(cid);

      // Mark test sessions — events will NOT be persisted for these sessions
      if (testMode) {
        testSessions.add(cid);
        logger.info({ cid }, '[register-agent] Test mode enabled — events will not be persisted');
      }

      // Look up roles from data/roles.json
      let roles: string[] = [];
      try {
        const allRoles = await jsonData.read('roles') as Array<{ username: string; roles: string[] }>;
        const entry = allRoles.find(r => r.username.toLowerCase() === username.toLowerCase());
        if (entry) {
          roles = entry.roles;
        }
      } catch (err: any) {
        logger.warn({ username, error: err.message }, '[register-agent] Failed to read roles data');
      }

      conn.username = username;
      conn.roles = roles;

      logger.info({ cid, username, roles, testMode: !!testMode }, '[register-agent] Agent registered');
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, username, roles, testMode: !!testMode }, null, 2) }]
      };
    },

    'register-skills': async (args, extra) => {
      const { sessionId: regSessionId, skills } = args as {
        sessionId: string;
        skills: Array<{ name: string; markdown: string; sliceData?: any; hidden?: boolean }>;
      };
      if (!regSessionId || !Array.isArray(skills)) {
        throw new Error('register-skills requires sessionId and skills array');
      }
      const skillMap = sessionSkills.get(regSessionId) ?? new Map();
      for (const skill of skills) {
        const { name: sName, description, body } = parseSkillFrontmatter(skill.markdown);
        // Extract triggers_on_event and publishes_event from frontmatter for routing
        const triggersMatch = skill.markdown.match(/^triggers_on_event:\s*"?([^"\n]+)"?/m);
        const publishesMatch = skill.markdown.match(/^publishes_event:\s*"?([^"\n]+)"?/m);
        const triggersOn = triggersMatch?.[1]?.trim() ?? '';
        const publishes = publishesMatch?.[1]?.trim() ?? '';
        const finalName = sName || skill.name;
        if (finalName) {
          skillMap.set(finalName, { name: finalName, description, body, triggersOn, triggersOnSet: parseTriggers(triggersOn), publishes, sliceData: skill.sliceData, hidden: skill.hidden ?? false });
          logger.info({ sessionId: regSessionId, skillName: finalName, hasSliceData: !!skill.sliceData, hidden: skill.hidden ?? false, triggersOn, publishes }, '[register-skills] Registered session skill');
        }
      }
      sessionSkills.set(regSessionId, skillMap);
      // Also index under the MCP transport session ID so complete-slice can find
      // skills when the workbench passes a different sessionId in the args.
      const cid2 = extra.sessionId ?? DEFAULT_SESSION_ID;
      if (cid2 !== regSessionId) sessionSkills.set(cid2, skillMap);

      // Build a fresh event-schema index from the FULL post-merge skill map.
      // Rebuilding (rather than mutating) drops events from removed slices,
      // matching the workbench's "re-push on model change" model.
      const sliceBundle: any[] = [];
      for (const v of skillMap.values()) {
        if (v.sliceData) sliceBundle.push(v.sliceData);
      }
      const eventSchemaIndex = buildEventSchemaIndex(sliceBundle);
      sessionEventSchemaIndex.set(regSessionId, eventSchemaIndex);
      if (cid2 !== regSessionId) sessionEventSchemaIndex.set(cid2, eventSchemaIndex);

      // Validate every slice's factId references against its scoped lookup.
      // An unmapped reference means the slice's rules or input mappings target
      // a factId that is neither declared on the slice nor on any outcome
      // event listed in its `scenario.given[]` — a design-time violation of
      // the Event Modeling contract that would silently fail at evaluation.
      const factWarnings: Array<{
        sliceName: string;
        location: string;
        factId: string;
        scenarioIndex?: number;
        suggestedGiven?: string;
      }> = [];
      for (const [sName, v] of skillMap.entries()) {
        if (!v.sliceData) continue;
        const scoped = buildScopedFactIdToName(v.sliceData, eventSchemaIndex);
        for (const ref of collectUnmappedFactIds(v.sliceData, scoped, eventSchemaIndex)) {
          factWarnings.push({
            sliceName: sName,
            location: ref.location,
            factId: ref.factId,
            scenarioIndex: ref.scenarioIndex,
            suggestedGiven: ref.suggestedGiven,
          });
        }
      }
      if (factWarnings.length > 0) {
        logger.warn(
          { sessionId: regSessionId, count: factWarnings.length, warnings: factWarnings },
          '[register-skills] Detected unmapped factId references — rules will not resolve them',
        );
      }

      // Eagerly derive activeWorkflow from the first skill with sliceData so that
      // direct log-event-to-bus calls (e.g. "start workflow" button) are prefixed correctly.
      const connForReg = getOrCreateConnection(cid2);
      if (!connForReg.activeWorkflow) {
        for (const sk of skills) {
          const activityName =
            sk.sliceData?.outcomes?.[0]?.activity?.name
            ?? sk.sliceData?.command?.outcomes?.[0]?.activity?.name;
          if (activityName) { connForReg.activeWorkflow = activityName; break; }
        }
      }

      const registered = [...skillMap.keys()];
      logger.info({ sessionId: regSessionId, cid: cid2, activeWorkflow: connForReg.activeWorkflow, count: registered.length }, '[register-skills] Session skills registered');
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, registered, factWarnings }, null, 2) }]
      };
    },

    'log-event-to-bus': async (args, extra) => {
      const { type, source: rawSource = 'llm', sessionId: providedSessionId, payload = {} } = args as { type: string; source?: string; sessionId?: string; payload?: Record<string, any> };
      const normalizedType = toKebabCase(type);

      // Always ensure the connection exists so the event router can find it when
      // automated slices publish events — even when no explicit sessionId is provided.
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;
      const conn = getOrCreateConnection(cid);

      // Mirror complete-slice: caller-provided sessionId wins, else reuse the
      // connection's active session, else mint a fresh UUID. Without this,
      // canvas-mode publishes events with sessionId=undefined and the
      // EVENT_ROUTER can't look up session-scoped handlers.
      const sessionId = providedSessionId ?? conn.activeWorkflowSessionId ?? crypto.randomUUID();

      // Prefix source with the connection's known workflow so the dispatch filter
      // can scope automated slice fan-out to the correct workflow.
      const source = (conn.activeWorkflow && !rawSource.includes('/'))
        ? `${conn.activeWorkflow}/${rawSource}`
        : rawSource;
      if (conn.activeWorkflowSessionId !== sessionId) {
        const isExplicitSwitch = !!providedSessionId && conn.activeWorkflowSessionId != null;
        conn.activeWorkflowSessionId = sessionId;
        if (isExplicitSwitch) conn.queue = []; // only flush stale events on a real session switch
        logger.info({ cid, workflowSessionId: sessionId, minted: !providedSessionId }, '[log-event-to-bus] New workflow session registered for connection');
      }

      logger.info({ eventType: normalizedType, source, sessionId, cid }, '[log-event-to-bus] Publishing event');
      await eventBus.publish({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, type: normalizedType, source, sessionId, payload, timestamp: new Date() });
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, eventType: normalizedType, source, sessionId }, null, 2) }]
      };
    },

    'get-next-event': async (_args, extra) => {
      const TIMEOUT_MS = 60000;
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;
      const conn = getOrCreateConnection(cid);

      // If there's already a queued event, return it immediately.
      if (conn.queue.length > 0) {
        const event = conn.queue.shift()!;
        logger.info({ cid, eventType: event.type, workflowSessionId: conn.activeWorkflowSessionId }, '[get-next-event] Returning queued event');
        return { content: [{ type: "text", text: JSON.stringify({ event }, null, 2) }] };
      }

      // Park a resolver; the EventBus routing subscriber will call it when an event arrives.
      const event = await new Promise<Event | null>((resolve) => {
        conn.waitingResolver = resolve;
        setTimeout(() => {
          if (conn.waitingResolver === resolve) {
            conn.waitingResolver = null;
            resolve(null);
          }
        }, TIMEOUT_MS);
      });

      if (event) {
        logger.info({ cid, eventType: event.type, workflowSessionId: conn.activeWorkflowSessionId }, '[get-next-event] Returning pushed event');
      } else {
        logger.info({ cid, workflowSessionId: conn.activeWorkflowSessionId }, '[get-next-event] Timeout — returning null event');
      }
      return { content: [{ type: "text", text: JSON.stringify({ event }, null, 2) }] };
    },

    'list-todos': async (args, extra) => {
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;
      const conn = getOrCreateConnection(cid);

      if (conn.roles.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: 'Not registered. Call register-agent first.' }, null, 2) }]
        };
      }

      const { status } = (args ?? {}) as { status?: string };
      const requested = status && ['pending', 'claimed', 'completed'].includes(status) ? status : 'pending';

      // Return todos matching the requested status and any of the connection's registered roles.
      // Also include todos with empty role (available to anyone).
      const todos = todoStore.findByStatus(requested).filter(t =>
        t.role === '' || conn.roles.includes(t.role)
      );

      // Always include todos claimed by the current user, regardless of
      // the requested status filter. This ensures a reconnecting client
      // can resume work that was in progress before the connection dropped.
      if (requested !== 'claimed' && conn.username) {
        const claimed = todoStore.findByStatus('claimed').filter(t =>
          t.claimedBy === conn.username && !todos.some(existing => existing.id === t.id)
        );
        todos.push(...claimed);
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ todos }, null, 2) }]
      };
    },

    'get-session-events': async (args) => {
      const { sessionId } = (args ?? {}) as { sessionId?: string };
      if (!sessionId) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: 'sessionId is required' }, null, 2) }]
        };
      }
      try {
        const { events, total } = await testAwareEventStore.getPaged(1000, 0, sessionId);
        // getPaged returns newest-first for paginated log views; timelines want oldest-first.
        const ordered = events.slice().reverse();
        return {
          content: [{ type: "text", text: JSON.stringify({ events: ordered, total }, null, 2) }]
        };
      } catch (err: any) {
        logger.error({ error: err.message, sessionId }, '[get-session-events] Error');
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }, null, 2) }]
        };
      }
    },

    'claim-todo': async (args, extra) => {
      const { todoId } = args as { todoId: string };
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;
      const conn = getOrCreateConnection(cid);

      if (conn.roles.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: 'Not registered. Call register-agent first.' }, null, 2) }]
        };
      }

      // Check role match before claiming
      const existing = todoStore.getById(todoId);
      if (!existing) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: 'Todo not found' }, null, 2) }]
        };
      }
      if (existing.role !== '' && !conn.roles.includes(existing.role)) {
        logger.warn({ cid, todoId, todoRole: existing.role, agentRoles: conn.roles }, '[claim-todo] Role mismatch');
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: `Role mismatch: todo requires '${existing.role}' but agent has roles [${conn.roles.join(', ')}]` }, null, 2) }]
        };
      }

      const claimedBy = conn.username ?? cid;

      // Allow the same user to resume a todo they previously claimed
      // (e.g. after a reconnect). The connection is re-bound to the
      // workflow session so the agent can continue where it left off.
      if (existing.status === 'claimed' && existing.claimedBy === claimedBy) {
        if (existing.workflowSessionId && conn.activeWorkflowSessionId !== existing.workflowSessionId) {
          conn.activeWorkflowSessionId = existing.workflowSessionId;
          conn.queue = [];
          logger.info({ cid, workflowSessionId: existing.workflowSessionId }, '[claim-todo] Resumed claimed todo — rejoined workflow session');
        }
        logger.info({ cid, todoId, sliceName: existing.sliceName, claimedBy }, '[claim-todo] Todo resumed by same user');
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            todo: {
              id: existing.id,
              sliceName: existing.sliceName,
              role: existing.role,
              workflowSessionId: existing.workflowSessionId,
              triggerEventType: existing.triggerEventType,
              payload: existing.payload,
            },
          }, null, 2) }]
        };
      }

      const todo = todoStore.claim(todoId, claimedBy);
      if (!todo) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: 'Todo already claimed or completed' }, null, 2) }]
        };
      }

      // Join the workflow session — same as log-event-to-bus does
      if (todo.workflowSessionId && conn.activeWorkflowSessionId !== todo.workflowSessionId) {
        conn.activeWorkflowSessionId = todo.workflowSessionId;
        conn.queue = [];
        logger.info({ cid, workflowSessionId: todo.workflowSessionId }, '[claim-todo] Joined workflow session');
      }

      logger.info({ cid, todoId, sliceName: todo.sliceName, role: todo.role, claimedBy, workflowSessionId: todo.workflowSessionId }, '[claim-todo] Todo claimed');
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: true,
          todo: {
            id: todo.id,
            sliceName: todo.sliceName,
            role: todo.role,
            workflowSessionId: todo.workflowSessionId,
            triggerEventType: todo.triggerEventType,
            payload: todo.payload,
          }
        }, null, 2) }]
      };
    },

    'resolve-todo': async (args, extra) => {
      const { todoId } = args as { todoId: string };
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;

      const existing = todoStore.getById(todoId);
      if (!existing) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: 'Todo not found' }, null, 2) }]
        };
      }
      if (existing.status === 'completed') {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, message: 'Todo already resolved' }, null, 2) }]
        };
      }

      const todo = todoStore.complete(todoId);
      logger.info({ cid, todoId, sliceName: existing.sliceName }, '[resolve-todo] Todo resolved');
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, todo }, null, 2) }]
      };
    },

    'unclaim-todo': async (args, extra) => {
      const { todoId } = args as { todoId: string };
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;

      const existing = todoStore.getById(todoId);
      if (!existing) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: 'Todo not found' }, null, 2) }]
        };
      }
      if (existing.status !== 'claimed') {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: `Cannot unclaim: todo status is '${existing.status}'` }, null, 2) }]
        };
      }

      // Reset back to pending
      todoStore.upsert({ ...existing, status: 'pending', claimedBy: undefined, claimedAt: undefined });
      logger.info({ cid, todoId, sliceName: existing.sliceName }, '[unclaim-todo] Todo returned to pending');
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, message: 'Todo returned to pending' }, null, 2) }]
      };
    },

    // ───────────────────────────────────────────────────────────────────
    // COMPLETE-SLICE — same SliceData shape, same downstream pipeline,
    // for both production disk slices AND workbench test sessions.
    //
    // Resolution: `resolveSliceForCompletion` checks session skills first,
    // then falls back to the disk outcome model JSON. From there, the
    // pipeline is uniform — `executeSliceQueries` → `evaluateSlice` →
    // (error early-return if any matched scenario has an `error`) →
    // `completeSliceFinalize`.
    //
    // Action-slice fresh-session minting is session-only on purpose: the
    // session path knows `triggersOnSet` from the registered markdown
    // frontmatter, while the disk path doesn't (and disk callers are not
    // the same hallucinating-LLM clients that motivated the workaround).
    //
    // Keep this aligned with the automated-slice dispatcher above.
    // ───────────────────────────────────────────────────────────────────
    'complete-slice': async (args, extra) => {
      const { sliceId, sessionId: providedSessionId, facts: collectedFacts } = args as {
        sliceId: string;
        sessionId?: string;
        facts: Record<string, any>;
      };
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;
      const conn = getOrCreateConnection(cid);

      const resolved = await resolveSliceForCompletion(sliceId, cid);
      if (!resolved) {
        logger.warn({ cid, sliceId }, '[complete-slice] No slice found (session or disk)');
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: false,
            error: `No slice data found for '${sliceId}'.`,
          }, null, 2) }]
        };
      }

      // Cache the activity workflow on the connection so log-event-to-bus
      // can prefix the event source. Prefer sliceData (more precise);
      // fall back to the disk path's directory layout when sliceData
      // doesn't carry an activity name.
      if (!conn.activeWorkflow) {
        const activityName =
          resolved.sliceData.outcomes?.[0]?.activity?.name
          ?? resolved.sliceData.command?.outcomes?.[0]?.activity?.name;
        if (activityName) {
          conn.activeWorkflow = activityName;
        } else if (resolved.skillMdPath) {
          const derived = path.basename(path.dirname(path.dirname(resolved.skillMdPath)));
          if (derived && derived !== path.basename(skillsDir)) conn.activeWorkflow = derived;
        }
      }

      // Action-slice (entry point) detection — session-only. Mint a fresh
      // workflow session so facts from a prior run don't bleed into a new
      // test. `providedSessionId` is IGNORED for action slices because the
      // interface LLM often hallucinates stable ids like "session-123" or
      // "test-session", which causes in-memory test events to accumulate
      // across runs and leak facts between users.
      const isSessionActionSlice = resolved.source === 'session'
        && (resolved.skill?.triggersOnSet?.size ?? 0) === 0
        && !!resolved.sliceData.interface
        && !resolved.sliceData.automation;
      const workflowSessionId = isSessionActionSlice
        ? crypto.randomUUID()
        : (providedSessionId ?? conn.activeWorkflowSessionId ?? crypto.randomUUID());
      if (isSessionActionSlice) {
        logger.info(
          { cid, sliceId, workflowSessionId, hallucinatedSessionId: providedSessionId },
          '[complete-slice] Action slice — minting fresh workflow session to prevent stale fact bleed'
        );
      }

      const sessionFacts = testAwareEventStore.getSessionFactValues(workflowSessionId);
      const mergedFacts = { ...sessionFacts, ...collectedFacts };

      const connectorContext = {
        eventBus,
        dataSources: { json: jsonData, sqlite: sqliteData },
        tools,
        sessionId: workflowSessionId,
      };
      const enrichedFacts = await executeSliceQueries(
        resolved.sliceData, mergedFacts, connectorExecutor, connectorContext, llmService,
        resolved.factIdToName,
      );

      const sliceLlmEvaluator = llmService
        ? (rule: any, factName: string, factValue: string, allFacts: Record<string, any>) =>
            llmService.evaluateRule(factName, factValue, rule.llmPrompt ?? '', allFacts)
        : undefined;
      const evalResult = await evaluateSlice(
        resolved.sliceData, enrichedFacts, sliceLlmEvaluator, resolved.factIdToName,
      );

      // Error-scenario early return (now applies to both sources): if any
      // matched scenario carries an `error`, return it WITHOUT publishing
      // events so the agent can re-collect facts and try again.
      const errors = evalResult.matchedScenarios
        .filter((s: any) => s.error)
        .map((s: any) => s.error);
      if (errors.length > 0) {
        logger.info(
          { sliceId, errors, source: resolved.source },
          '[complete-slice] Error scenarios matched — returning errors, no events published'
        );
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: false,
            sliceId: evalResult.sliceId,
            sliceName: evalResult.sliceName,
            errors,
            message: 'Correct the input and call complete-slice again.',
          }, null, 2) }]
        };
      }

      return await completeSliceFinalize(evalResult, workflowSessionId, cid, conn);
    },

    'handle-latest-event': async () => {
      const { description, body } = parseSkillFrontmatter(HANDLE_LATEST_EVENT_SKILL);
      return {
        content: [{ type: "text", text: `Skill/Slice: handle-latest-event\nDescription: ${description}\n\n${body}` }]
      };
    },

    'get-github-methods': async () => {
      const githubTools = Object.keys(tools)
        .filter(t => t.startsWith("github_"))
        .map(t => t.replace("github_", ""));

      return {
        content: [{ type: "text", text: JSON.stringify({ methods: githubTools }, null, 2) }]
      };
    },
  };

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    // Guard: only allow tools that are listed in the client-facing tool definitions.
    if (!cachedToolDefs) {
      cachedToolDefs = await buildToolDefs(skillsDir, interfaceSliceNames);
    }
    const callSessionId = extra?.sessionId ?? DEFAULT_SESSION_ID;
    const sessSkills = sessionSkills.get(callSessionId);
    const allowedNames = new Set(cachedToolDefs.map(t => t.name));
    if (sessSkills) for (const sName of sessSkills.keys()) allowedNames.add(sName);
    for (const d of externalMcpManager.getExposedToolDefinitions()) allowedNames.add(d.name);
    if (!allowedNames.has(name)) {
      logger.warn({ toolName: name }, `[SERVER] Rejected call to unlisted tool: ${name}`);
      throw new Error(`Tool not found: ${name}`);
    }

    try {
      // Dispatch inline tool handlers (declared above setRequestHandler).
      const inlineHandler = inlineToolHandlers[name];
      if (inlineHandler) {
        return await inlineHandler((args ?? {}) as Record<string, any>, extra) as { content: any[] };
      }

      // Check if it's a registered Connector
      let connector = connectors.find(t => t.name === name);
      logger.debug({ toolName: name }, `[SERVER] Checking for Connector '${name}'`);

      if (connector) {
        logger.info({ toolName: name }, `[SERVER] Running Connector '${name}'`);
        const conn = connectionPool.get(callSessionId);
        const connectorContext = {
          eventBus,
          dataSources: { json: jsonData, sqlite: sqliteData },
          tools: tools,
          sessionId: conn?.activeWorkflowSessionId ?? callSessionId,
        };
        const executor = connectorExecutor.createExecutor(name, args as Record<string, any>);
        const result = await executor(connectorContext, args as Record<string, any>);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }


      // Handle external tools registered from ExternalMcpManager
      if (tools[name]) {
        logger.info({ toolName: name }, `[SERVER] Running external tool '${name}'`);
        const result = await tools[name](args, {});
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }

      // Check session-scoped skills first (registered by test panels)
      const callSessSkills = sessionSkills.get(callSessionId);
      if (callSessSkills?.has(name)) {
        const skill = callSessSkills.get(name)!;
        // Derive activeWorkflow from sliceData so log-event-to-bus can prefix source correctly.
        const connForWorkflow = connectionPool.get(callSessionId);
        if (connForWorkflow && !connForWorkflow.activeWorkflow && skill.sliceData) {
          const activityName =
            skill.sliceData.outcomes?.[0]?.activity?.name
            ?? skill.sliceData.command?.outcomes?.[0]?.activity?.name;
          if (activityName) connForWorkflow.activeWorkflow = activityName;
        }
        logger.info({ toolName: name, sessionId: callSessionId, activeWorkflow: connectionPool.get(callSessionId)?.activeWorkflow }, `[SERVER] Returning session skill content: ${name}`);
        return {
          content: [
            {
              type: "text",
              text: `Skill/Slice: ${name}\nDescription: ${skill.description}\n\n${skill.body}`
            }
          ]
        };
      }

      // Check if it's a slice/skill registered as a tool (from disk)
      const fp = await resolveSkillPath(skillsDir, name);
      if (fs.existsSync(fp)) {
        const raw = await fsAsync.readFile(fp, 'utf-8');
        const { description, body } = parseSkillFrontmatter(raw);

        // Derive and cache the workflow from the resolved file path so that
        // subsequent log-event-to-bus calls can prefix their source correctly.
        const connForWorkflow = connectionPool.get(callSessionId);
        if (connForWorkflow && !connForWorkflow.activeWorkflow) {
          const derivedWorkflow = path.basename(path.dirname(path.dirname(fp)));
          if (derivedWorkflow && derivedWorkflow !== path.basename(skillsDir)) {
            connForWorkflow.activeWorkflow = derivedWorkflow;
          }
        }

        // Auto-bind: if the client dispatches a slice without claiming its
        // todo first, look up a pending todo by slice name and bind the
        // connection to the correct workflow session so the prefetch reads
        // the right facts.
        const baseSliceName = name.replace(/^slice-\d+-/, '');
        const connForBind = connectionPool.get(callSessionId);
        if (connForBind) {
          const pendingTodo = todoStore.findPendingBySliceName(baseSliceName);
          if (pendingTodo && pendingTodo.workflowSessionId !== connForBind.activeWorkflowSessionId) {
            connForBind.activeWorkflowSessionId = pendingTodo.workflowSessionId;
            connForBind.queue = [];
            logger.info(
              { cid: callSessionId, sliceName: baseSliceName, workflowSessionId: pendingTodo.workflowSessionId },
              '[SERVER] Auto-bound connection to workflow session from pending todo'
            );
          }
        }

        // Run any server-side queries declared on this slice (in the outcome
        // model JSON) and append their results to the slice body. This lets
        // the skill author declare "fetch X before presenting" once in the
        // model, instead of relying on the client agent to remember to call
        // the tool and render its output.
        //
        // Two kinds of queries:
        //  - with a `job`: server executes the connector and captures the
        //    returned payload.
        //  - without a `job`: the query is a snapshot declaration — we pluck
        //    the declared facts from the current session and report them.
        // Either way, the slice body is only returned once every query has
        // been resolved, so the client never sees a partial view.
        let queryResultsSection = '';
        // Collect raw connector results so they can be returned as extra
        // content blocks (e.g. for client-side DocumentCards rendering).
        const prefetchedToolResults: { toolId: string; result: any }[] = [];
        try {
          const sliceOutcomes = await loadSliceOutcomes(fp);
          if (sliceOutcomes) {
            const queries = await loadSliceQueries(fp, sliceOutcomes.factIdToName);
            if (queries.length) {
              // Facts are stored on events stamped with the workflow session
              // (shared across roles/connections), not the MCP transport id.
              // Prefer the connection's bound workflow session, fall back to
              // the transport id when the connection hasn't joined one yet.
              const connForFacts = connectionPool.get(callSessionId);
              const factsSessionId = connForFacts?.activeWorkflowSessionId ?? callSessionId;
              const sessionFacts = testAwareEventStore.getSessionFactValues(factsSessionId);
              logger.info(
                { toolName: name, factsSessionId, factKeys: Object.keys(sessionFacts) },
                `[SERVER] Prefetch facts loaded for slice dispatch`
              );
              const connectorContext = {
                eventBus,
                dataSources: { json: jsonData, sqlite: sqliteData },
                tools,
                sessionId: factsSessionId,
              };
              type QueryResult = {
                name: string;
                toolId?: string;
                result?: any;
                error?: string;
                snapshot?: Record<string, any>;
              };
              const results: QueryResult[] = [];
              // Execute each query sequentially so every await completes
              // before the slice body is returned — the client never sees
              // a partial view.
              for (const query of queries) {
                if (query.job) {
                  const jobParams: Record<string, any> = { ...query.job.staticParams };
                  for (const [param, factName] of Object.entries(query.job.resolvedInputMappings)) {
                    jobParams[param] = sessionFacts[factName] ?? '';
                  }
                  try {
                    const executor = connectorExecutor.createExecutor(query.job.toolId, jobParams, true);
                    const result = await executor(connectorContext, {});
                    results.push({ name: query.name, toolId: query.job.toolId, result });
                    prefetchedToolResults.push({ toolId: query.job.toolId, result });
                    logger.info(
                      { toolName: name, queryName: query.name, toolId: query.job.toolId },
                      `[SERVER] Pre-fetched query result for slice dispatch: ${query.name}`
                    );
                  } catch (qErr: any) {
                    results.push({ name: query.name, toolId: query.job.toolId, error: qErr.message });
                    logger.warn(
                      { toolName: name, queryName: query.name, toolId: query.job.toolId, error: qErr.message },
                      `[SERVER] Query '${query.name}' failed during slice dispatch — continuing`
                    );
                  }
                } else if (query.text && llmService) {
                  // Text-only query: ai.eval path — LLM interprets the
                  // instruction using the current session facts.
                  try {
                    const returnedFactName = query.factNames[0] ?? query.name;
                    const result = await llmService.evaluateInstruction(query.text, sessionFacts, returnedFactName);
                    results.push({ name: query.name, toolId: 'ai.eval', result });
                    logger.info(
                      { toolName: name, queryName: query.name, text: query.text.slice(0, 80), resultKeys: Object.keys(result) },
                      `[SERVER] Pre-fetched text instruction via LLM for slice dispatch: ${query.name}`
                    );
                  } catch (tErr: any) {
                    results.push({ name: query.name, toolId: 'ai.eval', error: tErr.message });
                    logger.warn(
                      { toolName: name, queryName: query.name, error: tErr.message },
                      `[SERVER] Text instruction '${query.name}' failed during slice dispatch — continuing`
                    );
                  }
                } else {
                  // Snapshot-only query: gather the declared facts from the
                  // current session. Null/undefined entries are preserved so
                  // the manager can see what is and isn't populated yet.
                  const snapshot: Record<string, any> = {};
                  for (const factName of query.factNames) {
                    snapshot[factName] = sessionFacts[factName] ?? null;
                  }
                  results.push({ name: query.name, snapshot });
                  logger.info(
                    { toolName: name, queryName: query.name, factKeys: query.factNames },
                    `[SERVER] Pre-fetched fact snapshot for slice dispatch: ${query.name}`
                  );
                }
              }
              if (results.length) {
                const lines: string[] = [
                  '## Pre-fetched Query Results',
                  '',
                  'The server has already resolved the queries declared for this slice. The results are shown below — **present relevant items to the user before asking for input.** Do not call these tools again.',
                  '',
                ];
                for (const r of results) {
                  const header = r.toolId ? `${r.name} (\`${r.toolId}\`)` : `${r.name} _(session fact snapshot)_`;
                  lines.push(`### ${header}`);
                  lines.push('');
                  if (r.error !== undefined) {
                    lines.push(`_Error:_ ${r.error}`);
                  } else {
                    lines.push('```json');
                    lines.push(JSON.stringify(r.result ?? r.snapshot ?? null, null, 2));
                    lines.push('```');
                  }
                  lines.push('');
                }
                queryResultsSection = lines.join('\n');
              }
            }
          }
        } catch (err: any) {
          logger.warn(
            { toolName: name, error: err.message },
            `[SERVER] Slice query prefetch failed — returning slice without results`
          );
        }

        // If we have pre-fetched query results, replace the "Pre-Interaction
        // Tool Calls" section in the slice body so the agent sees the data
        // at the right point in the flow instead of a competing "call tool X"
        // instruction. Match the section from its heading up to the next
        // same-level heading (## ...) or end of string.
        let finalBody = body;
        if (queryResultsSection) {
          const preInteractionPattern = /## 1\.\s*Pre-Interaction Tool Calls[\s\S]*?(?=\n## \d|$)/;
          if (preInteractionPattern.test(finalBody)) {
            finalBody = finalBody.replace(preInteractionPattern, queryResultsSection);
          } else {
            // No matching section — prepend so the agent sees results first.
            finalBody = queryResultsSection + '\n---\n\n' + finalBody;
          }
        }

        logger.info({ toolName: name, hasQueryResults: !!queryResultsSection, prefetchedTools: prefetchedToolResults.length }, `[SERVER] Returning skill/slice content as tool output: ${name}`);

        // Build content blocks: main slice body + extra blocks for each
        // prefetched connector result so the client can render them
        // (e.g. DocumentCards for file-list results).
        const contentBlocks: { type: string; text: string }[] = [
          {
            type: "text",
            text: `Skill/Slice: ${name}\nDescription: ${description}\n\n${finalBody}`
          },
        ];
        for (const ptr of prefetchedToolResults) {
          contentBlocks.push({
            type: "text",
            text: JSON.stringify({ _prefetchedTool: ptr.toolId, ...ptr.result }),
          });
        }

        return { content: contentBlocks };
      }

      logger.warn({ toolName: name }, `[SERVER] Tool not found: ${name}`);
      throw new Error(`Tool not found: ${name}`);
    } catch (error: any) {
      logger.error({ toolName: name, error: error.message, stack: error.stack }, `[SERVER] Error handling tool call '${name}': ${error.message}`);
      throw error;
    }
  });

  // server.setRequestHandler(ListPromptsRequestSchema, async () => {
  //   const skillsDir = path.join(projectRoot, 'skills');
  //   const filePaths = await listSkillPaths(skillsDir);
  //   const prompts = await Promise.all(filePaths.map(async (fp) => {
  //     const raw = await fsAsync.readFile(fp, 'utf-8');
  //     const { name, description } = parseSkillFrontmatter(raw);
  //     if (!name) return null;
  //     return { name, description };
  //   }));
  //   return { prompts: prompts.filter((p): p is NonNullable<typeof p> => p !== null) };
  // });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const skillsDir = path.join(projectRoot, 'skills');
    const fp = await resolveSkillPath(skillsDir, name);
    const raw = await fsAsync.readFile(fp, 'utf-8');
    const { description, body } = parseSkillFrontmatter(raw);
    return {
      description,
      messages: [{ role: 'user', content: { type: 'text', text: body } }]
    };
  });
}

function createMcpServer() {
  return new McpServer({
    name: "mmc-mcp-server",
    version: "1.0.0",
  }, {
    capabilities: {
      tools: {},
      prompts: {},
      logging: {}
    },
    instructions: `You are connected to the MMC MCP server.

IMPORTANT: At the start of every session, follow this sequence:
1. Call register-agent with your username to identify yourself and receive your assigned roles.
2. Call list-todos to check for any pending work items assigned to your roles.
3. If there are pending todos, call claim-todo to claim one and join its workflow session, then execute the corresponding skill.
4. If there are no pending todos, call get-next-event to begin polling for new workflow events.
After receiving any event (event is not null), invoke handle-latest-event with the event payload, then immediately re-call get-next-event.
If get-next-event returns { event: null }, re-call it immediately.
Do not wait for user input between get-next-event calls — continuous polling is required.`
  });
}

async function getSkillNames(skillsDir: string): Promise<string[]> {
  const skillFiles = await listSkillPaths(skillsDir);
  return (await Promise.all(skillFiles.map(async (fp) => {
    try {
      const raw = await fsAsync.readFile(fp, 'utf-8');
      return parseSkillFrontmatter(raw).name;
    } catch (e) {
      return null;
    }
  }))).filter((n): n is string => !!n);
}

async function getSkillNamesTyped(skillsDir: string, interfaceSliceNames: Set<string>): Promise<{ name: string; isInterface: boolean }[]> {
  const skillFiles = await listSkillPaths(skillsDir);
  return (await Promise.all(skillFiles.map(async (fp) => {
    try {
      const raw = await fsAsync.readFile(fp, 'utf-8');
      const { name } = parseSkillFrontmatter(raw);
      if (!name) return null;
      const dirName = path.basename(path.dirname(fp));
      const isInterface = interfaceSliceNames.has(dirName);
      return { name, isInterface };
    } catch (e) {
      return null;
    }
  }))).filter((n): n is { name: string; isInterface: boolean } => !!n);
}

async function main() {
  const appConfig = readAppConfig();
  await externalMcpManager.connectAll();

  // Resync skills from GitHub on startup
  try {
    const synced = await syncSkillsOnStartup(
      appConfig.skillsDir,
      externalMcpManager,
      appConfig.noSync,
      appConfig.forceSync
    );
    if (synced.length > 0) {
      // logger.info({ count: synced.length }, `[SERVER] Initial synchronization complete: ${synced.length} skill(s) synced.`);
    }
  } catch (err: any) {
    logger.error({ error: err.message }, `[SERVER] Error during initial skill synchronization: ${err.message}`);
  }

  const externalTools = await externalMcpManager.getExternalTools();
  Object.assign(tools, externalTools);

  // Load outcome model metadata once, used for both event subscriptions and tool filtering
  const skillsDir = path.join(projectRoot, 'skills');
  const interactionSliceTriggerEvents = await loadInteractionSliceTriggerEvents(skillsDir);
  const interfaceSliceNames = await loadInterfaceSliceNames(skillsDir);
  logger.info({ interactionSliceTriggerEvents, interfaceSliceNames: [...interfaceSliceNames] }, '[SERVER] Interaction slice trigger events loaded from models');

  // Event routing subscriber is registered after automatedSliceMap (below)
  // so it can detect terminal events with no downstream handler.
  const triggerEventSet = new Set(interactionSliceTriggerEvents);

  // Log all tools and skills as they will be given to an AI
  const typedSkills = await getSkillNamesTyped(skillsDir, interfaceSliceNames);
  const interfaceSkillNames = typedSkills.filter(s => s.isInterface).map(s => s.name);
  const automatedSkillNames = typedSkills.filter(s => !s.isInterface).map(s => s.name);

  const coreToolNames = [
    "get-github-methods",
    "log-event-to-bus",
    "events-dump",
    ...connectors.map(tool => tool.name),
  ];
  const clientToolNames = [...coreToolNames, ...interfaceSkillNames];

  const CYAN = '\x1b[36m';
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';

  const toolLines = [
    ...clientToolNames.map(n => `  ${CYAN}${n}${RESET}`),
    ...automatedSkillNames.map(n => `  ${DIM}[auto] ${n}${RESET}`),
  ].join('\n');

  logger.info(`[SERVER] Connected and synchronized. Tools (${clientToolNames.length} client, ${automatedSkillNames.length} automated):\n${toolLines}`);

  // Per-session transport pool: each MCP client gets its own server+transport pair.
  // This allows multiple concurrent browser tabs / clients and survives page refreshes.
  const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
  const httpSessions = new Map<string, { transport: StreamableHTTPTransport; server: McpServer; lastSeen: number }>();

  // Guards against tools/list reading partially-written skill files during a resync.
  let resyncing = false;

  function createHttpSession(): { transport: StreamableHTTPTransport; sessionId: string } {
    const sessionId = crypto.randomUUID();
    const server = createMcpServer();
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: true,
    });

    server.server.onerror = (error) => {
      logger.error({ error: error instanceof Error ? { message: error.message, stack: error.stack } : error, sessionId }, `[SERVER] HTTP server error: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
    };

    registerHandlers(server.server, interfaceSliceNames, () => resyncing);
    server.connect(transport);
    httpSessions.set(sessionId, { transport, server, lastSeen: Date.now() });
    logger.info({ sessionId, activeSessions: httpSessions.size }, '[SERVER] New HTTP session created');
    return { transport, sessionId };
  }

  // Evict stale sessions periodically
  setInterval(() => {
    const now = Date.now();
    for (const [sid, session] of httpSessions) {
      if (now - session.lastSeen > SESSION_TTL_MS) {
        session.transport.close();
        httpSessions.delete(sid);
        logger.info({ sessionId: sid, activeSessions: httpSessions.size }, '[SERVER] Evicted stale HTTP session');
      }
    }
  }, 5 * 60 * 1000); // every 5 minutes

  // Mutable ref — populated after workflowDefinitions loads (below serve()).
  let _workflowDefs: Map<string, any> | null = null;

  const app = new Hono();
  app.all("/mcp", async (c) => {
    // Route by mcp-session-id header; create new session for initialize requests
    const sessionId = c.req.header('mcp-session-id');

    if (sessionId && httpSessions.has(sessionId)) {
      const session = httpSessions.get(sessionId)!;
      session.lastSeen = Date.now();
      return session.transport.handleRequest(c);
    }

    // No valid session — check if this is an initialize request
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, 400);

    const messages = Array.isArray(body) ? body : [body];
    const isInit = messages.some((m: any) => m.method === 'initialize');

    if (!isInit) {
      // Non-init request without a valid session
      return c.json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
        id: messages[0]?.id ?? null,
      }, 400);
    }

    // Create a new session and handle the initialize request
    const { transport } = createHttpSession();
    return transport.handleRequest(c, body);
  });
  // GET /files/:referenceKey/:storedName — serve uploaded files
  app.get("/files/:referenceKey/:storedName", async (c) => {
    const { referenceKey, storedName } = c.req.param();
    const safeKey = referenceKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeName = path.basename(storedName);
    const filePath = path.resolve('data/files', safeKey, safeName);

    try {
      const stat = await fsAsync.stat(filePath);
      if (!stat.isFile()) return c.text('Not found', 404);

      // Read the sidecar metadata for MIME type
      let mimeType = 'application/octet-stream';
      try {
        const meta = JSON.parse(await fsAsync.readFile(`${filePath}.meta.json`, 'utf-8'));
        mimeType = meta.mimeType || mimeType;
      } catch { /* use default */ }

      const content = await fsAsync.readFile(filePath);
      return new Response(content, {
        headers: {
          'Content-Type': mimeType,
          'Content-Disposition': `inline; filename="${safeName}"`,
          'Content-Length': String(stat.size),
        },
      });
    } catch {
      return c.text('Not found', 404);
    }
  });

  // GET /roles — returns all unique roles and their associated usernames
  app.get("/roles", async (c) => {
    try {
      const allRoles = await jsonData.read('roles') as Array<{ username: string; roles: string[] }>;
      // Collect unique roles with associated usernames
      const roleMap = new Map<string, string[]>();
      for (const entry of allRoles) {
        for (const role of entry.roles) {
          if (!roleMap.has(role)) roleMap.set(role, []);
          roleMap.get(role)!.push(entry.username);
        }
      }
      const roles = [...roleMap.entries()].map(([role, usernames]) => ({ role, usernames }));
      return c.json({ roles });
    } catch {
      return c.json({ roles: [] });
    }
  });

  // GET /capabilities - return the names and parameters of capabilities
  app.get("/capabilities", async (c) => {
    const externalDefs = externalMcpManager.getExposedToolDefinitions().map(d => {
      const schema = d.inputSchema || {};
      const props = (schema.properties || {}) as Record<string, any>;
      const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
      const inputParams = Object.entries(props).map(([name, p]) => ({
        name,
        type: (p && typeof p === 'object' && typeof p.type === 'string') ? p.type : 'any',
        required: required.has(name),
        description: (p && typeof p === 'object' && typeof p.description === 'string') ? p.description : '',
      }));
      return {
        name: d.name,
        description: d.description ?? '',
        inputParams,
        outputParams: [],
      };
    });
    return c.json({ capabilities: [...connectors, ...externalDefs] });
  });

  // GET /workflows — returns entry-point interface slices that can start new workflows
  app.get("/workflows", async (c) => {
    if (!_workflowDefs) return c.json({ workflows: [] });
    const entryPoints: { workflow: string; sliceName: string; role: string; facts: string[] }[] = [];
    for (const [name, wf] of _workflowDefs) {
      for (const slice of wf.slices) {
        if (!slice.isInterface) continue;
        // Entry-point slices have no given events (nothing must happen before them)
        if (slice.givenEventGroups.length > 0) continue;
        // Read the skill .md to extract fact names from the frontmatter/content
        const mdPath = path.join(skillsDir, name, slice.name, `${slice.name}.md`);
        let facts: string[] = [];
        try {
          const content = await fsAsync.readFile(mdPath, 'utf-8');
          const factMatches = content.matchAll(/\|\s*`([^`]+)`\s*\|/g);
          facts = [...factMatches].map(m => m[1]);
        } catch { /* skill file not found */ }
        entryPoints.push({ workflow: name, sliceName: slice.name, role: slice.role, facts });
      }
    }
    return c.json({ workflows: entryPoints });
  });

  // GET /health — initialization and dependency checks
  app.get("/health", async (c) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    // SQLite event store reachable
    try {
      const seq = await eventStore.getMaxSequence();
      checks.eventStore = { ok: true, detail: `maxSeq: ${seq}` };
    } catch (e: any) {
      checks.eventStore = { ok: false, detail: e.message };
    }

    // External MCP servers connected
    const extStatus = externalMcpManager.getConnectionStatus();
    checks.externalMcp = {
      ok: extStatus.configured === 0 || extStatus.connected === extStatus.configured,
      detail: extStatus.configured === 0
        ? 'none configured'
        : `${extStatus.connected}/${extStatus.configured} connected: ${extStatus.servers.map(s => `${s.name}:${s.connected ? 'up' : 'down'}`).join(', ')}`,
    };

    // Required env vars
    const requiredEnv = ['OPENROUTER_API_KEY', 'GITHUB_PERSONAL_ACCESS_TOKEN'];
    const missingEnv = requiredEnv.filter(k => !process.env[k]);
    checks.env = {
      ok: missingEnv.length === 0,
      detail: missingEnv.length > 0 ? `missing: ${missingEnv.join(', ')}` : 'all set',
    };

    // Skills loaded from disk
    try {
      const skillFiles = await listSkillPaths(skillsDir);
      checks.skills = { ok: skillFiles.length > 0, detail: `${skillFiles.length} skill files` };
    } catch (e: any) {
      checks.skills = { ok: false, detail: e.message };
    }

    // Interface slices resolved from outcome models
    checks.interfaceSlices = {
      ok: interfaceSliceNames.size > 0,
      detail: `${interfaceSliceNames.size} slice(s): ${[...interfaceSliceNames].join(', ')}`,
    };

    // Workflow definitions loaded
    checks.workflows = {
      ok: _workflowDefs !== null && _workflowDefs.size > 0,
      detail: _workflowDefs
        ? `${_workflowDefs.size} workflow(s): ${[..._workflowDefs.keys()].join(', ')}`
        : 'not yet loaded',
    };

    const allOk = Object.values(checks).every(ch => ch.ok);
    return c.json({
      status: allOk ? 'ok' : 'degraded',
      uptime: Math.floor(process.uptime()),
      checks,
    }, allOk ? 200 : 503);
  });

  // POST /resync - force a resync with GitHub and reload skill-engine
  app.post("/resync", async (c) => {
    if (resyncing) {
      logger.info('[SERVER] Resync requested but already in progress — request rejected');
      return c.json({ status: "error", message: "Resync already in progress" }, 409);
    }
    resyncing = true;
    try {
      logger.info(`[SERVER] Manual resync requested via API, syncing from GitHub...`);

      // Invalidate cached outcome models so fresh files are read after sync.
      invalidateOutcomeModelCache();
      cachedToolDefs = null;

      const syncedFromGithub = await syncSkillsOnStartup(
        appConfig.skillsDir,
        externalMcpManager,
        appConfig.noSync
      );

      // Reload outcome-model derived state and mutate the live objects in-place
      // so all existing handler closures see the updated values immediately.
      // interfaceSliceNames must be resolved first — loadAutomatedSliceMap depends on it.
      const [newInterfaceSliceNames, newTriggerEvents] = await Promise.all([
        loadInterfaceSliceNames(skillsDir),
        loadInteractionSliceTriggerEvents(skillsDir),
      ]);

      interfaceSliceNames.clear();
      for (const n of newInterfaceSliceNames) interfaceSliceNames.add(n);

      const newAutomatedSliceMap = await loadAutomatedSliceMap(skillsDir, interfaceSliceNames);

      triggerEventSet.clear();
      for (const e of newTriggerEvents) triggerEventSet.add(e);

      automatedSliceMap.clear();
      for (const [k, v] of newAutomatedSliceMap) automatedSliceMap.set(k, v);

      const newWorkflows = await loadWorkflowDefinitions(skillsDir);
      workflowDefinitions.clear();
      for (const [k, v] of newWorkflows) workflowDefinitions.set(k, v);
      todoProcessor.invalidateCache();

      const newSliceWorkflowMap = await loadSliceWorkflowMap(skillsDir);
      sliceWorkflowMap.clear();
      for (const [k, v] of newSliceWorkflowMap) sliceWorkflowMap.set(k, v);

      logger.info(
        { interfaceSlices: [...interfaceSliceNames], triggerEvents: [...triggerEventSet], automatedSlices: [...automatedSliceMap.keys()], workflows: [...workflowDefinitions.keys()] },
        '[SERVER] Manual resync complete — outcome model metadata reloaded'
      );

      return c.json({
        status: "success",
        message: "Skills resynced successfully",
        syncedFiles: syncedFromGithub,
        count: syncedFromGithub.length
      });
    } catch (error: any) {
      logger.error({ error: error.message }, `[SERVER] Error during manual resync: ${error.message}`);
      return c.json({
        status: "error",
        message: error.message
      }, 500);
    } finally {
      resyncing = false;
    }
  });

  let port = process.env.PORT ? parseInt(process.env.PORT) : 3001;

  logger.info({ port }, `MMC MCP Server HTTP (Streamable) running on http://localhost:${port}/mcp`);

  // Stdio transport
  const stdioMcpServer = createMcpServer();
  const stdioTransport = new StdioServerTransport();

  stdioMcpServer.server.onerror = (error) => {
    logger.error({ error }, `[SERVER] Stdio server error: ${JSON.stringify(error)}`);
  };

  registerHandlers(stdioMcpServer.server, interfaceSliceNames, () => resyncing);

  // Subscribe a single wildcard dispatcher for automated slices.
  // It consults the mutable automatedSliceMap at call time so resync only needs
  // to clear+repopulate the map — no unsubscription required.
  const automatedSliceMap = await loadAutomatedSliceMap(skillsDir, interfaceSliceNames);
  const sliceWorkflowMap = await loadSliceWorkflowMap(skillsDir);
  logger.info({ automatedSliceEvents: [...automatedSliceMap.keys()] }, '[SERVER] Automated slice event subscriptions registered');

  const runnerDeps = {
    eventBus,
    eventStore: testAwareEventStore,
    skillsDir,
    llmService,
    executeConnector: (toolId: string, params: Record<string, any>, sessionId?: string) => {
      const ctx = { eventBus, dataSources: { json: jsonData, sqlite: sqliteData }, tools, sessionId };
      return connectorExecutor.createExecutor(toolId, params, true)(ctx, {});
    },
  };
  // ───────────────────────────────────────────────────────────────────────
  // AUTOMATED-SLICE DISPATCH (production AND workbench test sessions)
  //
  // Both paths run the SAME `createAutomatedSliceHandler` from
  // src/services/automatedSliceRunner.ts. The only difference is HOW the
  // slice JSON is resolved before being handed to the handler:
  //   • disk path  → `resolveDiskSliceData(skillMdPath)`   reads outcome
  //                                                        model JSON from
  //                                                        skills/
  //   • test path  → `resolveInlineSliceData(skill.sliceData, skill.name)`
  //                                                        uses sliceData
  //                                                        pushed via the
  //                                                        `register-skills`
  //                                                        MCP tool
  //
  // Once `SliceData` is resolved, the handler is path-agnostic. Everything
  // inside it is shared:
  //   - scenario eligibility (given[] gating)
  //   - query/command job execution + LLM instruction evaluation
  //   - business rule evaluation (deterministic + LLM-mode)
  //   - silent-stall + empty-then + conflict diagnostics
  //   - outcome event publishing
  //
  // What is DIFFERENT and must remain so:
  //   - Routing policy (this dispatcher): test sessions consult
  //     `sessionSkills` first and never fall through to disk; production
  //     uses `automatedSliceMap`. Disk automation would run with the wrong
  //     model's connectors and silently corrupt a test session.
  //   - Event persistence: handled in `testAwareEventStore` based on
  //     `testSessions` membership. Out of scope for this dispatcher.
  //   - Todo creation: `TodoProcessor` skips test sessions explicitly.
  //
  // If you need path-specific behaviour, do it HERE in the dispatcher —
  // never branch on source type inside the handler.
  //
  // Fire-and-forget: automated slice processing runs outside the EventBus
  // publish chain so it cannot block persistence or routing of subsequent
  // events.
  // ───────────────────────────────────────────────────────────────────────
  eventBus.subscribe('*', (event) => {
    // TEST SESSION PATH — session-registered skills take precedence over
    // any matching disk slice. Disk slices may be stale snapshots of a
    // different model whose command jobs reference connectors not present
    // in this session — running them silently corrupts the test.
    if (event.sessionId && testSessions.has(event.sessionId)) {
      const sessionMap = sessionSkills.get(event.sessionId);
      if (sessionMap) {
        let handled = false;
        const eventSchemaIndex = sessionEventSchemaIndex.get(event.sessionId);
        for (const skill of sessionMap.values()) {
          if (!skill.triggersOnSet.has(event.type) || !skill.sliceData) continue;
          // No cross-workflow check here: all session-registered skills
          // belong to the single workflow the test panel pushed; consulting
          // the disk `sliceWorkflowMap` by slice-name causes false negatives
          // when the same slice name exists under a different workflow on
          // disk (common with the AI story builder's generic slice names).
          const sliceDataResolved = resolveInlineSliceData(skill.sliceData, skill.name, eventSchemaIndex);
          createAutomatedSliceHandler(sliceDataResolved, runnerDeps)(event).catch((err) => {
            logger.error({ error: err.message, eventType: event.type, skill: skill.name }, '[SERVER] Session automated slice handler failed');
          });
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
          });
      }
    }
  });

  // TodoProcessor: event-sourced state machine that creates persistent work items
  // for interface slices when their preconditions are met.
  const workflowDefinitions = await loadWorkflowDefinitions(skillsDir);
  _workflowDefs = workflowDefinitions;
  const todoProcessor = new TodoProcessor({ eventBus, eventStore: testAwareEventStore, todoStore, workflows: workflowDefinitions, testSessions });
  todoProcessor.register();
  logger.info({ workflowCount: workflowDefinitions.size, workflows: [...workflowDefinitions.keys()] }, '[SERVER] TodoProcessor registered');

  // Route qualifying events to the connection that owns the matching workflow session.
  // Registered after the automated slice subscriber so automatedSliceMap is available.
  eventBus.subscribe('*', async (event) => {
    if (!event.sessionId) return;
    // Internal diagnostic events (e.g. connector TOOL_CALLED) are not part of
    // the workflow and must never be wrapped as unexpected_last_event or
    // delivered to clients — they would prematurely terminate the test view.
    if (event.type === 'TOOL_CALLED') return;

    let isRouted = triggerEventSet.has(event.type);
    let isAutomated = automatedSliceMap.has(event.type);

    // For test sessions, also check session-scoped skills for routing/automation matches
    if (!isRouted && !isAutomated && testSessions.has(event.sessionId)) {
      const sessionMap = sessionSkills.get(event.sessionId);
      if (sessionMap) {
        for (const skill of sessionMap.values()) {
          if (skill.triggersOnSet.has(event.type)) {
            // Session skill triggers on this event — check if it's an interface or automation
            if (skill.sliceData?.automation) {
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
    // wrap it as unexpected_last_event so the client agent gets an immediate
    // response instead of a 60s long-poll timeout.
    if (!isRouted && !isAutomated) {
      const fallback = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: 'unexpected_last_event',
        source: 'event-router',
        sessionId: event.sessionId,
        payload: { originalEvent: event },
        timestamp: new Date(),
      };
      for (const [cid, conn] of connectionPool) {
        if (conn.activeWorkflowSessionId !== event.sessionId) continue;
        if (conn.waitingResolver) {
          const resolve = conn.waitingResolver;
          conn.waitingResolver = null;
          logger.info({ cid, originalEventType: event.type, workflowSessionId: event.sessionId }, '[EVENT_ROUTER] No downstream handler — delivering unexpected_last_event');
          resolve(fallback);
        } else {
          conn.queue.push(fallback);
          logger.info({ cid, originalEventType: event.type, queueLength: conn.queue.length, workflowSessionId: event.sessionId }, '[EVENT_ROUTER] No downstream handler — queued unexpected_last_event');
        }
      }
      return;
    }

    // In test sessions, also deliver automation-trigger events as progress notifications
    // so the client can display each step rather than only receiving unexpected_last_event.
    if (!isRouted && !testSessions.has(event.sessionId)) return;
    for (const [cid, conn] of connectionPool) {
      if (conn.activeWorkflowSessionId !== event.sessionId) continue;
      if (conn.waitingResolver) {
        const resolve = conn.waitingResolver;
        conn.waitingResolver = null;
        logger.info({ cid, eventType: event.type, workflowSessionId: event.sessionId }, '[EVENT_ROUTER] Delivering event to waiting connection');
        resolve(event);
      } else {
        conn.queue.push(event);
        logger.info({ cid, eventType: event.type, queueLength: conn.queue.length, workflowSessionId: event.sessionId }, '[EVENT_ROUTER] Queued event for connection');
      }
    }
  });

  if (!process.env.VITE) {
    stdioMcpServer.connect(stdioTransport).then(() => {
      logger.info("MMC MCP Server running on stdio");
    }).catch(err => {
      logger.error({ error: err.message }, `[SERVER] Stdio connection error: ${err.message}`);
    });
  }

  return app;
}

const app = await main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

export default {
  fetch: app!.fetch.bind(app),
  port: parseInt(process.env.PORT ?? '3001'),
};
