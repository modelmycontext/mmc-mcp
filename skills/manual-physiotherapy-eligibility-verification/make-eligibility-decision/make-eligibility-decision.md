---
name: slice-4-make-eligibility-decision
description: |
  Ensures accurate physiotherapy coverage decisions by identifying and resolving 'Logic Gaps' between member claims and policy constraints, leading to correct approvals, declines, or escalations.
compatibility: "Requires mmc-mcp tools: log-event-to-bus, get-next-event, handle-latest-event, events-dump"
triggers_on_event: "member-account-suspended | member-policy-reviewed | exception-circumstances-queried"
publishes_event: "eligibility-decision-made"
---

# make-eligibility-decision

**Role:** eligibility-specialist
**Part of:** manual-physiotherapy-eligibility-verification

---

> **System Hint:** You are a deterministic logic engine. Evaluate business rules strictly against the event bus data. If a fact is missing, you must halt and use events-dump.

---

## 1. Data Retrieval & Fact Mapping
Extract facts from the triggering event. If any required fact is missing, you **must** call `events-dump` to retrieve session history before evaluation.

| Fact Key | Type | Source / Validation |
| :--- | :--- | :--- |
| `eligibility-status` | text | Event Bus |
| `decision-reason` | text | Event Bus |
| `covered-under-policy` | text | Event Bus |
| `valid-exceptions-for-policy` | text | Event Bus |
| `member-provided-exception` | text | Event Bus |
| `exception-queried` | text | Event Bus |
| `account-suspended` |  | Event Bus |
| `member-id` | identifier | Event Bus |

---

## 2. Decision Matrix
**Multi-scenario rule:** Evaluate every scenario below independently. More than one scenario can be true at the same time. For each scenario whose conditions are met, log its outcome/s by calling `log-event-to-bus` before moving on to the next scenario.

### Scenario A
- **When:** account-suspended equals True
- **Log event:**
  ```
  type:      eligibility-decision-made
  source:    slice-4-make-eligibility-decision
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    eligibility-status: Ineligible
    decision-reason: Account currently Suspended
  ```

### Scenario B
- **When:** covered-under-policy equals True
- **Log event:**
  ```
  type:      eligibility-decision-made
  source:    slice-4-make-eligibility-decision
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    eligibility-status: Eligible
    decision-reason: Covered under policy
  ```

### Scenario C
- **When:** covered-under-policy equals False AND exception-queried equals True AND member-provided-exception is not empty
- **Log event:**
  ```
  type:      eligibility-decision-made
  source:    slice-4-make-eligibility-decision
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    eligibility-status: Eligible
    decision-reason: Covered under policy: Policy exception valid
  ```

### Scenario D
- **When:** covered-under-policy equals False AND exception-queried equals True AND member-provided-exception is not empty
- **Log event:**
  ```
  type:      eligibility-decision-made
  source:    slice-4-make-eligibility-decision
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    eligibility-status: Ineligible
    decision-reason: Not covered under policy: No exceptions Met
  ```

---

## 3. Execution Pipeline
You must follow this sequence exactly to maintain the integrity of the Event Model:

1. **Action:** For every matching scenario in the Matrix, call `log-event-to-bus` with the relevant payload.
2. **Transition:** Immediately invoke `get-next-event`.
3. **Handoff:** Pass the resulting event directly to `handle-latest-event`. Do not make intermediate tool calls or provide summaries between these steps.
