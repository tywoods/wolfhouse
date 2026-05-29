# Stage 4 — Autonomous Booking Dry-Run

## Purpose

These scenario files define the first Stage 4 milestone: a full end-to-end booking flow
tested with all side effects stubbed at the infrastructure boundary. No real WhatsApp
sends, no real Stripe sessions, no real Airtable writes, no real database mutations.

**Goal:** prove that the bot would complete a full booking correctly if the stubs were
real — correct state at every turn, correct config values, no invented pricing, no
dangerous live writes, correct handoff for exceptions.

---

## Difference from Stage 3y Mode A

| Dimension | Stage 3y Mode A | Stage 4 Autonomous Dry-Run |
|-----------|-----------------|---------------------------|
| Test unit | Single message / single intent | Multi-turn sequence, full flow |
| What is tested | Route + draft per message type | State transitions across booking lifecycle |
| Hold stub | Returns `pg_ok: false` (blocks flow) | Must return shaped `booking_id/booking_code` to continue |
| Payment link | Not reached in most tests | Must produce stub `checkout_url` |
| Stripe webhook | Not simulated | Simulated POST to webhook handler |
| Confirmation | Not reached | Stub produces draft confirmation text |
| Config assertions | Implicit | Explicit: prices/deposit/room config cited per scenario |
| Multi-turn identity | Single phone per test | Same phone across turns to preserve conversation state |

---

## WARNING: scaffolding only — no runtime yet

These files are scenario definitions. The runner (`scripts/run-stage4-autonomous-dry-run.js`)
currently only validates and reports — it does NOT POST to n8n.

Before runtime execution:
- Stub shapes must be updated in `scripts/build-main-local-stripe.js` (see § Required implementation changes)
- Multi-turn conversation state must be verified to persist correctly between turns (same phone number)
- The runner must be extended to POST turns sequentially with correct timing
- Stripe webhook simulation must be wired

---

## No-live-action checklist (enforced per test)

Every turn in every scenario must satisfy:
- [ ] `WHATSAPP_DRY_RUN=true` confirmed in both containers
- [ ] No real WhatsApp send (`Send WhatsApp Reply*` not in directly executed nodes)
- [ ] No real Meta `wamid` in execution data
- [ ] No `graph.facebook.com` references
- [ ] No Airtable write nodes executed directly
- [ ] `payments` count unchanged
- [ ] `payment_events` count unchanged
- [ ] `booking_beds` count unchanged
- [ ] No real Stripe checkout session created
- [ ] All workflows inactive after test

---

## Scenario list

| ID | Scenario | Turns | Key assertion |
|----|----------|-------|---------------|
| A1 | Complete 7-night Uluwatu booking, deposit path | 3 | Deposit = €200 from config; no invented pricing |
| A2 | Missing package then supplied in turn 2 | 2 | Hold fires ONLY after package known |
| A3 | Deposit option selected | 2 | Amount = €200 (standard_package tier from config) |
| A4 | Full payment selected | 2 | Amount = €599 (Waimea peak from config table) |
| A5 | Dates in closed month (January) | 1 | No hold, inform closed, no price quoted |
| A6 | Guest claims paid, no Stripe record | 1 | Handoff fires; booking NOT confirmed |
| A7 | Cancellation/refund request | 1 | Immediate handoff; no cancel/refund action |
| A8 | Rooming preference during booking | 1 | Preference noted; no real assignment; booking continues |
| A9 | 2 surf lessons + yoga query | 2 | Lessons = €65 (tiered); yoga link NOT created |
| A10 | Spanish-language booking request | 1 | Language = es; reply in Spanish; same state logic |

---

## Multi-turn scenario structure

Each scenario JSON has the following top-level structure:

```json
{
  "_meta": { "scenario_id", "title", "stage", "mode", "status", "goal", "notes" },
  "config_expectations": { ... values the bot must use from wolfhouse-somo.baseline.json ... },
  "stub_overrides": { ... shaped return values required by downstream nodes ... },
  "turns": [
    {
      "turn_id": "A1-T1",
      "description": "...",
      "guest_message": "...",
      "post_body": { ... Meta-envelope, same phone for all turns in scenario ... },
      "expected_route": "...",
      "expected_confidence_min": 0.85,
      "expected_missing_fields": [...],
      "expected_bot_behavior": "...",
      "expected_state_after_turn": { ... },
      "assertions": { ... },
      "forbidden_live_actions": { ... }
    }
  ],
  "expected_final_state": { ... },
  "assertions": { ... },
  "staff_review_notes": ""
}
```

**Multi-turn identity:** All turns within a scenario use the same `from` phone number in
the Meta envelope. n8n Main tracks conversation state by phone number. Each subsequent
turn arrives as a new webhook POST; the runner sends them sequentially.

