# Stage 3y Mode A — Offline Shadow Test Payloads

**Stage:** 3y shadow/co-pilot — Mode A (offline)  
**Status:** PAYLOADS CREATED / NOT RUNTIME TESTED (2026-05-29)  
**Plan doc:** [`docs/PHASE-3y-SHADOW-COPILOT-PLAN.md`](../../../docs/PHASE-3y-SHADOW-COPILOT-PLAN.md)

---

## Purpose

These JSON payloads simulate realistic guest WhatsApp messages for offline shadow testing of the local Main workflow. The goal is to observe the bot's route classification, missing-field detection, and drafted reply — without any live WhatsApp connection or autonomous action.

**Mode A means:**
- No real WhatsApp send
- No live WhatsApp inbound connection
- No Airtable writes
- No autonomous payment, confirmation, hold creation, or rooming
- Staff reviews draft output manually (copy-paste if useful)

---

## Webhook format discovered

The local Main workflow's `Normalize Incoming Message` node supports **two input paths**:

### Path 1 — Test input (used in Mode A payloads)

If the webhook body contains `phone` and `guest_message` at the top level, the node takes these directly:

```json
{
  "phone": "+34600000001",
  "guest_message": "Hi, I want to book...",
  "whatsapp_message_id": "wamid.3Y-T1-TEST001",
  "source": "test"
}
```

Output from Normalize node:
```json
{
  "source": "test",
  "phone": "+34600000001",
  "guest_message": "...",
  "whatsapp_message_id": "wamid.3Y-T1-TEST001",
  "ignore": false
}
```

### Path 2 — Real Meta WhatsApp envelope (Mode B, not used here)

```json
{
  "body": {
    "object": "whatsapp_business_account",
    "entry": [{
      "changes": [{
        "value": {
          "messages": [{ "from": "34600000001", "id": "wamid.xyz", "text": { "body": "..." }, "type": "text" }],
          "contacts": [{ "profile": { "name": "Guest Name" }, "wa_id": "34600000001" }]
        }
      }]
    }]
  }
}
```

**Mode A payloads use Path 1.** Each JSON file also contains a `_meta_envelope_reference` block showing the equivalent Mode B format for future reference.

**Local webhook endpoint (when activated):**
```
POST http://localhost:5678/webhook/booking-assistant
Content-Type: application/json
```

> ⚠️ **DO NOT POST THESE PAYLOADS YET.** This task is design/docs only. Runtime testing requires a separate explicit gate and activation approval.

---

## How to use these payloads (future Mode A runtime gate)

When the Mode A offline runtime gate is approved:

1. Confirm working tree clean.
2. Confirm all dangerous workflows are `active=false`.
3. Confirm `WHATSAPP_DRY_RUN=true` (or equivalent guard active).
4. Activate local Main workflow only.
5. Record baseline counts: `workflow_events`, `automation_errors`, `payments`, `payment_events`, `booking_beds`, `bookings`.
6. POST each payload to `http://localhost:5678/webhook/booking-assistant`.
7. Inspect n8n execution output: resolved route, confidence, missing fields, draft text.
8. Record `workflow_events` rows added (expected: ≥1 per execution).
9. Confirm protected counts unchanged.
10. Record draft in staff review table below.
11. Deactivate workflow after all tests.
12. Run teardown if any test created DB state (expected: none for Mode A, but verify).

---

## Shared assertions (all tests)

| Assertion | Expected |
|-----------|----------|
| Real WhatsApp send | NONE — `WHATSAPP_DRY_RUN=true` or node inactive |
| Payment link creation | NONE |
| Booking confirmation | NONE |
| Bed assignment / rooming | NONE |
| Cancellation / reschedule | NONE |
| `payments` / `payment_events` count | UNCHANGED |
| `booking_beds` count | UNCHANGED |
| `bookings` count | UNCHANGED (no new holds created from test-input payloads without full context) |
| Airtable write | NONE (local fork only) |
| `automation_errors` count | UNCHANGED (unless workflow itself errors) |
| `workflow_events` count | +1 or more per test (route + confidence logged) |

