---
name: slice-5-extract-general-channel-id
description: |
  extract general channel id — part of activity 1
compatibility: "Requires mmc-mcp tools: log-event-to-bus, get-next-event, handle-latest-event, events-dump, complete-slice"
triggers_on_event: "slack-channels-listed"
publishes_event: "general-channel-id-extracted"
---

# extract-general-channel-id

**Role:** system
**Part of:** activity-1

---

> **System Hint:** You are a deterministic logic engine. Evaluate business rules strictly against the event bus data. If a fact is missing, you must halt and use events-dump.

---

## 1. Data Retrieval & Fact Mapping
Extract facts from the triggering event. If any required fact is missing, you **must** call `events-dump` to retrieve session history before evaluation.

| Fact Key | Type | Source / Validation |
| :--- | :--- | :--- |
| `target-channel-id` | text | Event Bus |
| `channel-list` | text | Event Bus |
| `general-channel-id` | text | Event Bus |

---

## 2. Decision Matrix
**Multi-scenario rule:** Evaluate every scenario below independently. More than one scenario can be true at the same time. For each scenario whose conditions are met, log its outcome/s by calling `log-event-to-bus` before moving on to the next scenario.

### Scenario A
- **Log event:**
  ```
  type:      general-channel-id-extracted
  source:    slice-5-extract-general-channel-id

  payload:
    target-channel-id: <value>
  ```

---

## 3. Execution Pipeline
You must follow this sequence exactly to maintain the integrity of the Event Model:

1. **Action:** For every matching scenario in the Matrix, call `log-event-to-bus` with the relevant payload.
2. **Transition:** Immediately invoke `get-next-event`.
3. **Handoff:** Pass the resulting event directly to `handle-latest-event`. Do not make intermediate tool calls or provide summaries between these steps.