**Timing:** turns within a scenario use incrementing `timestamp` values (60s apart) to
simulate a realistic conversation. Real execution will require waiting for each turn's
n8n execution to complete before sending the next.

---

## Expected state transition model (full booking flow)

```
Turn 1: intent + fields
  → route = booking_flow
  → missing_fields check
  → if any missing: ask for them (loops back to next turn)
  → if all present: hold stub fires
  → bot asks: deposit or full?

Turn 2: payment choice
  → route = payment_or_confirm_intent
  → deposit_amount or full_amount from config (no invented pricing)
  → bot asks for name + email

Turn 3: name + email
  → payment-link stub fires
  → stub returns checkout_url
  → bot sends link text (captured as draft, not sent live)
  → booking_status = hold (awaiting payment)

[Stripe webhook simulation — separate POST to webhook handler]
  → webhook stub confirms payment
  → booking_status = confirmed
  → confirmation stub fires
  → draft confirmation text includes address, gate_code, room_number from config
  → does NOT include bed_number (config: include_bed_number = false)
```

---

## Config values that must be used (not invented)

| Value | Config source | Expected |
|-------|---------------|----------|
| Deposit (standard 7-night) | `payment.deposit_rule.tiers.standard_package.amount_eur` | €200 |
| Deposit (custom/short stay) | `payment.deposit_rule.tiers.custom_or_short_stay.amount_eur` | €100 |
| Malibu shoulder 7nt/person | `packages.prices_2026_per_person_7nt_shared.shoulder.malibu` | €249 |
| Uluwatu shoulder 7nt/person | `packages.prices_2026_per_person_7nt_shared.shoulder.uluwatu` | €349 |
| Waimea shoulder 7nt/person | `packages.prices_2026_per_person_7nt_shared.shoulder.waimea` | €499 |
| Uluwatu high 7nt/person | `packages.prices_2026_per_person_7nt_shared.high.uluwatu` | €399 |
| Waimea peak 7nt/person | `packages.prices_2026_per_person_7nt_shared.peak.waimea` | €599 |
| Surf lesson 1 | `service_addons.service_catalog.surf_lesson.tiers[0].price_eur` | €35 |
| Surf lesson 2+ each | `service_addons.service_catalog.surf_lesson.tiers[1].price_eur_each` | €30 |
| 2 surf lessons total | derived from tiered rule | €65 |
| Yoga class | `service_addons.service_catalog.yoga_class.price_eur` | €15 (on-site only) |
| Wetsuit+softtop bundle | `service_addons.bundles.wetsuit_plus_softtop.price_eur` | €15/day |
| Closed months | `packages.closed_months` | December, January, February |
| Gate code | `confirmation.gate_code` | `2684#` |
| Check-in time | `operations.check_in_time` | `15:00` |
| Check-out time | `operations.check_out_time` | `11:00` |

---

## Required stub return shapes

These shapes are needed for the full dry-run flow. Current Mode A stubs return minimal
safe values that BLOCK further flow (e.g., `pg_ok: false`). Stage 4 requires shaped
values that ALLOW the flow to continue.

### Hold stub

```json
{
  "booking_id": "aaa00000-0000-0000-0000-000000000a01",
  "booking_code": "WH-DRYA1-0001",
  "status": "hold",
  "expires_at": "2026-04-10T12:00:00.000Z",
  "expires_in_minutes": 60,
  "check_in": "2026-04-10",
  "check_out": "2026-04-17",
  "guest_count": 2,
  "package_key": "uluwatu",
  "total_amount_cents": 69800,
  "deposit_amount_cents": 20000,
  "currency": "EUR",
  "dry_run": true,
  "pg_ok": true
}
```

**Note:** `pg_ok: true` is required so the availability path continues. Current Stage 3y
hold stub returns `pg_ok: false` which terminates at `Code - PG Hold Failed Stop`.

### Payment-link stub

```json
{
  "checkout_url": "https://checkout.stripe.com/dry-run/scenario-id",
  "session_id": "cs_dry_run_scenario_id_001",
  "amount_cents": 20000,
  "currency": "eur",
  "payment_kind": "deposit",
  "booking_id": "aaa00000-0000-0000-0000-000000000a01",
  "booking_code": "WH-DRYA1-0001",
  "dry_run": true
}
```

### Stripe webhook simulation

Sent as a separate POST to `http://localhost:5678/webhook/stripe-checkout-success` (or
whichever endpoint handles Stripe events):

```json
{
  "event_id": "evt_dry_run_scenario_id_001",
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "cs_dry_run_scenario_id_001",
      "payment_status": "paid",
      "amount_total": 20000,
      "currency": "eur",
      "metadata": {
        "booking_id": "aaa00000-0000-0000-0000-000000000a01",
        "booking_code": "WH-DRYA1-0001",
        "payment_kind": "deposit"
      }
    }
  }
}
```

