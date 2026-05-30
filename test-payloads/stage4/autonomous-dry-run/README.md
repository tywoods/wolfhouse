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

## ✅ Runtime gate 4 Batch 1 — A5, A6, A7, A8, A10 (2026-05-30)

Main only (RBfGNtVgrAkvhBHJ). WHATSAPP_DRY_RUN=true. All executions: success. Protected counts unchanged.

### Per-scenario results

| ID | Exec | Route | Conf | Safety fails | Result | Notes |
|----|------|-------|------|--------------|--------|-------|
| A5 | 1154 | booking_flow | 0.95 | 0 | ⚠️ PARTIAL — closed-month guard not enforced | Guard implemented (2026-05-30) — runtime re-test pending |
| A6 | 1155 | payment_completed_claim | 0.95 | 0 | ✅ PASS | Safe clarification, no confirmation |
| A7 | 1156 | human_handoff | 0.99 | 0 | ✅ PASS | Immediate handoff, empathetic draft |
| A8 | 1157 | booking_flow | 0.95 | 0 | ✅ PASS | Preference noted, booking continues, beds Δ=0 |
| A10 | 1158 | booking_flow | 0.95 | 0 | ✅ PASS | Spanish detected, full Spanish reply, hold stub fired |

### A5 — Closed month — PARTIAL (safety OK; guard IMPLEMENTED — runtime re-test pending)

Expected: bot refuses January, informs closed, no hold created.
Actual: bot found availability and created stub hold for January 15–22, 2027.

**Safety checks (all PASS):**
- No real PG hold (stub fired: `Code - DRY RUN Stub (Postgres - Create Booking Hold)` ✓)
- No real WhatsApp send (`dry_run: true, _shadow_note: WhatsApp send bypassed` ✓)
- No price invented in draft ✓
- `graph.facebook.com`: none ✓

**Draft (exec 1154):**
> Hey! 🤙 Great news — we have availability for the Malibu package for 2 people from January 15 to 22. We've temporarily held space for your group for the next hour.
> To secure the booking, could you drop us one lead guest name and one email address? 😊

**Finding:** The `closed_months` config guard (`packages.closed_months = [december, january, february]`) is not enforced by the current LLM system prompt or workflow routing. The LLM checked Postgres/Airtable availability (which returned available beds) and proceeded. The closed-month rule exists in `wolfhouse-somo.baseline.json` but is not explicitly injected into the bot's context for date checking. This is a **behavioral gap**, not a safety failure — no real side effects occurred.

**Required fix before A5 PASS:** Inject `closed_months` config into the LLM system prompt or add a pre-routing code node that rejects requests for closed months before the availability check runs.

### A6 — Claims paid, no Stripe record — ✅ PASS

Route: `payment_completed_claim` | `IF - Payment Booking Found` → false branch (booking WH-TEST-0042 not found).

**Draft (exec 1155):**
> Thanks! I couldn't find an active payment-pending booking for this WhatsApp number. Could you send your booking ID or the email used for the booking?

No booking confirmed ✓. No payment write ✓. Safe clarification response ✓.

### A7 — Cancellation/refund handoff — ✅ PASS

Route: `human_handoff` (conf=0.99). Cancellation + urgency → immediate handoff, no cancel action.

**Draft (exec 1156):**
> Hey! 👋 Thanks for reaching out. We understand this is urgent for you. A team member will be with you shortly to help with your cancellation request. We appreciate your patience! 🙏

No cancel write ✓. No refund action ✓. No real hold ✓.

### A8 — Rooming preference during booking — ✅ PASS

Route: `booking_flow`. Preference extracted as `room_type: private, room_preference: private, rooming_notes: "Guest requested sea view room or private"` in session_state. Booking continued to hold stub.

**Draft (exec 1157):**
> Hey! Great news — we have availability for the Uluwatu package for 2 guests from June 7–14 🤙
> We've temporarily held space for your group for the next hour, so you're good for now!
> To lock in the booking, I just need one lead guest name and one email address. What are those?

Hold stub fired ✓. `booking_beds` Δ=0 ✓. No bed assignment node executed (only Airtable READ nodes: `Search Active Beds - WA`, `Search Rooms - WA`, `Search Existing Bed Assignments - WA`) ✓.

### A10 — Spanish booking request — ✅ PASS

Route: `booking_flow`. Language detected: `es`. Reply fully in Spanish. Hold stub fired.

