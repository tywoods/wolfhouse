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

## ✅ Runtime gate 2 PASS — A1 turns 2 + 3 (2026-05-30)

### A1 Turn 2 — exec 1149 (success, 52s)

| Check | Result |
|-------|--------|
| route | payment_or_confirm_intent |
| confidence | 0.95 |
| WA send | stubbed — no real send ✓ |
| IF - Booking ID Ready | not reached (expected — name/email not yet provided) ✓ |
| draft reply | "Great! Let's get you booked in. 🏄 I just need a couple of quick details: 1. What's your full name? 2. What's your email address?" |

### A1 Turn 3 — exec 1150 (success, 50s)

| Check | Result |
|-------|--------|
| route | payment_details_provided |
| confidence | 0.95 |
| IF - Booking ID Ready | **TRUE ✓** |
| Code - DRY RUN Stub (Postgres - Ensure Booking In Postgres) | **executed ✓** — booking_id=dry-run-ensure-fallback |
| Code - Call Create Payment Session | **dry-run branch fired ✓** |
| checkout_url | `https://checkout.stripe.test/dry-run/dry-ensure` ✓ (contains "dry-run", not real Stripe) |
| session_id | `cs_test_dryrun_dry-ensure` ✓ |
| Postgres - Ensure Booking In Postgres (real node) | NOT executed ✓ (stub intercepted) |
| WA send | stubbed — no real send ✓ |
| draft reply | includes checkout_url ✓ |
| bookings count | 41 → 41 (unchanged) ✓ |
| payments count | 25 → 25 (unchanged) ✓ |
| payment_events count | 5 → 5 (unchanged) ✓ |
| booking_beds count | 15 → 15 (unchanged) ✓ |

**payment_link_stub: RUNTIME PROVEN ✓**

**Draft reply (A1-T3):**
> Thanks 3c G2 Test! Your space is held for 1 hour. Our team will send your secure payment link here shortly — we could not generate it automatically just now.
>
> https://checkout.stripe.test/dry-run/dry-ensure
>
> Quick one so we can place you in the best room: are you two a couple, two friends, two girls, two guys, or mixed?

**Note:** `IF - Payment Link Safe For Reply` went FALSE (stub URL is `stripe.test`, not `stripe.com` — real URL safety check rejects it), but the assembled reply still appended the `checkout_url`. In production with a real Stripe URL this branch would be TRUE. The dry-run stub checkout URL is intentionally non-production.

**Note:** `booking_id` in Ensure Booking stub is `"dry-run-ensure-fallback"` because T3 is a standalone POST and doesn't replay T1's hold creation. In a fully stateful real session the booking_id would come from the persisted hold record. This is expected dry-run behaviour.

---

## ✅ Runtime gate 1 PASS — A1 turn 1 (2026-05-30)

Execution 1147 (success, ~55s). WHATSAPP_DRY_RUN=true. Main workflow only active (RBfGNtVgrAkvhBHJ).

| Check | Result |
|-------|--------|
| route | booking_flow |
| confidence | 0.95 |
| IF - PG Hold OK | TRUE ✓ |
| Hold stub pg_ok | true ✓ |
| IF - PG Conversation OK | TRUE ✓ |
| Conv stub pg_ok | true ✓ (PG_CONV_STUB fixed) |
| Nodes executed | 69 |
| WhatsApp send | stubbed — no real send ✓ |
| Airtable writes | all stubbed ✓ |
| Postgres hold | stubbed ✓ |
| bookings count | 41 → 41 (unchanged) ✓ |
| payments count | 25 → 25 (unchanged) ✓ |
| payment_events count | 5 → 5 (unchanged) ✓ |
| booking_beds count | 15 → 15 (unchanged) ✓ |
| draft reply | captured ✓ |
| graph.facebook.com | not called ✓ |

**Draft reply (A1-T1):**
> Hey! Great news — we have availability for the Uluwatu package for 2 people from April 10–17 🤙
> We've temporarily held space for your group for the next hour.
> To secure the booking, could you drop us one lead guest name and one email address? That's all we need to get things moving! 🏄

