// STDOUT GUARD — must be the very first import so the console writers are
// aliased to stderr before any other module's top-level code runs. See
// ./stdoutGuard.ts.
import './stdoutGuard.js';

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import fs from 'fs';
import fsAsync from 'fs/promises';
import path from 'path';
import { Hono, type Context as HonoContext } from "hono";
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { logger, withTraceId } from '@src/utils/logger.js';
import { formatEventLog } from '@src/utils/eventFormatter.js';
import { eventForDisplay } from './displayNames.js';
import { readAppConfig, syncSkillsOnStartup } from '@src/skill-engine/skillSyncStartup.js';
import { connectors } from '@connectors/index.js';
import { loadInteractionSliceTriggerEvents, loadInterfaceSliceNames, loadViewSliceNames, loadAutomatedSliceMap, loadSliceWorkflowMap, loadWorkflowDefinitions, invalidateOutcomeModelCache, type WorkflowDefinition } from '@src/skill-engine/interaction-slice-trigger-events.js';
import { TodoProcessor } from '@src/services/todoProcessor.js';
import { parseSkillFrontmatter, listSkillPaths, resolveSkillPath } from '@src/utils/skillUtils.js';
import { type HandleLatestEventDeps } from './handleLatestEvent.js';
import { apiKeyMiddleware } from '../admin/apiKeyMiddleware.js';
import { mcpAuthMiddleware } from '../admin/mcpAuthMiddleware.js';
import { writeEnvVar } from '../admin/envManager.js';
import { readConfig, writeConfig } from '../admin/configStore.js';
import { randomBytes, createHash } from 'node:crypto';

// Runtime singletons + resolved paths are constructed in ./composition.ts.
import {
  projectRoot,
  skillsDir,
  eventBus,
  eventStore,
  testAwareEventStore,
  testAwareTodoStore,
  jsonData,
  sqliteData,
  llmService,
  externalMcpManager,
  toolOutputSchemaCache,
  connectorExecutor,
} from './composition.js';

// Runtime env overrides — written by /admin/rotate-key and persisted under
// data/ (volume-backed on Fly, where the container FS holding .env is
// ephemeral). Loaded with override so a hash rotated on a previous boot wins
// over the baked-in .env / image env.
dotenvConfig({ path: path.join(projectRoot, 'data', 'runtime.env'), override: true, quiet: true });

import { mountHttpRoutes } from './httpRoutes.js';
import { mountChatProxyRoute } from './chatProxy.js';
import { mountStaticUiRoutes } from './staticUi.js';
import { resolveAuthProvider } from '@src/admin/authProvider.js';
// Event-bus routers (the three wildcard dispatchers). See ./routers.ts.
import {
  registerEventStoreRouter,
  registerAutomatedSliceRouter,
  registerEventDeliveryRouter,
} from './routers.js';
// MCP request handlers (ListTools / CallTool / GetPrompt). See ./mcpHandlers.ts.
import { registerHandlers, invalidateToolDefsCache } from './mcpHandlers.js';

// Per-connection + per-session runtime state lives in ./sessionState.ts.
import {
  CONNECTION_EVICTION_INTERVAL_MS,
  evictStaleConnections,
} from './sessionState.js';
import { registerRunGcHook, getRun, isSessionScoped } from './workflowRun.js';
import { setQuiescenceWorkflowDefs, deliverToCorrelation, makeRouterEvent } from './quiescence.js';

// Cleanup hooks registered during module initialization. Drained in reverse
// order on shutdown (SIGTERM/SIGINT — see the handler at the bottom of this
// file). Under `tsx watch` (dev) a file change restarts the whole process —
// tsx terminates the previous run and its children — so there is no in-process
// HMR to coordinate, and graceful shutdown alone is enough to release connector
// child processes, setInterval timers, and SQLite handles. This replaces the
// previous `bun --hot` globalThis-sentinel dispose dance, which leaked
// grandchild processes on Windows.
const cleanupHooks: Array<() => void | Promise<void>> = [];

