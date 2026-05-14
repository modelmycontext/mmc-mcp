# Skill & Slice Definitions

How to author skills (slices) for `mmc-mcp`. Covers the on-disk layout, what the
server reads, and the LLM-facing prompt format.

> The conceptual spec for slice patterns and execution semantics (Event Modeling)
> lives in the project's shared knowledge base. This doc is the OSS-facing
> implementation reference — file layout, frontmatter, and what the server reads.

## File layout

```
skills/
  <activity>/
    <activity>.json                 # Outcome model — source of truth for slice topology
    <slice-1>/<slice-1>.md          # Skill body (LLM-facing prompt)
    <slice-2>/<slice-2>.md
    ...
```

The JSON outcome model is **canonical** for slice composition (components,
scenarios, given/then events, facts). The `.md` files are LLM-facing prompts
consumed only when the slice is rendered as a tool body to the agent. The
server does **not** read slice topology from `.md` frontmatter.

## Slice patterns

Three recognised patterns, inferred from the slice's component shape:

| Pattern | Detected by | Required components | Queries | Emits Outcome? |
|---|---|---|---|---|
| **Interface** | `slice.interface` truthy | Subscribed Outcomes (in) + Command | 0+ | yes |
| **Automation** | has `command`, no `interface` | Subscribed Outcomes + Automation + Query + Command | exactly 1 | yes |
| **View** | no `command` | Queries + delivery Interaction | 1+ | **no** |

Translation/anti-corruption is an Automation slice that maps external events
into the local context — not a separate pattern.

The server validates slices at startup and logs warnings for shape violations.
Stable error codes include `INTERFACE_MISSING_COMMAND`,
`AUTOMATION_QUERY_CARDINALITY`, `AUTOMATION_MISSING_SUBSCRIPTION`,
`VIEW_HAS_OUTCOMES`, etc. See `validateSlice` in
`src/skill-engine/interaction-slice-trigger-events.ts`.

## Slice components

| Component | Role |
|---|---|
| **Interaction Outcome** | Event with facts. Slices consume them (subscribed via `scenario.given[]`) and emit them (via `slice.outcomes` / `scenario.then`). |
| **Command** | Decides which Outcomes to emit. Owns the Scenarios. |
| **Query** | Reads past Interaction Outcomes / facts to provide supporting state. |
| **Scenario** | Given / When / Then unit. Multiple scenarios per slice are evaluated independently — every passing scenario fires its Then. |
| **Job** | Single-fact unit of work. Two kinds: Query Job (runs after slice trigger) and Command Job (runs before Command). Output facts are available to the whole slice. |

## Skill `.md` frontmatter

```markdown
---
name: my-slice
description: One-line summary used as the tool description for the agent.
compatibility: "Requires mmc-mcp tools: log-event-to-bus, get-next-event"
publishes_event: my-outcome-name
---
```

- `name` — slice identifier (matches the directory name).
- `description` — shown to the agent in the tools list.
- `compatibility` — comma-separated allowlist of tools the slice may call.
- `publishes_event` — informational; the actual emission topology lives
  in the JSON outcome model.

The server no longer reads `triggers_on_event` from `.md` frontmatter —
that map is now derived from the JSON's `scenario.given[]` events for
Automation pattern slices.

## Where to look in the source

- `src/skill-engine/interaction-slice-trigger-events.ts` — slice schema,
  `getSlicePattern`, `validateSlice`, model loaders.
- `src/services/automatedSliceRunner.ts` — Automation pattern execution
  handler (used by both disk and workbench-test paths).
- `src/server/systemSkills.ts` — `handle-latest-event` dispatcher prompt.
