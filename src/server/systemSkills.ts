/**
 * System skills that are built into the server and served from constants
 * rather than from disk, so they are available without a skills/ directory.
 */

export const HANDLE_LATEST_EVENT_SKILL = `---
name: handle-latest-event
description: >
  Generic dispatcher skill. You have been invoked with an event returned by the \`get-next-event\` tool.
  Read the \`event\` field from the tool result, then locates and invokes any skill whose triggers_on_event
  matches that event type.
triggers_on_event: null
publishes_event: null
---

# Skill: Get Latest Event

**Role:** system-dispatcher
**Type:** Generic / reusable

---

## Purpose

Acts as the dispatch bridge between slices. Each slice logs its outcome event
and then hands off to this skill. This skill reads the bus, finds the latest
event, and loads whichever skill is listening for it — without any slice needing
to know what that skill is.

---

## Usage

Call \`handle-latest-event\` with the event you just received from \`get-next-event\`:

\`\`\`
handle-latest-event(event: <event object from get-next-event>)
\`\`\`

The server inspects the event type and returns targeted instructions for that
specific case — typically one of:

- **\`workflow_completed\`**: clean end of the workflow. Summarise from the
  progress events you've seen and stop polling.
- **\`unexpected_last_event\`**: an event with no listener. Inform the user
  of the unmatched type and stop polling.
- **Interface pattern slice** (user/external system input): the matched slice's tool name and what to do next.
- **Automation pattern slice** (event-triggered, runs server-side): the server already evaluated the slice; acknowledge briefly and call \`get-next-event\` to continue.
- **View pattern slice** (read-only projection): not dispatched via this bridge — Views are invoked on demand and never appear as bus events.

Recognised slice patterns (Event Modeling): \`interface\`, \`automation\`, \`view\`. Translation/anti-corruption is implemented as an Automation slice that maps external events into the local context — it is not a separate pattern.

You should not need to read or scan other skill bodies — the server's reply
tells you exactly what to do.
`;
