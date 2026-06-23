// MCP request handlers — the ListTools / CallTool / GetPrompt handlers plus the
// tool-definition builder (buildToolDefs) and complete-slice helpers, extracted
// from index.ts (PR C step 4b). registerHandlers is wired onto both the HTTP and
// stdio transports by main() in index.ts.
//
// Shared mutable state:
//   - `cachedToolDefs` is owned here; index.ts invalidates it via
//     invalidateToolDefsCache() on resync / admin config change.
//   - the external-tool registry `tools` is owned by index.ts and passed into
//     registerHandlers by reference (so runtime Object.assign/delete are seen).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildSliceFormSpec, buildValueTypeRegistry } from '@src/ui/formSpec.js';
import {
  INTERFACE_FORM_URI,
  UI_META_KEY,
  FORM_SPEC_META_KEY,
  getInterfaceFormHtml,
} from '@src/ui/interfaceForm.js';
import type { Event } from '@src/events/eventBus.js';
import fs from 'fs';
import fsAsync from 'fs/promises';
import path from 'path';
import { logger } from '@src/utils/logger.js';
import { connectors } from '@connectors/index.js';
import { toKebabCase } from '@src/utils/stringUtils.js';
import {
  loadSliceOutcomes,
  loadSliceQueries,
  loadSliceFromMdPath,
  extractSliceQueries,
  buildEventSchemaIndex,
  buildScopedFactIdToName,
  collectUnmappedFactIds,
  getSlicePattern,
  type FactSchemaEntry,
  type WorkflowDefinition,
} from '@src/skill-engine/interaction-slice-trigger-events.js';
import { executeViewSlice } from '@src/services/viewSliceRunner.js';
import { ingestScopedFacts } from '@src/services/automatedSliceRunner.js';
import { evaluateSlice, executeSliceQueries } from '@src/services/sliceEvaluator.js';
import { parseSkillFrontmatter, listSkillPaths, resolveSkillPath } from '@src/utils/skillUtils.js';
import { fitToolName } from '@src/utils/toolNameUtils.js';
import { dispatchLatestEvent, type HandleLatestEventDeps } from './handleLatestEvent.js';
import { eventForDisplay } from './displayNames.js';
import {
  projectRoot,
  skillsDir,
  eventBus,
  testAwareEventStore,
  testAwareTodoStore,
  jsonData,
  sqliteData,
  llmService,
  externalMcpManager,
  toolOutputSchemaCache,
  connectorExecutor,
} from './composition.js';
import {
  DEFAULT_SESSION_ID,
  connectionPool,
  getOrCreateConnection,
  requireActiveCorrelation,
  type ConnectionState,
} from './sessionState.js';
import { getRun, attachSession } from './workflowRun.js';
import { scheduleQuiescenceCheck } from './quiescence.js';
import { createInlineToolHandlers } from './inlineToolHandlers.js';

/** Invalidate the cached MCP tool-definitions list. Called by index.ts on
 *  /resync and admin /config changes so the next tools/list rebuilds it. */
export function invalidateToolDefsCache(): void {
  cachedToolDefs = null;
}

// Cached tool definitions list — invalidated on resync via invalidateToolDefsCache().
let cachedToolDefs: Awaited<ReturnType<typeof buildToolDefs>> | null = null;

/**
 * Builds the MCP Apps `_meta` for a slice tool result: the UI resource pointer
 * plus the FormSpec the renderer draws. Interface slices get an editable form;
 * View slices get a read-only display form; everything else (automations) gets
 * undefined. Never throws — the slice's text content path must always succeed
 * regardless of form rendering.
 */
function sliceFormMeta(sliceJson: any): Record<string, unknown> | undefined {
  try {
    if (!sliceJson) return undefined;
    const spec = buildSliceFormSpec(sliceJson, { registry: buildValueTypeRegistry(sliceJson) });
    if (!spec) return undefined;
    return {
      [UI_META_KEY]: { resourceUri: INTERFACE_FORM_URI },
      [FORM_SPEC_META_KEY]: spec,
    };
  } catch (err: any) {
    logger.warn({ error: err?.message }, '[ui] failed to build interface form spec');
    return undefined;
  }
}