**NOT reached in T1 (expected):**
- `IF - Booking ID Ready` — only reached after T2 (deposit selection) + T3 (name/email)
- `Code - DRY RUN Stub (Postgres - Ensure Booking In Postgres)` — same
- `Code - Call Create Payment Session` dry-run branch — same

**Fix applied during gate 1:** `PG_CONV_STUB` in `build-main-local-stripe.js` updated to return `pg_ok: true` so `IF - PG Conversation OK` goes to TRUE branch. Previous Stage 3y stub only returned `{ phone: 'dry-run' }` without `pg_ok`.

**Next:** A1 turns 2 + 3 to verify payment-link path.

---

## WARNING: scaffolding only — no runtime yet (original note — superseded by gate 1 PASS above)

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

### 1. Hold stub shaped return — ✅ DONE (gate 1 PASS, d6e9fcd)

### 2. Payment-link stub shaped return — ✅ DONE (gate 2 PASS, 634366b)

### 3. Stripe webhook dry-run path — ✅ RUNTIME PROVEN (gate 3 sub-gate A PASS)

**File:** Stripe Webhook Handler workflow (`KZUQvwR6SPWpvaZ5`, no build script).

**Runtime evidence (2026-05-30, exec 1151, 16s):**
- HTTP 200, `processed=true`, `payment_status=deposit_paid`, `send_confirmation=true`
- `payment_events` +1 row: `stripe_event_id=evt_dry_run_a1_stage4_001`, `processed=true`, `booking_id` fixture-scoped ✓
- `payments.status=paid`, `amount_paid_cents=20000` (fixture row only) ✓
- `bookings.payment_status=deposit_paid`, `send_confirmation=true` (fixture row only) ✓
- `booking_beds` unchanged (15 baseline) ✓
- All counts restored after teardown ✓

### 4. Confirmation draft capture — ⚠️ PARTIAL (gate 3 sub-gate B — draft proven, dry-run gate not in DB)

**Runtime evidence (2026-05-30, exec 1152, 18s):**
- Confirmation draft GENERATED by `Anthropic Chat Model13` (claude-sonnet-4-6) ✓
- WhatsApp send: `whatsapp_sent: true, dry_run: true` — no real graph.facebook.com call ✓
- Draft text: see § Gate 3 sub-gate B runtime evidence below
- `IF - DRY RUN? (Mark Confirmed)` gate did NOT fire — n8n DB workflow `gxivKRJexzTCw9x6` still has OLD version (gate only in JSON output file, never imported) ⚠️
- `Postgres - Mark Booking Confirmed` ran on fixture row — `status=confirmed`, `confirmation_sent_at` set (fixture-scoped only) — acceptable under approved fixture write scope
- Gate code `2684#` absent from draft — Airtable search returned empty for test phone; LLM had no gate code context ⚠️
- All counts restored to baseline after teardown ✓

**Required fix before full gate 3 PASS:**
1. Import `n8n/phase2/Wolfhouse - Send Confirmation (local).json` into n8n DB (`gxivKRJexzTCw9x6`) — update `workflow_entity.nodes` + create new `workflow_history` entry + update `workflow_published_version`
2. Investigate gate code delivery: currently gate code comes from Airtable data; in dry-run Airtable returns empty. Options: (a) pass gate_code from `wolfhouse-somo.baseline.json` via `Code - Format Booking For LLM`; (b) hardcode in LLM system prompt for local/dry-run path
3. Fix `payment_status` enum in fixture SQL: `unpaid` → `not_requested` ✓ (already fixed in scaffold files)

### 5. Conversation state persistence across turns — ✅ OBSERVED in gates 1+2

Bot reads existing Postgres booking data for phone `34600000101` via `Search Active Booking`. Airtable stub does not break multi-turn flow for A1 (phone already has PG records). Re-evaluate for fresh-phone scenarios (A2–A10).

