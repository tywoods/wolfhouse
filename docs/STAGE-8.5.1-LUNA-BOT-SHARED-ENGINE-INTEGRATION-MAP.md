# Stage 8.5.1 — Luna Bot Shared Engine Integration Map

**Status:** PASS — planning/static mapping only (2026-06-02).
**Commit basis:** Stage 8.4.13 PASS at `902fa1b` — manual booking/payment MVP proven on Azure staging.
**Parent doc:** [`STAGE-8.4-MANUAL-BOOKING-CREATION.md`](STAGE-8.4-MANUAL-BOOKING-CREATION.md)
**Non-negotiables:** No code changes. No DB writes. No Azure deploy. No WhatsApp sends. No n8n activation. No Stripe changes. No new production flags. Docs and static mapping only.

---

## 1. Current proven shared engine (Stage 8.4)

The following chain is fully proven on Azure staging (commit `902fa1b`, Stage 8.4.13):

```
Staff Portal
  ↓ form input: dates / guests / package / room_type / add_ons / payment_choice
  ↓
  [1] calculateWolfhouseQuote(input)          ← scripts/lib/wolfhouse-quote-calculator.js
      Pure JS, no DB, no network
      Input:  client_slug, check_in, check_out, guest_count,
              package_code, room_type, payment_choice, add_ons
      Output: total_cents, deposit_required_cents,
              payment_link_amount_cents, balance_due_cents,
              line_items[], quote_snapshot, formula_summary
  ↓
  [2] POST /staff/quote-preview               ← staff-query-api.js
      Auth-gated (viewer+). No DB write.
      Returns full quote snapshot (preview_only:true).
  ↓
  [3] POST /staff/manual-bookings/create      ← staff-query-api.js
      Gate: MANUAL_BOOKING_ENABLED=true + STAFF_ACTIONS_ENABLED=true
      Calls calculateWolfhouseQuote() server-side from request body.
      Amounts never trusted from client.
      Writes:
        - bookings row (booking_code, total_amount_cents, deposit_required_cents,
                        balance_due_cents, requested_room_type, quote_snapshot in metadata)
        - payments row (status=draft, payment_kind, amount_due_cents = payment_link_amount_cents)
      Returns: booking_id, booking_code, payment_id
  ↓
  [4] POST /staff/payments/:id/create-stripe-link ← staff-query-api.js
      Gate: STRIPE_LINKS_ENABLED=true + STAFF_ACTIONS_ENABLED=true
      Reads amount_due_cents from payments row (never from client).
      Creates Stripe Checkout Session (mode=payment, eur).
      Writes:
        - payments.status = checkout_created
        - payments.stripe_checkout_session_id, checkout_url, expires_at
      Returns: checkout_url
  ↓
  [5] POST /staff/stripe/webhook              ← staff-query-api.js
      HMAC-verified (stripe.webhooks.constructEvent).
      Event: checkout.session.completed
      Looks up payment by metadata.payment_id → fallback stripe_checkout_session_id.
      Writes (atomic BEGIN/COMMIT):
        - payments.status = paid, amount_paid_cents, paid_at, stripe_payment_intent_id
        - bookings.amount_paid_cents, balance_due_cents,
          payment_status (deposit_paid / paid / waiting_payment)
      Safety: no_whatsapp, no_email, no_n8n, no_confirmation_sent in every response.
  ↓
  [6] Booking detail drawer (Staff Portal)
      Reads from DB: payment truth fields (paid_at, checkout_url, payment_kind,
      stripe_checkout_session_id, stripe_payment_intent_id).
      Shows green "✓ Deposit paid ✓" banner when payment_status = deposit_paid.
```

**Proven local and on Azure staging:** booking `MB-WOLFHO-20260705-30e9d3` (€299/€200 deposit), Stripe link `cs_test_a1Mzhctx5`, signed `checkout.session.completed` webhook (HMAC-valid, no SKIP_VERIFY), DB: `pm_status=paid, bk_payment_status=deposit_paid`. No WhatsApp sent. n8n untouched.

---

## 2. Luna bot — current flow (as-found, static inspection)

**Source:** `n8n/Wolfhouse Booking Assistant  - Main.json` (not activated; dry-run only).

```
WhatsApp inbound message
  ↓
  Normalize Incoming Message (phone / guest_message)
  ↓
  Search Conversation (Airtable — conversation state, session state, pending action)
  ↓
  Parser Node (Claude Haiku — extracts intent, dates, guests, room_type, package,
               name, email, arrival_time, departure_time, needs_human, confidence)
  ↓
  Router Node (Claude Sonnet — classifies route:
               booking_flow / payment_or_confirm_intent / payment_details_provided /
               package_question / cancellation / rooming_update / human_request / unknown)
  ↓
  [booking_flow branch]
  Code - Check Bed Availability (Postgres query)
  ↓
  Create Hold in Airtable (booking record: dates, guest_count, room_type, status=Hold)
  ↓
  Bot reply: asks for guest name + email (WhatsApp)
  ↓
  [payment_or_confirm_intent / payment_details_provided branch]
  Code - Extract Guest Details
  Update Hold in Airtable (guest_name, email, phone)
  ↓
  HTTP call → Wolfhouse - Create Payment Session (n8n webhook)
    Reads: deposit_required_cents / total_amount_cents from Airtable booking record
    Uses STRIPE_DEFAULT_DEPOSIT_CENTS=20000 if deposit not set
    Creates Stripe Checkout Session DIRECTLY (n8n → Stripe API)
    Returns: checkout_url, stripe_checkout_session_id
  ↓
  Bot sends Stripe checkout_url via WhatsApp
  ↓
  [Stripe webhook — separate n8n workflow]
  Wolfhouse - Stripe Webhook Handler (n8n phase2)
    Verifies HMAC. Parses checkout.session.completed.
    Updates Airtable booking: status=Deposit_Paid / status=Paid
    (n8n Postgres node: updates bookings table payment_status if PG-coupled)
  ↓
  Send Confirmation (n8n Wolfhouse - Send Confirmation workflow)
    Gated by confirmation_eligibility check.
    Sends WhatsApp confirmation if WHATSAPP_DRY_RUN=false.
```

**Conversation/session state:** Stored in Airtable (`Conversations` table). Fields: `Session State` (JSON blob), `Current Hold ID`, `Pending Action`, `Language`, `Conversation Summary`, `Chat Transcript`.

**Bot parser output schema (key fields for booking creation):**
```json
{
  "intent": "booking_request",
  "check_in": "YYYY-MM-DD",
  "check_out": "YYYY-MM-DD",
  "guest_count": 2,
  "room_type": "shared",
  "room_preference": "shared",
  "package": "malibu",
  "name": "Ana",
  "email": "ana@example.com",
  "phone": "+34...",
  "custom_extras": [],
  "needs_human": false,
  "confidence": 0.95
}
```

**No bot parser/session files exist in `scripts/`** — all bot logic lives in n8n workflow JSON nodes. There is no standalone bot session manager, bot parser module, or guest conversation state handler outside n8n.

---

## 3. Luna target flow — using the shared engine

This is the target architecture for Luna guest bookings. No implementation here — map only.

```
WhatsApp inbound message
  ↓
  [UNCHANGED] Normalize / Search Conversation / Parser / Router
  ↓
  [booking_flow branch]
  Code - Check Bed Availability (Postgres — UNCHANGED)
  ↓
  [NEW] Before creating hold: call POST /staff/quote-preview (or internal equivalent)
        Input: dates, guests, package, room_type, add_ons
        Output: quote_snapshot, line_items, total_cents, deposit_required_cents
        Purpose: establish pricing truth BEFORE creating booking record
  ↓
  POST /staff/manual-bookings/create (or bot-equivalent /bot/bookings/create)
    Gate: new bot-specific flag (e.g. BOT_BOOKING_ENABLED) OR reuse MANUAL_BOOKING_ENABLED
    Calls calculateWolfhouseQuote() server-side (NOT from Airtable amounts)
    Writes: bookings + booking_beds + payments (draft) — same as Staff Portal
    Returns: booking_id, payment_id, booking_code, quote_snapshot
  ↓
  Ask guest: deposit or full payment? (WhatsApp)
  ↓
  POST /staff/payments/:id/create-stripe-link (or bot-equivalent)
    Reads amount from payments.amount_due_cents (never from guest message)
    Creates Stripe Checkout Session
    Returns: checkout_url
  ↓
  WHATSAPP_DRY_RUN=true  → log/draft checkout_url, do NOT send via WhatsApp
  WHATSAPP_DRY_RUN=false → send checkout_url via WhatsApp (requires separate approval)
  ↓
  [Stripe webhook — SHARED]
  POST /staff/stripe/webhook (SAME endpoint as Staff Portal)
    HMAC-verified. Updates payments + bookings.
    payment_status → deposit_paid or paid
    Emits: no_whatsapp, no_confirmation_sent (webhook only marks payment truth)
  ↓
  [Confirmation eligibility check — SEPARATE, GATED]
  Only AFTER webhook marks payment_status = deposit_paid / paid:
    Check confirmation_eligibility (beds assigned, rooming complete, etc.)
    WHATSAPP_DRY_RUN=true  → draft confirmation, do NOT send
    WHATSAPP_DRY_RUN=false → send confirmation via WhatsApp (requires separate approval)
```

