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
  loadSliceFromSliceId,
  extractSliceQueries,
  buildEventSchemaIndex,
  buildScopedFactIdToName,
  buildWorkflowDefinition,
  collectUnmappedFactIds,
  getSlicePattern,
  type FactSchemaEntry,
  type WorkflowDefinition,
} from '@src/skill-engine/interaction-slice-trigger-events.js';
import { executeViewSlice } from '@src/services/viewSliceRunner.js';
import { ingestScopedFacts } from '@src/services/automatedSliceRunner.js';
import { eventForDisplay } from './displayNames.js';
import { evaluateSlice, executeSliceQueries } from '@src/services/sliceEvaluator.js';
import { parseSkillFrontmatter, listSkillPaths, resolveSkillPath } from '@src/utils/skillUtils.js';
import { fitToolName } from '@src/utils/toolNameUtils.js';
import { dispatchLatestEvent, type HandleLatestEventDeps } from './handleLatestEvent.js';
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
  type ConnectionState,
} from './sessionState.js';
import {
  getRun,
  ensureRun,
  addAlias,
  addMember,
  attachSession,
} from './workflowRun.js';
import { scheduleQuiescenceCheck } from './quiescence.js';


// Inline MCP tool handlers, extracted from registerHandlers (#81) so each is
// independently testable and the dispatcher file stays thin. The handlers
// close over the per-connection context (the external-tool registry + event
// routing deps); everything else they use is a module-level singleton import
// above. createInlineToolHandlers binds that context via destructured params,
// so the handler bodies are unchanged from when they lived in the closure.

export interface InlineToolContext {
  /** The mutable external-tool registry, owned by index.ts. */
  tools: Record<string, (params: any, input: any) => Promise<any>>;
  /** Live accessors for the handle-latest-event dispatcher. */
  routingDeps: HandleLatestEventDeps;
}

export type ToolResult = { content: unknown[] };

