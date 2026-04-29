---
name: slice-1-request-discount
description: |
  Calculates and applies order discounts based on customer tier and order value, ensuring consistent and accurate discount handling.
compatibility: "Requires mmc-mcp tools: log-event-to-bus, get-next-event, handle-latest-event, events-dump"
use_when_user_mentions: |
  request-discount-interaction
publishes_event: "discount-requested"
---

# request-discount

**Role:** customer
**Part of:** process-tiered-customer-discount

---

> **System Hint:** Focus on empathetic but efficient data collection. Do not assume values; ask for clarification if the user's input is ambiguous.

---

## 1. Data Retrieval & Fact Mapping
Adopt the assigned role and collect the following facts from the user. Do not proceed until all required fields are non-null.

| Fact Key | Type | Source / Validation |
| :--- | :--- | :--- |
| `customer-id` | identifier | User Input |
| `order-value` | numeric | User Input |

---

## 2. Decision Matrix
**Multi-scenario rule:** Evaluate every scenario below independently. More than one scenario can be true at the same time. For each scenario whose conditions are met, log its outcome/s by calling `log-event-to-bus` before moving on to the next scenario.

### Scenario A
> **Validation Hint:** Ensure you have confirmed all identities before moving to logging.
- **When:** customer-id is not empty AND order-value is greater than 0
- **Log event:**
  ```
  type:      discount-requested
  source:    slice-1-request-discount
  sessionId: Unique and persistent session ID for the workflow currently being followed
  payload:
    customer-id: cust-1234
    order-value: $0
  ```

### Scenario B
- **When:** customer-id is empty OR order-value is less than 0
- **Error:** customerID is required and order value must be above $0

---

## 3. Execution Pipeline
You must follow this sequence exactly to maintain the integrity of the Event Model:

1. **Action:** For every matching scenario in the Matrix, call `log-event-to-bus` with the relevant payload.
2. **Transition:** Immediately invoke `get-next-event`.
3. **Handoff:** Pass the resulting event directly to `handle-latest-event`. Do not make intermediate tool calls or provide summaries between these steps.
