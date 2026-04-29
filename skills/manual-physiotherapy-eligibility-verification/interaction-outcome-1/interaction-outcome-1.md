---
name: slice-6-interaction-outcome-1
description: |
  Ensures accurate physiotherapy coverage decisions by identifying and resolving 'Logic Gaps' between member claims and policy constraints, leading to correct approvals, declines, or escalations.
compatibility: "Requires mmc-mcp tools: log-event-to-bus, get-next-event, handle-latest-event, events-dump"
use_when_user_mentions: |
  interaction-outcome-1-interaction
publishes_event: "interaction-outcome-1"
---

# interaction-outcome-1

**Role:** intake-coordinator
**Part of:** manual-physiotherapy-eligibility-verification

---

> **System Hint:** Focus on empathetic but efficient data collection. Do not assume values; ask for clarification if the user's input is ambiguous.

---

## 1. Data Retrieval & Fact Mapping
Adopt the assigned role and collect the following facts from the user. Do not proceed until all required fields are non-null.

| Fact Key | Type | Source / Validation |
| :--- | :--- | :--- |
| `session_id` | string | persistent context |

---

## 2. Decision Matrix
**Multi-scenario rule:** Evaluate every scenario below independently. More than one scenario can be true at the same time. For each scenario whose conditions are met, log its outcome/s by calling `log-event-to-bus` before moving on to the next scenario.

No business rules apply. **Always** log the following outcome(s) to the event bus:

- **Log event:**
  ```
  type:      interaction-outcome-1
  source:    slice-6-interaction-outcome-1
  sessionId: Unique and persistent session ID for the workflow currently being followed
  ```

---

## 3. Execution Pipeline
You must follow this sequence exactly to maintain the integrity of the Event Model:

1. **Action:** For every matching scenario in the Matrix, call `log-event-to-bus` with the relevant payload.
2. **Transition:** Immediately invoke `get-next-event`.
3. **Handoff:** Pass the resulting event directly to `handle-latest-event`. Do not make intermediate tool calls or provide summaries between these steps.