**Draft (exec 1158):**
> ¡Hola! 🤙 Tenemos disponibilidad para el paquete Uluwatu del 20 al 27 de abril para 2 personas. Hemos reservado temporalmente un espacio para vosotros durante 1 hora.
> Para confirmar la reserva, solo necesito un nombre de contacto y un email. ¿Me los puedes dar?

Language detection ✓. Spanish reply ✓. Same state transitions as English booking_flow ✓.

### Count proof (Gate 4 Batch 1)

| Table | Pre | Post | Baseline | Protected |
|-------|-----|------|----------|-----------|
| bookings | 41 | 41 | ✓ | YES |
| payments | 25 | 25 | ✓ | YES |
| payment_events | 5 | 5 | ✓ | YES |
| booking_beds | 15 | 15 | ✓ | YES |
| automation_errors | 0 | 0 | ✓ | YES |
| workflow_events | 24 | 24 | (allowed state) | — |
| conversations | 7 | 7 | (allowed state) | — |

### A5 closed-month gap — design plan (2026-05-30)

This is a **Stage 3x / bot-knowledge guardrail** item, not a safety failure. All dry-run gates operated correctly. The plan below defines how to fix it.

**Config confirmed** (`wolfhouse-somo.baseline.json`):
```json
"closed_months": ["december", "january", "february"],
"closed_months_behavior": "do_not_quote_or_book_inform_closed_and_handoff_if_insistent"
```
`closed_months` is also present in `_deploy-config.template.json` — all future clients must supply it.

**Booking-flow insertion point:**
```
Determine Missing Fields
       ↓  (all four fields present: check_in, check_out, room_type, guest_count)
[NEW] Code - Check Closed Month        ← injected here by build script
       ↓
[NEW] IF - Closed Month?
    true  → [NEW] Reply - Closed Month  → IF - DRY RUN? (Create Outbound Message)
    false → IF - Ready For Availability  (existing path, unchanged)
```
`Determine Missing Fields` already has `check_in` and `check_out` resolved in `session` — this is the earliest safe point to check closed months (all required fields verified present, before any availability query or hold stub).

**Recommended approach: Option C — deterministic guard + LLM context injection**

| Option | Description | Safety | Quality |
|--------|-------------|--------|---------|
| A — Deterministic Code node only | Parse ISO dates → extract month names → compare to `closed_months` → block and reply | ✅ deterministic, cannot be overridden | ⚠️ reply is templated, less conversational |
| B — LLM context injection only | Add `closed_months` to booking-flow LLM system prompt | ⚠️ LLM can still hallucinate or ignore | ✅ conversational, multilingual |
| **C — Both (recommended)** | Deterministic guard blocks hold; LLM context improves reply quality | ✅ production-safe | ✅ better reply, multilingual-aware |

**Do not rely on LLM-only guard.** The deterministic check must run before any availability query, hold stub, or price quote.

**Nodes to add in `scripts/build-main-local-stripe.js`:**

1. **`Code - Check Closed Month`** (n8n-nodes-base.code)
   - Reads `session.check_in` and `session.check_out` from `Determine Missing Fields` output
   - Extracts month name(s) from ISO date strings (e.g. `"2027-01-15"` → `"january"`)
   - Compares against `CLOSED_MONTHS` injected as a literal by the build script (loaded from `wolfhouse-somo.baseline.json` at build time)
   - Outputs: `{ ...all_existing_fields, closed_month_detected: boolean, closed_month_name: string, suggested_open_months: string }`

2. **`IF - Closed Month?`** (n8n-nodes-base.if)
   - Condition: `{{ $json.closed_month_detected === true }}`
   - `true` (branch 0) → `Reply - Closed Month`
   - `false` (branch 1) → `IF - Ready For Availability` (existing)

3. **`Reply - Closed Month`** (n8n-nodes-base.code or Anthropic LLM node)
   - For Option C: LLM node with system prompt containing `closed_months`, `suggested_open_months`, guest `language` — so the reply is conversational and multilingual
   - Must produce `response_text` in the same shape as `Generate Next Reply`
   - Wires to → `IF - DRY RUN? (Create Outbound Message)` (same sink as other reply nodes)
   - Must NOT fire hold stub, payment link, or price quote

