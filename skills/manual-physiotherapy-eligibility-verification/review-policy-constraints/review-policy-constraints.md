---
name: slice-2-review-policy-constraints
description: |
  Ensures accurate physiotherapy coverage decisions by identifying and resolving 'Logic Gaps' between member claims and policy constraints, leading to correct approvals, declines, or escalations.
compatibility: "Requires mmc-mcp tools: log-event-to-bus, get-next-event, handle-latest-event, events-dump, json-read"
triggers_on_event: "member-physio-claim-received"
publishes_event: "member-policy-reviewed | exception-required-for-policy | member-account-suspended"
---

# review-policy-constraints

**Role:** policy-analyst
**Part of:** manual-physiotherapy-eligibility-verification

---

> **System Hint:** You are a deterministic logic engine. Evaluate business rules strictly against the event bus data. If a fact is missing, you must halt and use events-dump.

---

## 1. Data Retrieval & Fact Mapping
Extract facts from the triggering event. If any required fact is missing, you **must** call `events-dump` to retrieve session history before evaluation.

| Fact Key | Type | Source / Validation |
| :--- | :--- | :--- |
| `covered-under-policy` | text | Event Bus |
| `exception-queried` | text | Event Bus |
| `valid-exceptions-for-policy` | text | Event Bus |
| `member-id` | identifier | Event Bus |
| `account-suspended` |  | Event Bus |
| `collected-user-information` | user-data | Event Bus |
| `collected-user-information.join-date` | date-time | Event Bus |
| `collected-user-information.account-status` | text | Event Bus |
| `collected-user-information.plan-type` | text | Event Bus |
| `service-date` | date | Event Bus |
| `claim-id` | identifier | Event Bus |

---

## 2. Decision Matrix
**Multi-scenario rule:** Evaluate every scenario below independently. More than one scenario can be true at the same time. For each scenario whose conditions are met, log its outcome/s by calling `log-event-to-bus` before moving on to the next scenario.

### Scenario A
- **When:** collected-user-information.Account Status equals suspended
- **Log event:**
  ```
  type:      member-account-suspended
  source:    slice-2-review-policy-constraints
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    member-id: <value>
    account-suspended: True
  ```
- **Log event:**
  ```
  type:      member-policy-reviewed
  source:    slice-2-review-policy-constraints
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    covered-under-policy: <value>
    exception-queried: <value>
  ```

### Scenario B
- **When:** collected-user-information.Account Status equals active AND collected-user-information.Plan Type equals standard AND service-date is not empty
- **Log event:**
  ```
  type:      member-policy-reviewed
  source:    slice-2-review-policy-constraints
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    covered-under-policy: True
    exception-queried: False
  ```

### Scenario C
- **When:** collected-user-information.Account Status equals active AND collected-user-information.Plan Type equals standard AND service-date is not empty
- **Log event:**
  ```
  type:      member-policy-reviewed
  source:    slice-2-review-policy-constraints
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    covered-under-policy: False
    exception-queried: True
  ```
- **Log event:**
  ```
  type:      exception-required-for-policy
  source:    slice-2-review-policy-constraints
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    valid-exceptions-for-policy: ['Hospital Recovery','Accepted ACC Claim','Time spent with previous Insurer if member swapped to this insurer in 60 days']
  ```

---

## 3. Execution Pipeline
You must follow this sequence exactly to maintain the integrity of the Event Model:

1. **Action:** For every matching scenario in the Matrix, call `log-event-to-bus` with the relevant payload.
2. **Transition:** Immediately invoke `get-next-event`.
3. **Handoff:** Pass the resulting event directly to `handle-latest-event`. Do not make intermediate tool calls or provide summaries between these steps.