**Key principle:** Luna must never calculate package pricing in prompt text, never derive Stripe amount from raw Airtable fields, and never create a Stripe session outside the shared engine path.

---

## 4. Required data Luna must collect before creating a booking

Luna must have ALL of the following before calling the shared booking create path:

| Field | Source | Notes |
|-------|--------|-------|
| `check_in` | Parser Node | YYYY-MM-DD; required |
| `check_out` | Parser Node | YYYY-MM-DD; required |
| `guest_count` | Parser Node | ≥ 1; required |
| `package_code` | Parser Node / prompt | `malibu` / `uluwatu` / `waimea`; if unknown, bot must ask |
| `room_type` | Parser Node | `shared` / `private` / `double`; default `shared` |
| `guest_name` | Parser Node / follow-up turn | Required before booking create |
| `phone` | Normalize Incoming Message | Already known from WhatsApp inbound |
| `email` | Parser Node / follow-up turn | Required for Stripe receipt |
| `payment_choice` | Follow-up turn | `deposit` / `full`; bot must ask |
| `add_ons` | Parser Node / follow-up turn | Optional array; default `[]` |

**Fields NOT required to be collected by Luna (handled server-side):**
- `total_amount_cents` — calculated by `calculateWolfhouseQuote()`, never from guest input
- `deposit_required_cents` — same; never from Airtable field or LLM output
- Stripe amount — derived from `payments.amount_due_cents`, never from conversation

**Current gap:** The bot parser currently extracts `package` as `malibu / uluwatu / waimea / custom / unknown / null`. If `package` is `unknown` or `null`, the shared engine will return a blocked quote (`confidence: blocked`). Luna must handle this case by asking the guest to choose a package before proceeding.

---

## 5. Integration points — mapping bot/n8n nodes to shared engine calls

### 5.1 Availability preview / check

| Attribute | Detail |
|-----------|--------|
| **Existing implementation** | `Code - Check Bed Availability - WA` node in Main workflow. Queries Postgres directly for available beds/rooms. |
| **Target shared engine call** | No change needed for availability check itself. Availability logic (Postgres query) is already shared infrastructure. |
| **Gap** | None for availability. Bot calls Postgres availability query correctly. No pricing is involved in this step. |
| **Smallest next change** | None required. |

### 5.2 Create booking

| Attribute | Detail |
|-----------|--------|
| **Existing implementation** | Bot creates a "Hold" record in **Airtable** (not Postgres `bookings` table). Node: `Create Hold - Airtable`. Pricing amounts (`deposit_required_cents`, `total_amount_cents`) come from Airtable booking fields set by staff or synced from CSV — **not** from `calculateWolfhouseQuote()`. |
| **Target shared engine call** | `POST /staff/manual-bookings/create` (or a new bot-accessible variant). Must call `calculateWolfhouseQuote()` server-side. Must write to Postgres `bookings` + `booking_beds` + `payments` (draft). |
| **Gap** | **LARGE GAP.** Bot currently writes to Airtable, not Postgres. Bot does not call the quote calculator. The shared engine endpoint requires `MANUAL_BOOKING_ENABLED=true` + `STAFF_ACTIONS_ENABLED=true` and uses staff auth. Luna needs either: (a) these flags enabled for bot path, or (b) a new bot-specific booking create endpoint that calls the same internal functions but behind a bot auth gate. |
| **Smallest next change** | 8.5.4: Add a bot-accessible booking create endpoint (e.g. `POST /bot/bookings/create`) that internally calls `calculateWolfhouseQuote()` + the same SQL helper. No flag sharing with staff path. No auth session required (bot uses signed webhook or n8n internal token). |

### 5.3 Calculate quote

| Attribute | Detail |
|-----------|--------|
| **Existing implementation** | **Not called by bot.** The "Wolfhouse - Create Payment Session" n8n workflow reads `deposit_required_cents` from the Airtable booking record and uses `STRIPE_DEFAULT_DEPOSIT_CENTS=20000` as fallback. No formula, no package/season logic. |
| **Target shared engine call** | `calculateWolfhouseQuote(input)` in `scripts/lib/wolfhouse-quote-calculator.js`. Must be called server-side by the booking create endpoint, **not** by n8n Code node directly (to avoid duplicating pricing logic in n8n). |
| **Gap** | **LARGE GAP.** Bot completely bypasses the quote calculator. Pricing is ad hoc from Airtable fields. No quote snapshot stored. |
| **Smallest next change** | 8.5.3: Bot quote preview call from parsed booking details — dry-run only. N8n node calls `POST /bot/quote-preview` (or existing `/staff/quote-preview` with bot auth token) and logs the result. No DB write. Proves the parser-to-calculator handoff works. |

### 5.4 Create draft payment record

| Attribute | Detail |
|-----------|--------|
| **Existing implementation** | **Does not exist in bot path.** The bot goes directly from Airtable Hold → Stripe Checkout Session without creating a `payments` row first. |
| **Target shared engine call** | `POST /staff/manual-bookings/create` (step 3 in shared engine) creates a `payments` row (status=draft) atomically with the booking. The payment record's `amount_due_cents` is set from the quote output — never from the client/guest. |
| **Gap** | **LARGE GAP.** No draft payment record exists in the bot path today. The n8n "Wolfhouse - Create Payment Session" creates a Stripe session directly and optionally writes `checkout_url` back to the Airtable booking — but no `payments` row is created first. |
| **Smallest next change** | Resolved as part of 8.5.4 (bot booking create endpoint writes `payments` draft row). |

### 5.5 Create Stripe link

| Attribute | Detail |
|-----------|--------|
| **Existing implementation** | `n8n/phase2/Wolfhouse - Create Payment Session.json` — n8n workflow called from Main workflow. Code node `Code - Stripe Create Session` calls Stripe API directly using `STRIPE_SECRET_KEY` env var. Amount comes from `deposit_required_cents` / `total_amount_cents` Airtable fields. Idempotency: checks for existing `checkout_url` on the payment row (but no payment row is guaranteed to exist). |
| **Target shared engine call** | `POST /staff/payments/:id/create-stripe-link`. Reads `amount_due_cents` from `payments` row (created in step 5.4). Same Stripe Checkout Session creation logic, same metadata shape, same idempotency. |
| **Gap** | **LARGE GAP.** Bot calls Stripe directly from n8n using Airtable amounts. Shared engine reads from DB payment record. `payment_id` is required in Stripe metadata for webhook truth to work correctly with the shared webhook handler. Without `payment_id` in Stripe metadata, `POST /staff/stripe/webhook` cannot match the payment row. |
| **Smallest next change** | 8.5.4: After bot creates booking + draft payment via shared engine, bot calls `POST /staff/payments/:id/create-stripe-link` (or bot-accessible variant) to create Stripe link. `payment_id` must be in Stripe session metadata. |

### 5.6 Webhook truth

| Attribute | Detail |
|-----------|--------|
| **Existing implementation** | `n8n/phase2/Wolfhouse - Stripe Webhook Handler.json` — separate n8n workflow. Verifies HMAC. Parses `checkout.session.completed`. Updates Airtable booking status. Optionally updates Postgres `bookings.payment_status` if PG-coupled. Does NOT look up `payments` row by `payment_id` (relies on `booking_id` in metadata). |
| **Target shared engine call** | `POST /staff/stripe/webhook` in `scripts/staff-query-api.js`. Looks up `payments` row by `metadata.payment_id` → fallback `stripe_checkout_session_id`. Updates `payments` + `bookings` atomically. Returns `no_whatsapp, no_n8n, no_confirmation_sent:true`. |
| **Gap** | **MEDIUM GAP.** The existing n8n webhook handler works for the bot's Airtable path but does not update the `payments` table correctly (no `payment_id` in metadata because no `payments` row was created). For the shared engine path, the Staff Portal's `POST /staff/stripe/webhook` must be the webhook truth endpoint for both Staff Portal and Luna bot bookings. The n8n webhook handler becomes redundant once Luna uses the shared path. The Stripe webhook endpoint registered in the Stripe dashboard must point to `POST /staff/stripe/webhook`. |
| **Smallest next change** | 8.5.4 / 8.5.5: Ensure Stripe webhook endpoint (`we_1TdxY1G36qRefvdPmdvzA0Tm` on staging) is the shared endpoint. Luna bot bookings created via shared engine will automatically be handled by the same webhook. |

