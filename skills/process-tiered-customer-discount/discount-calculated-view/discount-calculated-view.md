---
name: slice-4-discount-calculated-view
description: |
  Calculates and applies order discounts based on customer tier and order value, ensuring consistent and accurate discount handling.
compatibility: "Requires mmc-mcp tools: log-event-to-bus, get-next-event, handle-latest-event, events-dump"
triggers_on_event: "discount-calculated"
use_when_user_mentions: |
  discount-interaction
publishes_event: "outcome-event"
---

# discount-calculated-view

**Role:** intake-coordinator
**Part of:** process-tiered-customer-discount

---

> **System Hint:** Focus on empathetic but efficient data collection. Do not assume values; ask for clarification if the user's input is ambiguous.

---

## 1. Data Retrieval & Fact Mapping
Adopt the assigned role and collect the following facts from the user. Do not proceed until all required fields are non-null.

| Fact Key | Type | Source / Validation |
| :--- | :--- | :--- |
| `discount-percentage` | numeric | User Input |

---

## 2. Decision Matrix
**Multi-scenario rule:** Evaluate every scenario below independently. More than one scenario can be true at the same time. For each scenario whose conditions are met, log its outcome/s by calling `log-event-to-bus` before moving on to the next scenario.

### Scenario A
> **Validation Hint:** Ensure you have confirmed all identities before moving to logging.
- **When:** discount-percentage is not empty

### Scenario B
- **When:** discount-percentage is empty
- **Error:** Discount Calculation unsuccessful, inform customer they may need to try again

---

## 3. Execution Pipeline
You must follow this sequence exactly to maintain the integrity of the Event Model:

1. **Action:** For every matching scenario in the Matrix, call `log-event-to-bus` with the relevant payload.
2. **Transition:** Immediately invoke `get-next-event`.
3. **Handoff:** Pass the resulting event directly to `handle-latest-event`. Do not make intermediate tool calls or provide summaries between these steps.
