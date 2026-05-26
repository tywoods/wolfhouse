# Phase 2f — Booking Flow Router Hardening (proposal)

**Status:** Phase 2f.0 + 2f.1 implemented in local Main fork build. Phase 2f.2 (one-shot auto-continue) **not** started.

**Scope:** Local `Wolfhouse Booking Assistant - Main (local Stripe).json` only. Hosted exports unchanged. No Stripe/Send Confirmation changes. No Phase 3.

---

## Problem

When a guest sends a **complete first message** (dates + guest count + room type + name + email), the LLM router often returns `payment_details_provided`. The workflow then runs `Search Hold With Guest Details`, finds **no hold**, and **stops silently** (Airtable search returns 0 rows, no `alwaysOutputData`).

Example:

> Hi, we are 2 people, shared room, June 1-3, my name is Jamy, email is jamy@example.com.

**Wrong:** `payment_details_provided` → Search Hold → stop.

**Right:** `booking_flow` → availability → hold/assign → then guest details → payment link.

---

## Root cause (local Main fork)

| # | Issue |
|---|--------|
| 1 | LLM misclassifies one-shot messages as `payment_details_provided` |
| 2 | Switch matches `payment_details_provided` **before** `booking_flow` |
| 3 | `Code - Parse Route` has no deterministic override for “booking core + no hold” |
| 4 | `Search Hold With Guest Details` has no empty-result guard |

---

## Scenario matrix

| Scenario | Current risk | Desired route | Required state |
|----------|--------------|---------------|----------------|
| Vague availability | OK | `booking_flow` | None |
| Full booking, no contact | OK | `booking_flow` | None |
| **Full booking + contact, no hold** | **Silent stop** | `booking_flow` | None |
| Guest details only | OK if hold exists | `payment_details_provided` | Hold/Payment_Pending |
| Payment claim | OK | `payment_completed_claim` | Does not set paid (2b) |
| Modify/cancel/status | OK | `existing_booking_*` | Booking lookup |
| General question | OK | `general_question` | None |
| Human handoff | OK | `human_handoff` | None |
| Rooming without hold | Misroute | `booking_flow` if dates in message | Hold OR `rooming_info_needed` |

---

## Booking State Resolver

**Placement:** `Code - Parse Route` → **`Code - Booking State Resolver`** → `Switch`

**Switch:** uses `$json.resolved_route` (not raw LLM `route`).

### Deterministic overrides (2f.1)

| Rule | Effect |
|------|--------|
| `payment_details_provided` + no usable hold + booking core in message | → `booking_flow`, code `R2F_FULL_BOOKING_NO_HOLD` |
| `payment_details_provided` + no usable hold | → `booking_flow`, code `R2F_PAYMENT_DETAILS_NO_HOLD` |
| `payment_details_provided` + usable hold | → stay, `should_search_hold=true` |
| `rooming_details_provided` without hold and not `rooming_info_needed` | → `booking_flow` |
| `payment_completed_claim` | unchanged (never sets paid in this workflow) |

`hold_usable` = active booking with status `Hold` or `Payment_Pending`.

### Output schema (resolver node JSON)

See implementation: `scripts/lib/booking-state-resolver.js`

Key fields:

- `resolved_route`, `resolved_sub_route`, `route_overridden`, `override_reason`
- `message_signals` (has_booking_core, has_guest_email, …)
- `hold_lookup.should_search_hold`
- `logging.decision_code`, `logging.fallback_route`

---

## Payment path guards (2f.1)

```text
Switch [payment_details_provided]
  → AI - Extract Guest Details
  → Code - Extract Guest Details
  → IF - Should Search Hold (resolver.hold_lookup.should_search_hold)
      true  → Search Hold (alwaysOutputData)
              → IF - Hold Found
                  true  → Update Hold → … Stripe (2c)
                  false → IF has_booking_core → Parser Node
                        else → Reply - Collect Booking Details
      false → Code - Redirect to Booking Flow → Parser Node
```

No silent stop when Search Hold returns 0 rows.

---

## Logging

| What | Where |
|------|--------|
| Full resolver JSON | **n8n node output** on `Code - Booking State Resolver` (required) |
| `decision_code`, override, hold IDs | Same output |
| Optional Postgres | `PHASE2F_LOG_WORKFLOW_EVENTS=true` — non-blocking HTTP stub (off by default) |

---

## Regression test matrix

| ID | Fixture | Expected |
|----|---------|----------|
| 2f-01 | Jamy message, router=payment_details, no hold | `booking_flow`, `R2F_FULL_BOOKING_NO_HOLD` |
| 2f-02 | Name+email only, hold exists | `payment_details_provided`, `should_search_hold=true` |
| 2f-03 | “I paid” | `payment_completed_claim` |
| 2f-04 | Surfboards | `general_question` |
| 2f-05 | Modify + active booking | `existing_booking_modify` |
| 2f-06 | Rooming + dates, no hold | `booking_flow` |

Automated: `node scripts/test-booking-state-resolver.js`

---

## Implementation phases

| Phase | Delivered |
|-------|-----------|
| **2f.0** | This proposal doc |
| **2f.1** | Resolver + Switch + hold guards in `build-main-local-stripe.js` |
| **2f.2** | One-shot auto-continue after hold (deferred) |

---

## Files

| File | Role |
|------|------|
| `scripts/lib/booking-state-resolver.js` | Resolver logic (tests + n8n codegen) |
| `scripts/build-main-local-stripe.js` | Injects 2f nodes into local fork |
| `scripts/test-booking-state-resolver.js` | Unit fixtures |
| `docs/PHASE-2f.md` | Runbook |

**Untouched:** `n8n/Wolfhouse Booking Assistant  - Main.json`, Stripe workflows, Send Confirmation hosted export.