### 5.7 Confirmation eligibility

| Attribute | Detail |
|-----------|--------|
| **Existing implementation** | `n8n/Wolfhouse - Send Confirmation.json` workflow. Called from Main workflow after payment truth detected. Checks: booking status, payment status, beds assigned, rooming complete. Sends WhatsApp confirmation if `WHATSAPP_DRY_RUN=false`. |
| **Target shared engine call** | No change to confirmation logic yet. Confirmation send remains gated and must only fire AFTER `payments.status=paid` / `bookings.payment_status=deposit_paid` (from webhook truth). `WHATSAPP_DRY_RUN=true` gates the actual send. |
| **Gap** | **SMALL GAP.** The existing confirmation workflow already correctly gates on payment status. The gap is: confirmation currently reads payment truth from Airtable booking status, not from Postgres `payments` table. Once Luna uses the shared engine, confirmation eligibility should read from `bookings.payment_status` (Postgres) not Airtable. |
| **Smallest next change** | 8.5.5: Webhook-triggered confirmation draft. After `POST /staff/stripe/webhook` marks `bk_payment_status=deposit_paid`, a confirmation eligibility check queries Postgres and drafts (but does not send) a confirmation message. `WHATSAPP_DRY_RUN=true` must gate the send. |

---

## 6. Do not duplicate logic — hard rules

The following rules are binding for all future Luna bot implementation slices:

1. **Luna must not calculate package pricing in prompt text.** The LLM parser extracts `package_code` and booking fields — it must not generate, invent, or confirm price amounts in its output.
2. **Luna must not create Stripe amount directly.** No n8n Code node may call `Number(deposit_required_cents)` or `STRIPE_DEFAULT_DEPOSIT_CENTS` and pass it to Stripe. All amounts come from `calculateWolfhouseQuote()` output, stored in `payments.amount_due_cents`.
3. **Luna must call the same quote/payment path used by Staff Portal.** Either the exact same endpoints (with bot auth) or bot-specific variants that internally call the same functions (`calculateWolfhouseQuote`, `staff-manual-booking-create-sql.js`, etc.).
4. **Stripe webhook remains payment truth.** No bot node, no n8n Code node, no LLM output may mark a booking as paid. Only `POST /staff/stripe/webhook` (or the shared equivalent) may update `payments.status=paid` and `bookings.payment_status`.
5. **Quote snapshot must be stored.** The booking `metadata.quote_snapshot` must contain the full output of `calculateWolfhouseQuote()` at the time of booking creation. This provides an audit trail and prevents pricing drift.

---

## 7. Dry-run behavior — definition

| Flag | Effect on Luna bot |
|------|--------------------|
| `WHATSAPP_DRY_RUN=true` | Luna logs / drafts the Stripe payment link response but does **not** send it via WhatsApp. The `checkout_url` is available in logs/DB but the guest never receives it. |
| `WHATSAPP_DRY_RUN=true` | Luna drafts a confirmation message but does **not** send it via WhatsApp. Confirmation is only drafted after webhook truth marks payment_status correctly. |
| `WHATSAPP_DRY_RUN=false` | Live WhatsApp send is enabled. **This requires explicit separate approval and must not be enabled during integration mapping or dry-run slices.** |

**Gate hierarchy:**
1. `WHATSAPP_DRY_RUN=true` must be confirmed before any Luna bot payment link or confirmation work.
2. Live WhatsApp send requires a separate explicit approval step (8.5.7).
3. Confirmation send must ALWAYS be conditional on webhook truth (`payments.status=paid` or `bookings.payment_status=deposit_paid`). The bot must never send a confirmation based on a guest message claiming payment.

**n8n activation:** No n8n workflow may be activated as part of 8.5.1–8.5.6. Activation is a separate approval step.

---

## 8. Gap summary

| Integration Point | Bot Has Today | Shared Engine Requires | Gap Size |
|-------------------|--------------|----------------------|----------|
| Quote calculation | None — uses Airtable amounts + fallback constant | `calculateWolfhouseQuote()` server-side | **Large** |
| Booking create | Airtable Hold record | Postgres bookings + booking_beds + draft payments row | **Large** |
| Draft payment record | None | `payments` row (status=draft, amount from quote) | **Large** |
| Stripe link creation | n8n direct Stripe API call with Airtable amounts | `POST /staff/payments/:id/create-stripe-link` (amount from DB) | **Large** |
| `payment_id` in Stripe metadata | Not present (no payments row) | Required for webhook truth lookup | **Large** |
| Webhook truth | n8n Stripe Webhook Handler (Airtable + optional PG) | `POST /staff/stripe/webhook` (Postgres-only, HMAC) | **Medium** |
| Confirmation eligibility | Reads Airtable booking status | Must read Postgres `bookings.payment_status` | **Small** |
| Availability check | Postgres query (correct) | Same | **None** |
| Parser output | Extracts `package`, dates, guests, room_type, name, email | Must also capture `payment_choice` before Stripe step | **Small** |
| Conversation state | Airtable `Conversations` table | Airtable OK for now; Postgres migration is future | **Deferred** |

**Total gaps requiring implementation:** 6 large, 1 medium, 2 small.
**Total gaps deferred:** 1 (conversation state Airtable→Postgres migration; future stage).

---

## 9. Small implementation ladder (recommended slices)

Each slice is independently gated, independently provable, and does not depend on activating the next.

### 8.5.2 — Static verifier: identify bot workflow payment/booking nodes and gaps
**Goal:** Write a static verifier script that reads the Main workflow JSON, the Create Payment Session JSON, and the Stripe Webhook Handler JSON, and asserts that none of them contain direct pricing logic (`STRIPE_DEFAULT_DEPOSIT_CENTS`, hardcoded amounts) that would conflict with the shared engine.
**Type:** Docs/static inspection only. No DB. No n8n activation.
**Pass criteria:** Report of all payment-related Code nodes in bot workflows, with exact line references showing where amounts originate.

> **Stage 8.5.2 RE-SCOPED AND DELIVERED (2026-06-02):** Instead of a passive JSON-reading verifier, 8.5.2 delivered the actual Luna bot booking preview API endpoint `POST /staff/bot/booking-preview` in `scripts/staff-query-api.js`. This is the first working bridge from Luna/n8n to the shared engine. Static verifier `scripts/verify-staff-bot-booking-preview-api.js` 53/53 PASS. Local proof: missing-fields → `ask_missing_fields` + reply_draft; complete Malibu 5-night → `ready_for_create_dry_run` + `quote.total_cents=45000` + `preview_only:true` + `no_write_performed:true`. No DB writes. No Stripe. No WhatsApp. No n8n activation.

### 8.5.3 — Internal bot token auth for Luna endpoints — **PASS (2026-06-02)**
**Goal:** Allow n8n/Luna to call `POST /staff/bot/*` endpoints using a pre-shared `LUNA_BOT_INTERNAL_TOKEN` env secret, without requiring a browser staff session cookie. Unblocks dry-run n8n integration.
**Delivered:**
- `requireBotAuth()` function added to `scripts/staff-query-api.js`. Separate from `requireAuth` — normal staff auth unchanged.
- Auth priority for `/staff/bot/*`: (1) no-auth open mode (`STAFF_AUTH_REQUIRED=false`), (2) `X-Luna-Bot-Token` header or `Authorization: Bearer` header matching `LUNA_BOT_INTERNAL_TOKEN`, (3) normal session cookie fallback.
- Constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks.
- Token path disabled if `LUNA_BOT_INTERNAL_TOKEN` is empty — falls through to session auth (safe default).
- Wrong token → 401. Token not echoed in any response.
- Response includes `auth_mode: "bot_token"` when token auth used.
- Token auth scoped exclusively to `/staff/bot/*` route blocks. All other endpoints (`/staff/ui`, `/staff/manual-bookings/create`, `/staff/stripe/webhook`, etc.) use `requireAuth` exclusively.
- `LUNA_BOT_INTERNAL_TOKEN` read from `process.env` only. Not hardcoded anywhere.
**Verifier:** `scripts/verify-staff-bot-booking-preview-api.js` 65/65 PASS (12 new P-series checks). `verify-wolfhouse-quote-calculator.js` 77/77 PASS. `verify-staff-quote-preview-api.js` 33/33 PASS.
**Local proof:** no token → 401; wrong token → 401; correct `X-Luna-Bot-Token` → 200 + `auth_mode:bot_token` + `next_action:ready_for_create_dry_run`; `Authorization: Bearer` → 200 + `auth_mode:bot_token`; `/staff/ui` → 302 to login page (bot token irrelevant). No DB writes. No Stripe. No WhatsApp. No n8n activation.

