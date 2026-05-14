# Contributing to mmc-mcp

Thanks for your interest in contributing. This document covers how to set up the project, the conventions we follow, and how to make sure your change has the best chance of being merged quickly.

For licensing details (the GPL/Apache split between `src/` and `sdk/`), see [`LICENSING.md`](LICENSING.md). For the runtime architecture, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Setup

Follow the [Quick start in README.md](README.md#quick-start) to clone, install, configure `.env` and `config/config.json`, and run the server. Tests run under Bun via Vitest — see the [Test runner caveat](#test-runner-caveat) below for why.

## Dev commands

```bash
pnpm dev            # bun --hot src/server/index.ts (hot-reload dev server)
pnpm build          # vite build → dist/
pnpm test           # bun x vitest run
pnpm test:watch     # vitest in watch mode
```

After every `pnpm build`, run the performance regression suite to catch wall-clock regressions early:

```bash
pnpm build && bun x vitest run tests/performance.test.ts
```

## What to work on

- **Bug fixes** — file an issue first if it's non-trivial. Always include a reproduction.
- **Small refactors / tidying** — open a PR directly. Keep them focused.
- **New connectors** — read [`sdk/README.md`](sdk/README.md) for the authoring contract. The SDK is permissively-licensed so your connector can be too (Apache-2.0, MIT, even proprietary). Add yours to [`/connectors/`](connectors/) and register it in [`/connectors/index.ts`](connectors/index.ts).
- **New features** — open an issue to discuss the design first. Server changes especially: the event bus, slice runner, and dispatcher are deliberately small and hard to refactor under load.
- **Skill / outcome-model authoring** — `SKILL.md` files are typically authored in the [MMC Workbench](https://modelmycontext.com), not by hand-editing in this repo.

## Code conventions

- **TypeScript with `"strict": true`.** New code should pass `bun x tsc --noEmit` cleanly. There is a backlog of pre-existing strict-mode noise — don't add to it.
- **Prefer `unknown` over `any`** for parameters and return types where you don't control all callers.
- **Logger, not `console.*`** — use `logger` from `src/utils/logger.ts`. The only exception is one-off CLI scripts.
- **No emojis in code or commits** unless the user explicitly asked.
- **No new comments unless the WHY is non-obvious** — well-named identifiers and types should carry the intent. Reserve comments for hidden constraints, subtle invariants, workarounds, or surprising behaviour.
- **Don't add error handling for cases that can't happen.** Trust internal code; only validate at system boundaries (user input, external APIs).

## The SDK boundary

This is the one architectural rule we enforce in code review:

- Files in `sdk/` **MUST NOT** import from `@src/...`.
- Files in `connectors/` (root) **MUST NOT** import from `@src/...` — only from `@sdk/...` and Node/Bun built-ins.
- Files in `src/` may freely import from `@sdk/...`.

Violating this re-introduces the GPL contamination problem [`LICENSING.md`](LICENSING.md) explains. If you find yourself wanting to reach into `src/utils/X.ts` from a connector, the right move is usually to move `X.ts` into `sdk/`.

## Path unification rules (server)

The dispatcher in `src/server/index.ts` and the handler factory in `src/services/automatedSliceRunner.ts` are deliberately the **same path** for production disk-based dispatch and workbench test sessions. The two paths differ only in how `SliceData` is resolved (`resolveDiskSliceData` vs `resolveInlineSliceData`). The handler is path-agnostic.

If you need path-specific behaviour, do it in the dispatcher, not the handler. Re-introducing a forked code path will be flagged in review. The block comments at the top of those two files explain the rule and what stays divergent on purpose (routing policy, persistence, todo creation).

The same shape applies to the `complete-slice` tool — single resolver (`resolveSliceForCompletion`), single pipeline.

## Commit messages

Imperative subject line, ~70 characters. Explain the *why* in the body if it isn't obvious from the diff. Reference issue numbers where relevant.

Recent examples to imitate:

```
Carve out an Apache-licensed connector SDK from src/
Extract inline tool handlers into a dispatch table
Unify automated-slice dispatch via SliceData
Tighten connector layer types, drop any from public surface
```

We don't enforce Conventional Commits prefixes (`feat:`, `fix:`, ...). Imperative prose is enough.

## Test runner caveat

`pnpm test` runs Vitest **under Bun** (`bun x vitest run`). Don't switch it back to plain `bun test` — the test suite uses Vitest APIs like `vi.hoisted` that Bun's native test runner doesn't support.

Production uses `bun:sqlite`, but Vitest spawns Node-like workers that can't resolve `bun:` imports. We alias `bun:sqlite` → a `node:sqlite`-backed shim at [`tests/_shims/bun-sqlite.ts`](tests/_shims/bun-sqlite.ts) via [`vitest.config.ts`](vitest.config.ts). If you add SQLite-touching code, the existing shim should cover the API surface (`new Database(path)`, `db.exec`, `db.prepare(...).all/.run/.get`). Extend the shim if not.

## Pull request checklist

Before opening a PR:

- [ ] `pnpm build` passes.
- [ ] `pnpm test` passes (347+ tests).
- [ ] `bun x vitest run tests/performance.test.ts` passes (no perf regressions).
- [ ] `bun x tsc --noEmit` doesn't introduce new type errors (count the existing ones, don't grow the count).
- [ ] No `@src/` imports added to `sdk/` or `connectors/`.
- [ ] If you touched `src/server/index.ts` or the slice runner, document any behavioural changes in the commit message.
- [ ] If you added a new tool handler, it goes into the `inlineToolHandlers` dispatch table (not back into an `if (name === "X")` block).

## Reporting bugs

Please include in the issue:

- The MCP tool call that failed (request + response or stack trace).
- Whether the session was a test session (`testMode: true` in `register-agent`) or production.
- Server log output covering the failure window.
- The output of `git log --oneline -5` so we know which commit you're on.

## Code of Conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). TL;DR: be kind, don't haze newcomers, focus on the change not the person.

## License

By contributing you agree your contribution is licensed under the same terms as the file you're modifying — GPL-3.0-or-later for `src/` and `tests/`, Apache-2.0 for `sdk/`, `connectors/`, and `docs/`. See [`LICENSING.md`](LICENSING.md).
