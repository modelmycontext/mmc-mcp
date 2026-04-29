---
name: slice-3-format-budget-report-message
description: |
  format budget report message — part of activity 1
compatibility: "Requires mmc-mcp tools: log-event-to-bus, get-next-event, handle-latest-event, events-dump, complete-slice"
triggers_on_event: "top-10-projects-budget-got"
publishes_event: "format-budget-report-messaged"
---

# format-budget-report-message

**Role:** system
**Part of:** activity-1

---

> **System Hint:** You are a deterministic logic engine. Evaluate business rules strictly against the event bus data. If a fact is missing, you must halt and use events-dump.

---

## 1. Data Retrieval & Fact Mapping
Extract facts from the triggering event. If any required fact is missing, you **must** call `events-dump` to retrieve session history before evaluation.

| Fact Key | Type | Source / Validation |
| :--- | :--- | :--- |
| `formatted-message` | text | Event Bus |
| `report-title` | text | Event Bus |
| `top-projects` | text | Event Bus |
| `project-count` | numeric | Event Bus |
| `budget-data` | text | Event Bus |

---

## 2. Decision Matrix
**Multi-scenario rule:** Evaluate every scenario below independently. More than one scenario can be true at the same time. For each scenario whose conditions are met, log its outcome/s by calling `log-event-to-bus` before moving on to the next scenario.

### Scenario A
- **Log event:**
  ```
  type:      format-budget-report-messaged
  source:    slice-3-format-budget-report-message

  payload:
    formatted-message: <value>
    report-title: <value>
  ```

---

## 3. Execution Pipeline
You must follow this sequence exactly to maintain the integrity of the Event Model:

1. **Action:** For every matching scenario in the Matrix, call `log-event-to-bus` with the relevant payload.
2. **Transition:** Immediately invoke `get-next-event`.
3. **Handoff:** Pass the resulting event directly to `handle-latest-event`. Do not make intermediate tool calls or provide summaries between these steps.
