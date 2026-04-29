---
name: slice-2-identify-customer-tier
description: |
  Calculates and applies order discounts based on customer tier and order value, ensuring consistent and accurate discount handling.
compatibility: "Requires mmc-mcp tools: log-event-to-bus, get-next-event, handle-latest-event, events-dump, json-read"
triggers_on_event: "discount-requested"
publishes_event: "customer-tier-identified"
---

# identify-customer-tier

**Role:** system
**Part of:** process-tiered-customer-discount

---

> **System Hint:** You are a deterministic logic engine. Evaluate business rules strictly against the event bus data. If a fact is missing, you must halt and use events-dump.

---

## 1. Data Retrieval & Fact Mapping
Extract facts from the triggering event. If any required fact is missing, you **must** call `events-dump` to retrieve session history before evaluation.

| Fact Key | Type | Source / Validation |
| :--- | :--- | :--- |
| `order-value` | numeric | Event Bus |
| `customer-details` | customer-details | Event Bus |
| `customer-id` | identifier | Event Bus |

---

## 2. Decision Matrix
**Multi-scenario rule:** Evaluate every scenario below independently. More than one scenario can be true at the same time. For each scenario whose conditions are met, log its outcome/s by calling `log-event-to-bus` before moving on to the next scenario.

### Scenario A
- **When:** customer-details.tier is not empty
- **Log event:**
  ```
  type:      customer-tier-identified
  source:    slice-2-identify-customer-tier
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    order-value: $0
    customer-details: <value>
  ```

### Scenario B
- **When:** customer-details.tier is empty
- **Error:** Customer Tier not Found

---

## 3. Execution Pipeline
You must follow this sequence exactly to maintain the integrity of the Event Model:

1. **Action:** For every matching scenario in the Matrix, call `log-event-to-bus` with the relevant payload.
2. **Transition:** Immediately invoke `get-next-event`.
3. **Handoff:** Pass the resulting event directly to `handle-latest-event`. Do not make intermediate tool calls or provide summaries between these steps.
