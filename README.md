# mmc-mcp — Model My Context MCP Server

[![Tests](https://github.com/ebd-connect/mmc-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ebd-connect/mmc-mcp/actions/workflows/ci.yml)

**`mmc-mcp` is the open-source runtime that lets AI agents execute structured business processes without going off-script.** It exposes process steps to AI agents (Claude, Gemini, GPT, …) as [Model Context Protocol](https://modelcontextprotocol.io) tools, gates each step on a sequenced event bus so the agent can't skip or reorder work, and routes external calls through typed connectors.

Think of it as the **execution half** of the Model My Context platform. The other half — authoring those processes — happens in [MMC Workbench](#mmc-workbench-the-authoring-half).

![mmc-mcp architecture](public/mmc-mcp-flow.png)

---

## Table of Contents

- [Install in Claude Desktop](#install-in-claude-desktop)
- [How it works](#how-it-works)
- [MMC Workbench: the authoring half](#mmc-workbench-the-authoring-half)
- [Quick start (build from source)](#quick-start-build-from-source)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

---

## Install in Claude Desktop

The easiest way to run `mmc-mcp` is as a Claude Desktop extension. No terminal, no Bun, no Node.js install — Claude Desktop's bundled runtime executes the server.

1. **Download `mmc-mcp.mcpb`** from the [latest release](https://github.com/modelmycontext/mmc-mcp/releases).
2. **Open Claude Desktop → Settings → Extensions** and drag the `.mcpb` file into the panel.
3. When prompted, fill in:
   - **OpenRouter API key** — [get one here](https://openrouter.ai/keys)
   - **OpenRouter model** — leave the default (`google/gemini-2.5-flash`) unless you have a reason
   - **GitHub Personal Access Token** — needs read access to the GitHub repo holding your `SKILL.md` files ([create a fine-grained PAT](https://github.com/settings/personal-access-tokens/new))
4. **Toggle the extension on.** That's it.

To verify, ask Claude *"What MCP tools do you have from mmc-mcp?"* — it should list `log-event-to-bus`, `get-next-event`, `handle-latest-event`, plus any registered connectors and interface slices.

> Want to see the full list of prompted fields, defaults, and what each one does? They're declared in [`manifest.json`](manifest.json) under `user_config`.

If you want to build the bundle yourself or develop on the server, see [Quick start (build from source)](#quick-start-build-from-source) below.

## How it works

A business process is modelled as an ordered list of **slices** (steps). Each slice is one `SKILL.md` file with YAML frontmatter and a Markdown body. Slices come in two flavours:

- **Interface slices** — executed by an AI agent. The agent polls `get-next-event`, receives exactly the slice it should run next, collects user input, and calls `complete-slice` to advance the process.
- **Automated slices** — executed server-side by `createAutomatedSliceHandler`. They fire when their declared trigger event arrives on the bus, run any query/command jobs, evaluate scenarios, and publish outcome events.

Process state lives entirely in the **event bus**. Every step's outputs are published as events; the next step only fires when its `given` events are present. This is what makes the agent unable to skip work — there is literally no "next step" until the event sequence allows it.

External services (Slack, Xero, GitHub, Jira, …) are reached through **typed connectors** — either built-in (`json-read`, `json-write`) or proxied via `ExternalMcpManager` to child MCP servers.

## MMC Workbench: the authoring half

`mmc-mcp` is the executor. The authoring story lives in **[MMC Workbench](https://modelmycontext.com)**, a separate human-in-the-loop governance tool that:

1. **Imports messy SOPs** (rough text, transcripts, existing process docs) and turns them into structured outcome models.
2. **Models the events** of a process visually so non-developers can reason about flow, conditions, and dependencies.
3. **Generates `SKILL.md` files** from the modelled outcome model. These are the files this server consumes.
4. **Publishes to GitHub** as the single source of truth — `mmc-mcp` syncs from there at startup.
5. **Pushes test sessions** directly to a running `mmc-mcp` instance via the `register-skills` MCP tool, letting authors validate a process end-to-end before publishing.

Without the workbench the server has nothing to dispatch — the two halves are designed together. If you're standing up `mmc-mcp` alone for development you can skip the workbench by hand-writing `SKILL.md` files, but for any real workflow the workbench is the upstream.

The licensing split mirrors this:

| Component | License | Where |
|---|---|---|
| **mmc-mcp** (this repo) | GPL-3.0-or-later AND Apache-2.0 | `LICENSE` + `LICENSE-APACHE` |
| `SKILL.md` format | Open standard | This repo's parsers + workbench's generator both consume the same shape |
| **MMC Workbench** | Proprietary / SaaS | https://modelmycontext.com |

## Quick start (build from source)

This path is for developers who want to build the `.mcpb` bundle, run the server outside Claude Desktop, or hack on `mmc-mcp` itself.

### Prerequisites

- **[Bun](https://bun.sh) 1.x** — production runtime and dev runtime.
- **[pnpm](https://pnpm.io) 10+** — package manager (used for `pnpm test`, `pnpm build`).
- **Persistent storage access** for two directories:
  - `data/` — the event log (`events.db`), workflow data (`data.db`), and any JSON collections referenced by slices.
  - `skills/` — the `SKILL.md` files. Synced from GitHub at startup if configured.

> Node.js is **not** required for runtime. Vitest tests run under Bun via `bun x vitest run` (see [Testing](#testing) for the SQLite shim that makes this work).

### Install and run

```bash
git clone https://github.com/modelmycontext/mmc-mcp.git
cd mmc-mcp
pnpm install
cp .env.example .env
# edit .env: set OPENROUTER_API_KEY and GITHUB_PERSONAL_ACCESS_TOKEN
# edit config/config.json: replace `your-github-org` / `your-skills-repo` with the
#   GitHub repo that holds your `SKILL.md` files (or set `mmcGithubServer: []`
#   if you'll author them locally and want to skip GitHub sync entirely)
pnpm start
```

### Pointing at your skills source

`config/config.json` controls where `mmc-mcp` looks for `SKILL.md` files at startup:

```json
"mmcGithubServer": [
  {
    "owner": "your-github-org",
    "repo": "your-skills-repo",
    "path": "models",
    "branch": "main"
  }
]
```

- **`owner` / `repo`** — your GitHub org and repository. The PAT in `.env` (`GITHUB_PERSONAL_ACCESS_TOKEN`) needs read access to it.
- **`path`** — directory inside the repo containing the outcome models. Hardcoded to `models` in the workbench's publish flow; leave as-is.
- **`branch`** — which branch to pull from.

If you don't have a skills repo yet, set `mmcGithubServer: []` and drop hand-written `SKILL.md` files into `skills/` directly. The server runs fine with no GitHub sync — it just expects whatever it dispatches to be present locally.

### Build the .mcpb bundle

To produce an installable `mmc-mcp.mcpb` from your local source:

```bash
pnpm build:mcpb     # esbuild → dist-mcpb/server/index.js (fully self-contained)
pnpm pack:mcpb      # @anthropic-ai/mcpb pack → dist-mcpb/mmc-mcp.mcpb
```

The resulting `dist-mcpb/mmc-mcp.mcpb` is ~256 KB, contains the bundled server + `manifest.json` + your edited `config/config.json`, and can be dragged into Claude Desktop's Extensions panel as described in [Install in Claude Desktop](#install-in-claude-desktop).

> Edit `config/config.json` *before* running `pnpm pack:mcpb` if you want a specific `mmcGithubServer` baked into the distributed bundle.

### Server transports

The server boots with two MCP transports active:

- **HTTP (StreamableHTTP)** on `http://localhost:3001/mcp` — for Claude Desktop, MCP Inspector, the workbench test panel, and any HTTP-MCP client.
- **stdio** — for direct CLI integration.

To force a fresh GitHub sync of `SKILL.md` files at startup: `pnpm start:force-sync`.

To skip GitHub sync entirely (e.g. if you've put `SKILL.md` files in `skills/` by hand): pass `--no-sync`.

## Configuration

Two files do all the configuration.

### `.env`

```bash
OPENROUTER_API_KEY=sk-or-v1-...           # used by the automated slice runner for rule + instruction evaluation
OPENROUTER_MODEL=google/gemini-2.5-flash  # the model the runner calls
GITHUB_PERSONAL_ACCESS_TOKEN=...          # used by the GitHub skill sync + (optionally) the GitHub external MCP
# Optional, for Slack-using processes:
SLACK_BOT_TOKEN=xoxb-...
SLACK_TEAM_ID=T...
```

### `config/config.json`

```json
{
  "skillsDir": "./skills",
  "mmcGithubServer": [
    {
      "owner": "your-org",
      "repo": "your-skills-repo",
      "path": "models",
      "branch": "main"
    }
  ],
  "externalServers": [
    {
      "name": "sqlite",
      "command": "bun",
      "args": ["x", "-y", "mcp-server-sqlite", "--db", "data/events.db"]
    },
    {
      "name": "github",
      "command": "bun",
      "args": ["x", "-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "{{GITHUB_PERSONAL_ACCESS_TOKEN}}" }
    }
  ]
}
```

| Key | Purpose |
|---|---|
| `skillsDir` | Where local `SKILL.md` files live (default `./skills`). |
| `mmcGithubServer` | Repos to sync skills from at startup. Requires `GITHUB_PERSONAL_ACCESS_TOKEN` in `.env`. |
| `externalServers` | Child MCP servers to spawn and merge into the tool list. Use `{{ENV_VAR}}` to inject secrets. |

## Architecture

The high-level diagram is at the top of this README. For the runtime details — event bus, slice dispatch, the unified path between production and workbench test sessions, the connector layer — see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

A short orientation:

- **`src/server/index.ts`** — bootstraps both transports, owns the EventBus subscriber that dispatches automated slices, hosts the inline tool dispatch table.
- **`src/services/automatedSliceRunner.ts`** — `createAutomatedSliceHandler` (production AND workbench test sessions both flow through this; see the path-unification doc block at the top of the file).
- **`src/services/sliceEvaluator.ts`** — `executeSliceQueries` + `evaluateSlice`, the deterministic scenario engine used by `complete-slice`.
- **`src/skill-engine/`** — `SKILL.md` and outcome-model JSON loading, with `extract*` helpers shared between disk and inline sources.
- **`src/connectors/`** — `Connector` interface, `ConnectorExecutor`, and `connectorOutputKeys.ts` (extracts a fact value from a connector's result).
- **`src/events/`** — pub/sub bus with sequenced events, plus SQLite/JSON/in-memory stores. `testAwareEventStore.ts` routes events for sessions marked `testMode: true` to the in-memory store so workbench test runs don't pollute production state.

## Testing

```bash
pnpm test          # runs the full vitest suite under Bun
pnpm test:watch    # vitest in watch mode
```

The test runner is **Vitest under Bun** (`bun x vitest run`). Production uses `bun:sqlite`; Vitest workers run as Node, so we alias `bun:sqlite` to a small `node:sqlite`-backed shim — see [`tests/_shims/bun-sqlite.ts`](tests/_shims/bun-sqlite.ts) and [`vitest.config.ts`](vitest.config.ts).

Performance regression suite (run after every build):

```bash
pnpm build && bun x vitest run tests/performance.test.ts
```

This exercises EventBus throughput, SqliteEventStore I/O, and BusinessRuleEvaluator with wall-clock thresholds.

## Project structure

```
src/                    GPL-3.0 — server runtime
├── server/             MCP server bootstrap, request dispatcher, ExternalMcpManager
├── services/           automatedSliceRunner, sliceEvaluator, todoProcessor, llm
├── skill-engine/       SKILL.md parsing, outcome-model loading, GitHub sync
├── connectors/         ConnectorExecutor + connectorOutputKeys (server-side glue)
├── events/             EventBus (pub/sub + sequence numbers), event stores
├── data-sources/       JsonDataSource (data/*.json), SqliteDataSource
└── utils/              logger, businessRuleEvaluator, factValueResolver, strings, logic
sdk/                    Apache-2.0 — public connector API (no @src/ imports allowed)
├── connectorTypes.ts   Connector / ConnectorContext / DataSources / McpTool
├── parsing.ts          parseJobInputs, parseKeyValueBlock, extractField
└── index.ts            Barrel export
connectors/             Apache-2.0 — built-in connectors (json-read, json-write, file-store, …)
tests/                  GPL-3.0 — vitest suite
docs/                   Apache-2.0 — ARCHITECTURE.md
config/                 config.json (per-deployment)
data/                   Local event log + JSON collections (gitignored)
skills/                 SKILL.md files (synced from GitHub or local)
public/                 README assets
```

## Contributing

Contributions welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for dev setup, commit conventions, the test-runner caveat, and how the workbench fits into the SKILL.md authoring loop.

If you're filing a bug, please include:

- The output of `pnpm start` (server boot log)
- The MCP tool call that failed (request + response)
- Whether the session was a test session (`testMode: true`) or production

Code of Conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

This repository is **dual-licensed by folder**, not as a whole — see [`LICENSING.md`](LICENSING.md) for the full breakdown.

The short version:

- **`src/` and `tests/`** — GPL-3.0-or-later (server runtime; copyleft).
- **`sdk/`, `connectors/`, `docs/`** — Apache-2.0 (the public connector SDK and built-in connector implementations; permissive).

The split lets third-party authors ship **proprietary connectors** that import from `@sdk/...` without inheriting GPL obligations from the server runtime. Forks of the server itself stay copyleft.

The `SKILL.md` format is an open standard — anyone can author or consume it.