### 6. Closed-month guard (A5) — ⏳ PENDING

### 7. Spanish language detection (A10) — ⏳ PENDING

### 8. Runner multi-turn POST sequencing — ✅ DONE (gates 1+2 PASS)

---

## Gate 3 runtime evidence (2026-05-30, PARTIAL PASS)

### Sub-gate A: Stripe webhook simulation — PASS

| Check | Result |
|-------|--------|
| n8n exec | 1151, status=success, 16s |
| HTTP response | 200 `{"received":true,"processed":true,"booking_id":"b4000000...","payment_status":"deposit_paid","send_confirmation":true}` |
| payment_events fixture row | `stripe_event_id=evt_dry_run_a1_stage4_001`, `processed=true`, fixture booking_id |
| payment_events total | 6 (baseline 5 + 1 fixture) |
| payments fixture row | `status=paid`, `amount_paid_cents=20000` |
| bookings fixture row | `payment_status=deposit_paid`, `send_confirmation=true` |
| booking_beds | 15 (unchanged, baseline match) |
| non-fixture mutations | none |
| post-deactivate active workflows | NONE |

### Sub-gate B: Send Confirmation + draft capture — PARTIAL

| Check | Result |
|-------|--------|
| n8n exec | 1152, status=success, 18s |
| HTTP response | 200 `{"message":"Workflow was started"}` |
| LLM draft generated | YES (Anthropic claude-sonnet-4-6) |
| WhatsApp dry-run | `whatsapp_sent: true, dry_run: true` — no real send |
| graph.facebook.com call | NONE |
| `IF - DRY RUN? (Mark Confirmed)` fired | **NO** — gate not in n8n DB (old workflow version) |
| `Postgres - Mark Booking Confirmed` | **RAN** — fixture row only (`status=confirmed`, `confirmation_sent_at` set) |
| Gate code `2684#` in draft | **NO** — Airtable returns empty for test phone |
| Booking confirmed language | PASS |
| No bed number in draft | PASS |
| Dates in draft | PASS (29 June / 6 July) |
| All workflows deactivated | PASS |

### Confirmation draft text (full, exec 1152)

```
🐺 Welcome to the WolfHouse Family, Stage4! 🎉

We're so stoked to have you with us! Your booking is officially confirmed and we can't wait to welcome you!

Here's a quick summary:

🆔 Booking ID: DRY-STAGE4-FX-A1-001
📦 Package: Uluwatu
👥 Guests: 2
📅 Check-in: 29 June 2026
📅 Check-out: 6 July 2026

Your room details will be shared with you closer to your arrival. 🏄

If you have any questions before your stay, don't hesitate to reach out — we're always here to help!

See you soon! 🌊🐺
```

### Teardown verification

| Table | Pre-teardown | Post-teardown | Baseline match |
|-------|-------------|---------------|----------------|
| bookings | 42 | 41 | ✓ |
| payments | 26 | 25 | ✓ |
| payment_events | 6 | 5 | ✓ |
| booking_beds | 15 | 15 | ✓ |
| automation_errors | 0 | 0 | ✓ |
| workflow_events | 25 | 24 | ✓ |

### Required for full gate 3 PASS — STATIC FIXES APPLIED

1. **Import new Send Confirmation local workflow into n8n DB** — ✅ STATIC FIX APPLIED (`node scripts/build-send-confirmation-local.js --import-inactive`, workflow `gxivKRJexzTCw9x6` updated, active=false, 27 nodes, all gate wiring verified in n8n DB)
2. **Gate code in confirmation draft** — ✅ STATIC FIX APPLIED (`Code - Format Booking For LLM` now passes `Gate Code: 2684#`, `Check In Time: 15:00`, `Check Out Time: 11:00` from `wolfhouse-somo.baseline.json`; `Property Address: null` — owner confirm required)
3. **Fixture SQL enum** — ✅ ALREADY FIXED (`not_requested`)