// Run eviction every 30 minutes.
const connectionEvictionInterval = setInterval(evictStaleConnections, CONNECTION_EVICTION_INTERVAL_MS);
connectionEvictionInterval.unref();
cleanupHooks.push(() => clearInterval(connectionEvictionInterval));

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

// Persist every event to the correct store (test → in-memory, prod → SQLite).
// See ./routers.ts.
registerEventStoreRouter();

// jsonData, sqliteData, llmService, externalMcpManager, toolOutputSchemaCache
// and connectorExecutor are constructed in ./composition.ts (imported above).
// Admin routes below read the effective config and write the volume-backed
// runtime copy via src/admin/configStore.ts.

// Workflow definitions are loaded inside main() but a few tool handlers
// (declared at module scope so the `tools` registry can be built before
// main runs) need to read them at call-time. Hoisting the binding here
// gives both the tool handlers and main() the same shared reference.
let _workflowDefs: Map<string, WorkflowDefinition> | null = null;

const tools: Record<string, (params: any, input: any) => Promise<any>> = {
  'events-dump': async (params, input) => {
    let limit = parseInt(params.limit && !params.limit.includes('{{') ? params.limit : '20');
    let skip = parseInt(params.skip && !params.skip.includes('{{') ? params.skip : '0');
    // Scope by workflow-instance id; legacy callers may still pass `sessionId`.
    const correlationId = params.correlationId ?? params.sessionId;

    if (isNaN(limit)) limit = 20;
    if (isNaN(skip)) skip = 0;

    try {
      const { events, total } = await testAwareEventStore.getPaged(limit, skip, correlationId);
      // #77 Increment B: translate factId payload keys → names for the dump UI.
      const displayEvents = events.map(e => eventForDisplay(e, _workflowDefs));
      const formattedEvents = formatEventLog(displayEvents);

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

function createMcpServer() {
  return new McpServer({
    name: "mmc-mcp-server",
    version: "1.0.0",
  }, {
    capabilities: {
      // listChanged: true is load-bearing. Without it, the SDK refuses to
      // emit notifications/tools/list_changed even when sendToolListChanged()
      // is called — and connected clients silently keep their stale tool
      // snapshot from session start until they re-initialise. The /resync
      // handler depends on this notification reaching clients to make a live
      // skill update visible without a reconnect.
      tools: { listChanged: true },
      prompts: {},
      logging: {},
      // MCP Apps UI resources (ui://mmc/interface-form). See mcpHandlers'
      // ListResources/ReadResource handlers.
      resources: {}
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

  // Auto-generate admin API key on first boot if none exists.
  // Raw key is logged later, near the stdio ready message.
  let generatedAdminKey: string | null = null;
  if (!process.env.ADMIN_API_KEY_HASH) {
    const rawKey = 'mmc_sk_' + randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(rawKey).digest('hex');
    writeEnvVar(path.join(projectRoot, '.env'), 'ADMIN_API_KEY_HASH', hash);
    process.env.ADMIN_API_KEY_HASH = hash;
    generatedAdminKey = rawKey;
  }

  await toolOutputSchemaCache.load();
  await externalMcpManager.connectAll();

  // Resync skills from GitHub on startup
  try {
    const synced = await syncSkillsOnStartup(
      appConfig.skillsDir,
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
  const viewSliceNames = await loadViewSliceNames(skillsDir);
  logger.info(
    { interactionSliceTriggerEvents, interfaceSliceNames: [...interfaceSliceNames], viewSliceNames: [...viewSliceNames] },
    '[SERVER] Interaction slice trigger events loaded from models',
  );

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
  ];
  const clientToolNames = [...coreToolNames, ...interfaceSkillNames];
  const internalConnectorNames = connectors.map(tool => tool.name);

  const CYAN = '\x1b[36m';
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';

  const toolLines = [
    ...clientToolNames.map(n => `  ${CYAN}${n}${RESET}`),
    ...automatedSkillNames.map(n => `  ${DIM}[auto] ${n}${RESET}`),
    ...internalConnectorNames.map(n => `  ${DIM}[internal] ${n}${RESET}`),
  ].join('\n');

  logger.info(`[SERVER] Connected and synchronized. Tools (${clientToolNames.length} client, ${automatedSkillNames.length} automated, ${internalConnectorNames.length} internal connectors):\n${toolLines}`);

  // Per-session transport pool: each MCP client gets its own server+transport pair.
  // This allows multiple concurrent browser tabs / clients and survives page refreshes.
  const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
  const httpSessions = new Map<string, { transport: StreamableHTTPTransport; server: McpServer; lastSeen: number }>();

  // Guards against tools/list reading partially-written skill files during a resync.
  let resyncing = false;

  // _workflowDefs is hoisted to module scope (see top of file) so disk-path
  // tool handlers like `log-event-to-bus` can read the live workflow
  // definitions at call-time. The assignment below populates the same shared
  // binding; resync mutates the Map in place.

  // Live accessors for the `handle-latest-event` dispatcher. Each call must
  // observe the CURRENT state of the routing structures — both because resync
  // clears+repopulates them, and because the stdio `registerHandlers` call
  // below fires BEFORE `automatedSliceMap` is initialised. Reading via getters
  // defers the lookup to handler invocation time, after main() finishes setup.
  const routingDeps: HandleLatestEventDeps = {
    getTriggerEventSet: () => triggerEventSet,
    getWorkflowDefs: () => _workflowDefs,
    getAutomatedSliceMap: () => automatedSliceMap,
  };

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

    registerHandlers(server.server, interfaceSliceNames, viewSliceNames, () => resyncing, routingDeps, tools);
    server.connect(transport);
    httpSessions.set(sessionId, { transport, server, lastSeen: Date.now() });
    logger.info({ sessionId, activeSessions: httpSessions.size }, '[SERVER] New HTTP session created');
    return { transport, sessionId };
  }

  // Evict stale sessions periodically
  const httpSessionEvictionInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, session] of httpSessions) {
      if (now - session.lastSeen > SESSION_TTL_MS) {
        session.transport.close();
        httpSessions.delete(sid);
        logger.info({ sessionId: sid, activeSessions: httpSessions.size }, '[SERVER] Evicted stale HTTP session');
      }
    }
  }, 5 * 60 * 1000); // every 5 minutes
  cleanupHooks.push(() => clearInterval(httpSessionEvictionInterval));
  cleanupHooks.push(() => {
    for (const session of httpSessions.values()) {
      try { session.transport.close(); } catch { /* ignore */ }
    }
    httpSessions.clear();
  });

  const app = new Hono();

  // Request-scoped trace ID: honour an incoming `x-request-id` if the caller
  // sent one (lets a workbench or test client thread its own ID through),
  // otherwise mint a UUID. Set as a response header and propagated via
  // AsyncLocalStorage so every logger.* call inside the request chain picks
  // it up automatically (see src/utils/logger.ts mixin).
  app.use(async (c, next) => {
    const traceId = c.req.header('x-request-id') ?? crypto.randomUUID();
    c.header('x-request-id', traceId);
    const start = performance.now();
    await withTraceId(traceId, async () => {
      try {
        await next();
      } finally {
        const durationMs = Math.round(performance.now() - start);
        logger.info(
          { event: 'http.request', method: c.req.method, path: c.req.path, status: c.res.status, durationMs },
          `${c.req.method} ${c.req.path} ${c.res.status} ${durationMs}ms`,
        );
      }
    });
  });

  const authMode = resolveAuthProvider().mode;
  if (authMode === 'none' || (authMode === 'static-token' && !process.env.MCP_ACCESS_TOKEN_HASH)) {
    logger.warn({ authMode }, '[AUTH] HTTP surface is unauthenticated — no credential configured. Acceptable for loopback dev only; managed deployments must set MMC_AUTH_MODE + a credential.');
  } else {
    logger.info({ authMode }, '[AUTH] HTTP surface authentication active');
  }
  app.use('/mcp', mcpAuthMiddleware);
  // The same token guards the auxiliary REST surface: these routes expose
  // model/event data or execute real side effects (/connectors/:name/run).
  // /livez and /health stay open — Fly health checks and the workbench
  // deploy-status probe need them, and they leak nothing sensitive.
  for (const guarded of ['/files/*', '/roles', '/connectors', '/connectors/*', '/workflows', '/external-events/*', '/resync', '/api/*']) {
    app.use(guarded, mcpAuthMiddleware);
  }
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
  // Auxiliary REST endpoints (/files, /roles, /connectors[/run],
  // /workflows, /livez, /health, /external-events) — see ./httpRoutes.ts.
  // The /mcp transport (above), request-logging middleware, and /resync
  // (below) stay here — tied to the transport / runtime-map lifecycle.
  mountHttpRoutes(app, {
    tools,
    interfaceSliceNames,
    getWorkflowDefs: () => _workflowDefs,
  });
  // POST /api/chat — streaming LLM proxy for the co-hosted dashboard UI
  // (ported from mmc-workflow; see ./chatProxy.ts).
  mountChatProxyRoute(app);

  // POST /resync — force a resync with GitHub and reload skill-engine.
  // Mounted twice: on /resync (guarded by mcpAuthMiddleware above — open in
  // tokenless dev) and on /admin/resync (admin-key auth) for the workbench
  // dashboard's "Resync now".
  const resyncHandler = async (c: HonoContext) => {
    if (resyncing) {
      logger.info('[SERVER] Resync requested but already in progress — request rejected');
      return c.json({ status: "error", message: "Resync already in progress" }, 409);
    }
    resyncing = true;
    try {
      logger.info(`[SERVER] Manual resync requested via API, syncing from GitHub...`);

      // Invalidate cached outcome models so fresh files are read after sync.
      invalidateOutcomeModelCache();
      invalidateToolDefsCache();

      const syncedFromGithub = await syncSkillsOnStartup(
        appConfig.skillsDir,
        appConfig.noSync
      );

      // Reload outcome-model derived state and mutate the live objects in-place
      // so all existing handler closures see the updated values immediately.
      const [newInterfaceSliceNames, newViewSliceNames, newTriggerEvents] = await Promise.all([
        loadInterfaceSliceNames(skillsDir),
        loadViewSliceNames(skillsDir),
        loadInteractionSliceTriggerEvents(skillsDir),
      ]);

      interfaceSliceNames.clear();
      for (const n of newInterfaceSliceNames) interfaceSliceNames.add(n);
      viewSliceNames.clear();
      for (const n of newViewSliceNames) viewSliceNames.add(n);

      const newAutomatedSliceMap = await loadAutomatedSliceMap(skillsDir);

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
        { interfaceSlices: [...interfaceSliceNames], viewSlices: [...viewSliceNames], triggerEvents: [...triggerEventSet], automatedSlices: [...automatedSliceMap.keys()], workflows: [...workflowDefinitions.keys()] },
        '[SERVER] Manual resync complete — outcome model metadata reloaded'
      );

      // Tell every connected MCP client that the tool list has changed so
      // they re-run tools/list and see the freshly registered (or removed)
      // skill tools. Without this broadcast, clients keep using the snapshot
      // they took at session-init time — the whole point of /resync as a
      // live update is defeated, and users have to reconnect each client to
      // see the new skills. Wrapped per-session because a single broken
      // transport must not block the rest of the fan-out.
      let notified = 0;
      for (const [sid, session] of httpSessions) {
        try {
          session.server.sendToolListChanged();
          notified++;
        } catch (err: any) {
          logger.warn({ sessionId: sid, err: err?.message ?? String(err) }, '[SERVER] Failed to notify HTTP session of tools/list_changed');
        }
      }
      if (stdioMcpServer) {
        try {
          stdioMcpServer.sendToolListChanged();
          notified++;
        } catch (err: any) {
          logger.warn({ err: err?.message ?? String(err) }, '[SERVER] Failed to notify stdio session of tools/list_changed');
        }
      }
      logger.info({ notified, httpSessions: httpSessions.size, stdio: !!stdioMcpServer }, '[SERVER] Broadcast tools/list_changed to connected MCP clients');

      return c.json({
        status: "success",
        message: "Skills resynced successfully",
        syncedFiles: syncedFromGithub,
        count: syncedFromGithub.length,
        notifiedClients: notified,
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
  };
  app.post("/resync", resyncHandler);

  // ── Admin routes (/admin/*) — protected by API key auth ──────────────────
  let adminUpdating = false;
  // Rotated key hashes go to data/runtime.env (volume-backed on Fly), not
  // .env on the ephemeral container FS — loaded with override at boot below.
  const runtimeEnvPath = path.join(projectRoot, 'data', 'runtime.env');

  const adminApp = new Hono();
  adminApp.use('/*', apiKeyMiddleware);

  adminApp.get('/config', async (c) => {
    try {
      const raw = readConfig(projectRoot) ?? {};
      // Partially mask externalServers env values:
      // - {{VAR}} references and empty strings are shown as-is
      // - length > 6: first 2 chars + •••••• + last 3 chars
      // - length <= 6: ••• + last 3 chars
      const maskEnvValue = (v: unknown): unknown => {
        if (typeof v !== 'string' || !v) return v;
        const isTemplate = v.startsWith('{{') && v.endsWith('}}');
        const inner = isTemplate ? v.slice(2, -2) : v;
        const masked = inner.length <= 6
          ? '•••' + inner.slice(-3)
          : inner.slice(0, 2) + '••••••' + inner.slice(-3);
        return isTemplate ? `{{${masked}}}` : masked;
      };
      if (Array.isArray(raw.externalServers)) {
        raw.externalServers = raw.externalServers.map((srv: any) => ({
          ...srv,
          env: srv.env
            ? Object.fromEntries(Object.entries(srv.env).map(([k, v]) => [k, maskEnvValue(v)]))
            : undefined,
        }));
      }
      return c.json(raw);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  adminApp.put('/config', async (c) => {
    if (adminUpdating) return c.json({ error: 'Update already in progress' }, 409);
    adminUpdating = true;
    try {
      const body = await c.req.json().catch(() => null);
      if (!body || !Array.isArray(body.externalServers)) {
        return c.json({ error: 'Invalid config: externalServers array required' }, 400);
      }

      // Read existing config — payload only contains dirty fields, so we merge
      // partial updates over the stored values rather than overwriting entirely.
      const existing = readConfig(projectRoot) ?? {};
      const oldServers: any[] = existing.externalServers ?? [];

      // Merge mmcGithubServer — payload contains only dirty keys
      const mergedGithubServer = { ...(existing.mmcGithubServer ?? {}), ...(body.mmcGithubServer ?? {}) };

      // Merge each external server's env — payload env contains only dirty keys;
      // non-env fields (name, command, args, exposeToClient) are always sent as-is
      const mergedServers: any[] = body.externalServers.map((payloadSrv: any) => {
        const existingSrv = oldServers.find((s: any) => s.name === payloadSrv.name) ?? {};
        return {
          ...existingSrv,
          ...payloadSrv,
          env: { ...(existingSrv.env ?? {}), ...(payloadSrv.env ?? {}) },
        };
      });

      const merged = {
        ...existing,
        ...(body.skillsDir !== undefined ? { skillsDir: body.skillsDir } : {}),
        mmcGithubServer: mergedGithubServer,
        externalServers: mergedServers,
      };

      writeConfig(projectRoot, merged);
      externalMcpManager.updateConfigs(mergedServers);
      const newServers = mergedServers;

      // Identify changed/added/removed servers
      const oldMap = new Map(oldServers.map((s: any) => [s.name, s]));
      const newMap = new Map(newServers.map((s: any) => [s.name, s]));
      const toReinit = new Set<string>();
      for (const [name, newCfg] of newMap) {
        const oldCfg = oldMap.get(name);
        if (!oldCfg || JSON.stringify(oldCfg) !== JSON.stringify(newCfg)) toReinit.add(name);
      }
      for (const name of oldMap.keys()) {
        if (!newMap.has(name)) {
          await externalMcpManager.disconnectOne(name);
          for (const key of Object.keys(tools)) {
            if (key.startsWith(`${name}_`)) delete tools[key];
          }
        }
      }

      for (const name of toReinit) {
        for (const key of Object.keys(tools)) {
          if (key.startsWith(`${name}_`)) delete tools[key];
        }
        await externalMcpManager.reinitialize(name);
      }

      const freshTools = await externalMcpManager.getExternalTools();
      Object.assign(tools, freshTools);
      invalidateToolDefsCache();

      let notified = 0;
      for (const [sid, session] of httpSessions) {
        try { session.server.sendToolListChanged(); notified++; } catch (err: any) {
          logger.warn({ sessionId: sid, err: err?.message }, '[ADMIN] Failed to notify session of tools/list_changed');
        }
      }
      if (stdioMcpServer) {
        try { stdioMcpServer.sendToolListChanged(); notified++; } catch { /* ignore */ }
      }

      logger.info({ reinitialized: [...toReinit], notified }, '[ADMIN] Config updated and affected servers reinitialized');
      return c.json({ status: 'success', reinitialized: [...toReinit], notifiedClients: notified });
    } catch (err: any) {
      logger.error({ error: err.message }, '[ADMIN] Config update failed');
      return c.json({ error: err.message }, 500);
    } finally {
      adminUpdating = false;
    }
  });

  adminApp.post('/rotate-key', async (c) => {
    try {
      const rawKey = 'mmc_sk_' + randomBytes(32).toString('hex');
      const hash = createHash('sha256').update(rawKey).digest('hex');
      writeEnvVar(runtimeEnvPath, 'ADMIN_API_KEY_HASH', hash);
      process.env.ADMIN_API_KEY_HASH = hash;
      logger.info('[ADMIN] API key rotated');
      return c.json({ status: 'success', key: rawKey });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  adminApp.post('/resync', resyncHandler);

  adminApp.post('/restart', async (c) => {
    logger.info('[ADMIN] Restart requested — disconnecting external servers and exiting');
    c.json({ status: 'restarting' });
    await externalMcpManager.disconnectAll();
    process.exit(0);
  });

  app.route('/admin', adminApp);
  // ─────────────────────────────────────────────────────────────────────────

  // Co-hosted dashboard SPA (catch-all) — registered LAST so every runtime/API
  // route above wins first. No-op unless MMC_UI_DIST is set (see ./staticUi.ts).
  mountStaticUiRoutes(app);

  let port = process.env.PORT ? parseInt(process.env.PORT) : 3001;

  logger.info({ port }, `MMC MCP Server HTTP (Streamable) running on http://localhost:${port}/mcp`);

  // Stdio transport — opt-out via MCP_STDIO=false. The transport reads
  // JSON-RPC from process.stdin and is unauthenticated by design: anyone
  // who can write to the process's stdin can invoke tools, bypassing the
  // HTTP layer's session check, the trace-id middleware, and any future
  // auth. On Fly (or any networked deployment) no legitimate client
  // reaches us this way — they all come over HTTP — so we shut it off
  // to remove an unaudited entry point and to free process.stdout for
  // ordinary logging if anyone wants to switch the logger transport later.
  const STDIO_ENABLED = process.env.MCP_STDIO !== 'false';
  let stdioMcpServer: ReturnType<typeof createMcpServer> | undefined;
  let stdioTransport: StdioServerTransport | undefined;
  if (STDIO_ENABLED) {
    stdioMcpServer = createMcpServer();
    stdioTransport = new StdioServerTransport();

    stdioMcpServer.server.onerror = (error) => {
      logger.error({ error }, `[SERVER] Stdio server error: ${JSON.stringify(error)}`);
    };

    // Note: at this point `automatedSliceMap` and `_workflowDefs` haven't been
    // initialised yet — that happens a few lines below. `routingDeps` uses
    // getters, so the handler reads the live values at invocation time (always
    // after main() finishes).
    registerHandlers(stdioMcpServer.server, interfaceSliceNames, viewSliceNames, () => resyncing, routingDeps, tools);
  } else {
    logger.info('[SERVER] Stdio MCP transport disabled via MCP_STDIO=false');
  }

  // Subscribe a single wildcard dispatcher for automated slices.
  // It consults the mutable automatedSliceMap at call time so resync only needs
  // to clear+repopulate the map — no unsubscription required.
  const automatedSliceMap = await loadAutomatedSliceMap(skillsDir);
  const sliceWorkflowMap = await loadSliceWorkflowMap(skillsDir);
  logger.info({ automatedSliceEvents: [...automatedSliceMap.keys()] }, '[SERVER] Automated slice event subscriptions registered');

  const runnerDeps = {
    eventBus,
    eventStore: testAwareEventStore,
    skillsDir,
    llmService,
    executeConnector: (toolId: string, params: Record<string, any>, correlationId?: string) => {
      const ctx = { eventBus, dataSources: { json: jsonData, sqlite: sqliteData }, tools, correlationId };
      return connectorExecutor.createExecutor(toolId, params, true)(ctx, {});
    },
  };
  // Automated-slice dispatch (production disk path + workbench test sessions).
  // See ./routers.ts for the full routing-policy rationale.
  registerAutomatedSliceRouter({ automatedSliceMap, runnerDeps });

  // TodoProcessor: event-sourced state machine that creates persistent work items
  // for interface slices when their preconditions are met.
  const workflowDefinitions = await loadWorkflowDefinitions(skillsDir);
  _workflowDefs = workflowDefinitions;
  // Let the quiescence gate resolve a session's workflow (for the awaiting-
  // callback obligation). Reads live `_workflowDefs`, so resync is transparent.
  setQuiescenceWorkflowDefs(() => _workflowDefs);
  const todoProcessor = new TodoProcessor({
    eventBus,
    eventStore: testAwareEventStore,
    todoStore: testAwareTodoStore,
    workflows: workflowDefinitions,
    // Session-scoped (Test panel) runs resolve todos against their inline model,
    // mirroring the automated-slice dispatcher's test-vs-disk seam (#73).
    isSessionScoped,
    getInlineWorkflow: (sid) => getRun(sid)?.inlineWorkflow,
    // Expose a notable "no eligible scenario" deferral to the session's client
    // as a synthetic diagnostic event. The client renders it (e.g. "Application
    // Approved is waiting on enrolment-agreement-signed") so a wiring deadlock
    // surfaces immediately instead of the run silently quiescing with the
    // expected interface step never appearing.
    onSliceDeferred: (info) => {
      const ev = makeRouterEvent(info.correlationId, 'slice-eligibility-deferred');
      ev.payload = {
        ...ev.payload,
        sliceName: info.sliceName,
        role: info.role,
        pattern: info.pattern,
        triggerEventType: info.triggerEventType,
        missingGivens: info.missingGivens,
        rulesFailed: info.rulesFailed,
      };
      deliverToCorrelation(info.correlationId, ev);
    },
  });
  todoProcessor.register();
  logger.info({ workflowCount: workflowDefinitions.size, workflows: [...workflowDefinitions.keys()] }, '[SERVER] TodoProcessor registered');

  // Reclaim per-instance caches when a WorkflowRun is GC'd (#73). The run owns
  // skills/quiescence; these two caches live outside it, so a hook drops them
  // for every alias of the collected run — closing the correlationWorkflowCache
  // and correlationFactCache leaks called out in the issue.
  registerRunGcHook((_run, aliases) => {
    for (const alias of aliases) {
      todoProcessor.dropCorrelation(alias);
      testAwareEventStore.dropCorrelation(alias);
    }
  });

  // Route qualifying events to the connection that owns the matching workflow
  // session, emit terminus / unexpected_last_event, and feed the quiescence gate.
  // Registered after the automated-slice subscriber so automatedSliceMap is set.
  registerEventDeliveryRouter({
    triggerEventSet,
    automatedSliceMap,
    getWorkflowDefs: () => _workflowDefs,
  });

  if (STDIO_ENABLED && !process.env.VITE && stdioMcpServer && stdioTransport) {
    const localStdioServer = stdioMcpServer;
    const localStdioTransport = stdioTransport;
    localStdioServer.connect(localStdioTransport).then(() => {
      logger.info("MMC MCP Server running on stdio");
      if (generatedAdminKey) {
        logger.warn(
          { event: 'admin.key.generated' },
          `[ADMIN] New admin API key generated — copy it now, it will not be shown again:\n\n  ${generatedAdminKey}\n`,
        );
      }
    }).catch(err => {
      logger.error({ error: err.message }, `[SERVER] Stdio connection error: ${err.message}`);
    });
    cleanupHooks.push(async () => {
      try { await localStdioTransport.close?.(); } catch { /* ignore */ }
      try { await localStdioServer.close?.(); } catch { /* ignore */ }
    });
  }

  return app;
}

const app = await main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

// Default export: under Bun, exporting `{ fetch, port }` auto-starts Bun.serve
// (this is how the Fly production image, `bun src/server/index.ts`, listens).
export default {
  fetch: app!.fetch.bind(app),
  port: parseInt(process.env.PORT ?? '3001'),
};

// Under Node (dev via `tsx`, and the future Node production runtime) the default
// export above is inert — nothing listens unless we start a server explicitly.
// Spin up @hono/node-server when NOT running under Bun. The dynamic import keeps
// the dependency off Bun's load path.
const runningUnderBun = typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';
if (!runningUnderBun && app) {
  const { serve } = await import('@hono/node-server');
  const port = parseInt(process.env.PORT ?? '3001');
  serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, `MMC MCP Server (Node) listening on http://localhost:${info.port}/mcp`);
  });
}

// Graceful shutdown. Dev (`tsx watch`) and prod (process manager / Fly) send
// SIGTERM/SIGINT on restart or exit; drain cleanup hooks in reverse order and
// disconnect child MCP servers + close SQLite handles so nothing orphans on
// Windows or elsewhere. Guarded against a double signal.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, '[SERVER] Shutting down — releasing resources');
  for (const hook of cleanupHooks.slice().reverse()) {
    try { await hook(); } catch (err: any) {
      logger.error({ error: err?.message }, '[SERVER] Cleanup hook failed');
    }
  }
  try { await externalMcpManager.disconnectAll(); } catch (err: any) {
    logger.error({ error: err?.message }, '[SERVER] externalMcpManager.disconnectAll failed');
  }
  try { eventStore.close(); } catch { /* ignore */ }
  try { testAwareTodoStore.close(); } catch { /* ignore */ }
  logger.info('[SERVER] Shutdown complete');
  process.exit(0);
}
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