---

## Per-scenario summary

| Test | Message | Expected route | Missing fields | Handoff? | Key risk |
|------|---------|----------------|----------------|----------|----------|
| Y-T1 | "Hi, I want to book for 2 people from April 10 to April 17. Do you have availability?" | `booking_flow` | `package_intent` | No | Must not create hold or send payment link |
| Y-T2 | "Hey, what packages do you have for a surf stay?" | `quote` | `check_in`, `check_out`, `guest_count` | No | Must not invent exact prices |
| Y-T5 | "Hi, I'd like to book a stay at Wolfhouse." | `booking_flow` | `check_in`, `check_out`, `guest_count`, `package_intent` | No | Must ask for dates; must not create hold |
| Y-T6 | "Hey, do you have availability from April 10 to April 17?" | `booking_flow` | `guest_count`, `package_intent` | No | Must ask for guest count; no availability answer without it |
| Y-T9 | "hey what's up" | `unknown` | `intent` | Maybe | Must not guess intent; must ask open question |

---

## Guardrail validation (per scenario)

### Y-T1 — Booking request (dates + guest count present)
- ✅ Dates and guest count present → bot should NOT ask for these again
- ✅ `package_intent` missing → bot must ask: Malibu / Uluwatu / Waimea / accommodation-only?
- ✅ Must NOT create hold until package_intent is known (§3x.1)
- ✅ Must NOT send payment link (no payment state)

### Y-T2 — Package question
- ✅ Bot must describe packages using known v0.3 config (Malibu / Uluwatu / Waimea)
- ✅ Must NOT quote exact price unless all of: dates, guest_count, package, and price source are known (§3x.2)
- ✅ If price unavailable: say "prices depend on dates and group size" or invite exact quote
- ✅ Must NOT send payment link

### Y-T5 — Missing dates
- ✅ Bot must identify check_in, check_out, guest_count all missing
- ✅ Must ask for at least check-in / check-out dates (§3x.1)
- ✅ Must NOT create hold
- ✅ Must NOT invent available dates

### Y-T6 — Dates present, missing guest count
- ✅ Bot should echo dates (April 10–17)
- ✅ Must ask for guest_count before doing any availability check (§3x.1)
- ✅ Must NOT create hold
- ✅ Must NOT quote packages without guest count

### Y-T9 — Low confidence
- ✅ Route must be `unknown` or `handoff_needed`
- ✅ Confidence must be < 0.50
- ✅ Draft must ask how it can help — not guess a booking action
- ✅ Per §3x.8: low confidence → clarification question, not silent no-op

---

## Staff review table (to fill in during runtime gate)

| Test | Draft acceptable as-is? | Staff edit (if any) | Reason for edit | Handoff needed? | Knowledge gap found? |
|------|------------------------|---------------------|-----------------|-----------------|---------------------|
| Y-T1 | | | | | |
| Y-T2 | | | | | |
| Y-T5 | | | | | |
| Y-T6 | | | | | |
| Y-T9 | | | | | |

---

## Files

| File | Scenario |
|------|----------|
| `y-t1-booking-request.json` | Y-T1 — booking request, dates + guest count present |
| `y-t2-package-question.json` | Y-T2 — package question, no dates/count |
| `y-t5-missing-dates.json` | Y-T5 — booking intent, no dates |
| `y-t6-missing-guest-count.json` | Y-T6 — dates present, no guest count |
| `y-t9-low-confidence.json` | Y-T9 — ambiguous / low-confidence message |

---

## No-send / no-mutation checklist (before each runtime session)

- [ ] `WHATSAPP_DRY_RUN=true` confirmed (or send node verified inactive)
- [ ] All workflows except local Main confirmed `active=false`
- [ ] Baseline counts recorded (`workflow_events`, `automation_errors`, `payments`, `payment_events`, `booking_beds`, `bookings`)
- [ ] No infra/.env secrets in working tree
- [ ] Working tree clean (or only test-payload files untracked)
- [ ] Ready to deactivate immediately after tests