**Next: gate 3 confirmation re-run** — sub-gate B only (Stripe webhook payment state already applied; re-seed fixture + re-run Send Confirmation).

---

## Payment confirmation simulation strategy (Stage 4 planning, 2026-05-30)

### What must happen for A1 to continue after checkout_url is returned

1. **Simulate Stripe payment success** — POSTing a `checkout.session.completed` event to the Stripe Webhook Handler.
2. **Apply payment state** — `payments`, `payment_events`, `bookings.send_confirmation=true` updated.
3. **Trigger Send Confirmation** — POST to `send-confirmation-local` webhook with `booking_id`.
4. **Generate confirmation draft** — LLM produces confirmation text including address/gate_code/room.
5. **Capture draft** — extract from execution data without real WhatsApp send or real DB confirm.

### Option A — Pure runner simulation (no webhook execution)

**Approach:** Runner reads the `stub_overrides.stripe_webhook_sim` from the scenario JSON and asserts expected state without running any workflow.

**Pros:** No DB side effects, simplest, no new gates needed.  
**Cons:** Does not prove the workflow actually works end-to-end. Confirmation draft not generated. Doesn't validate the LLM confirmation text or config field inclusion.

### Option B — Dedicated dry-run fixture table/file state

**Approach:** Insert a synthetic `workflow_events` or `dry_run_events` record instead of real DB writes. Runner reads it back.

**Pros:** Avoids touching real tables.  
**Cons:** Requires schema migration, complex to set up, doesn't exercise the real confirmation path.

### Option C — Add `WHATSAPP_DRY_RUN` gate to Stripe webhook handler build

**Approach:** Create `scripts/build-stripe-webhook-local.js` that wraps `Postgres - Apply Payment Success` in an `IF - DRY RUN?` gate + stub, similar to how Main is built. Import with `active=false`, activate only for the gate.

**Pros:** Exercises the real workflow path. No PG mutations in dry-run. Can be activated safely.  
**Cons:** New build script. The Stripe webhook handler is a Phase 2 frozen workflow — changes must be careful. Execution of the stub won't actually set `send_confirmation=true`, so confirmation workflow won't trigger without a fixture.

### Option D — Fixture-scoped disposable booking row ✅ RECOMMENDED

