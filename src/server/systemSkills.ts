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

## Step 1 — Read the Event

You have been invoked with an event returned by the \`get-next-event\` tool.
Read the \`event\` field from the tool result and apply the rules in Step 2 rigorously.

## Step 2 — Match to a Skill

Scan all available skills in the runtime. For each skill, read its YAML
frontmatter to find the \`triggers_on_event\` field. A skill matches when its
\`triggers_on_event\` value equals \`event.type\`, or is a pipe-separated list
that contains \`event.type\` (e.g. \`MEMBER_POLICY_REVIEWED | MEMBER_ACCOUNT_SUSPENDED\`).

**Do not use a hardcoded routing table.** The mapping is derived entirely from
the \`triggers_on_event\` fields declared in the available skill descriptions.

If multiple skills match, invoke them in the order they appear in the available
skills list.

---

## Step 3 — Invoke the Matched Skill

Load and execute the matched skill/s, passing the event payload as its input context.

If no skill matches the latest event type, stop and inform the user:
> "No skill is registered for event type \`<event.type>\`. The workflow may be complete
> or an unexpected event was published."

---

## Error Handling

| Condition | Response |
|---|---|
| No skill matches the event type | Inform user with the unmatched event type (see above) |
| Matched skill fails to load | Inform user of the skill name that could not be loaded |
`;
