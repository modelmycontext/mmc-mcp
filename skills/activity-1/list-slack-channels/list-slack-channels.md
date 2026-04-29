---
name: slice-4-list-slack-channels
description: |
  list slack channels — part of activity 1
compatibility: "Requires mmc-mcp tools: log-event-to-bus, get-next-event, handle-latest-event, events-dump, complete-slice, slack_slack_list_channels"
triggers_on_event: "project-list-slack-formatted"
publishes_event: "slack-channels-listed"
---

# list-slack-channels

**Role:** system
**Part of:** activity-1

---

> **System Hint:** You are a deterministic logic engine. Evaluate business rules strictly against the event bus data. If a fact is missing, you must halt and use events-dump.

---

## 1. Data Retrieval & Fact Mapping
Extract facts from the triggering event. If any required fact is missing, you **must** call `events-dump` to retrieve session history before evaluation.

| Fact Key | Type | Source / Validation |
| :--- | :--- | :--- |
| `channels` | text | Event Bus |
| `formatted-message` | text | Event Bus |

---

## 2. Decision Matrix
**Multi-scenario rule:** Evaluate every scenario below independently. More than one scenario can be true at the same time. For each scenario whose conditions are met, log its outcome/s by calling `log-event-to-bus` before moving on to the next scenario.

### Scenario A
- **Log event:**
  ```
  type:      slack-channels-listed
  source:    slice-4-list-slack-channels

  payload:
    channels: <value>
  ```

---

## 3. Execution Pipeline
You must follow this sequence exactly to maintain the integrity of the Event Model:

1. **Action:** For every matching scenario in the Matrix, call `log-event-to-bus` with the relevant payload.
2. **Transition:** Immediately invoke `get-next-event`.
3. **Handoff:** Pass the resulting event directly to `handle-latest-event`. Do not make intermediate tool calls or provide summaries between these steps.
