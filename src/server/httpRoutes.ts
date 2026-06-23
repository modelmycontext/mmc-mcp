// Auxiliary REST endpoints, extracted from index.ts so the HTTP surface lives
// in one place. The MCP transport (`/mcp`), request-logging middleware, and the
// runtime-control `/resync` route stay in index.ts — they are tied to the
// transport/lifecycle and the mutable loaded-skill maps.
//
// Most dependencies are long-lived singletons imported directly from
// ./composition.js. Only the three things owned by main()'s scope —
// the `tools` registry, the mutable `interfaceSliceNames` set, and the
// reassignable `_workflowDefs` map — are threaded in via HttpRoutesDeps.
import type { Hono } from 'hono';
import path from 'path';
import fsAsync from 'fs/promises';
import { randomBytes } from 'node:crypto';
import { logger } from '@src/utils/logger.js';
import { listSkillPaths } from '@src/utils/skillUtils.js';
import { verifyJti } from '@src/forms/jtiVerify.js';
import { mountFormRunnerRoute } from '@src/ui/formRunner.js';
import { mountPublicFormRoutes } from '@src/ui/publicForm.js';
import { isSpaCoHosted } from '@src/server/staticUi.js';
import type { Event } from '@src/events/eventBus.js';
import type { WorkflowDefinition } from '@src/skill-engine/interaction-slice-trigger-events.js';
import { connectors } from '@connectors/index.js';
import {
  eventBus,
  eventStore,
  jsonData,
  sqliteData,
  externalMcpManager,
  toolOutputSchemaCache,
  connectorExecutor,
  skillsDir,
  consumedJtiStore,
} from './composition.js';

export interface HttpRoutesDeps {
  /** The internal connector tool registry (events-dump etc.). */
  tools: Record<string, (params: any, input: any) => Promise<any>>;
  /** Mutable set of interface slice names — reloaded on resync. */
  interfaceSliceNames: Set<string>;
  /** Reads the current workflow definitions (reassigned on resync). */
  getWorkflowDefs: () => Map<string, WorkflowDefinition> | null;
}

