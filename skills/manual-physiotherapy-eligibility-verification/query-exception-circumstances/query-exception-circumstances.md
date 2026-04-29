---
name: slice-3-query-exception-circumstances
description: |
  Ensures accurate physiotherapy coverage decisions by identifying and resolving 'Logic Gaps' between member claims and policy constraints, leading to correct approvals, declines, or escalations.
compatibility: "Requires mmc-mcp tools: log-event-to-bus, get-next-event, handle-latest-event, events-dump"
triggers_on_event: "exception-required-for-policy"
use_when_user_mentions: |
  Query the Member about whether they meet any of the valid exceptions
publishes_event: "exception-circumstances-queried"
---

# query-exception-circumstances

**Role:** claims-processor
**Part of:** manual-physiotherapy-eligibility-verification

---

> **System Hint:** Focus on empathetic but efficient data collection. Do not assume values; ask for clarification if the user's input is ambiguous.

---

## 1. Data Retrieval & Fact Mapping
Adopt the assigned role and collect the following facts from the user. Do not proceed until all required fields are non-null.

| Fact Key | Type | Source / Validation |
| :--- | :--- | :--- |
| `valid-exceptions-for-policy` | text | User Input |
| `member-provided-exception` | text | User Input |

---

## 2. Decision Matrix
**Multi-scenario rule:** Evaluate every scenario below independently. More than one scenario can be true at the same time. For each scenario whose conditions are met, log its outcome/s by calling `log-event-to-bus` before moving on to the next scenario.

### Scenario A
> **Validation Hint:** Ensure you have confirmed all identities before moving to logging.
- **When:** member-provided-exception is empty
- **Error:** Member response could not be interpreted in any meaningful way, clarify if member meets valid policy exceptions

### Scenario B
- **When:** member-provided-exception is not empty
- **Error:** Members response is unrelated, attempt clarification on whether they meet valid policy exceptions

### Scenario C
- **When:** member-provided-exception is not empty OR member-provided-exception equals
- **Log event:**
  ```
  type:      exception-circumstances-queried
  source:    slice-3-query-exception-circumstances
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    valid-exceptions-for-policy: <value>
    member-provided-exception: <value>
  ```

---

## 3. Execution Pipeline
You must follow this sequence exactly to maintain the integrity of the Event Model:

1. **Action:** For every matching scenario in the Matrix, call `log-event-to-bus` with the relevant payload.
2. **Transition:** Immediately invoke `get-next-event`.
3. **Handoff:** Pass the resulting event directly to `handle-latest-event`. Do not make intermediate tool calls or provide summaries between these steps.