### 8.5.4 — Bot create booking + draft payment endpoint — **PASS (2026-06-02)**
**Goal:** Allow Luna/n8n to create a booking using the shared Stage 8.4 engine: booking → quote_snapshot → draft payment → return `payment_id` for next slice. No Stripe link. No WhatsApp.
**Delivered:**
- `POST /staff/bot/bookings/create` added to `scripts/staff-query-api.js`.
- Gated by `BOT_BOOKING_ENABLED=false` (default) → 403. Separate from `MANUAL_BOOKING_ENABLED`.
- Auth: `requireBotAuth()` — bot token (`X-Luna-Bot-Token` / `Authorization: Bearer`) or session cookie.
- Bot token actor assigned `operator` role so `buildManualBookingCreateSql()` role check passes.
- Reuses shared SQL helper (`buildManualBookingCreateSql`), `calculateWolfhouseQuote()`, and the same `BEGIN/COMMIT/ROLLBACK` transaction path proven in Stage 8.4.
- Writes: `bookings` row + `booking_beds` + `quote_snapshot` in `bookings.metadata` + draft `payments` row.
- `selected_bed_codes` required for this slice (auto-assign is next slice).
- Idempotency key with `bot-` prefix.
- Returns: `booking_id`, `booking_code`, `payment_id`, `payment_status: "draft"`, `next_action: "create_stripe_link"`, `creates_stripe_link: false`, `sends_whatsapp: false`, `whatsapp_dry_run: true`, `auth_mode`.
- No Stripe API calls. No WhatsApp. No n8n. `no_stripe: true`, `no_n8n: true`.
**Verifier:** `scripts/verify-staff-bot-booking-create-api.js` **54/54 PASS** (new). All other verifiers: `verify-staff-bot-booking-preview-api.js` 65/65 · `verify-wolfhouse-quote-calculator.js` 77/77 · `verify-staff-quote-preview-api.js` 33/33 · `verify-staff-manual-booking-create-api.js` 50/50 — all PASS.
**Local proof:** wrong token → 401; `BOT_BOOKING_ENABLED=false` → 403; correct token + `BOT_BOOKING_ENABLED=true` + 2 bed codes → **201** + `booking_code: MB-WOLFHO-20260710-0417a3` + `payment_id: 312fea13...` + `next_action: create_stripe_link` + `creates_stripe_link: false` + `auth_mode: bot_token` + `quote.total_cents: 45000`. Test booking cleaned up after proof. No Stripe. No WhatsApp. No n8n.

### 8.5.5 — Bot Stripe link from draft payment — **PASS (2026-06-02)**
**Goal:** Allow Luna/n8n to create a Stripe Checkout link from the draft `payment_id` returned by 8.5.4. Returns `checkout_url` for the bot to share. No WhatsApp send.
**Delivered:**
- `POST /staff/bot/payments/:payment_id/create-stripe-link` added to `scripts/staff-query-api.js`.
- `BOT_PAYMENT_STRIPE_LINK_RE` regex for bot payment route (separate from existing `PAYMENT_STRIPE_LINK_RE`).
- Auth: `requireBotAuth()` — bot token or session cookie. Original `/staff/payments/:id/create-stripe-link` uses `requireAuth(operator)` unchanged.
- Gates: `BOT_BOOKING_ENABLED=true` + `STRIPE_LINKS_ENABLED=true` (no `STAFF_ACTIONS_ENABLED` required for bot path).
- Reuses same Stripe SDK call (`stripe.checkout.sessions.create`), same payment validation, same `UPDATE payments SET status='checkout_created'` SQL as Stage 8.4.9. Source metadata set to `bot_stage855`.
- Amount from `payments.amount_due_cents` — never from request body.
- Returns: `checkout_url`, `stripe_checkout_session_id`, `payment_status: "checkout_created"`, `next_action: "draft_payment_link_reply"`, `sends_whatsapp: false`, `whatsapp_dry_run: true`, `no_payment_truth_recorded: true`, `auth_mode`, `source: "luna_whatsapp"`.
- Does NOT mark paid. `amount_paid_cents` remains 0. `bookings.payment_status` unchanged. Payment truth remains via existing Stripe webhook.
- Idempotent: returns existing URL if session already created.
**Verifier:** `scripts/verify-staff-bot-stripe-link-api.js` **56/56 PASS** (new). `verify-staff-bot-booking-create-api.js` 54/54 · `verify-staff-bot-booking-preview-api.js` 65/65 · `verify-staff-stripe-payment-link-api.js` 55/55 · `verify-wolfhouse-quote-calculator.js` 77/77 — all PASS.
**Local proof:** wrong token → 401; correct token + `BOT_BOOKING_ENABLED=true` + `STRIPE_LINKS_ENABLED=true` → booking created (MB-WOLFHO-20260720-e466f4) → Stripe link → **200** + `checkout_url: https://checkout.stripe.com/c/pay/cs_test_...` + `payment_status: checkout_created` + `auth_mode: bot_token` + `amount_due_cents: 10000` + `sends_whatsapp: false`; DB: `payments.status=checkout_created`, `amount_paid_cents=0`, `bookings.payment_status=not_requested`. Test booking cleaned up. No WhatsApp. No n8n.

### 8.5.6 — Deploy Luna bot shared-engine endpoints to Azure staging — **PASS (2026-06-02)**
**Goal:** Deploy Staff API through Stage 8.5.5 to Azure staging and prove the three bot endpoints work over HTTPS with `LUNA_BOT_INTERNAL_TOKEN`. No n8n edits. No WhatsApp sends.
**Delivered:**
- Image `wh-staff-api:dec785c-stage855-bot-engine` built and pushed to ACR `whstagingacr`.
- `wh-staging-staff-api` updated to revision `wh-staging-staff-api--0000017`.
- `LUNA_BOT_INTERNAL_TOKEN` generated (40-char hex), stored in Key Vault `wh-staging-kv`, wired as env secret.
- `BOT_BOOKING_ENABLED=true`, `STRIPE_LINKS_ENABLED=true`, `WHATSAPP_DRY_RUN=true` confirmed on staging.
- `STAFF_AUTH_REQUIRED=true`, `STRIPE_WEBHOOK_SKIP_VERIFY=false` unchanged.
- Stripe test-mode key confirmed (`sk_test_...`).
**Hosted proof:**
- **A. Preview:** `POST /staff/bot/booking-preview` → 200 + `preview_only:true` + `no_write_performed:true` + `auth_mode:bot_token` + `quote.total_cents:25000`.
- **B. Create:** `POST /staff/bot/bookings/create` (bed `DEMO-R1-B1`) → 201 + `booking_code:MB-WOLFHO-20260801-4f10c3` + `payment_id:ec4938e8-c21f-434f-ae7c-c3db71b26e6a` + `creates_stripe_link:false` + `sends_whatsapp:false` + `whatsapp_dry_run:true`.
- **C. Stripe link:** `POST /staff/bot/payments/ec4938e8.../create-stripe-link` → 200 + `checkout_url:https://checkout.stripe.com/c/pay/cs_test_...` + `payment_status:checkout_created` + `no_payment_truth_recorded:true` + `sends_whatsapp:false`.
**Safety proof:** wrong token → 401; bot token on `/staff/ui` → 302 redirect (not opened); bot token on `/staff/manual-bookings/create` → 401; `payments.amount_paid_cents=0` (not marked paid before webhook); `payments.status=checkout_created`; Stripe test mode only. No WhatsApp. No email. No n8n. No workflow activated.
**Test booking:** `MB-WOLFHO-20260801-4f10c3` left on staging (disposable staging data, clearly labelled as Luna test).
**Verifiers:** All 6 verifiers PASS (65+54+56+60+77 checks) at commit `dec785c`.