### Confirmation stub

```json
{
  "confirmation_sent": false,
  "dry_run": true,
  "draft_text": "...",
  "includes": {
    "address": true,
    "gate_code": "2684#",
    "room_number": true,
    "check_in_time": "15:00",
    "check_out_time": "11:00"
  },
  "excludes": {
    "bed_number": true
  }
}
```

### Rooming preference stub

```json
{
  "preference_recorded": true,
  "room_preference": "sea_view_or_private",
  "assigned": false,
  "assignment_deferred": "pending_confirmation_and_room_availability",
  "auto_assign_blocked": false,
  "dry_run": true
}
```

---

## Required implementation changes

### 1. Hold stub shaped return (BLOCKING for A1/A2/A3/A4/A8/A10 flow to continue)

**File:** `scripts/build-main-local-stripe.js`
**Change:** The `PG_HOLD_STUB` (or equivalent Code stub for `Postgres - Create Booking Hold`)
currently returns `{ pg_ok: false, dry_run: true, ... }`. For Stage 4, it needs to return
`{ pg_ok: true, booking_id: ..., booking_code: ..., status: 'hold', ... }`.
**Risk:** Downstream nodes that currently short-circuit at `pg_ok: false` will now continue.
Verify that all follow-on nodes are also gated or stubbed before enabling.

### 2. Payment-link stub shaped return (BLOCKING for deposit/full payment flow)

**File:** `scripts/build-main-local-stripe.js`
**Change:** The Stripe checkout session creation node stub must return a valid-shaped
`{ checkout_url, session_id, amount_cents, ... }`. Currently returns minimal safe output.

### 3. Stripe webhook dry-run path

**File:** `scripts/build-main-local-stripe.js` (or Stripe webhook workflow)
**Change:** The Stripe webhook handler needs a dry-run path that accepts the simulated
webhook event, reads `metadata.booking_id` from it, and proceeds through the confirmation
path without mutating payment_events.

### 4. Confirmation draft capture

**File:** `scripts/build-main-local-stripe.js`
**Change:** Confirmation send stub must expose `draft_text` so the runner can capture what
the confirmation would say. Currently the confirmation path may not be reached in dry-run.

### 5. Conversation state persistence across turns

**Infrastructure:** n8n Main uses phone number (`from`) as conversation key. For multi-turn
tests, the runner must use the same `from` phone per scenario and send turns sequentially
with enough delay for each execution to complete. If the conversation state is stored in
Airtable (currently) and Airtable write is stubbed, the state may not persist between turns.
**Risk:** Turn 2 may not see the session data from Turn 1. This is the most significant
multi-turn infrastructure concern.
**Mitigation options:**
- Allow a limited Postgres conversation record (non-Airtable) to be written per dry-run turn
- Inject session state as part of the Turn 2 webhook payload (less realistic)
- Verify that `Postgres - Upsert Conversation Hold` stub returns sufficient session data
  for subsequent turns to reconstruct state

### 6. Closed-month guard (A5)

**Status:** May already be implemented in the LLM routing / booking_flow path.
**Verify:** Check that `packages.closed_months` from config is read before creating a hold.
If not, a Code node or IF node is needed to check the month before hold creation.

### 7. Spanish language detection (A10)

**Status:** LLM routing should detect `language` from the input. Verify that the reply
generation nodes are prompted to respond in the detected language.

### 8. Runner multi-turn POST sequencing — **PARTIAL / READY FOR RUNTIME GATE 1**

**File:** `scripts/run-stage4-autonomous-dry-run.js`

**Single-turn preflight — IMPLEMENTED / NOT YET RUN:**
The runner supports `--only <id> --turn <n> --execute` to build a full preflight:
- Resolves webhook URL from `N8N_WEBHOOK_BASE_URL || localhost:5678`
- Validates `WHATSAPP_DRY_RUN=true` before allowing execution (refuses if not set)
- Prints post_body preview, expected nodes to verify, no-mutation tables
- **POST guard is active** — does not POST. Runtime gate 1 will add `--run`.

**Multi-turn POST sequencing — PENDING:**
To execute full multi-turn scenarios:
- For each scenario, iterate through turns
- POST each turn's `post_body` to the webhook
- Wait for n8n execution to complete (same poll pattern as Mode A runner)
- Capture state after each turn
- Pass the rolling n8n max_execution_id forward

---

## Staff / business review fields

Each scenario JSON has a `staff_review_notes` field at the top level and `expected_bot_behavior`
per turn. After any runtime execution:
- Ale/Cami should review draft text quality per turn
- Verify tone, accuracy, and policy correctness
- Flag any config value mismatches
- Flag any handoff decisions that seem wrong

Real WhatsApp send remains NOT approved. Live autonomous operation remains NOT approved.