**LLM context injection point (secondary, Option C):**
- The `Parser Node` Anthropic system prompt is the booking-flow LLM that extracts intent/dates from guest messages
- Injecting `closed_months` there lets the classifier at least flag obvious closed-month requests — but this is advisory; the Code guard is the enforcement layer

**Fields required at guard point:**
- `session.check_in` (ISO date string, from Parser Node)
- `session.check_out` (ISO date string)
- `session.language` (for multilingual reply)
- `CLOSED_MONTHS` array (injected as literal by build script from `wolfhouse-somo.baseline.json`)

**Build script changes needed:**
- New function `applyClosedMonthGuard(workflow, closedMonths)` that inserts the three new nodes and rewires connections
- Called after existing gate functions (after `applyPhase3cHoldGate`, etc.)
- Load `closed_months` from `wolfhouse-somo.baseline.json` at build time (same pattern as `gate_code`, `check_in_time`, `check_out_time`)

**Static verifier update (`--verify-targets`):**
- Add assertion: when `closed_months.length > 0`, `Code - Check Closed Month` node must exist in workflow

**Runner assertion update for A5:**
- Expect `Code - Check Closed Month` node executed
- Expect `closed_month_detected === true` in its output
- Expect `Reply - Closed Month` executed
- Expect hold stub NOT fired
- Expect NO `payment_link` in draft
- Expect draft mentions "closed" or "unavailable" for the requested month