### 8.5.7 — Wire Luna n8n dry-run to hosted shared booking/payment engine — **PASS (2026-06-02)**
**Goal:** Wire the Luna bot n8n workflow (dry-run only) to call the three hosted Staff API bot endpoints proven in Stage 8.5.6. No live WhatsApp sends. No n8n activation.
**Delivered:**
- New inactive workflow JSON: `n8n/Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json` (`active: false`, NOT imported into live n8n).
- 12 nodes: `WHATSAPP_DRY_RUN` guard (blocks if not `true`) → `Code - Parse Booking Fields` → `HTTP - Bot Booking Preview` → `IF - Missing Fields or Ready` → (missing: log draft reply, no send) OR (ready: `HTTP - Bot Booking Create` → `HTTP - Bot Stripe Link` → `Code - Draft Payment Link Reply` → respond).
- `X-Luna-Bot-Token: {{ $env.LUNA_BOT_INTERNAL_TOKEN }}` header on all Staff API calls — never hardcoded.
- No `graph.facebook.com` nodes — all WhatsApp sends bypassed in dry-run fork.
- No direct Stripe API calls (`api.stripe.com`). Stripe handled exclusively via Staff API bot endpoint.
- `STRIPE_DEFAULT_DEPOSIT_CENTS` NOT used as env var expression.
- `deposit_required_cents` (Airtable field) NOT used for Stripe amount.
- **GAP documented:** `selected_bed_codes` does not exist in the current live bot session state. The live flow assigns beds via Airtable "Search Active Beds - WA". Dry-run uses staging placeholder `DEMO-R1-B1`. Auto-assignment from availability is the next slice (Stage 8.5.8).
- Draft payment-link reply crafted with `checkout_url` from Staff API (not from n8n Stripe call). Message says "secure Stripe payment link" with deposit/full label from `payment_choice`.
- `_proof_no_direct_stripe: true`, `_proof_no_stripe_default_deposit_cents: true`, `_proof_sends_whatsapp_false: true` proof fields in draft reply node.
- Original main workflow (`Wolfhouse Booking Assistant  - Main.json`) and `Wolfhouse - Create Payment Session.json` untouched — still contains direct Stripe call.
- `no_payment_truth_recorded: true` in Stripe link response — payment truth via webhook only.
**Verifier:** `scripts/verify-luna-n8n-bot-shared-engine-dry-run.js` **31/31 PASS** (new). Checks: workflow inactive, three bot URLs present, `X-Luna-Bot-Token` from env, `WHATSAPP_DRY_RUN` guard, no `graph.facebook.com`, no `api.stripe.com`, no `STRIPE_DEFAULT_DEPOSIT_CENTS` env ref, no `deposit_required_cents`, `payment_id` dynamic in Stripe link URL, `no_payment_truth_recorded`, original workflow untouched, docs reference Stage 8.5.7 and Staff Ask Luna allowlist.
**Gap:** `selected_bed_codes` not in current live bot session state — requires Stage 8.5.8 bed availability lookup slice before dry-run can be imported and executed end-to-end.
**Activation status:** NOT imported into n8n. NOT activated. Dry-run wiring is static/local only pending bed availability gap resolution.

### 8.5.8 — Bed availability query endpoint for real `selected_bed_codes` — **PASS (2026-06-03)**
**Goal:** Add a read-only `/staff/bot/availability-check` endpoint so Luna/n8n can discover real available bed codes before calling `/staff/bot/bookings/create`, closing the Stage 8.5.7 staging placeholder gap.
**Delivered:**
- `POST /staff/bot/availability-check` added to `scripts/staff-query-api.js`.
- Auth: `requireBotAuth()` — bot token (`X-Luna-Bot-Token` / `Authorization: Bearer`) or session cookie.
- Input: `client_slug`, `check_in`, `check_out`, `guest_count`, `room_type` (optional), `gender_preference` (optional).
- DB queries (SELECT only): `getBedCalendarRoomsQuery()` (beds + rooms) and `getBedCalendarBlocksQuery()` (half-open overlap, excludes `cancelled`/`expired` booking statuses).
- Room-type filter: shared beds preferred for `room_type=shared`; private/double preferred for private; `room_type_filter_not_strict` warning if filter cannot be applied strictly.
- First-fit selection: `selected_bed_codes` = first N available beds for `guest_count`.
- Returns: `selected_bed_codes`, `has_enough_beds`, `available_count`, `available_beds[]`, `blockers[]`, `warnings[]`, `next_action` (`ready_for_bot_create` or `ask_staff_or_alternate_dates`).
- All safety fields: `preview_only:true`, `no_write_performed:true`, `creates_booking:false`, `creates_payment:false`, `creates_stripe_link:false`, `sends_whatsapp:false`.
- No INSERT / UPDATE / DELETE — read-only.
**Verifier:** `scripts/verify-staff-bot-availability-api.js` **39/39 PASS** (new). All prior bot verifiers PASS (39+54+65+77 checks).
**Local proof:** guest_count=2 → `selected_bed_codes:["DEMO-R1-B1","DEMO-R1-B2"]`, `has_enough_beds:true`, `next_action:ready_for_bot_create`; guest_count=999 → `has_enough_beds:false`, `blockers:["not_enough_available_beds"]`, `next_action:ask_staff_or_alternate_dates`; DB bookings count unchanged (0 writes). No Stripe. No WhatsApp. No n8n.

### 8.5.9 - Wire n8n dry-run workflow to availability-check - **PASS (2026-06-03)**
**Goal:** Update the inactive dry-run workflow (Stage 8.5.7) to call `/staff/bot/availability-check` (Stage 8.5.8) before `/staff/bot/bookings/create`, using the returned `selected_bed_codes` instead of the `DEMO-R1-B1` staging placeholder. Add not-enough-beds branch.
**Delivered:**
- `HTTP - Bot Availability Check` node added (POST `/staff/bot/availability-check`). Sends `client_slug`, `check_in`, `check_out`, `guest_count`, `room_type`, `package_code`, `gender_preference`. `X-Luna-Bot-Token` from `$env.LUNA_BOT_INTERNAL_TOKEN`.
- `IF - Has Enough Beds` branch: true → `HTTP - Bot Booking Create` with `selected_bed_codes` from availability response; false → `Set - Log No Beds Reply DryRun` (drafts "I'm checking with the team") → `Respond - DryRun No Beds`. No booking, no Stripe link, no WhatsApp send on false path.
- `selected_bed_codes` in booking-create body now references `$('HTTP - Bot Availability Check').first().json.selected_bed_codes` — `DEMO-R1-B1` placeholder REMOVED.
- `Code - Parse Booking Fields` cleaned up: no placeholder bed codes, `gender_preference` forwarded.
- Happy path: booking-preview → availability-check → (has beds?) → booking-create (real beds) → Stripe-link → draft payment reply.
- `active: false` — workflow not imported or activated. No Azure deploy. No DB writes. No Stripe. No WhatsApp.
**Verifier:** `scripts/verify-luna-n8n-bot-shared-engine-dry-run.js` **41/41 PASS** (updated). New checks: B4/B5 (availability-check URL + node), G2 (selected_bed_codes from avail node), G3 (DEMO-R1-B1 absent), G4/G5/G6 (wiring order via connections), H1–H4 (not-enough-beds branch), K2/K3 (docs 8.5.9 refs).

### 8.5.10 - Hosted Luna shared-engine dry-run execution - **PASS (2026-06-03)**
**Goal:** Import the Stage 8.5.9 dry-run workflow into staging n8n (inactive), run one manual execution with a fake guest booking payload, and prove the full shared-engine chain end-to-end without live WhatsApp.

**Delivered:**
- Workflow imported/updated in staging n8n as `stage8510SharedDryRun01` (`active:false`, 17 nodes including staging guard patch).
- Manual execution #4 (`mode:manual`, status:success, ~15s) with pinned webhook payload: phone `+34999000123`, guest Test Guest, email `test@example.test`, check_in 2026-08-15, check_out 2026-08-20 (5 nights), guest_count 2, malibu, shared, deposit, source luna_whatsapp.
- Happy path executed: `Set - DryRun Mode Flags` → `HTTP - Bot Booking Preview` → `HTTP - Bot Availability Check` → `HTTP - Bot Booking Create` → `HTTP - Bot Stripe Link` → `Code - Draft Payment Link Reply` → `Respond - DryRun Payment Link Success`.
- Staff API responses: preview quote (`ready_for_create_dry_run`); availability (`has_enough_beds:true`, real `selected_bed_codes`); create (`booking_code:MB-WOLFHO-20260815-4d37a0`, `payment_id`); Stripe link (`checkout_url`, `payment_status:checkout_created`).
- Dry-run output: `reply_draft` present, `whatsapp_sent:false`, `no_payment_truth_recorded:true`.
- Safety: no `graph.facebook.com`; no direct `api.stripe.com` in n8n; `STRIPE_DEFAULT_DEPOSIT_CENTS` not used as env/config fallback.
- Workflow left **inactive**. No activation. No live WhatsApp send.
- Test booking **left on staging** (disposable): `MB-WOLFHO-20260815-4d37a0`, phone `+34999000123`, payment checkout_created, not paid.