/**
 * Builds the full MCP tool definitions list.
 * When interfaceSliceNames is non-empty, only interface slices are included (no root-level skills).
 * When interfaceSliceNames is empty (runner mode), ALL slice skills are included.
 * `interfaceOnly` is the Interface-pattern subset (excludes Views) — those tools
 * get an MCP Apps `_meta.ui.resourceUri` pointer so hosts can preload the form.
 */
async function buildToolDefs(skillsDir: string, interfaceSliceNames: Set<string>, interfaceOnly: Set<string>) {
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
    // MCP tool names must match ^[a-zA-Z0-9_-]{1,64}$, so use "--" as workflow separator
    // (e.g. skills/wf-a3f9b2c1/request-top-projects-report/... → "wf-a3f9b2c1--request-top-...")
    // Internal event sources keep the "/" format; only the exposed tool name uses "--".
    // Names that would exceed 64 chars are deterministically truncated + 6-char hash via fitToolName.
    const workflowDir = path.basename(path.dirname(path.dirname(fp)));
    const isNestedInWorkflow = workflowDir !== path.basename(skillsDir);
    const rawToolName = skill_id || (isNestedInWorkflow ? `${workflowDir}--${name}` : name);
    const toolName = fitToolName(rawToolName);
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
      },
      // Interface slices link to the ui://mmc/interface-form renderer (MCP Apps).
      // Hosts that don't support MCP Apps ignore _meta and fall back to the
      // text skill body — no regression.
      ...(interfaceOnly.has(dirName)
        ? { _meta: { [UI_META_KEY]: { resourceUri: INTERFACE_FORM_URI } } }
        : {}),
    };
  }))).filter((t): t is NonNullable<typeof t> => t !== null);

  return [
    // Connectors (find-json-record, json-write, budget-top, file-*, azure-blob-download, ...)
    // are deliberately NOT published in tools/list. They are implementation details
    // of skill workflows — the slice runner invokes them directly via
    // `connectorExecutor.createExecutor`, bypassing the public tools/call dispatcher
    // entirely. Exposing them as first-class tools lets an LLM short-circuit the
    // skill (e.g. answer "make a budget report" by calling budget-top instead of
    // triggering the request-budget-report → automation-chain → slack-post flow),
    // which defeats the event-modelled workflow and skips logging, scenarios, and
    // downstream effects. Public tools/call already rejects unlisted names via the
    // `allowedNames` check, so removal here is sufficient — no dispatcher edits needed.
    // The internal `/connectors` REST endpoint (see below) advertises them to the
    // workbench planner without leaking them into the public MCP surface.
    {
      name: "get-github-methods",
      description: "List all available GitHub MCP methods (tools).",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "register-agent",
      description: "Register this agent and bind roles to the connection. Provide either `username` (production: roles are looked up from the server's role configuration) or `roles` (test harnesses: bind the given role names directly). Must be called before list-todos or claim-todo.",
      inputSchema: {
        type: "object",
        properties: {
          username: { type: "string", description: "The username to register (e.g. 'arjan'). Roles are looked up from the server's role configuration." },
          roles: { type: "array", items: { type: "string" }, description: "Explicit role names to bind to this connection, bypassing the username lookup. Used by test harnesses that have no real users." },
          testMode: { type: "boolean", description: "If true, this is a test session. Events will NOT be persisted to the event store." }
        }
      }
    },
    {
      name: "start-workflow",
      description: "Begin a NEW workflow instance. Returns a server-minted { correlationId } that identifies this run. Call this once when the user starts a new task, then pass the returned correlationId to subsequent complete-slice / log-event-to-bus calls so a second task on the same connection stays isolated from the first. The server is the sole minter — never invent a correlationId.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "log-event-to-bus",
      description: "Log a custom event into the event store. Use this to record observations, decisions, or notable moments during a workflow instance. Pass the `correlationId` returned by start-workflow; if omitted, the server uses the connection's active instance or mints a fresh one for an entry-point event.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "The event type (e.g. 'member-claim-received'). Must be kebab-case; other formats are auto-normalized." },
          source: { type: "string", description: "Source identifier for the event. Defaults to 'llm'." },
          correlationId: { type: "string", description: "Workflow-instance id from start-workflow. Optional — defaults to the connection's active instance." },
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
          correlationId: { type: "string", description: "Filter events by workflow-instance id. Optional (legacy 'sessionId' also accepted)." }
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
      description: "Claim a pending todo work item and join its workflow instance. Returns the todo's payload (accumulated fact values) and correlationId so you can continue the workflow.",
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
      description: "Return the full structured event list for a workflow instance (oldest first). Used by UIs that render a timeline.",
      inputSchema: {
        type: "object",
        properties: {
          correlationId: { type: "string", description: "The workflow-instance id to load events for (legacy 'sessionId' also accepted)." },
          sessionId: { type: "string", description: "Deprecated alias for correlationId." }
        }
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
      description: "Complete a workflow slice by evaluating its business rules against collected facts. The server evaluates scenarios deterministically, logs matching outcome events to the event bus, and advances the workflow. Call this after collecting all required facts for a slice. Pass the `correlationId` from start-workflow; if omitted, the server uses the connection's active instance (or mints a fresh one for an entry-point slice).",
      inputSchema: {
        type: "object",
        properties: {
          sliceId: { type: "string", description: "The slice tool name (e.g. 'intake-request'). Legacy 'slice-N-...' values are still accepted for older skills on disk." },
          correlationId: { type: "string", description: "Workflow-instance id from start-workflow. Optional — defaults to the connection's active instance." },
          facts: { type: "object", description: "Collected fact key-value pairs (kebab-case keys)" }
        },
        required: ["sliceId", "facts"]
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
    {
      name: "probe-tool-output",
      description: "Calls an external MCP tool once with caller-supplied sample arguments, captures the top-level keys of its response into the persistent tool-output-schema cache, and returns the captured shape. Use this when the plan synthesizer encounters an external tool whose upstream server doesn't advertise an outputSchema and which hasn't been exercised by any prior workflow run — without it the synthesizer can only see the generic `result` placeholder and may invent field names that don't exist. Rarely needed in steady state because observe-and-remember already records the shape from every successful real call.",
      inputSchema: {
        type: "object",
        properties: {
          toolName: { type: "string", description: "The fully-prefixed external tool name (as reported by tools/list, e.g. `slack_slack_list_channels`)." },
          sampleArgs: { type: "object", description: "Arguments to invoke the tool with. Use minimal safe values; for write tools (post, create, delete) pick a sandbox target or skip and observe-and-remember will catch the shape from the first real run instead." }
        },
        required: ["toolName"]
      }
    },
    ...sliceTools
  ];
}


// Shared slice-query prefetch. Runs the slice's declared queries and
// snapshots their declared facts from the current session, returning a
// "Pre-fetched Query Results" markdown block + raw connector results.
// Used by BOTH the session-skill branch (test panel) and the disk
// branch so they are FUNCTIONALLY IDENTICAL — only the slice source
// differs (registered sliceData vs disk md). Without this in the
// session branch, test-panel interface slices (e.g. underwriter-review)
// never receive their query/context fact values, so the agent is told
// to display the credit file but is never given it.
// Hoisted to module scope (#81) so it is not re-allocated on every CallTool
// request. `tools` is passed in (the only per-connection dependency); the rest
// are module-level singletons.
const runSliceQueryPrefetch = async (
  queries: Awaited<ReturnType<typeof loadSliceQueries>>,
  factsCorrelationId: string,
  tools: Record<string, (params: any, input: any) => Promise<any>>,
  factIdToName: Map<string, string>,
): Promise<{ queryResultsSection: string; prefetchedToolResults: { toolId: string; result: any }[] }> => {
  const prefetchedToolResults: { toolId: string; result: any }[] = [];
  let queryResultsSection = '';
  if (!queries.length) return { queryResultsSection, prefetchedToolResults };
  const rawSessionFacts = testAwareEventStore.getCorrelationFactValues(factsCorrelationId);
  // Session events are keyed by factId on the wire (#77). ingestScopedFacts
  // translates them to the slice's NAME-keyed contract (factId-primary,
  // bare-name fallback for external/log-event payloads), so the queries below
  // — which declare bare fact names — resolve their context values.
  const sessionFacts = ingestScopedFacts(rawSessionFacts, factIdToName);
  logger.info(
    { factsCorrelationId, rawFactKeys: Object.keys(rawSessionFacts), scopedFactKeys: Object.keys(sessionFacts) },
    `[SERVER] Prefetch facts loaded for slice dispatch`,
  );
  const connectorContext = {
    eventBus,
    dataSources: { json: jsonData, sqlite: sqliteData },
    tools,
    correlationId: factsCorrelationId,
  };
  type QueryResult = { name: string; toolId?: string; result?: any; error?: string; snapshot?: Record<string, any> };
  const results: QueryResult[] = [];
  for (const query of queries) {
    if (query.job) {
      const jobParams: Record<string, any> = { ...query.job.staticParams };
      for (const [param, factName] of Object.entries(query.job.resolvedInputMappings)) {
        jobParams[param] = sessionFacts[factName as string] ?? '';
      }
      try {
        const executor = connectorExecutor.createExecutor(query.job.toolId, jobParams, true);
        const result = await executor(connectorContext, {});
        results.push({ name: query.name, toolId: query.job.toolId, result });
        prefetchedToolResults.push({ toolId: query.job.toolId, result });
      } catch (qErr: any) {
        results.push({ name: query.name, toolId: query.job.toolId, error: qErr.message });
        logger.warn({ queryName: query.name, error: qErr.message }, `[SERVER] Query '${query.name}' failed during slice dispatch — continuing`);
      }
    } else if (query.text && llmService) {
      try {
        const returnedFactName = query.factNames[0] ?? query.name;
        const result = await llmService.evaluateInstruction(query.text, sessionFacts, returnedFactName);
        results.push({ name: query.name, toolId: 'ai.eval', result });
      } catch (tErr: any) {
        results.push({ name: query.name, toolId: 'ai.eval', error: tErr.message });
        logger.warn({ queryName: query.name, error: tErr.message }, `[SERVER] Text instruction '${query.name}' failed during slice dispatch — continuing`);
      }
    } else {
      const snapshot: Record<string, any> = {};
      for (const factName of query.factNames) snapshot[factName] = sessionFacts[factName] ?? null;
      results.push({ name: query.name, snapshot });
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
      lines.push(`### ${header}`, '');
      if (r.error !== undefined) {
        lines.push(`_Error:_ ${r.error}`);
      } else {
        lines.push('```json', JSON.stringify(r.result ?? r.snapshot ?? null, null, 2), '```');
      }
      lines.push('');
    }
    queryResultsSection = lines.join('\n');
  }
  return { queryResultsSection, prefetchedToolResults };
};

export function registerHandlers(
  server: Server,
  interfaceSliceNames: Set<string>,
  viewSliceNames: Set<string>,
  isResyncing: () => boolean,
  routingDeps: HandleLatestEventDeps,
  // The mutable external-tool registry, owned by index.ts (populated from
  // ExternalMcpManager in main() and mutated by the admin /config handler).
  // Passed by reference so runtime mutations remain visible here.
  tools: Record<string, (params: any, input: any) => Promise<any>>,
) {
  // Tool list filter — both Interface and View pattern slices are exposed
  // to the agent. The dispatcher (below) branches on which set the tool
  // name lives in: Interface returns the .md prompt; View runs the queries
  // and returns a projection.
  const exposedSliceNames = (): Set<string> => new Set([...interfaceSliceNames, ...viewSliceNames]);
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
      cachedToolDefs = await buildToolDefs(skillsDir, exposedSliceNames(), interfaceSliceNames);
    }

    // Only expose session-scoped skills registered by THIS session.
    // Non-test sessions have no registered skills and see disk tools only.
    const callerSessionId = (extra as any)?.sessionId ?? DEFAULT_SESSION_ID;
    const callerSkillMap = getRun(callerSessionId)?.skills;
    const callerConn = connectionPool.get(callerSessionId);
    const allSessionToolDefs: typeof cachedToolDefs = [];
    const seenSessionSkills = new Set<string>();
    if (callerSkillMap) {
      for (const s of callerSkillMap.values()) {
        if (s.hidden) continue; // automation slices: server-run only, not LLM-callable
        seenSessionSkills.add(s.name);
        const triggerInfo = s.triggersOn ? ` | triggers_on_event: ${s.triggersOn}` : '';
        const publishInfo = s.publishes ? ` | publishes_event: ${s.publishes}` : '';
        const isIfaceSession =
          !!(s as any).sliceData && getSlicePattern((s as any).sliceData) === 'interface';
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
          },
          ...(isIfaceSession
            ? { _meta: { [UI_META_KEY]: { resourceUri: INTERFACE_FORM_URI } } }
            : {}),
        });
      }
    }

    const exposedExternalDefs = externalMcpManager.getExposedToolDefinitions().map(d => ({
      name: d.name,
      description: `[External MCP] ${d.description ?? ''}`,
      inputSchema: d.inputSchema,
    }));

    // Session-isolated mode: once this connection has called register-skills,
    // hide ALL disk slice tools so a stale export of a previous workflow with
    // the same slice kebab name (different workflowId prefix) can't be picked
    // up by accident. Connectors and other non-skill disk entries stay visible
    // — they're identified by description prefix: skill tools start with
    // `[Skill/Slice]`. External agents that never call register-skills are
    // unaffected and see disk skills as before.
    const isolated = !!callerConn?.sessionIsolated;
    const diskTools = isolated
      ? cachedToolDefs.filter(t => !t.description?.startsWith('[Skill/Slice]'))
      : cachedToolDefs.filter(t => !seenSessionSkills.has(t.name));

    const mergedTools = [
      ...diskTools,
      ...allSessionToolDefs,
      ...exposedExternalDefs,
    ];

    const toolNames = mergedTools.map(t => t.name).join(', ');
    logger.info({ toolCount: mergedTools.length, toolNames }, `[SERVER] tools/list requested. Available tools: ${toolNames}`);
    return { tools: mergedTools };
  });

  // MCP Apps UI resources. Currently a single generic interface-form renderer;
  // interface slice tools point at it via _meta.ui.resourceUri and deliver the
  // per-slice FormSpec on their tool result. Hosts without MCP Apps simply
  // never read these.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: INTERFACE_FORM_URI,
        name: 'MMC interface form',
        description: 'Generic form renderer for interface slices (MCP Apps UI).',
        mimeType: 'text/html',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri !== INTERFACE_FORM_URI) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: 'text/html',
          text: getInterfaceFormHtml(),
          _meta: { [UI_META_KEY]: { preferredFrame: { height: 640 } } },
        },
      ],
    };
  });

  // Inline tool handlers — extracted to ./inlineToolHandlers.ts (#81). Bound
  // to this connection's tool registry + routing deps; dispatched by CallTool below.
  const inlineToolHandlers = createInlineToolHandlers({ tools, routingDeps });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    // Guard: only allow tools that are listed in the client-facing tool definitions.
    if (!cachedToolDefs) {
      cachedToolDefs = await buildToolDefs(skillsDir, exposedSliceNames(), interfaceSliceNames);
    }
    const callSessionId = extra?.sessionId ?? DEFAULT_SESSION_ID;
    const sessSkills = getRun(callSessionId)?.skills;
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
          // Connector exec is instance-scoped — require a bound instance rather
          // than falling back to the transport cid (workflow-instance-isolation RFC).
          correlationId: requireActiveCorrelation(conn, `connector:${name}`),
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
      const callSessSkills = getRun(callSessionId)?.skills;
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
        // Functional parity with the disk branch: run the slice's declared
        // queries against the current workflow session and prepend the
        // pre-fetched results to the body. Without this, an interface slice
        // like underwriter-review lists its query/context facts as
        // "Context — display" but the agent never receives their values.
        let sessionBody = skill.body;
        const sessionPrefetched: { toolId: string; result: any }[] = [];
        try {
          if (skill.sliceData) {
            const eventSchemaIndex =
              getRun(callSessionId)?.eventSchemaIndex ?? new Map<string, FactSchemaEntry[]>();
            const factIdToName = buildScopedFactIdToName(skill.sliceData, eventSchemaIndex);
            const queries = extractSliceQueries(skill.sliceData, factIdToName);
            // Pre-start fetch: an entry-point slice's prefetch legitimately
            // precedes the first instance — read an empty pool, never the cid.
            const factsCorrelationId =
              connectionPool.get(callSessionId)?.activeCorrelationId ?? '';
            const { queryResultsSection, prefetchedToolResults } =
              await runSliceQueryPrefetch(queries, factsCorrelationId, tools, factIdToName);
            if (queryResultsSection) {
              const preInteractionPattern = /## 1\.\s*Pre-Interaction Tool Calls[\s\S]*?(?=\n## \d|$)/;
              sessionBody = preInteractionPattern.test(sessionBody)
                ? sessionBody.replace(preInteractionPattern, queryResultsSection)
                : queryResultsSection + '\n---\n\n' + sessionBody;
            }
            sessionPrefetched.push(...prefetchedToolResults);
          }
        } catch (err: any) {
          logger.warn(
            { toolName: name, error: err.message },
            `[SERVER] Session slice query prefetch failed — returning slice without results`,
          );
        }
        logger.info({ toolName: name, sessionId: callSessionId, activeWorkflow: connectionPool.get(callSessionId)?.activeWorkflow, prefetchedTools: sessionPrefetched.length }, `[SERVER] Returning session skill content: ${name}`);
        const sessionContentBlocks: { type: string; text: string }[] = [
          {
            type: "text",
            text: `Skill/Slice: ${name}\nDescription: ${skill.description}\n\n${sessionBody}`,
          },
        ];
        for (const ptr of sessionPrefetched) {
          sessionContentBlocks.push({
            type: "text",
            text: JSON.stringify({ _prefetchedTool: ptr.toolId, ...ptr.result }),
          });
        }

        // A session-registered VIEW has no outcome event — rendering it IS its
        // durable branch close. Mirror the disk View branch: auto-resolve the
        // view's todo(s) and re-arm the completion gate. Without this, a workflow
        // whose last owed branch is a session view (e.g. an auto-approved
        // credit-decisioning's show-credit-decision) stays un-completed because
        // no terminus event follows a render. (Test-session views are served
        // here, not via the disk viewSliceNames branch below.)
        if (skill.sliceData && getSlicePattern(skill.sliceData) === 'view') {
          // View render is instance-scoped (it resolves the instance's view todo).
          const viewCorrelationId = requireActiveCorrelation(connectionPool.get(callSessionId), `view:${name}`);
          const bareName = toKebabCase(skill.sliceData?.name ?? skill.name ?? name);
          const toolKebab = toKebabCase(skill.name ?? name);
          let resolvedAny = false;
          for (const t of testAwareTodoStore.getByCorrelation(viewCorrelationId)) {
            if (t.pattern !== 'view' || (t.status !== 'pending' && t.status !== 'claimed')) continue;
            const tn = toKebabCase(t.sliceName);
            if (tn === bareName || toolKebab === tn || toolKebab.endsWith(`-${tn}`)) {
              testAwareTodoStore.complete(t.id);
              resolvedAny = true;
              logger.info({ toolName: name, sliceName: t.sliceName, todoId: t.id, viewCorrelationId }, '[SERVER] Auto-resolved session view todo on render (view rendered = branch closed)');
            }
          }
          if (resolvedAny) scheduleQuiescenceCheck(viewCorrelationId);
        }

        // Interface slices carry the FormSpec + ui:// pointer so MCP Apps hosts
        // can render the form; non-interface session skills get no _meta.
        const sessionMeta = sliceFormMeta(skill.sliceData);
        return { content: sessionContentBlocks, ...(sessionMeta ? { _meta: sessionMeta } : {}) };
      }

      // View pattern slice: run queries and return the projection. Views
      // are read-only — no scenarios, no Command, no Outcome emission.
      // Distinct from Interface slices (whose tool body is a prompt the
      // agent reads to drive a complete-slice flow).
      // Route views by sliceId, exactly like interface slices: resolve the
      // unique `skill_id` (the tool name the client invoked) to its .md, then
      // classify the RESOLVED slice via getSlicePattern. Keying off the bare
      // slice NAME is unsafe — names are not unique across activities (the same
      // `show-summary` could be a View in one activity and an Interaction in
      // another), so a name-set membership check can misroute. Resolving by
      // skill_id first and reading the pattern of that one slice is
      // collision-proof. (`viewSliceNames` remains for tool-list exposure in
      // buildToolDefs; it is intentionally NOT consulted for routing here.)
      const fpView = await resolveSkillPath(skillsDir, name);
      const loaded = fs.existsSync(fpView) ? await loadSliceFromMdPath(fpView) : null;
      if (loaded && getSlicePattern(loaded.slice) === 'view') {
          // View render is instance-scoped.
          const viewCorrelationId = requireActiveCorrelation(connectionPool.get(callSessionId), `view:${name}`);
          const result = await executeViewSlice(
            loaded.slice,
            loaded.factIdToName,
            (args ?? {}) as Record<string, any>,
            {
              executeConnector: async (toolId, params, cId) => {
                const ctx = {
                  eventBus,
                  dataSources: { json: jsonData, sqlite: sqliteData },
                  tools,
                  correlationId: cId ?? viewCorrelationId,
                };
                const exec = connectorExecutor.createExecutor(toolId, params);
                return await exec(ctx as any, params);
              },
              llmService,
            },
            viewCorrelationId,
          );
          logger.info(
            { toolName: name, projectionKeys: Object.keys(result.projection), errorCount: result.errors.length },
            `[SERVER] Executed View slice '${name}'`,
          );
          // A View emits no outcome event, so rendering it IS its durable
          // branch close. Auto-resolve its todo(s) and re-arm the completion
          // gate — otherwise a workflow whose last owed branch is a View would
          // stay un-completed (no terminus event follows a render). Match on
          // the loaded slice's name (== the todo's sliceName), not the kebab
          // tool name.
          const viewSliceName: string | undefined = loaded.slice?.name;
          if (viewSliceName) {
            let resolvedAny = false;
            for (const t of testAwareTodoStore.getByCorrelation(viewCorrelationId)) {
              if (t.sliceName === viewSliceName && (t.status === 'pending' || t.status === 'claimed')) {
                testAwareTodoStore.complete(t.id);
                resolvedAny = true;
                logger.info({ toolName: name, sliceName: viewSliceName, todoId: t.id, viewCorrelationId }, '[SERVER] Auto-resolved view todo on render (view rendered = branch closed)');
              }
            }
            if (resolvedAny) scheduleQuiescenceCheck(viewCorrelationId);
          }
          // Return the authored skill body ALONGSIDE the projection. Views
          // used to return the data projection alone, so the view's authored
          // rendering instructions (System Hint, "Display Results", and any
          // formatting guidance such as timestamp → human date/time) never
          // reached the agent on the disk path — only Interface slices got
          // their .md body. Mirror the Interface branch: body block first
          // (how to render), then the live data (what to render). The client
          // (mmc-workflow) concatenates non-prefetched text blocks into the
          // slice instructions, so the agent now sees both.
          let viewBodyBlock = '';
          try {
            const rawView = await fsAsync.readFile(fpView, 'utf-8');
            const { description: viewDesc, body: viewBody } = parseSkillFrontmatter(rawView);
            viewBodyBlock = `Skill/Slice: ${name}\nDescription: ${viewDesc}\n\n${viewBody}`;
          } catch (err: any) {
            logger.warn(
              { toolName: name, error: err?.message },
              '[SERVER] Could not read view slice body — returning projection only',
            );
          }
          const viewContentBlocks: { type: string; text: string }[] = [];
          if (viewBodyBlock) viewContentBlocks.push({ type: 'text', text: viewBodyBlock });
          viewContentBlocks.push({
            type: 'text',
            text: `=== LIVE DATA (already fetched — render this, do not call any tool) ===\n${JSON.stringify(result, null, 2)}`,
          });
          // Read-only display FormSpec so MCP Apps hosts can render the view.
          const viewMeta = sliceFormMeta(loaded.slice);
          return { content: viewContentBlocks, ...(viewMeta ? { _meta: viewMeta } : {}) };
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
          const pendingTodo = testAwareTodoStore.findPendingBySliceName(baseSliceName);
          if (pendingTodo && pendingTodo.correlationId !== connForBind.activeCorrelationId) {
            connForBind.activeCorrelationId = pendingTodo.correlationId;
            connForBind.queue = [];
            const boundRun = attachSession(callSessionId, pendingTodo.correlationId);
            connForBind.runId = boundRun.id;
            logger.info(
              { cid: callSessionId, sliceName: baseSliceName, correlationId: pendingTodo.correlationId },
              '[SERVER] Auto-bound connection to workflow instance from pending todo'
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
        // Disk path: identical prefetch to the session branch (same
        // runSliceQueryPrefetch helper) — only the slice source differs
        // (disk md → loadSliceQueries vs registered sliceData →
        // extractSliceQueries).
        let queryResultsSection = '';
        let prefetchedToolResults: { toolId: string; result: any }[] = [];
        try {
          const sliceOutcomes = await loadSliceOutcomes(fp);
          if (sliceOutcomes) {
            const queries = await loadSliceQueries(fp, sliceOutcomes.factIdToName);
            const connForFacts = connectionPool.get(callSessionId);
            // Pre-presentation prefetch — read the bound instance's facts, or an
            // empty pool for an entry-point slice. Never the transport cid.
            const factsCorrelationId = connForFacts?.activeCorrelationId ?? '';
            const pf = await runSliceQueryPrefetch(queries, factsCorrelationId, tools, sliceOutcomes.factIdToName);
            queryResultsSection = pf.queryResultsSection;
            prefetchedToolResults = pf.prefetchedToolResults;
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

        // Interface slices: attach the FormSpec + ui:// pointer (disk path).
        // loadSliceFromMdPath gives the full slice JSON; interfaceFormMeta
        // returns undefined for non-interface slices, so this is a no-op for
        // ordinary skills and views.
        let diskMeta: Record<string, unknown> | undefined;
        try {
          const loaded = await loadSliceFromMdPath(fp);
          diskMeta = sliceFormMeta(loaded?.slice);
        } catch (err: any) {
          logger.warn({ toolName: name, error: err?.message }, '[ui] interface form meta (disk) failed');
        }
        return { content: contentBlocks, ...(diskMeta ? { _meta: diskMeta } : {}) };
      }

      logger.warn({ toolName: name }, `[SERVER] Tool not found: ${name}`);
      throw new Error(`Tool not found: ${name}`);
    } catch (error: any) {
      logger.error({ toolName: name, error: error.message, stack: error.stack }, `[SERVER] Error handling tool call '${name}': ${error.message}`);
      throw error;
    }
  });

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
