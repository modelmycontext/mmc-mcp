---
name: slice-3-discount
description: |
  Calculates and applies order discounts based on customer tier and order value, ensuring consistent and accurate discount handling.
compatibility: "Requires mmc-mcp tools: log-event-to-bus, get-next-event, handle-latest-event, events-dump"
triggers_on_event: "customer-tier-identified"
publishes_event: "discount-calculated"
---

# discount

**Role:** system
**Part of:** process-tiered-customer-discount

---

> **System Hint:** You are a deterministic logic engine. Evaluate business rules strictly against the event bus data. If a fact is missing, you must halt and use events-dump.

---

## 1. Data Retrieval & Fact Mapping
Extract facts from the triggering event. If any required fact is missing, you **must** call `events-dump` to retrieve session history before evaluation.

| Fact Key | Type | Source / Validation |
| :--- | :--- | :--- |
| `discount-percentage` | numeric | Event Bus |
| `order-value` | numeric | Event Bus |
| `customer-details` | customer-details | Event Bus |

---

## 2. Decision Matrix
**Multi-scenario rule:** Evaluate every scenario below independently. More than one scenario can be true at the same time. For each scenario whose conditions are met, log its outcome/s by calling `log-event-to-bus` before moving on to the next scenario.

### Scenario A
- **When:** customer-details.tier equals VIP
- **Log event:**
  ```
  type:      discount-calculated
  source:    slice-3-discount
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    discount-percentage: 20
  ```

### Scenario B
- **When:** customer-details.tier equals Member AND order-value is greater than or equal to 50
- **Log event:**
  ```
  type:      discount-calculated
  source:    slice-3-discount
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    discount-percentage: 10
  ```

### Scenario C
- **When:** customer-details.tier equals Member AND order-value is less than 50
- **Log event:**
  ```
  type:      discount-calculated
  source:    slice-3-discount
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    discount-percentage: 0
  ```

### Scenario D
- **When:** customer-details.tier equals Guest
- **Log event:**
  ```
  type:      discount-calculated
  source:    slice-3-discount
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    discount-percentage: 0
  ```

---

## 3. Execution Pipeline
You must follow this sequence exactly to maintain the integrity of the Event Model:

1. **Action:** For every matching scenario in the Matrix, call `log-event-to-bus` with the relevant payload.
2. **Transition:** Immediately invoke `get-next-event`.
3. **Handoff:** Pass the resulting event directly to `handle-latest-event`. Do not make intermediate tool calls or provide summaries between these steps.