**Staging import note:** Staging n8n has `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` and no `LUNA_BOT_INTERNAL_TOKEN` on the n8n container. Import applied staging-only patches: `Set - DryRun Mode Flags` + `$json.dry_run` guard (same pattern as Stage 8.6.6) and bot token injection from Key Vault into HTTP header fields. Repo JSON unchanged in this slice.

**Next:** Stage 8.5.11 repo guard fix (same pattern as 8.6.6) — see §8.5.11.

### 8.5.11 - Repo staging-safe dry-run guard + credential auth - **PASS (2026-06-03)**
**Goal:** Update repo dry-run workflow JSON so it imports cleanly into staging n8n without manual `$env` patches when `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`.

**Delivered:**
- `Set - DryRun Mode Flags` Code node added after webhook: sets `dry_run:true`, `live_send_enabled:false` on inbound payload (no `$env`).
- `IF - DryRun Guard` updated to check `$json.dry_run === true` (boolean), not `$env.WHATSAPP_DRY_RUN`.
- All four bot HTTP nodes (`booking-preview`, `availability-check`, `bookings/create`, `payments/:id/create-stripe-link`) use n8n **Header Auth** credential placeholder `Luna Bot Internal Token (staging)` (`httpHeaderAuth`, empty id — bind token value at import; header name `X-Luna-Bot-Token` configured in credential).
- No hardcoded secrets. No `$env` in IF expressions. `active:false` retained. All branches keep `whatsapp_sent:false`. No `graph.facebook.com`. No `api.stripe.com`.
- `scripts/verify-luna-n8n-bot-shared-engine-dry-run.js` updated for 8.5.11 checks.

**Import note:** After re-import, create/bind Header Auth credential in staging n8n UI: Name=`X-Luna-Bot-Token`, Value=Key Vault `LUNA_BOT_INTERNAL_TOKEN`. Workflow not re-imported or activated in this slice.

**Proof:** Static verifier only. No hosted execution in 8.5.11.

### 8.5.12 - Staging-safe re-import + hosted proof (no patches) - **PASS (2026-06-03)**
**Goal:** Re-import the Stage 8.5.11 repo workflow into staging n8n, bind Header Auth credential, run one manual execution, and confirm it works **without** import-time `$env` or token header patches.

**Delivered:**
- Credential created in staging n8n: `Luna Bot Internal Token (staging)` (`stage8512LunaBotTok01`, type `httpHeaderAuth`, header name `X-Luna-Bot-Token`, value from Key Vault `luna-bot-internal-token`).
- Workflow updated from repo JSON as-is (`stage8510SharedDryRun01`, `active:false`, 17 nodes). No guard bypass. No manual token injection into HTTP header fields.
- Manual execution #5 (`mode:manual`, status:success, ~2s) with pinned payload: phone `+34999000123`, guest Test Guest, email `test@example.test`, check_in 2026-08-22, check_out 2026-08-27 (5 nights), guest_count 2, malibu, shared, deposit, source luna_whatsapp.
- Happy path: `Set - DryRun Mode Flags` (`dry_run:true`, `live_send_enabled:false`) → `IF - DryRun Guard` (pass on `$json.dry_run`) → booking-preview → availability-check → booking-create → Stripe link → draft payment reply.
- Results: `booking_code:MB-WOLFHO-20260822-3a4d1a`; `payment_status:checkout_created`; `checkout_url` via Staff API; `reply_draft` present; `whatsapp_sent:false`; `no_payment_truth_recorded:true`.
- Safety: no `dry_run_guard_blocked`; no `$env.WHATSAPP_DRY_RUN`; no `graph.facebook.com`; no direct `api.stripe.com` in n8n execution.
- Workflow left **inactive**. No activation. No live WhatsApp.
- Test booking **left on staging** (disposable): `MB-WOLFHO-20260822-3a4d1a`, phone `+34999000123`, payment checkout_created, not paid.

**Contrast with 8.5.10:** 8.5.10 required import-time patches for `$env` block + token injection. 8.5.12 proves the 8.5.11 repo JSON imports and runs cleanly with credential binding only.

### 8.5.13 - Luna-created booking webhook truth proof - **PASS (2026-06-03)**
**Goal:** Prove a booking created by the Luna shared-engine dry-run path reaches Stripe webhook payment truth — same `/staff/stripe/webhook` handler as Stage 8.4.13 manual-booking proof, but sourced from the bot chain (`source:bot_stage855`).