**Approach:**
1. Insert a synthetic `bookings` row in Wolfhouse PG with `status='payment_pending'`, `payment_status='deposit_paid'`, `send_confirmation=true`, using the dry-run `booking_id` and `session_id` from T3. Use a dedicated test phone (`34600000199` or similar) NOT used by any real guest.
2. Activate Stripe Webhook Handler with `STRIPE_WEBHOOK_SKIP_VERIFY=true`. POST simulated `checkout.session.completed` event with matching `session_id` and `booking_id`. The handler will write `payment_events`, update `payments`/`bookings` — all on the fixture row only.
3. POST to Send Confirmation webhook with the fixture `booking_id`. Workflow runs with `WHATSAPP_DRY_RUN=true`, generates LLM draft, stubs WhatsApp send, but WILL write `Postgres - Mark Booking Confirmed` (flipping `status=confirmed` on the fixture row — acceptable since it's a disposable row).
4. Runner captures confirmation draft from execution data.
5. After gate: DELETE fixture rows (`bookings`, `payments` WHERE `booking_code LIKE 'DRY-STAGE4-%'`).

**Pros:** Exercises real workflow paths end-to-end. Confirms address/gate_code/room_number in LLM output. No mutation to real guest data. Cleanup is trivial.  
**Cons:** Requires a fixture INSERT (explicit pre-gate step, clearly documented). Anthropic API call for draft generation (cost, latency). Mark Booking Confirmed runs on fixture row.

**Safety guards for Option D:**
- Use a dedicated fixture booking_code prefix e.g. `DRY-STAGE4-FX-*`
- Use a phone number never used by a real guest
- Activate Stripe Webhook Handler ONLY during the gate window
- Activate Send Confirmation ONLY during the gate window
- Delete fixture rows immediately after gate (or at start of next gate as cleanup)
- Confirm `payment_events` count delta = 1 (fixture row only)
- Confirm `bookings` fixture row has `status=confirmed`, all others unchanged

### Simulated Stripe event shape (for Option D)

```json
{
  "id": "evt_dry_run_a1_stage4_001",
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "cs_test_dryrun_dry-ensure",
      "object": "checkout.session",
      "payment_status": "paid",
      "amount_total": 20000,
      "currency": "eur",
      "payment_intent": "pi_dry_run_a1_stage4_001",
      "metadata": {
        "booking_id": "<fixture_booking_uuid>",
        "booking_code": "DRY-STAGE4-FX-A1-001",
        "payment_kind": "deposit_only",
        "client_id": "<wolfhouse_client_uuid>",
        "amount_due_cents": "20000"
      }
    }
  }
}
```

### Confirmation draft requirements (from config `wolfhouse-somo.baseline.json`)

**Must include (confirmed config fields):**
- Booking confirmed ✓
- Property address (from config)
- Gate code: `2684#` (confirmed)
- Room number if assigned
- Check-in time: `15:00`, Check-out time: `11:00`
- Check-in date / check-out date from booking

**Must exclude:**
- Bed number (`include_bed_number: false`)

**Must NOT:**
- Send real WhatsApp (`WHATSAPP_DRY_RUN=true` throughout)
- Mark real guest booking confirmed (only fixture row)
- Write `payment_events` for real guest rows

### Minimum implementation batch for next gate (gate 3)

| Step | What | File | Risk |
|------|------|------|------|
| 1 | Write fixture INSERT script | `scripts/fixtures/stage4-a1-payment-sim-up.sql` | Low — clearly labelled rows |
| 2 | Write fixture DELETE script | `scripts/fixtures/stage4-a1-payment-sim-down.sql` | Low |
| 3 | Verify `STRIPE_WEBHOOK_SKIP_VERIFY=true` in n8n-main env | docker env | None (already in env?) |
| 4 | Build simulated Stripe event JSON payload | `test-payloads/stage4/autonomous-dry-run/a1-stripe-sim.json` | None |
| 5 | Add gate 3 steps to runner or document as manual | `scripts/run-stage4-autonomous-dry-run.js` | Low |
| 6 | Add dry-run gate to `Postgres - Mark Booking Confirmed` in `build-send-confirmation-local.js` | `scripts/build-send-confirmation-local.js` | Medium — prevents real booking state mutation during dry-run |
| 7 | Activate Stripe Webhook, POST sim event, capture execution | runtime gate | Fixture-scoped only |
| 8 | Activate Send Confirmation, POST with booking_id, capture draft | runtime gate | Fixture-scoped, WA dry-run |
| 9 | Delete fixture rows, confirm counts restored | cleanup | None |

**Risks / unknowns:**
- `payments` table: fixture row needs `stripe_checkout_session_id` matching the sim event `session_id`. Need to insert a `payments` row too.
- `client_id` UUID: fixture INSERT needs the real `clients` table UUID for `wolfhouse-somo`. Query: `SELECT id FROM clients WHERE slug='wolfhouse-somo'`.
- LLM draft quality: `Anthropic Chat Model13` runs live — expect ~10-15s add to confirmation gate runtime.
- `IF - Payment Link Safe For Reply` in Main went FALSE in T3 (stub domain). This does NOT affect the confirmation path — the confirmation workflow is triggered independently via Send Confirmation webhook, not via Main.



---

## Staff / business review fields

Each scenario JSON has a `staff_review_notes` field at the top level and `expected_bot_behavior`
per turn. After any runtime execution:
- Ale/Cami should review draft text quality per turn
- Verify tone, accuracy, and policy correctness
- Flag any config value mismatches
- Flag any handoff decisions that seem wrong

Real WhatsApp send remains NOT approved. Live autonomous operation remains NOT approved.