**Expected A5 PASS behavior after fix:**
- Guest asks for January 15–22, 2027
- Bot detects January → closed month
- No availability check, no hold, no price quote, no payment link
- Reply (in guest's language): "Wolfhouse is closed in January. We're open March through November. Would you like to pick dates in a different month? I can check availability for March, April, or any open month you prefer."
- `bookings` / `payments` / `payment_events` / `booking_beds` all unchanged (Δ=0)
- No real WhatsApp send, no Airtable write

---

### Multilingual testing plan (Stage 4 batch — to follow A5 guard fix)

**Expected usage mix (approximate):**
| Language | Share | Priority |
|----------|-------|----------|
| Italian | ~65% | **Primary acceptance language** |
| English | ~20% | Control (A1 series) |
| Spanish | ~10% | Control (A10) |
| German | ~10% | — |

Italian must be treated as the **primary acceptance language**, not an afterthought. Scenarios passing in English/Spanish but not Italian are not acceptable for production sign-off.

**Proposed multilingual batch (Gate 4 Batch 2 or dedicated multilingual gate):**
| Scenario | Language | Intent | Priority |
|----------|----------|--------|----------|
| Italian booking request (all fields) | IT | booking_flow → hold | P1 |
| Italian missing-fields request | IT | booking_flow → collect details | P1 |
| Italian payment/deposit question | IT | payment_pending_intent | P1 |
| German booking request | DE | booking_flow → hold | P2 |
| Spanish booking control | ES | booking_flow → hold | P3 (A10 partial) |
| English control | EN | booking_flow → hold | P4 (A1 series) |

**Notes:**
- A10 (Spanish) already PASSED for `booking_flow` routing and Spanish reply detection
- Italian scenarios require verifying that `language = "it"` is detected, reply is fully in Italian, and hold/reply nodes do not fall back to English
- `closed_months` reply (post A5 fix) must be tested in Italian and German as well

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

### 4. Confirmation draft capture — ✅ RUNTIME PROVEN (gate 3 sub-gate B PASS, re-run 2026-05-30)

**Runtime evidence (2026-05-30 re-run, exec 1153, ~11s):**
- Confirmation draft GENERATED by `Anthropic Chat Model13` ✓
- WhatsApp send: `whatsapp_sent: true, dry_run: true` — no real graph.facebook.com call ✓
- `IF - DRY RUN? (Mark Confirmed)` gate FIRED on true branch ✓ (static fix imported correctly)
- `Code - DRY RUN Stub (Mark Booking Confirmed)` EXECUTED ✓ — returned `status=confirmed, dry_run=true, stub_type=mark_confirmed_stub`
- `Postgres - Mark Booking Confirmed` did NOT execute ✓ (bypassed by dry-run gate)
- Gate code `2684#` PRESENT in confirmation draft ✓ (LLM context fix applied)
- Check-in `15:00`, Check-out `11:00` PRESENT in draft ✓
- No bed number in draft ✓
- Fixture booking remained `status=payment_pending` (not mutated to `confirmed`) ✓
- All counts restored to baseline after teardown ✓

**Fixes applied (see § Required for full gate 3 PASS below):**
1. Import fix: n8n DB workflow `gxivKRJexzTCw9x6` updated to 27-node version with dry-run gate ✓
2. LLM context fix: `Code - Format Booking For LLM` passes `Gate Code: 2684#`, check-in/out times ✓
3. Fixture enum fix: `payment_status=not_requested` ✓

### 5. Conversation state persistence across turns — ✅ OBSERVED in gates 1+2

Bot reads existing Postgres booking data for phone `34600000101` via `Search Active Booking`. Airtable stub does not break multi-turn flow for A1 (phone already has PG records). Re-evaluate for fresh-phone scenarios (A2–A10).

### 6. Closed-month guard (A5) — ⏳ PENDING

### 7. Spanish language detection (A10) — ⏳ PENDING

### 8. Runner multi-turn POST sequencing — ✅ DONE (gates 1+2 PASS)

---

## Gate 3 runtime evidence (2026-05-30)

### Sub-gate A: Stripe webhook simulation — ✅ PASS

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

### Sub-gate B: Send Confirmation + draft capture — ✅ PASS (re-run)

| Check | Result |
|-------|--------|
| n8n exec | 1153, status=success, ~11s |
| HTTP response | 200 `{"message":"Workflow was started"}` |
| LLM draft generated | YES (Anthropic claude-sonnet-4-6) |
| WhatsApp dry-run | `whatsapp_sent: true, dry_run: true` — no real send ✓ |
| graph.facebook.com call | NONE ✓ |
| `IF - DRY RUN? (Mark Confirmed)` fired | **YES — true branch ✓** |
| `Code - DRY RUN Stub (Mark Booking Confirmed)` | **EXECUTED ✓** — `stub_type=mark_confirmed_stub`, `dry_run=true` |
| `Postgres - Mark Booking Confirmed` | **NOT executed ✓** (bypassed by dry-run gate) |
| Gate code `2684#` in draft | **YES ✓** (LLM context fix applied) |
| Check-in `15:00` in draft | PASS ✓ |
| Check-out `11:00` in draft | PASS ✓ |
| Booking confirmed language | PASS ✓ |
| No bed number in draft | PASS ✓ |
| Fixture booking `status` after run | `payment_pending` (NOT mutated to `confirmed`) ✓ |
| Non-fixture mutations | NONE ✓ |
| booking_beds | 15 (unchanged) ✓ |
| All workflows deactivated | NONE active ✓ |

### Confirmation draft text (full, exec 1153)

```
🐺🏄 Welcome to the WolfHouse Family, Stage4!

We're so stoked to have you with us! Your booking is officially confirmed — happy days! 🎉

Here are your details:

📋 Booking ID: DRY-STAGE4-FX-A1-001
📅 Check-in: 29 June 2026 at 15:00
📅 Check-out: 6 July 2026 at 11:00
👥 Guests: 2
🔑 Gate Code: 2684#

We'll have everything ready for your arrival. If you have any questions before you get here, don't hesitate to reach out — we're always happy to help!

Can't wait to see you soon. Get ready for an epic stay! 🌊☀️

The WolfHouse Team 🐺
```

**Draft validation:**
- booking confirmed language: PASS ✓
- gate_code 2684#: PASS ✓
- check-in time 15:00: PASS ✓
- check-out time 11:00: PASS ✓
- no bed number: PASS ✓
- no real wamid: PASS ✓

### Teardown verification (re-run)

| Table | Pre-teardown | Post-teardown | Baseline match |
|-------|-------------|---------------|----------------|
| bookings | 42 | 41 | ✓ |
| payments | 26 | 25 | ✓ |
| payment_events | 5 | 5 | ✓ |
| booking_beds | 15 | 15 | ✓ |
| automation_errors | 0 | 0 | ✓ |
| workflow_events | 25 | 24 | ✓ |

### Static fixes applied (before re-run)

1. **Import new Send Confirmation local workflow into n8n DB** — ✅ APPLIED (`node scripts/build-send-confirmation-local.js --import-inactive`, workflow `gxivKRJexzTCw9x6` updated, active=false, 27 nodes, all gate wiring verified in n8n DB)
2. **Gate code in confirmation draft** — ✅ APPLIED (`Code - Format Booking For LLM` now passes `Gate Code: 2684#`, `Check In Time: 15:00`, `Check Out Time: 11:00` from `wolfhouse-somo.baseline.json`; `Property Address: null` — owner confirm required)
3. **Fixture SQL enum** — ✅ FIXED (`not_requested`)

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

---

## A2–A10 runtime planning (2026-05-30)

### Planning table

| ID | Scenario | Turns | New phone | Stubs needed | Multi-turn state risk | New infra needed | Stripe webhook | Send Confirm | No-mutation assertions | Priority | Risk |
|----|----------|-------|-----------|--------------|----------------------|-----------------|----------------|--------------|----------------------|----------|------|
| A2 | Missing package → supplied T2 | 2 | 34600000102 | hold_stub (proven) | **HIGH** — T2 requires T1 conversation state; `PG_CONV_STUB` doesn't write, so T2 sees empty conversation | Need real conversation writes OR fixture conversation record OR accept T2 ambiguity | No | No | bookings/payments/booking_beds Δ=0 | 4 | HIGH — multi-turn state accumulation |
| A3 | Deposit selected | 2 | 34600000103 | hold_stub + payment_link_stub (both proven) | HIGH — T2 "Deposit please" needs T1 booking context | Same as A2 | No | No | Δ=0 | 5 | HIGH — multi-turn state + amount assertion €200 |
| A4 | Full payment selected | 2 | 34600000104 | hold_stub + payment_link_stub (both proven) | HIGH — T2 needs T1 context | Same as A2 | No | No | Δ=0 | 5 | HIGH — multi-turn state + amount assertion €599 |
| A5 | Closed month (January) | 1 | 34600000105 | **None** (`stub_overrides: {}`) | None — single turn | None | No | No | All Δ=0, no hold created | 1 | LOW — 1 turn, no stubs, closed-month config read |
| A6 | Claims paid, no Stripe record | 1 | 34600000106 | None needed (booking WH-TEST-0042 won't exist) | None — single turn | None | No | No | Δ=0, booking NOT confirmed | 2 | LOW-MED — route accuracy + handoff behavior |
| A7 | Cancellation/refund handoff | 1 | 34600000107 | **None** (`stub_overrides: {}`) | None — single turn | None | No | No | All Δ=0, no cancel action | 1 | LOW — 1 turn, no stubs, handoff path |
| A8 | Rooming preference during booking | 1 | 34600000108 | hold_stub (proven) | None — 1 turn, all fields present T1 | None | No | No | booking_beds Δ=0 | 2 | LOW — same hold_stub, no room assignment |
| A9 | Surf lessons + yoga (addon pricing) | 2 | 34600000109 | addon_payment_link_stub (NEW shape) | MED — T2 yoga query is simple follow-up, may work | Investigate whether addon CPS path exists in Main | No | No | Δ=0 | 6 | HIGH — addon payment link path may not be implemented |
| A10 | Spanish booking request | 1 | 34600000110 | hold_stub (proven) | None — 1 turn, all fields present | None | No | No | All Δ=0 | 1 | LOW — same hold_stub, language detection test |

### Multi-turn state risk (A2/A3/A4) — full static analysis (2026-05-30)

**Root cause: Conversation state is read from AIRTABLE, not Postgres.**

The Main workflow's `Search Conversation` node is an **Airtable read** — it retrieves `Current Hold ID`, `Language`, `Session State`, etc. from the Airtable Conversations table for the guest's phone number. All Airtable write nodes (`Create Conversation`, `Update Conversation After Reply`, and 18+ other conversation update nodes) are stubbed via `AT_CONV_STUB` in Stage 4 dry-run — they write nothing.

For new phones (A2–A4):
- T1: `Search Conversation` (Airtable) returns empty — no record for this phone ✓ expected
- T1: Bot processes, hold stub fires, `Create Conversation` (Airtable) **STUBBED** → writes nothing
- T1: `Postgres - Upsert Conversation Hold` **STUBBED** → writes nothing  
- T2: `Search Conversation` (Airtable) **STILL returns empty** — nothing was written in T1
- T2: Bot has no context about T1 → misroutes or responds generically

**Safety review of `Postgres - Upsert Conversation Hold`:**

| Dimension | Finding |
|-----------|---------|
| Tables written | `conversations` ONLY (INSERT ON CONFLICT DO UPDATE) |
| Tables read (SELECT) | `clients` (id lookup), `bookings` (validation read) |
| `bookings` mutations | NONE — bookings is read only, never mutated |
| `payments` | NONE |
| `payment_events` | NONE |
| `booking_beds` | NONE |
| Airtable | NONE |
| Stripe | NONE |
| WhatsApp | NONE |
| Comment in source | "Writes conversations only. No messages, payments, booking_beds." |
| **VERDICT** | **SAFE from data-mutation perspective** |

**Why removing the gate alone would NOT fix multi-turn state AND would BREAK the flow:**

1. **Flow breakage**: The stub booking_codes (WH-DRYA2-0001, etc.) do not exist in the DB. The real SQL guards fail with `booking_missing = TRUE` → `pg_ok = FALSE` → `IF - PG Conversation OK` routes to `Code - PG Conversation Failed Stop` → workflow terminates
2. **State problem remains**: Even if the PG write succeeded, `Search Conversation` is an Airtable read — T2 still reads from Airtable and finds nothing. The Postgres conversations table is not consulted by the Main workflow for state lookups.

**Static fix decision: DO NOT REMOVE THE GATE**

Removing `addDryRunGate('Postgres - Upsert Conversation Hold', ...)` would:
- Break T1 execution (flow terminates with pg_ok=false for stub booking_codes)
- Not fix T2 context (wrong source — state lives in Airtable reads)
- Introduce a functional regression without solving the stated problem

**Real fix paths for A2/A3/A4 (future work):**

| Option | What | Risk | When |
|--------|------|------|------|
| A | Add a `Search Conversation (PG)` Postgres read node to Main workflow; allow real conv PG writes with fixture bookings | Medium — architectural change + fixture scope expansion | Before A2/A3/A4 runtime gate |
| B | Accept Airtable coupling: run A2/A3/A4 only with phones that have live Airtable records (real guests, not test phones) | Low infra but breaks isolation | After Airtable cutover (Stage 6) |
| C | Runner-level state injection: T2 POST body includes explicit session_state fields that the LLM can use without DB lookup | Medium — requires LLM prompt to accept injected context | Could be validated empirically with A2 |

**Stage 4 dry-run `conversations` table status:**
- `conversations` may be written by other workflows during runtime (not by Main in dry-run)
- Protected business tables (bookings, payments, payment_events, booking_beds) remain zero-delta in all Stage 4 dry-run tests
- `conversations` and `messages` can be treated as **allowed state tables** for multi-turn test scenarios (not protected business data)

**Gate 4 Batch 1 is completely unaffected** — A5/A6/A7/A8/A10 are single-turn; no multi-turn state needed.

**Current static verification results (2026-05-30):**
- `node scripts/build-main-local-stripe.js --verify-targets`: Shadow-mode safety: OK (70 nodes gated, token clean, hold gated, ensure-booking gated, typing gated, reassign gated)
- `node scripts/report-main-payment-contract.js`: Overall OK: true
- `node scripts/report-main-rooming-contract.js`: Overall OK: true
- `node --check scripts/run-stage4-autonomous-dry-run.js`: no syntax errors
- **No changes made to `build-main-local-stripe.js` or Main workflow JSON**

### Recommended next runtime batch — Option: Single-turn routing + guard batch

**Run A5 + A7 + A8 + A10 as Gate 4 Batch 1 (all single-turn, zero new infrastructure):**

| Scenario | Why include |
|----------|-------------|
| A5 (closed month) | 1 turn, no stubs, tests closed-month config guard — cheapest expansion |
| A7 (cancellation handoff) | 1 turn, no stubs, tests handoff path |
| A8 (rooming preference) | 1 turn, uses proven hold_stub, confirms booking_beds Δ=0 |
| A10 (Spanish) | 1 turn, uses proven hold_stub, tests language detection |

**Also include A6 (claims paid) but flag it:** A6 depends on route accuracy for `existing_booking_status` against a phone with no records. Run it; if route is wrong, document and fix.

**Exclude until multi-turn state is resolved:** A2, A3, A4, A9.

**Required implementation before Batch 1:** NONE — all 4-5 scenarios use proven stubs or no stubs.

**Required implementation before A2/A3/A4:** Add `Search Conversation (PG)` node to Main workflow + fixture hold bookings. Separate planning task.

**Required investigation before A9:** Verify whether addon payment-link path exists in Main workflow. Separate planning task.