**Booking under test:** `MB-WOLFHO-20260822-3a4d1a` (created in Stage 8.5.12 n8n manual execution #5).

**Payment lookup (staging DB):**
| Field | Value |
|---|---|
| `booking_id` | `f970104d-22f2-453f-8b45-8fef18f89e6b` |
| `payment_id` | `a90d9cf6-5a8d-4741-94db-8e461796590f` |
| `stripe_checkout_session_id` | `cs_test_a122Kv5aHuDLB3kxYI4KWEaF6HATwKZoq99NArMjrRD4B64jGSus6TEMpE` |
| BEFORE webhook | `pm_status=checkout_created`, `amount_due_cents=10000`, `bk.payment_status=not_requested`, metadata `source:bot_stage855` |

**Webhook proof:**
- Signed test `checkout.session.completed` event sent to `https://staff-staging.lunafrontdesk.com/staff/stripe/webhook` using Key Vault `stripe-webhook-secret` + Stripe SDK test header (HMAC-valid; `STRIPE_WEBHOOK_SKIP_VERIFY=false`).
- Event metadata included `payment_id`, `booking_id`, `client_slug`, `source:bot_stage855`.
- Response **200**: `success:true`, `payment_status:deposit_paid`, `amount_paid_cents:10000`, `booking_balance_due_cents:40000`, `no_whatsapp:true`, `no_n8n:true`, `no_confirmation_sent:true`.

**DB AFTER (all PASS):**
| Assertion | Result |
|---|---|
| `payments.status=paid` | ✓ |
| `payments.amount_paid_cents=10000` | ✓ |
| `payments.paid_at` set | ✓ |
| `payments.stripe_payment_intent_id` set | ✓ |
| `bookings.payment_status=deposit_paid` | ✓ |
| `bookings.amount_paid_cents=10000` | ✓ |
| `bookings.balance_due_cents=40000` | ✓ |

**Staff Portal drawer proof (browser + API):**
- Login → Bed Calendar → open `MB-WOLFHO-20260822-3a4d1a` drawer.
- Green **Deposit paid ✓** banner; Total €500.00; Deposit required €100.00; Booking paid €100.00; Balance due €400.00.
- Payment row **Paid ✓** (Deposit only); paid_at `3 Jun 2026, 11:11`; truncated session/intent IDs; checkout URL + copy button.
- `GET /staff/bookings/MB-WOLFHO-20260822-3a4d1a/context` confirms same fields (9/9 drawer checks PASS).

**Safety:**
- No WhatsApp sent (`no_whatsapp:true` in webhook response; `WHATSAPP_DRY_RUN=true` on staging).
- No n8n activation; no workflow called.
- No confirmation send; no live guest message.

**Outcome:** Luna bot path booking → Staff API draft payment + Stripe checkout link → Stripe webhook → Postgres payment truth → Staff Portal drawer visibility. Same chain as manual booking (8.4.13), now proven for bot-created bookings. Test booking left on staging (disposable).

### 8.5.14 - Luna payment confirmation draft after webhook truth - **PASS (2026-06-03)**
**Goal:** After Stripe webhook records payment truth for Luna-created bookings, return a dry-run `confirmation_draft` in the webhook response — no WhatsApp send, no n8n, no `confirmation_sent` write.

**Delivered:**
- `buildPaymentConfirmationDraft()` added to `scripts/staff-query-api.js`.
- Webhook success response includes `confirmation_draft` when `bookings.payment_status` becomes `deposit_paid` or `paid`.
- Draft fields: `booking_code`, `guest_name`, `payment_status`, `amount_paid_cents`, `balance_due_cents`, `room_number` (`primary_room_code`), `address`/`gate_code` (from `config/clients/<slug>.baseline.json` when available; Wolfhouse gate `2684#`).
- Safety: `sends_whatsapp:false`, `whatsapp_dry_run:true`; existing `no_whatsapp`/`no_n8n`/`no_confirmation_sent` flags unchanged.
- Payment truth SQL/transaction logic unchanged. No `confirmation_sent_at` write. No `graph.facebook.com`. No n8n HTTP call.
- `verify-staff-stripe-webhook-api.js` extended with M-series checks; **69/69 PASS**.

**Not in this slice:** hosted re-fire on staging booking; live WhatsApp send (separate gate).

### 8.5.15 - Hosted confirmation_draft webhook proof - **PASS (2026-06-03)**
**Goal:** Deploy Stage 8.5.14 to Azure staging and prove `/staff/stripe/webhook` returns `confirmation_draft` after payment truth on a Luna-created booking.

**Azure deploy:**
- Image: `whstagingacr.azurecr.io/wh-staff-api:d3929b2-stage8515-confirmation-draft` (ACR build run `cbe`, commit `d3929b2`).
- Container App: `wh-staging-staff-api` revision `--0000020` (100% traffic, Healthy).

**Hosted webhook proof (booking `MB-WOLFHO-20260815-4d37a0`, Luna dry-run 8.5.10):**

| Check | Result |
|---|---|
| Webhook 200 | ✓ |
| `confirmation_draft` present | ✓ |
| `booking_code` | ✓ `MB-WOLFHO-20260815-4d37a0` |
| `payment_status:deposit_paid` | ✓ |
| `amount_paid_cents:10000` | ✓ |
| `balance_due_cents:40000` | ✓ |
| `room_number:DEMO-R1` | ✓ |
| `gate_code:2684#` | ✓ |
| `sends_whatsapp:false` | ✓ |
| `whatsapp_dry_run:true` | ✓ |
| `no_whatsapp/no_n8n/no_confirmation_sent:true` | ✓ |
| `confirmation_sent_at` unchanged | ✓ (null) |
| n8n `stage8510SharedDryRun01` inactive | ✓ |
| No WhatsApp sent | ✓ |

### 8.5.16 - Persist confirmation_draft in bookings.metadata - **PASS (2026-06-03)**
**Goal:** Store webhook `confirmation_draft` in `bookings.metadata.confirmation_draft` so Staff Portal/n8n can retrieve it later — no WhatsApp send.

**Delivered:**
- `buildPaymentConfirmationDraft()` result assigned once; reused for DB persist + webhook response.
- Booking UPDATE merges `metadata.confirmation_draft` via `jsonb_build_object('confirmation_draft', $draft::jsonb)` in same transaction as payment truth.
- Fields persisted match response: booking_code, guest_name, payment_status, amount_paid_cents, balance_due_cents, room_number, address, gate_code, sends_whatsapp:false, whatsapp_dry_run:true.
- No `confirmation_sent_at` write. No WhatsApp. No n8n. Payment truth SQL unchanged.
- `verify-staff-stripe-webhook-api.js` **76/76 PASS** (N-series checks).

**Not in this slice:** hosted staging re-proof; Staff Portal drawer read of metadata.confirmation_draft.

---

## 10. Files identified (static inspection, no changes made)

### Shared engine files (proven, read-only inspection)
| File | Role |
|------|------|
| `scripts/lib/wolfhouse-quote-calculator.js` | Pure quote calculator (Formula B) |
| `config/clients/wolfhouse-somo.pricing.json` | Pricing config fixture |
| `scripts/staff-query-api.js` | `POST /staff/quote-preview`, `/staff/manual-bookings/create`, `/staff/payments/:id/create-stripe-link`, `POST /staff/stripe/webhook` |
| `scripts/lib/staff-manual-booking-create-sql.js` | SQL helper for booking + payment create |
| `scripts/lib/staff-booking-detail-queries.js` | `getBookingPaymentsQuery()` — returns `payment_kind`, `currency`, `checkout_url`, `stripe_checkout_session_id` |

### Bot files (read-only inspection, no activation)
| File | Role | Integration status |
|------|------|-------------------|
| `n8n/Wolfhouse Booking Assistant  - Main.json` | Main bot workflow — parser, router, availability, hold, payment send | **NOT integrated with shared engine** |
| `n8n/phase2/Wolfhouse - Create Payment Session.json` | Creates Stripe session from Airtable amounts | **Replace with shared engine call** |
| `n8n/phase2/Wolfhouse - Create Payment Session (stub local).json` | Stub for local testing (returns dummy checkout_url) | **Replace with shared engine call** |
| `n8n/phase2/Wolfhouse - Stripe Webhook Handler.json` | Stripe webhook truth for bot path | **Replace/redirect to `/staff/stripe/webhook`** |
| `n8n/phase2/Wolfhouse - Stripe Checkout Success.json` | HTML success page (no DB writes) | **Keep as-is** |
| `n8n/Wolfhouse - Send Confirmation.json` | Confirmation send, gated on payment status | **Update eligibility check to use Postgres `bookings.payment_status`** |
| `n8n/phase2/Wolfhouse - Send Confirmation (local).json` | Local fork of confirmation workflow | **Same as above** |

### No bot parser/session files in `scripts/`
**Finding:** There are no standalone bot parser or session manager files in `scripts/`. All bot logic (parser, router, availability check, session state management, payment send, confirmation) lives entirely within n8n workflow JSON nodes. The session state for each guest conversation is stored in Airtable (`Conversations` table, `Session State` JSON blob field). This is important because:
- Any shared engine integration must work as n8n HTTP call nodes (calling the Staff API endpoints).
- There is no `scripts/lib/bot-session.js` or equivalent to refactor.
- Future migration of session state from Airtable to Postgres is a separate deferred work item.

---

## 11. Stage 8.5.1 outcome

**Status: PASS**

- Shared engine integration map complete.
- Luna bot current flow documented (static inspection of n8n workflow JSON).
- All required data fields identified.
- All integration points mapped with gap analysis.
- No-duplicate-logic rules stated explicitly.
- Dry-run behavior defined.
- 6-slice implementation ladder (8.5.2–8.5.7) recommended.
- No bot wiring implemented.
- No WhatsApp sends.
- No n8n workflow activation.
- No DB writes.
- No Azure deploy.
- No Stripe changes.
- No new production flags.

**Smallest next implementation slice:** Stage 8.5.2 — static verifier of bot workflow payment nodes.

---

*Stage 8.5.1 — static mapping only. No implementation performed. 2026-06-02.*

---

## 11. Stage 8.6 — Staff Ask Luna via WhatsApp

### 8.6.1 — Staff Ask Luna read-only endpoint — **PASS (2026-06-03)**
**Goal:** Backend foundation for staff asking Luna operational questions via text. Staff Portal (session) or allowlisted WhatsApp numbers can query Postgres via the shared registry.
**Delivered:**
- POST /staff/ask-luna endpoint in scripts/staff-query-api.js.
- Session auth for source=staff_portal; allowlist phone auth for source=staff_whatsapp.
- config/clients/wolfhouse-somo.staff-whatsapp-allowlist.json created (3 staging test numbers, staff_whatsapp_enabled:true for testing).
- esolveNaturalLanguageIntent(): 14 keyword patterns + direct registry key passthrough. Maps to all 35 registry intents.
- Unsupported intents (departures_today, ooms_or_beds_need_cleaning) return unsupported_intent + suggestion list.
- ormatAnswer(): WhatsApp-friendly per-intent answer strings.
- Response: ead_only:true, 
o_write_performed:true, sends_whatsapp:false, intent, nswer, ows, ow_count, staff_access.
- No DB writes. No Stripe. No WhatsApp send. No n8n.
**Verifier:** scripts/verify-staff-ask-luna-api.js **48/48 PASS** (new).
**Local proof:** unknown phone->403/phone_not_allowlisted; allowlisted +34999000999->200/payments.balance_due/answer with real data; staff_portal dev->200/handoffs.open; unsupported->safe suggestion; departures_today->unsupported_intent+hint.

### 8.6.2 — Staff Portal Ask Luna text box — **PASS (2026-06-03)**
**Goal:** Add a text input box in the Staff Portal UI so staff can type a question and see the answer inline.
**Delivered:**
- New "Ask Luna" tab in Staff Portal nav (between Tour Operator and Developer Tools).
- Compact hero card with title, subtitle, and example prompts.
- Text input (`al-input`) + Ask button (`al-btn`); Enter key submits.
- `alAsk()` POSTs to `/staff/ask-luna` with `source:"staff_portal"` using session auth.
- `alRenderResult()` displays: intent badge, answer text, row_count, compact table of rows (first 20), unsupported_intent message + suggestion list.
- `alShowError()` / `alSetLoading()` for loading and error states.
- No WhatsApp, no n8n, no Stripe, no DB writes.
**Verifier:** scripts/verify-staff-query-ui.js **43/43 PASS** (updated with new 7b block — 14 Ask Luna checks). scripts/verify-staff-ask-luna-api.js **48/48 PASS** (unchanged).
**Local proof:** `who still owes money` → 200 / payments.balance_due / 1 row with real guest data. `what is the weather today` → unsupported_intent + full suggestion list. No DB writes / no WhatsApp / no n8n / no Stripe / no Azure.

### 8.6.3 — Staff Ask Luna WhatsApp dry-run workflow — **PASS (2026-06-03)**
**Goal:** Create an inactive n8n dry-run workflow that routes inbound staff WhatsApp messages to `POST /staff/ask-luna` and logs the answer without sending anything live.
**Delivered:**
- New file: `n8n/Wolfhouse Staff Ask Luna - WhatsApp Dry Run.json` (`active:false`, 10 nodes).
- `WHATSAPP_DRY_RUN` env guard — IF node exits immediately if guard is not `"true"`.
- `Code - Parse Staff Message` node: extracts `from` (staff phone), `text` (question), `client_slug`, `channel` from inbound webhook body.
- `HTTP - Staff Ask Luna` node: `POST https://staff-staging.lunafrontdesk.com/staff/ask-luna` with `{client_slug, question, staff_phone, source:"staff_whatsapp"}`. No `X-Luna-Bot-Token` (phone allowlist is the auth path). `neverError:true` + `fullResponse:true` so 403 flows to branch instead of throwing.
- `IF - API Authorized` node: branches on `json.success === true`.
  - TRUE → `Code - Format DryRun Answer` → `Respond - DryRun Answer` (logs intent, answer, rows, reply_draft — no send).
  - FALSE → `Set - Log Unauthorized` → `Respond - DryRun Unauthorized` (logs "This number is not enabled for Staff Ask Luna." — no send).
- All paths output `whatsapp_sent:false`, `dry_run:true`, `live_send_blocked:true`.
- `unsupported_intent` handled in `Code - Format DryRun Answer` — appends suggestion text to reply_draft, no send.
- No `graph.facebook.com` in any node parameters. No Stripe. No DB writes.
**Verifier:** `scripts/verify-staff-ask-luna-whatsapp-dry-run.js` **40/40 PASS** (new). `scripts/verify-staff-ask-luna-api.js` **48/48 PASS** (unchanged).
**Proof:** Static verification only (workflow not imported/activated). Allowlisted phone `+34999000999` would return 200/answer; unlisted phone would return 403/phone_not_allowlisted and log "not enabled" draft. All dry-run outputs have `whatsapp_sent:false`.

### 8.6.4 — Azure staging deploy (Staff Ask Luna live) — **PASS (2026-06-03)**
**Goal:** Deploy current HEAD to Azure staging so Stage 8.6.1/8.6.2 are live on `staff-staging.lunafrontdesk.com`.
**Delivered:**
- Image `wh-staff-api:1f9e21e-stage864-ask-luna` built and pushed to `whstagingacr.azurecr.io`.
- Deployed to `wh-staging-staff-api` revision `--0000018` (`provisioningState: Succeeded`).
- Hosted proofs:
  - `GET /staff/login` → 200 ✓
  - `GET /staff/ui` → 200, 170234 chars — Ask Luna tab, `al-input`, `al-btn`, `alAsk`, `source:staff_portal` all present; no `graph.facebook.com`; no `api.stripe.com` ✓
  - `POST /staff/ask-luna` (session auth, `staff_portal`) → 200 / `payments.balance_due` / `read_only:true` / `no_write_performed:true` / `sends_whatsapp:false` / `staff_access:session` / `row_count:1` ✓
  - `POST /staff/ask-luna` (allowlisted phone `+34999000999`, `staff_whatsapp`) → 200 / `staff_access:allowlisted_phone` / `sends_whatsapp:false` ✓
  - `POST /staff/ask-luna` (unlisted phone) → 403 ✓
- No n8n import/activation. No Stripe calls. No WhatsApp sent.
- `staff_whatsapp_enabled:true` in staging config for hosted smoke test.

### 8.6.5 — Hosted inactive Staff Ask Luna dry-run proof — **PASS (2026-06-03)**
**Goal:** Import the Stage 8.6.3 dry-run workflow into staging n8n (inactive), run one manual execution with a fake allowlisted staff phone, and confirm it calls `/staff/ask-luna` and returns a draft answer without sending WhatsApp.

**Delivered:**
- Workflow imported into staging n8n DB as `stage863AskLuna01` (`active:false`, name matches repo JSON).
- Manual execution #2 (`mode:manual`, status:success) with pinned webhook payload:
  - `from: +34999000999` (allowlisted staging test number)
  - `text: who still owes money`
  - `client_slug: wolfhouse-somo`, `channel: whatsapp`
- Happy path executed: `Code - Parse Staff Message` → `HTTP - Staff Ask Luna` → `IF - API Authorized` (true) → `Code - Format DryRun Answer` → `Respond - DryRun Answer`.
- Staff API response: `intent: payments.balance_due`, real row data, `read_only:true`, `no_write_performed:true`, `sends_whatsapp:false`.
- Dry-run output: `reply_draft` present, `whatsapp_sent:false`, `dry_run:true`, `live_send_blocked:true`.
- No `graph.facebook.com` in workflow node params or execution data.
- Workflow left **inactive** after proof; node graph restored to match `n8n/Wolfhouse Staff Ask Luna - WhatsApp Dry Run.json`.

**Staging gap (documented, not fixed in this slice):** staging n8n has `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`, which prevents `$env.WHATSAPP_DRY_RUN` from evaluating in the IF guard. Execution #1 returned `dry_run_guard_blocked`. Proof execution used a temporary staging-only IF guard bypass, then nodes were restored to repo JSON.

**Proof:** Hosted manual execution only. No workflow activation. No live WhatsApp send. No Staff API edits. No Stripe.

### 8.6.6 — Fix Staff Ask Luna dry-run guard for staging n8n — **PASS (2026-06-03)**
**Goal:** Replace `$env.WHATSAPP_DRY_RUN` IF guard (blocked by `N8N_BLOCK_ENV_ACCESS_IN_NODE` on staging) with workflow JSON flags.

**Delivered:**
- Added `Set - DryRun Mode Flags` node: sets `dry_run:true`, `live_send_enabled:false` on inbound payload.
- `IF - DryRun Guard` now checks `$json.dry_run === true` (no `$env`).
- Workflow remains `active:false`; all replies still `whatsapp_sent:false`; no `graph.facebook.com`.
- `scripts/verify-staff-ask-luna-whatsapp-dry-run.js` **46/46 PASS**.

**Proof:** Static verifier only. Not re-imported to staging in this slice (see 8.6.7).

### 8.6.7 — Re-import fixed dry-run workflow + manual execution — **PASS (2026-06-03)**
**Goal:** Re-import the Stage 8.6.6 guard-fixed workflow into staging n8n (inactive) and run one manual execution without any temporary IF bypass.

**Delivered:**
- Workflow updated in staging n8n DB as `stage863AskLuna01` (`active:false`, 11 nodes, includes `Set - DryRun Mode Flags`, no `$env.WHATSAPP_DRY_RUN`).
- Manual execution #3 (`mode:manual`, status:success, ~13s) with pinned webhook payload:
  - `from: +34999000999`, `text: who still owes money`, `client_slug: wolfhouse-somo`, `channel: whatsapp`
- Happy path without bypass: `Set - DryRun Mode Flags` → `IF - DryRun Guard` (pass) → `Code - Parse Staff Message` → `HTTP - Staff Ask Luna` → `IF - API Authorized` (true) → `Code - Format DryRun Answer` → `Respond - DryRun Answer`.
- Staff API: `intent: payments.balance_due`; dry-run output: `reply_draft` present, `whatsapp_sent:false`, `dry_run:true`, `live_send_enabled:false` in execution data.
- No `graph.facebook.com`; no `dry_run_guard_blocked`.
- Workflow left **inactive**.

**Proof:** Hosted manual execution only. No workflow activation. No live WhatsApp send. No Staff API/Stripe/Azure changes.

### 8.6.8 — Staff WhatsApp live gated send — *pending (requires explicit go/no-go)*
**Goal:** Enable live WhatsApp replies to allowlisted staff numbers. Requires explicit approval + real staff phone numbers in config.
