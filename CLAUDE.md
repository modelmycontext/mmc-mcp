# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm build              # Compile TypeScript via Vite to dist/
pnpm start              # Run the server under Node via tsx (HTTP on :3001 + stdio)
pnpm start:force-sync   # Run under tsx with --force-sync flag
pnpm dev                # tsx watch dev server (Node; hot-restart on change)
pnpm test               # Run Vitest under Node (vitest run)
pnpm test:watch         # Run Vitest in watch mode
pnpm debug              # Run under Node (tsx) with --inspect
pnpm debug:brk          # Run under Node (tsx) with --inspect-brk (pauses on start)
```

Run a single test file:
```bash
pnpm exec vitest run tests/events/eventBus.test.ts
```

> **Development and tests run under Node (via `tsx`), never Bun** — Bun's
> `--hot` model leaked grandchild processes on Windows. The deployed Fly image
> still runs Bun for now (`CMD ["bun", ...]`); a runtime-detecting shim
> (`src/shims/bun-sqlite.ts`) picks `bun:sqlite` under Bun and `node:sqlite`
> under Node, so the production code path is unchanged while local dev is
> Bun-free. The server listens via `@hono/node-server` under Node and via Bun's
> default-export serve under Bun.

Force GitHub skill resync at runtime:
```bash
curl -X POST http://localhost:3001/resync
```

## Environment

Required in `.env`:
- `OPENROUTER_API_KEY` — used by the automated slice runner to call LLMs
- `OPENROUTER_MODEL` — use to make api calls to llm's
- `GITHUB_PERSONAL_ACCESS_TOKEN` — used by the GitHub MCP external server

## Post-Build Verification

After every `pnpm build`, run the performance regression suite to catch degradation early:

```bash
pnpm build && pnpm exec vitest run tests/performance.test.ts
```

This exercises the three hot paths — EventBus throughput, SqliteEventStore I/O, and BusinessRuleEvaluator — with wall-clock thresholds. A failure means a change made something measurably slower.

If a performance test fails:
1. Identify which threshold was exceeded from the test output.
2. Check the diff for the likely cause (new allocations, missing indexes, dropped caching, extra I/O).
3. Fix the regression before merging — do **not** raise the threshold unless the slower behaviour is intentional and justified.

## Architecture

This is an **MCP server** that orchestrates AI-assisted business workflows through **outcome models** and **slices**.

### Dual Transport

The server runs two MCP transports simultaneously from `src/server/index.ts`:
- **HTTP** (Hono + `@hono/mcp` StreamableHTTP) on port 3001 at `/mcp`
- **stdio** for direct Claude Desktop / CLI integration

Both transports share the same `registerHandlers()` call and see the same tools.

### Skills and Slices

Skills are Markdown files in `skills/` with YAML frontmatter:
```
---
name: my-skill
description: What this skill does
triggers_on_event: SOME_EVENT_TYPE
compatibility: "Requires mmc-mcp tools: find-json-record, log-event-to-bus"
---
```

A **slice** is a skill `.md` file inside a subdirectory of `skills/`. Root-level `.md` files are standalone skills.

**Two slice types:**
- **Interface slices** — declared via `interface` property in the outcome model JSON. Exposed to the connected client AI agent. The agent polls `get-next-event` and dispatches these when triggered.
- **Automated slices** — no `interface` in the outcome model. Declared via `triggers_on_event` frontmatter. Run server-side by `AutomatedSliceRunner` via OpenRouter when their trigger event fires.

### ⚠️ Path unification — automated slice dispatch

**There are two execution contexts but ONE handler.** Production (disk-based) and workbench test sessions (in-memory) BOTH run through `createAutomatedSliceHandler` in [src/services/automatedSliceRunner.ts](src/services/automatedSliceRunner.ts). The handler consumes plain `SliceData = { sliceName, slice, factIdToName }`. Two resolvers build it:

- `resolveDiskSliceData(skillMdPath)` — production. Walks the activity directory, finds the matching slice in any outcome model JSON, builds a model-wide `factIdToName`.
- `resolveInlineSliceData(sliceData, name)` — workbench. Wraps sliceData pushed via `register-skills` and synthesises `factIdToName` from the slice's own facts.

**When making changes:**
- Modifying handler internals (scenario eval, query/command jobs, diagnostics, outcome publishing) affects **both paths** — verify with `tests/services/automatedSliceRunner.test.ts` AND a workbench smoke test.
- Path-specific behaviour belongs in the **dispatcher** (`src/server/index.ts` `eventBus.subscribe('*', ...)`), not in the handler. Branching on source type inside the handler re-introduces the divergence we just removed.
- Routing policy lives in the dispatcher: test sessions consult `sessionSkills` first and never fall through to disk; production uses `automatedSliceMap`. Test sessions also stay isolated by `testAwareEventStore` (no SQLite persistence) and `TodoProcessor` (no todos).

**Same pattern applies to `complete-slice`** in `src/server/index.ts` — the disk and session branches both flow through `executeSliceQueries` → `evaluateSlice` → `completeSliceFinalize`. Keep them aligned.

### Outcome Models

Each multi-slice workflow has a companion JSON file (e.g., `skills/process-customer-tiered-discount/process-customer-tiered-discount.json`) defining the full workflow: slices, scenarios, given/when/then conditions, and facts.

At startup, `src/skill-engine/interaction-slice-trigger-events.ts` scans all JSON outcome models to:
1. Identify interface slice names → filter tool list shown to client agent
2. Build trigger event → automated slice `.md` path map → register EventBus subscriptions

### Event Bus

`src/events/eventBus.ts` is a pub/sub system with sequence numbers. All events are persisted to SQLite (`data/events.db` via `SqliteEventStore`). The server-managed `sessionCursor` drives `get-next-event` long-polling (60s timeout, 2s poll interval).

### Tool Routing (CallToolRequest)

Priority order in `registerHandlers()`:
1. `log-event-to-bus` / `get-next-event` — handled inline
2. `SkillTools` (`find-json-record`, `json-write`) — dispatched via `SkillToolExecutor`
3. `get-github-methods` — lists registered external tools
4. External tools (registered from `ExternalMcpManager` → `config/config.json`)
5. Skill/slice `.md` files — resolved by name, content returned as text

### External MCP Servers

`config/config.json` registers child MCP servers (SQLite, GitHub). `ExternalMcpManager` connects them and merges their tools into the main tool map. GitHub token is injected via `{{GITHUB_PERSONAL_ACCESS_TOKEN}}` template syntax.

### Automated Slice Runner

`src/services/automatedSliceRunner.ts` — factory creates an `EventBus` subscriber per automated slice. On trigger:
1. Loads `handle-latest-event.md` + the slice's `.md` as system prompt
2. Calls OpenRouter with only tools listed in the slice's `compatibility` frontmatter
3. Runs agentic tool-call loop (max 15 iterations)
4. Applies scenario gating: only scenarios whose `given[]` events are present on the session bus are eligible

### Data Sources

- `JsonDataSource` — reads/writes JSON files in `data/` (users, members)
- `SqliteDataSource` — query interface to `data/data.db`
- `SqliteEventStore` — append-only event log in `data/events.db`

### Build

Vite bundles `src/server/index.ts` to `dist/server/index.js` as ES modules. Node built-ins, `hono`, `@modelcontextprotocol/sdk`, `pino`, `zod`, and `dotenv` are all externalized (not bundled).
