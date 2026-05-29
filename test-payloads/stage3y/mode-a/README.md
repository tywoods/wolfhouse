# Stage 3y Mode A — Offline Shadow Test Payloads

**Stage:** 3y shadow/co-pilot — Mode A (offline)  
**Status:** OFFLINE-SAFE BUILD IMPLEMENTED / NOT RUNTIME TESTED (2026-05-29)  
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

## Payload format — Meta-envelope (WhatsApp path)

### Why the previous flat format was blocked

The Mode A payloads were originally designed using a flat `phone` / `guest_message` shape, based on the assumption that `Normalize Incoming Message` would read those fields at the top level of the webhook body.

**What the runtime gate discovered:** n8n's webhook node nests the entire POST body under `input.body`. So `input.phone` is never set by an external POST — it would only be present if the n8n execution itself set it upstream. The `Normalize Incoming Message` node's test path checks `input.phone` (only reachable by internal upstream injection, not by an external POST). As a result, the flat payload was silently misrouted and the workflow stopped at `IF - Ignore Non Guest Message`.

### Correct format for Mode A POSTs — Meta-envelope

The `Normalize Incoming Message` node's **WhatsApp path** reads from `input.body.entry[0].changes[0].value.messages[0]` — exactly what a real Meta webhook delivers.

POSTing the Meta-envelope directly causes n8n to nest it under `input.body`, which is what the WhatsApp path expects.

**The POST body must be the Meta-envelope:**

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "FAKE_WABA_ID",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "34600000001",
              "phone_number_id": "FAKE_PHONE_NUMBER_ID"
            },
            "contacts": [
              {
                "profile": { "name": "Test Guest T1" },
                "wa_id": "34600000001"
              }
            ],
            "messages": [
              {
                "from": "34600000001",
                "id": "wamid.3Y-T1-TEST001",
                "timestamp": "1777000001",
                "text": { "body": "Hi, I want to book for 2 people..." },
                "type": "text"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

**All five payload files now use this format.** Each file is POSTable directly — the `_meta`, `_webhook`, and `_assertions` top-level keys are underscore-prefixed metadata and are ignored by the workflow.

### How Normalize Incoming Message parses a Meta-envelope POST

```
n8n webhook node receives POST
  → wraps body as: input.body = { object, entry, ... }
  → Normalize Incoming Message reads:
      msg   = input.body.entry[0].changes[0].value.messages[0]
      phone = msg.from                            → "+34600000001"
      text  = msg.text.body                       → "Hi, I want to book..."
      wamid = msg.id                              → "wamid.3Y-T1-TEST001"
      source = "whatsapp"
```

---

## Local webhook endpoint (when activated)

```
POST http://localhost:5678/webhook/booking-assistant
Content-Type: application/json
```

> **DO NOT POST THESE PAYLOADS YET.** Runtime testing requires a separate explicit gate and activation approval.
>
> **Mode A requires a fully offline-safe Main build.** Runtime gate 2 (2026-05-29) found critical live side effects (real WhatsApp send, Airtable writes, Postgres booking hold). This build fixes all three categories:
>
> - **WhatsApp sends gated** (16 `Send WhatsApp Reply*` nodes): `IF - DRY RUN?` gate added before every send node. Hardcoded Bearer token replaced with `$env.WHATSAPP_ACCESS_TOKEN`.
> - **Airtable writes gated** (47 nodes, all create/update/upsert): same `IF - DRY RUN?` pattern. Stubs return typed synthetic data so routing/LLM/draft logic continues.
> - **Postgres writes gated** (3 nodes: Create Booking Hold, Upsert Conversation Hold, Backfill AT Record Id): same pattern. PG Hold stub returns a shaped record so `Code - Validate PG Hold` proceeds and the LLM still generates the draft reply.
> - **Typing indicator gated** (existing fix, preserved): `IF - Send Typing Indicator (Local Guard)` checks `$env.WHATSAPP_DRY_RUN`.
> - **Static verifier passes**: `node scripts/build-main-local-stripe.js --verify-targets` includes `verifyShadowModeSafety` checks.
>
> **Do not rerun until this static verifier passes on the current build.** Current build: PASSES (2026-05-29).

---

## How to use these payloads (future Mode A runtime gate)

When the Mode A offline runtime gate is approved:

1. Confirm working tree clean.
2. Confirm all dangerous workflows are `active=false`.
3. Confirm `WHATSAPP_DRY_RUN=true` in `.env` (gated at the workflow level — 66 IF gates check `$env.WHATSAPP_DRY_RUN` across all send/write nodes).
4. Activate local Main workflow only.
5. Record baseline counts: `workflow_events`, `automation_errors`, `payments`, `payment_events`, `booking_beds`, `bookings`.
6. POST each file directly to `http://localhost:5678/webhook/booking-assistant` (whole file is the POST body).
7. Inspect n8n execution output: resolved route, confidence, missing fields, draft text.
8. Confirm `Send Typing Indicator` node was skipped (false branch of `IF - Send Typing Indicator (Local Guard)` taken) — no Meta Graph API call.
9. Confirm `Send WhatsApp Reply*` nodes were intercepted by `IF - DRY RUN?` gates (false branch → `Code - DRY RUN Stub`, no real send).
9. Record `workflow_events` rows added (expected: ≥1 per execution).
10. Confirm protected counts unchanged.
11. Record draft in staff review table below.
12. Deactivate workflow after all tests.
13. Run teardown if any test created DB state (expected: none for Mode A, but verify).

---

## Shared assertions (all tests)

| Assertion | Expected |
|-----------|----------|
| Real WhatsApp send | NONE — `WHATSAPP_DRY_RUN=true` blocks send |
| Typing indicator Meta API call | NONE — `IF - Send Typing Indicator (Local Guard)` now checks `WHATSAPP_DRY_RUN` |
| Payment link creation | NONE |
| Booking confirmation | NONE |
| Bed assignment / rooming | NONE |
| Cancellation / reschedule | NONE |
| `payments` / `payment_events` count | UNCHANGED |
| `booking_beds` count | UNCHANGED |
| `bookings` count | UNCHANGED |
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

- [ ] `WHATSAPP_DRY_RUN=true` confirmed in `.env`
- [ ] Workflow-level guards confirmed: `IF - Send Typing Indicator (Local Guard)` + 66 `IF - DRY RUN?` gates cover all sends, Airtable writes, and Postgres hold writes (implemented 2026-05-29, static verifier passes)
- [ ] All workflows except local Main confirmed `active=false`
- [ ] Baseline counts recorded (`workflow_events`, `automation_errors`, `payments`, `payment_events`, `booking_beds`, `bookings`)
- [ ] No infra/.env secrets in working tree
- [ ] Working tree clean (or only test-payload files untracked)
- [ ] Ready to deactivate immediately after tests