/** Split a `a|b|c` trigger string into a set (used by register-skills). */
function parseTriggers(raw: string): Set<string> {
  return new Set(raw.split('|').map(s => s.trim()).filter(Boolean));
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
  // Resolve in identity order: canvas UUID (new canonical) → kebab tool name
  // (legacy / external callers) → linear scan by display name. The third
  // fallback is preserved because some agents still pass the slice's `name`
  // instead of the canonical id.
  const run = getRun(cid);
  const sessById = run?.skillsById;
  const sessSkills = run?.skills;
  let skill = sessById?.get(sliceId);
  if (!skill?.sliceData && sessSkills) skill = sessSkills.get(sliceId);
  if (!skill?.sliceData && sessSkills) {
    for (const s of sessSkills.values()) {
      if (s.name === sliceId && s.sliceData) { skill = s; break; }
    }
  }
  if (skill?.sliceData) {
    const eventSchemaIndex =
      run?.eventSchemaIndex ?? new Map<string, FactSchemaEntry[]>();
    const factIdToName = buildScopedFactIdToName(skill.sliceData, eventSchemaIndex);
    return { source: 'session', sliceData: skill.sliceData, skill, factIdToName };
  }

  // 2. Disk-based outcome model JSON — resolve by canonical `slice.id` first.
  // Post-identity-refactor, `complete-slice` receives the slice's opaque `id`
  // (the same value the session path resolves above), NOT the kebab tool name
  // or `.md` skill_id — names are never routing keys (slice-patterns.md "Slice
  // identity"; model-contract.md Decision 1). `loadSliceFromSliceId` scans the
  // outcome-model JSON for `slice.id === sliceId` and returns the scoped factId
  // map plus a synthesized skillMdPath for activity-name derivation.
  const byId = await loadSliceFromSliceId(skillsDir, sliceId);
  if (byId) {
    return {
      source: 'disk',
      sliceData: byId.slice,
      factIdToName: byId.factIdToName,
      skillMdPath: byId.skillMdPath,
    };
  }

  // 2b. Legacy fallback: a kebab tool name or `.md` skill_id (older callers,
  // and skills registered without an `id`). `complete-slice` accepts either a
  // UUID sliceId (new) or a kebab tool name (legacy) — slice-patterns.md
  // "Backward compatibility".
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
  // `evaluateSlice` is async, so its bare `ReturnType` is `Promise<...>` — the
  // caller already awaits, so this parameter receives the unwrapped value.
  evalResult: Awaited<ReturnType<typeof evaluateSlice>>,
  correlationId: string,
  cid: string,
  conn: ConnectionState,
) {
  // Bind connection to this workflow instance and alias the correlationId onto
  // this connection's run (#73) so the event router can reach the instance by
  // correlationId. correlationId is a per-instance id, never the transport cid
  // (workflow-instance-isolation RFC).
  if (correlationId) {
    if (conn.activeCorrelationId !== correlationId) {
      conn.activeCorrelationId = correlationId;
      conn.queue = [];
      logger.info({ cid, correlationId }, '[complete-slice] Joined workflow instance');
    }
    const run = attachSession(cid, correlationId);
    conn.runId = run.id;
  }

  // The workbench commonly opens TWO MCP transport sessions for the same
  // logical workflow: one cid runs `complete-slice` (the LLM tool path) and a
  // sibling cid long-polls `get-next-event` (the test panel's event stream).
  // EVENT_ROUTER fans out by `activeCorrelationId`, which only the cid
  // that called complete-slice has bound — the polling cid stays unbound and
  // never receives the `unexpected_last_event` terminus, leaving the test
  // panel hanging. Propagate this session to every unbound sibling that
  // registered the same workflow so downstream automated-slice events and
  // the synthetic completion event reach the polling client.
  if (correlationId && conn.activeWorkflow) {
    for (const [siblingCid, sibling] of connectionPool) {
      if (siblingCid === cid) continue;
      if (sibling.activeWorkflow !== conn.activeWorkflow) continue;
      if (sibling.activeCorrelationId) continue;
      sibling.activeCorrelationId = correlationId;
      sibling.queue = [];
      const siblingRun = attachSession(siblingCid, correlationId);
      sibling.runId = siblingRun.id;
      logger.info(
        { siblingCid, sourceCid: cid, correlationId, activeWorkflow: conn.activeWorkflow },
        '[complete-slice] Propagated workflow instance to sibling connection',
      );
    }
  }

  // (#73) The attachSession call above already aliased correlationId onto this
  // connection's run — carrying its skills, skillsById, eventSchemaIndex and
  // isTest flag — so the event router reaches it by correlationId. The previous
  // block that mirrored those maps under a SECOND key (and never deleted that
  // key) was the memory leak this aggregate removes.

  // Log all matched outcome events to the event bus
  for (const event of evalResult.eventsToLog) {
    const eventId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const prefixedSource = (conn.activeWorkflow && event.source && !event.source.includes('/'))
      ? `${conn.activeWorkflow}/${event.source}`
      : event.source;
    logger.info({ eventType: event.type, source: prefixedSource, correlationId, cid }, '[complete-slice] Logging event');
    await eventBus.publish({
      id: eventId,
      type: event.type,
      source: prefixedSource,
      correlationId,
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

/**
 * Build the inline tool-handler registry bound to this connection's context.
 * Called once per registerHandlers wiring (same allocation profile as before
 * the extraction). Handlers reference `tools` / `routingDeps` as the
 * destructured factory params.
 */
export function createInlineToolHandlers(
  { tools, routingDeps }: InlineToolContext,
): Record<string, (args: Record<string, any>, extra: { sessionId?: string; [k: string]: any }) => Promise<ToolResult>> {
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

    'probe-tool-output': async (args) => {
      // User/LLM-triggered output-schema discovery for an external MCP tool.
      // Invokes the tool once with the supplied sample args and lets the
      // wrapper's observe-and-remember path record the response keys.
      // Returns the captured schema (or an error envelope when the call
      // fails — typical for write-tools called with insufficient args).
      const { toolName, sampleArgs } = args as { toolName: string; sampleArgs?: Record<string, any> };
      if (typeof toolName !== 'string' || !toolName) {
        throw new Error('probe-tool-output requires a non-empty `toolName`');
      }
      const toolFn = tools[toolName];
      if (typeof toolFn !== 'function') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, toolName, error: `Tool "${toolName}" is not a registered external tool. Call tools/list first to confirm the name.` }, null, 2) }],
        };
      }
      const beforeEntry = toolOutputSchemaCache.get(toolName);
      let invokeError: string | undefined;
      try {
        await toolFn(sampleArgs ?? {}, {});
      } catch (err: any) {
        invokeError = err?.message ?? String(err);
      }
      const afterEntry = toolOutputSchemaCache.get(toolName);
      const captured = !!afterEntry && afterEntry !== beforeEntry;
      const payload = {
        ok: captured && !invokeError,
        toolName,
        captured,
        invokeError,
        schema: afterEntry
          ? {
              properties: afterEntry.properties,
              capturedAt: afterEntry.capturedAt,
              source: afterEntry.source,
            }
          : null,
      };
      logger.info({ toolName, captured, invokeError }, '[probe-tool-output] completed');
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },

    'register-agent': async (args, extra) => {
      const { username, roles: explicitRoles, testMode } = args as { username?: string; roles?: string[]; testMode?: boolean };
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;
      const conn = getOrCreateConnection(cid);

      // Mark test sessions — events will NOT be persisted for these sessions
      if (testMode) {
        const run = ensureRun(cid, { isTest: true });
        addMember(run, cid);
        conn.runId = run.id;
        logger.info({ cid }, '[register-agent] Test mode enabled — events will not be persisted');
      }

      // Two ways to bind roles to the connection:
      //   1. Explicit `roles` array — used by test harnesses (the workbench Test
      //      panel) which have no real users and push the model's role name
      //      directly. Bind it without a roles.json lookup. The role dropdown /
      //      auto-role switch relies on this; without it conn.roles stays empty
      //      and list-todos/claim-todo reject every todo ("Not registered").
      //   2. `username` — production clients: look up the user's roles from
      //      data/roles.json.
      let roles: string[] = [];
      if (Array.isArray(explicitRoles) && explicitRoles.length > 0) {
        roles = explicitRoles.filter((r): r is string => typeof r === 'string' && r.length > 0);
      } else if (username) {
        try {
          const allRoles = await jsonData.read('roles') as Array<{ username: string; roles: string[] }>;
          const entry = allRoles.find(r => r.username?.toLowerCase() === username.toLowerCase());
          if (entry) {
            roles = entry.roles;
          }
        } catch (err: any) {
          logger.warn({ username, error: err.message }, '[register-agent] Failed to read roles data');
        }
      }

      // Identify the connection: prefer the supplied username; for role-only
      // test registrations fall back to the first role, then the connection id.
      conn.username = username ?? roles[0] ?? cid;
      conn.roles = roles;

      logger.info({ cid, username: conn.username, roles, testMode: !!testMode }, '[register-agent] Agent registered');
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, username: conn.username, roles, testMode: !!testMode }, null, 2) }]
      };
    },

    'register-skills': async (args, extra) => {
      const { sessionId: regSessionId, skills } = args as {
        sessionId: string;
        skills: Array<{ id?: string; name: string; markdown: string; sliceData?: any; hidden?: boolean }>;
      };
      if (!regSessionId || !Array.isArray(skills)) {
        throw new Error('register-skills requires sessionId and skills array');
      }
      // Replace the session's skill maps wholesale — the workbench treats each
      // register-skills call as authoritative for the current model. Merging
      // into the prior map (`sessionSkills.get(...) ?? new Map()`) was what
      // caused stale skills from prior rebuilds to keep firing alongside the
      // new ones: a Rebuild that renames a slice (e.g.
      // `general-channel-id-extracted` → `general-channel-found`) left the
      // old name in the map, both subscribed to the same upstream event, and
      // both fired — leading to slice-tool-failed / unexpected_last_event
      // aborts that the new model alone would have completed.
      //
      // Replacement is safe because the workbench's `pushSkills` always sends
      // the FULL slice set for the current outcome model. If we ever support
      // additive cross-model registrations, callers will need a new
      // `merge: true` flag — at that point document the contract here.
      const skillMap = new Map();
      const skillByIdMap = new Map();
      for (const skill of skills) {
        const { name: sName, skill_id: sSkillId, description, body } = parseSkillFrontmatter(skill.markdown);
        // Extract triggers_on_event and publishes_event from frontmatter for routing
        const triggersMatch = skill.markdown.match(/^triggers_on_event:\s*"?([^"\n]+)"?/m);
        const publishesMatch = skill.markdown.match(/^publishes_event:\s*"?([^"\n]+)"?/m);
        const triggersOn = triggersMatch?.[1]?.trim() ?? '';
        const publishes = publishesMatch?.[1]?.trim() ?? '';
        // Canonical identifier mirrors the disk path (rawToolName at line ~273):
        // skill_id wins over name. This is required because slice names can
        // collide across workflows (e.g. two activities with a "review-input"
        // slice). skill_id encodes `<workflowId>-<sliceKebab>` so the session
        // registry key, the exposed MCP tool name, and the sliceId the LLM
        // sends to complete-slice all converge on one unambiguous value.
        const finalName = sSkillId || sName || skill.name;
        // `id` is the canvas-minted UUID — the new canonical routing key
        // (see TodoRecord.sliceId and the workbench D-loop). Older workbench
        // builds and external callers may omit it; fall back to the kebab
        // tool name so legacy paths still work.
        const sliceId = skill.id || finalName;
        if (finalName) {
          const entry = { id: sliceId, name: finalName, description, body, triggersOn, triggersOnSet: parseTriggers(triggersOn), publishes, sliceData: skill.sliceData, hidden: skill.hidden ?? false };
          skillMap.set(finalName, entry);
          skillByIdMap.set(sliceId, entry);
          logger.info({ sessionId: regSessionId, sliceId, skillName: finalName, hasSliceData: !!skill.sliceData, hidden: skill.hidden ?? false, triggersOn, publishes }, '[register-skills] Registered session skill');
        }
      }
      // (#73) One WorkflowRun holds the skill maps ONCE. The workbench's
      // register-skills sessionId (regSessionId) and the MCP transport session
      // (cid2) commonly differ; aliasing both to the same run replaces the old
      // store-under-two-keys (whose second key was never GC'd). Reuse the run the
      // transport connection already belongs to so register-skills after
      // register-agent(testMode) keeps the isTest flag.
      const cid2 = extra.sessionId ?? DEFAULT_SESSION_ID;
      const run = getRun(cid2) ?? getRun(regSessionId) ?? ensureRun(regSessionId);
      addAlias(run, regSessionId);
      addAlias(run, cid2);
      addMember(run, cid2);
      const conn2 = connectionPool.get(cid2);
      if (conn2) conn2.runId = run.id;
      run.skills = skillMap;
      run.skillsById = skillByIdMap;

      // Build a fresh event-schema index from the FULL post-merge skill map.
      // Rebuilding (rather than mutating) drops events from removed slices,
      // matching the workbench's "re-push on model change" model.
      const sliceBundle: any[] = [];
      for (const v of skillMap.values()) {
        if (v.sliceData) sliceBundle.push(v.sliceData);
      }
      const eventSchemaIndex = buildEventSchemaIndex(sliceBundle);
      run.eventSchemaIndex = eventSchemaIndex;

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
      // Lock this connection into session-isolated mode: tools/list will hide
      // disk slice tools (which may belong to a stale export of a previous
      // workflow with the same slice kebab name) so the LLM only sees this
      // session's canonical slice tools.
      connForReg.sessionIsolated = true;
      if (!connForReg.activeWorkflow) {
        for (const sk of skills) {
          const activityName =
            sk.sliceData?.outcomes?.[0]?.activity?.name
            ?? sk.sliceData?.command?.outcomes?.[0]?.activity?.name;
          if (activityName) { connForReg.activeWorkflow = activityName; break; }
        }
      }

      // Build this run's workflow topology from the inline model the workbench
      // just pushed, so TodoProcessor creates interface/view todos against the
      // model UNDER TEST — never the disk export (which may be stale or absent
      // for unpublished edits). Same builder the disk path uses, so the two
      // can't diverge. Rebuilt wholesale on every register-skills, mirroring the
      // skill-map replacement above. externalOutcomes/outcomeLinks aren't part
      // of the per-slice register-skills payload, so inline external-event
      // triggers are empty here (a separate, canvas-only feature track).
      run.inlineWorkflow = buildWorkflowDefinition(
        connForReg.activeWorkflow ?? regSessionId,
        { slices: sliceBundle } as any,
      );

      const registered = [...skillMap.keys()];
      logger.info({ sessionId: regSessionId, cid: cid2, activeWorkflow: connForReg.activeWorkflow, count: registered.length }, '[register-skills] Session skills registered');
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, registered, factWarnings }, null, 2) }]
      };
    },

    'start-workflow': async (_args, extra) => {
      // Mint a fresh workflow-instance id (correlationId) for a NEW task and
      // bind the connection to it (workflow-instance-isolation RFC D7). The
      // server is the SOLE minter; the client calls this when starting a new
      // task and echoes the returned correlationId on subsequent complete-slice
      // / log-event-to-bus calls so a second task on the same connection stays
      // isolated. Never derived from the transport cid. Emits no business event.
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;
      const conn = getOrCreateConnection(cid);
      const correlationId = crypto.randomUUID();
      conn.activeCorrelationId = correlationId;
      conn.queue = [];
      const run = attachSession(cid, correlationId);
      conn.runId = run.id;
      logger.info({ cid, correlationId }, '[start-workflow] Minted fresh workflow instance');
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, correlationId }, null, 2) }],
      };
    },

    'log-event-to-bus': async (args, extra) => {
      const { type, source: rawSource = 'llm', payload = {} } = args as { type: string; source?: string; payload?: Record<string, any> };
      // The client supplies the workflow-instance id as `correlationId`
      // (workflow-instance-isolation RFC D7 — obtained from `start-workflow`).
      // Legacy clients still send `sessionId`; accept it as a transitional
      // alias. This is a CLIENT-tracked instance id, never the transport cid.
      const providedCorrelationId = (args.correlationId ?? args.sessionId) as string | undefined;
      const normalizedType = toKebabCase(type);

      // Always ensure the connection exists so the event router can find it when
      // automated slices publish events — even when no explicit sessionId is provided.
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;
      const conn = getOrCreateConnection(cid);

      // Entry-point interface slices: mirror the action-slice mint in
      // complete-slice. Every invocation of an entry-point slice starts a
      // NEW workflow run by definition — the user is kicking off a fresh
      // execution of the activity. The LLM driving mmc-workflow's disk path
      // typically hallucinates a stable sessionId from the workflow name
      // (e.g. `discount-order-session`) and the connection's
      // `activeCorrelationId` from any prior run is still bound, so
      // gating the mint on "no provided id" or "no active session" is
      // insufficient — both signals miss the second-and-later runs and the
      // event lands in a session that already holds the previous run's join
      // events. Always mint fresh when the event is the published outcome
      // of an entry-point interface slice; rebind the connection too so the
      // cascade lands under the new id.
      let mintedFreshForEntryPoint = false;
      const entryWorkflowDefs = routingDeps.getWorkflowDefs() as Map<string, WorkflowDefinition> | null;
      if (entryWorkflowDefs) {
        const inferredSliceName = rawSource.includes('/')
          ? rawSource.split('/').slice(1).join('/')
          : rawSource;
        for (const wf of entryWorkflowDefs.values()) {
          const matched = wf.slices.find(s =>
            s.isInterface
            && s.givenEventGroups.length === 0
            && s.name === inferredSliceName,
          );
          if (matched && matched.outcomeEventTypes.some(o => toKebabCase(o) === normalizedType)) {
            mintedFreshForEntryPoint = true;
            logger.info(
              {
                cid,
                hallucinatedCorrelationId: providedCorrelationId,
                priorActiveCorrelationId: conn.activeCorrelationId,
                sliceName: matched.name,
                workflow: wf.name,
              },
              '[log-event-to-bus] Entry-point interface slice — minting fresh correlationId to prevent stale event bleed',
            );
            break;
          }
        }
      }
      // Birth rule (workflow-instance-isolation RFC D2 + D7): an EXPLICIT
      // client-supplied correlationId always wins — a D7 client already started
      // the instance via `start-workflow`, so don't re-mint over it. Only when no
      // id is supplied does the entry-point auto-mint fire (the disk/Claude-
      // Desktop path, which can't call start-workflow and hallucinates ids).
      // NEVER falls back to the transport cid — a missing id mints fresh.
      const correlationId = providedCorrelationId
        ?? (mintedFreshForEntryPoint ? crypto.randomUUID() : (conn.activeCorrelationId ?? crypto.randomUUID()));

      // Prefix source with the connection's known workflow so the dispatch filter
      // can scope automated slice fan-out to the correct workflow.
      const source = (conn.activeWorkflow && !rawSource.includes('/'))
        ? `${conn.activeWorkflow}/${rawSource}`
        : rawSource;
      if (conn.activeCorrelationId !== correlationId) {
        const isExplicitSwitch = !!providedCorrelationId && conn.activeCorrelationId != null;
        conn.activeCorrelationId = correlationId;
        if (isExplicitSwitch) conn.queue = []; // only flush stale events on a real instance switch
        const run = attachSession(cid, correlationId);
        conn.runId = run.id;
        logger.info({ cid, correlationId, minted: !providedCorrelationId }, '[log-event-to-bus] New workflow instance bound to connection');
      }

      logger.info({ eventType: normalizedType, source, correlationId, cid }, '[log-event-to-bus] Publishing event');
      await eventBus.publish({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, type: normalizedType, source, correlationId, payload, timestamp: new Date() });
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, eventType: normalizedType, source, correlationId }, null, 2) }]
      };
    },

    'get-next-event': async (_args, extra) => {
      // Cap below the workbench's Netlify Function timeout (lambda-local: 30s)
      // so the proxy round-trip never times out before we do. Frontend
      // re-polls on null, so a shorter wait has no functional effect.
      const TIMEOUT_MS = 25000;
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;
      const conn = getOrCreateConnection(cid);

      // If there's already a queued event, return it immediately.
      if (conn.queue.length > 0) {
        const event = conn.queue.shift()!;
        logger.info({ cid, eventType: event.type, correlationId: conn.activeCorrelationId }, '[get-next-event] Returning queued event');
        // #77 Increment B: translate factId payload keys → names for the client.
        return { content: [{ type: "text", text: JSON.stringify({ event: eventForDisplay(event, routingDeps.getWorkflowDefs()) }, null, 2) }] };
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
        logger.info({ cid, eventType: event.type, correlationId: conn.activeCorrelationId }, '[get-next-event] Returning pushed event');
      } else {
        logger.info({ cid, correlationId: conn.activeCorrelationId }, '[get-next-event] Timeout — returning null event');
      }
      // #77 Increment B: translate factId payload keys → names for the client.
      const displayEvent = event ? eventForDisplay(event, routingDeps.getWorkflowDefs()) : null;
      return { content: [{ type: "text", text: JSON.stringify({ event: displayEvent }, null, 2) }] };
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

      // A test session is a single omniscient tester impersonating every role in
      // turn (the workbench Test panel's auto-role switch narrows the connection
      // to one role at a time). Role-filtering it would hide todos owned by a
      // role the connection isn't *currently* on — e.g. an auto-approved
      // application's `show-credit-decision` View (role loan-officer) while the
      // connection is on `system` from the automation cascade — which is exactly
      // why the View was never dispatched. So for test sessions, ignore the role
      // filter and instead scope to the connection's bound workflow session so
      // todos from other concurrent test runs don't leak in. Production keeps the
      // role filter (a real underwriter must not see a claims-processor's todos).
      const isTest = getRun(cid)?.isTest ?? false;
      const wsid = conn.activeCorrelationId;
      const todos = testAwareTodoStore.findByStatus(requested).filter(t =>
        isTest
          ? (!wsid || t.correlationId === wsid)
          : (t.role === '' || conn.roles.includes(t.role))
      );

      // Always include todos claimed by the current user, regardless of
      // the requested status filter. This ensures a reconnecting client
      // can resume work that was in progress before the connection dropped.
      if (requested !== 'claimed' && conn.username) {
        const claimed = testAwareTodoStore.findByStatus('claimed').filter(t =>
          t.claimedBy === conn.username && !todos.some(existing => existing.id === t.id)
        );
        todos.push(...claimed);
      }

      // Enrich each todo with the canvas `sliceId` so the workbench Test panel's
      // D-loop can route by identity (`todo.sliceId === canvas item id`). Session
      // skills are registered with the canvas-minted UUID as their `id`, keyed by
      // kebab name; the todo's `sliceName` is the same kebab name. The TodoRecord
      // itself has no sliceId (todos are created by the disk-based TodoProcessor,
      // which doesn't know canvas identity), so without this the D-loop never
      // matches a slice and falls back to canvas linear scroll-next — the
      // loose-routing bug that skipped `show-credit-decision` on an auto-approve.
      const skillMap = (getRun(cid) ?? (wsid ? getRun(wsid) : undefined))?.skills;
      // Match the disk todo's bare `sliceName` (e.g. `show-credit-decision`) to a
      // session skill. The skill registry is keyed by the canonical identifier
      // `skill_id` = `activity-<workflowId>-<sliceKebab>` (see register-skills),
      // so an exact/kebab-equality match against the bare name misses; bridge via
      // a boundary suffix (`…-show-credit-decision`). entry.id is the canvas UUID
      // the D-loop matches against canvas item ids.
      const matchSkill = (sliceName: string): { id?: string } | undefined => {
        if (!skillMap) return undefined;
        const direct = skillMap.get(sliceName);
        if (direct) return direct;
        const target = toKebabCase(sliceName);
        for (const e of skillMap.values()) {
          const en = toKebabCase(e.name);
          if (en === target || en.endsWith(`-${target}`)) return e;
        }
        return undefined;
      };
      // Map each slice name → its command name across all workflow defs, so the
      // client can label a todo by its command (the user-facing task name)
      // rather than the internal slice name.
      const commandBySlice = new Map<string, string>();
      for (const wf of (routingDeps.getWorkflowDefs()?.values() ?? [])) {
        for (const s of wf.slices) {
          if (s.command) commandBySlice.set(s.name, s.command);
        }
      }

      const enrichedTodos = todos.map(t => {
        const command = commandBySlice.get(t.sliceName);
        const entry = skillMap ? matchSkill(t.sliceName) : undefined;
        return {
          ...t,
          ...(command ? { command } : {}),
          ...(entry?.id ? { sliceId: entry.id } : {}),
        };
      });

      logger.debug(
        { cid, requested, isTest, wsid, roles: conn.roles, count: enrichedTodos.length, todos: enrichedTodos.map(t => ({ name: t.sliceName, sliceId: (t as any).sliceId })) },
        '[list-todos] Returning todos',
      );
      return {
        content: [{ type: "text", text: JSON.stringify({ todos: enrichedTodos }, null, 2) }]
      };
    },

    'get-session-events': async (args, extra) => {
      // The client passes the workflow-instance id to read as `correlationId`
      // (legacy clients send `sessionId`; accept it transitionally).
      const correlationId = (args?.correlationId ?? args?.sessionId) as string | undefined;
      if (!correlationId) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: 'correlationId is required' }, null, 2) }]
        };
      }
      // Refuse cross-instance reads when the connection is bound to a specific
      // instance. An unbound connection (no active instance yet) is allowed any
      // correlationId — that's the admin/dev path.
      const cid = extra?.sessionId ?? DEFAULT_SESSION_ID;
      const activeCorrelationId = connectionPool.get(cid)?.activeCorrelationId;
      // Refuse only genuine cross-RUN reads. The client commonly passes its
      // registration id, which is an ALIAS of the same WorkflowRun (#73) as the
      // connection's bound instance — allow those, resolving both through the run
      // aggregate. (A strict raw-id match would refuse the test panel's own
      // timeline reads, since registration id ≠ minted correlationId.)
      const sameRun = !!(getRun(correlationId) && getRun(activeCorrelationId) && getRun(correlationId) === getRun(activeCorrelationId));
      if (activeCorrelationId && correlationId !== activeCorrelationId && !sameRun) {
        logger.warn({ cid, requested: correlationId, active: activeCorrelationId }, '[get-session-events] Cross-instance read refused');
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Cross-instance access denied. Active workflow instance is ${activeCorrelationId}.` }, null, 2) }]
        };
      }
      // Events are persisted under the correlationId, which can differ from the
      // registration alias the client passed. Read the bound instance when
      // present so an aliased caller still gets the full log.
      const readCorrelationId = activeCorrelationId ?? correlationId;
      try {
        const { events, total } = await testAwareEventStore.getPaged(1000, 0, readCorrelationId);
        // getPaged returns newest-first for paginated log views; timelines want oldest-first.
        // #77 Increment B: translate factId payload keys → names for the timeline UI.
        const wfDefs = routingDeps.getWorkflowDefs();
        const ordered = events.slice().reverse().map(e => eventForDisplay(e, wfDefs));
        return {
          content: [{ type: "text", text: JSON.stringify({ events: ordered, total }, null, 2) }]
        };
      } catch (err: any) {
        logger.error({ error: err.message, correlationId }, '[get-session-events] Error');
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }, null, 2) }]
        };
      }
    },

    'events-dump': async (args, extra) => {
      // Refuse cross-instance reads when the connection is bound to an instance.
      // Same scoping rule as get-session-events.
      const cid = extra?.sessionId ?? DEFAULT_SESSION_ID;
      const activeCorrelationId = connectionPool.get(cid)?.activeCorrelationId;
      const requestedCorrelationId = (args?.correlationId ?? args?.sessionId) as string | undefined;
      if (activeCorrelationId) {
        if (requestedCorrelationId && requestedCorrelationId !== activeCorrelationId) {
          logger.warn({ cid, requested: requestedCorrelationId, active: activeCorrelationId }, '[events-dump] Cross-instance dump refused');
          return {
            content: [{ type: "text", text: JSON.stringify({ error: `Cross-instance access denied. Active workflow instance is ${activeCorrelationId}.` }, null, 2) }]
          };
        }
        // Active instance bound but caller omitted it — implicitly scope to active.
        args = { ...(args ?? {}), correlationId: activeCorrelationId };
      }
      const result = await tools['events-dump'](args ?? {}, {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
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

      // Check role match before claiming.
      const existing = testAwareTodoStore.getById(todoId);
      if (!existing) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: 'Todo not found' }, null, 2) }]
        };
      }
      // Test sessions are a single omniscient tester impersonating every role,
      // so they may claim any todo (mirrors the list-todos test-session bypass).
      // Production enforces the role gate: a real agent can only claim todos for
      // a role it holds.
      const isTest = getRun(cid)?.isTest ?? false;
      if (!isTest && existing.role !== '' && !conn.roles.includes(existing.role)) {
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
        if (existing.correlationId && conn.activeCorrelationId !== existing.correlationId) {
          conn.activeCorrelationId = existing.correlationId;
          conn.queue = [];
          const run = attachSession(cid, existing.correlationId);
          conn.runId = run.id;
          logger.info({ cid, correlationId: existing.correlationId }, '[claim-todo] Resumed claimed todo — rejoined workflow session');
        }
        logger.info({ cid, todoId, sliceName: existing.sliceName, claimedBy }, '[claim-todo] Todo resumed by same user');
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            todo: {
              id: existing.id,
              sliceName: existing.sliceName,
              role: existing.role,
              correlationId: existing.correlationId,
              triggerEventType: existing.triggerEventType,
              payload: existing.payload,
              pattern: existing.pattern ?? 'interface',
            },
          }, null, 2) }]
        };
      }

      const todo = testAwareTodoStore.claim(todoId, claimedBy);
      if (!todo) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: 'Todo already claimed or completed' }, null, 2) }]
        };
      }

      // Join the workflow session — same as log-event-to-bus does
      if (todo.correlationId && conn.activeCorrelationId !== todo.correlationId) {
        conn.activeCorrelationId = todo.correlationId;
        conn.queue = [];
        const run = attachSession(cid, todo.correlationId);
        conn.runId = run.id;
        logger.info({ cid, correlationId: todo.correlationId }, '[claim-todo] Joined workflow session');
      }

      logger.info({ cid, todoId, sliceName: todo.sliceName, role: todo.role, claimedBy, correlationId: todo.correlationId }, '[claim-todo] Todo claimed');
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: true,
          todo: {
            id: todo.id,
            sliceName: todo.sliceName,
            role: todo.role,
            correlationId: todo.correlationId,
            triggerEventType: todo.triggerEventType,
            payload: todo.payload,
            pattern: todo.pattern ?? 'interface',
          }
        }, null, 2) }]
      };
    },

    'resolve-todo': async (args, extra) => {
      const { todoId } = args as { todoId: string };
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;

      const existing = testAwareTodoStore.getById(todoId);
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

      const todo = testAwareTodoStore.complete(todoId);
      logger.info({ cid, todoId, sliceName: existing.sliceName }, '[resolve-todo] Todo resolved');
      // Resolving a todo closes an interface/view branch — re-check quiescence
      // so a workflow whose last owed branch was this todo can now complete.
      scheduleQuiescenceCheck(existing.correlationId);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, todo }, null, 2) }]
      };
    },

    'unclaim-todo': async (args, extra) => {
      const { todoId } = args as { todoId: string };
      const cid = extra.sessionId ?? DEFAULT_SESSION_ID;

      const existing = testAwareTodoStore.getById(todoId);
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
      testAwareTodoStore.upsert({ ...existing, status: 'pending', claimedBy: undefined, claimedAt: undefined });
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
    // Sessions are server-assigned: the tool schema no longer exposes
    // `sessionId` to the caller, so `providedSessionId` is normally
    // undefined and the LLM cannot fabricate one. The action-slice mint
    // below kicks in for session-scoped entry-point interface slices;
    // every other call falls through to `conn.activeCorrelationId`
    // (set by an earlier call in the same workflow) or a fresh UUID.
    //
    // Keep this aligned with the automated-slice dispatcher above.
    // ───────────────────────────────────────────────────────────────────
    'complete-slice': async (args, extra) => {
      const { sliceId, facts: collectedFacts } = args as {
        sliceId: string;
        facts: Record<string, any>;
      };
      // Client-supplied workflow-instance id (RFC D7); legacy clients send
      // `sessionId`. A client-tracked instance id, never the transport cid.
      const providedCorrelationId = (args.correlationId ?? args.sessionId) as string | undefined;
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

      // View slices have no Command/Outcome and are marked seen the moment they
      // render (executeViewSlice auto-resolves the view todo — "view rendered =
      // branch closed"). A form's Close button still posts complete-slice as the
      // user's acknowledgement, but there is nothing to evaluate: running
      // evaluateSlice on a view matches no scenario, emits `slice-misconfigured`,
      // and that re-surfaces the view tool — re-rendering the form. Treat
      // complete-slice on a view as a benign no-op acknowledgement so the client
      // advances instead of looping.
      if (getSlicePattern(resolved.sliceData) === 'view') {
        logger.info({ cid, sliceId }, '[complete-slice] View acknowledged (already seen at render) — skipping evaluation');
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            sliceId,
            pattern: 'view',
            message: 'View acknowledged.',
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
      // correlationId so facts from a prior run don't bleed into a new instance
      // (workflow-instance-isolation RFC D2). With the schema change
      // (correlationId not exposed to the LLM), `providedCorrelationId` is
      // normally undefined here; we keep the explicit override to defend against
      // legacy callers that might still pass one. Mirrors the entry-point mint
      // in `log-event-to-bus`. NEVER falls back to the transport cid.
      const isSessionActionSlice = resolved.source === 'session'
        && (resolved.skill?.triggersOnSet?.size ?? 0) === 0
        && getSlicePattern(resolved.sliceData) === 'interface';
      // D7: an explicit client correlationId (from start-workflow) wins over the
      // action-slice auto-mint, so the client and server agree on the instance id.
      const correlationId = providedCorrelationId
        ?? (isSessionActionSlice ? crypto.randomUUID() : (conn.activeCorrelationId ?? crypto.randomUUID()));
      if (isSessionActionSlice) {
        logger.info(
          { cid, sliceId, correlationId, hallucinatedCorrelationId: providedCorrelationId },
          '[complete-slice] Action slice — minting fresh correlationId to prevent stale fact bleed'
        );
      }

      // Instance facts are factId-keyed on the wire (#77); translate to the
      // slice's NAME-keyed contract so they merge with the LLM-collected facts
      // (kebab names) and the name-based evaluator/payload builder resolve them.
      const sessionFacts = ingestScopedFacts(
        testAwareEventStore.getCorrelationFactValues(correlationId),
        resolved.factIdToName,
      );
      const mergedFacts = { ...sessionFacts, ...collectedFacts };

      const connectorContext = {
        eventBus,
        dataSources: { json: jsonData, sqlite: sqliteData },
        tools,
        correlationId,
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

      return await completeSliceFinalize(evalResult, correlationId, cid, conn);
    },

    'handle-latest-event': async (args: any) => {
      // Server-driven dispatch: routingDeps exposes the live trigger set,
      // workflow definitions, and automated slice map (declared inside main()
      // and mutated by resync). Routing logic lives in handleLatestEvent.ts
      // so it can be unit-tested without an MCP server.
      return dispatchLatestEvent(args?.event ?? {}, routingDeps);
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
  return inlineToolHandlers;
}