/** Mounts the auxiliary REST routes on the given Hono app. */
export function mountHttpRoutes(app: Hono, deps: HttpRoutesDeps): void {
  const { tools, interfaceSliceNames, getWorkflowDefs } = deps;

  app.get('/files/:referenceKey/:storedName', async (c) => {
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
  app.get('/roles', async (c) => {
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

  // GET /connectors - return the names and parameters of every registered
  // connector (local + external MCP-derived). This is the INTERNAL planner
  // surface; the public `tools/list` MCP method stays filtered to avoid
  // leaking workflow-internal primitives outside the workbench.
  app.get('/connectors', async (c) => {
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

      const outSchema = d.outputSchema;
      const upstreamOutProps = (outSchema && typeof outSchema === 'object' && outSchema.properties && typeof outSchema.properties === 'object')
        ? outSchema.properties as Record<string, any>
        : null;
      // Resolution order for outputParams:
      //   1. Upstream `outputSchema.properties` (most community MCP servers
      //      don't ship this yet — MCP spec 2025-03).
      //   2. ToolOutputSchemaCache — populated by observe-and-remember on every
      //      successful external tool call, plus user/LLM-initiated probes via
      //      the inline `probe-tool-output` tool. This is the dynamic discovery
      //      path: no upfront knowledge of any external server lives in mmc-mcp.
      //   3. Generic `result` placeholder so the workbench UI isn't gated to
      //      zero outputs on first contact with a brand-new tool.
      const cachedEntry = toolOutputSchemaCache.get(d.name);
      const cachedOutProps = cachedEntry?.properties ?? null;
      const cachedErrorProps = cachedEntry?.errorProperties ?? null;
      // The validator-facing `outputParams` is the UNION of success and error
      // keys so existing rules ("returnedFact.name is one of the tool's
      // declared outputs") accept names from either path. The split lives on
      // `errorOutputParams` so write-tool-specific rules can demand presence
      // on BOTH paths (see validate-synthesis-plan.ts's Rule 8c).
      const unionMap: Record<string, any> = {};
      if (upstreamOutProps) Object.assign(unionMap, upstreamOutProps);
      else if (cachedOutProps) Object.assign(unionMap, cachedOutProps);
      if (cachedErrorProps) {
        for (const [k, v] of Object.entries(cachedErrorProps)) {
          if (!(k in unionMap)) unionMap[k] = v;
        }
      }
      const hasAnyDeclared = Object.keys(unionMap).length > 0;
      const outputParams = hasAnyDeclared
        ? Object.entries(unionMap).map(([name, p]) => ({
            name,
            type: (p && typeof p === 'object' && typeof (p as any).type === 'string') ? (p as any).type : 'any',
            description: (p && typeof p === 'object' && typeof (p as any).description === 'string') ? (p as any).description : '',
          }))
        : [{ name: 'result', type: 'any', description: 'Full tool response (no output schema declared by upstream server; will auto-populate on first call).' }];
      const errorOutputParams = cachedErrorProps
        ? Object.entries(cachedErrorProps).map(([name, p]) => ({
            name,
            type: (p && typeof p === 'object' && typeof (p as any).type === 'string') ? (p as any).type : 'any',
          }))
        : undefined;

      return {
        name: d.name,
        description: d.description ?? '',
        inputParams,
        outputParams,
        ...(errorOutputParams ? { errorOutputParams } : {}),
      };
    });
    return c.json({ connectors: [...connectors, ...externalDefs] });
  });

  // POST /connectors/:name/run - execute a built-in connector by name and
  // return its raw output. Internal-only path used by the mmc-workbench
  // "Edit Job → Test Tool" surface to validate that a connector behaves as
  // expected with a given set of inputs.
  //
  // Why this is a REST endpoint and NOT a public `tools/call`: connectors
  // are deliberately excluded from the MCP tools/list / tools/call allowlist
  // (exposing connectors as first-class tools lets an LLM short-circuit the
  // event-modelled slice workflow, skipping logging, scenarios, and downstream
  // effects). This endpoint bypasses that guard for the workbench's testing
  // flow ONLY.
  //
  // Security: same tier as `GET /connectors` today — no auth. Connectors here
  // are real side effects (send-email, json-write, azure-blob-download ...), so
  // deployments must restrict network access until this moves under `/admin/`.
  app.post('/connectors/:name/run', async (c) => {
    const name = c.req.param('name');
    const connector = connectors.find(t => t.name === name);
    if (!connector) {
      return c.json({ error: `Connector not found: ${name}` }, 404);
    }
    let body: { params?: Record<string, any> } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      // Empty body is fine — some connectors take no params.
    }
    const params = (body.params && typeof body.params === 'object') ? body.params : {};
    try {
      const connectorContext = {
        eventBus,
        dataSources: { json: jsonData, sqlite: sqliteData },
        tools: tools,
        // No workflow instance — this is an ad-hoc test invocation.
        correlationId: undefined,
      };
      const executor = connectorExecutor.createExecutor(name, params);
      const result = await executor(connectorContext as any, params);
      return c.json({ result });
    } catch (err: any) {
      logger.warn({ connectorName: name, error: err?.message }, `[connectors/run] Connector '${name}' threw during ad-hoc test invocation`);
      return c.json({ error: err?.message ?? String(err) }, 500);
    }
  });

  // GET /workflows — returns entry-point interface slices that can start new workflows
  app.get('/workflows', async (c) => {
    const workflowDefs = getWorkflowDefs();
    if (!workflowDefs) return c.json({ workflows: [] });
    const entryPoints: { workflow: string; context: string; project: string; sliceName: string; command: string; role: string; facts: string[] }[] = [];
    for (const [name, wf] of workflowDefs) {
      // Read the activity model JSON once to pick up its context grouping
      // (`context.name`, e.g. "driving-academy"), owning project/org, and each
      // slice's command name (the user-facing task label).
      let context = '';
      let project = '';
      try {
        const modelRaw = await fsAsync.readFile(path.join(skillsDir, name, `${name}.json`), 'utf-8');
        const model = JSON.parse(modelRaw);
        context = model?.context?.name ?? '';
        project = model?.project?.name ?? '';
      } catch { /* model JSON not found — leave context blank */ }
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
        // Prefer the command name as the task label; fall back to the slice name.
        const command = slice.command || slice.name;
        entryPoints.push({ workflow: name, context, project, sliceName: slice.name, command, role: slice.role, facts });
      }
    }
    return c.json({ workflows: entryPoints });
  });

  // GET /run/:toolName — standalone slice-form page (see src/ui/formRunner.ts).
  mountFormRunnerRoute(app);

  // GET /forms/resolve/:token (always) + GET /f/:token (engine-only) — authored
  // public form runner (FormTemplate path; see src/ui/publicForm.ts). When the
  // mmc-workflow SPA is co-hosted it owns the `/f/:token` React route, so the
  // runtime's own vanilla HTML page is skipped and `/f/*` falls through to the
  // SPA fallback. The resolve endpoint is served either way. Submit lands on the
  // existing POST /external-events/:eventType below.
  mountPublicFormRoutes(app, { skillsDir, serveHtmlPage: !isSpaCoHosted() });

  // GET /livez — liveness probe. Returns 200 the instant the HTTP server is
  // accepting connections. No async work, no dependency checks.
  app.get('/livez', (c) => c.json({ status: 'ok' }));

  // GET /health — initialization and dependency checks
  app.get('/health', async (c) => {
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
    const workflowDefs = getWorkflowDefs();
    checks.workflows = {
      ok: workflowDefs !== null && workflowDefs.size > 0,
      detail: workflowDefs
        ? `${workflowDefs.size} workflow(s): ${[...workflowDefs.keys()].join(', ')}`
        : 'not yet loaded',
    };

    const allOk = Object.values(checks).every(ch => ch.ok);
    return c.json({
      status: allOk ? 'ok' : 'degraded',
      uptime: Math.floor(process.uptime()),
      checks,
    }, allOk ? 200 : 503);
  });

  // ── External-event webhook ──────────────────────────────────────────────
  // Generic external-event ingestion. The jti is a self-contained HMAC-signed
  // routing envelope minted upstream (workbench or a slice's Command Job).
  // mmc-mcp verifies the signature, extracts sessionId/eventType, and publishes
  // onto that session's bus; the subscribed automation slice handles the rest.
  app.post('/external-events/:eventType', async (c) => {
    const urlEventType = c.req.param('eventType');
    let body: { jti?: string; payload?: Record<string, any> } = {};
    try { body = await c.req.json(); } catch { /* empty body */ }
    if (!body.jti) {
      return c.json({ ok: false, reason: 'invalid', message: 'Missing jti.' }, 400);
    }
    const key = process.env.FORMS_HMAC_KEY;
    if (!key) {
      return c.json({ ok: false, reason: 'misconfigured', message: 'FORMS_HMAC_KEY env not set.' }, 500);
    }
    const verified = verifyJti(body.jti, key);
    if (!verified.ok) {
      const status = verified.reason === 'expired' ? 410 : 401;
      return c.json(verified, status);
    }
    const { correlationId, eventType, templateId, extras } = verified.payload;
    if (eventType !== urlEventType) {
      return c.json({
        ok: false,
        reason: 'event-type-mismatch',
        message: `Token was minted for '${eventType}', not '${urlEventType}'.`,
      }, 400);
    }
    // Single-use enforcement (replay protection). Atomically claim the jti AFTER
    // the signature/expiry/type checks pass but BEFORE publishing, so a replayed
    // link can't drive the workflow twice. The claim is race-free (one SQL
    // INSERT OR IGNORE on a PRIMARY KEY); a malformed/mismatched request above
    // never burns the token.
    if (!consumedJtiStore.claim(body.jti)) {
      logger.info({ eventType, correlationId, jti: body.jti }, '[external-events] rejected replay (jti already consumed)');
      return c.json({
        ok: false,
        reason: 'already-consumed',
        message: 'This form link has already been submitted.',
      }, 409);
    }
    const event: Event = {
      id: randomBytes(8).toString('hex'),
      type: eventType,
      source: 'external-webhook',
      payload: {
        jti: body.jti,
        templateId,
        ...(extras ?? {}),
        ...(body.payload ?? {}),
      },
      timestamp: new Date(),
      // Bind the inbound event to the instance the token was minted for — NOT to
      // any session (workflow-instance-isolation RFC D4).
      correlationId,
    };
    await eventBus.publish(event);
    logger.info({ eventType, correlationId, jti: body.jti, sequence: (event as any).sequence }, '[external-events] published');
    return c.json({ ok: true, sequence: (event as any).sequence ?? null });
  });
}
