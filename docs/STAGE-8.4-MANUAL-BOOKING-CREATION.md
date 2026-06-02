# Stage 8.4 — Manual Booking Creation (PLAN / GATE CHECKPOINT)

**Status:** PLAN + GATED STUB ONLY (2026-06-02). **Manual booking creation is NOT enabled and NOT wired to the UI.** A pricing/payment engine is a hard prerequisite before a real create path can ship. **Slice 1 (pricing/payment config plan) DONE — [`STAGE-8.4.1-WOLFHOUSE-PRICING-PAYMENT-CONFIG-PLAN.md`](STAGE-8.4.1-WOLFHOUSE-PRICING-PAYMENT-CONFIG-PLAN.md) (2026-06-02): known Wolfhouse config captured (packages/seasons/double-room/deposits/hold/add-ons in cents), REQUIRED_FROM_STAFF gaps listed, quote input/output contracts, payment-record/invoice model, quote-snapshot storage, override + handoff rules, and the hard gate before `MANUAL_BOOKING_ENABLED`.** **Slice 2 (pricing config fixture) DONE — `config/clients/wolfhouse-somo.pricing.json` created; `scripts/verify-wolfhouse-pricing-config.js` 63/63 PASS (2026-06-02).** **Slice 3 (quote calculator) DONE — `scripts/lib/wolfhouse-quote-calculator.js` (pure JS, no DB); `scripts/verify-wolfhouse-quote-calculator.js` 77/77 PASS (2026-06-02). Formula B per-night ceil5 selected: weekly_price÷7 rounded up to nearest €5/night × nights × guests. All 3 packages × all 3 seasons, 7-night flat, proration, supplement, all add-ons, blockers covered.** **Slice 4 (quote preview endpoint) DONE — `POST /staff/quote-preview` in `scripts/staff-query-api.js`; `scripts/verify-staff-quote-preview-api.js` 33/33 PASS (2026-06-02). Auth-gated (viewer+). No DB reads or writes. No Stripe. Calls `calculateWolfhouseQuote()`. Returns `preview_only:true`, `no_write_performed:true`, `creates_booking:false`, `creates_payment:false`, `creates_stripe_link:false`. Local proof PASS (Malibu 7n total=24900¢ deposit=20000¢; Malibu 4n total=16000¢ deposit=10000¢). `MANUAL_BOOKING_ENABLED` and `STAFF_ACTIONS_ENABLED` remain false.** **Slice 6 (booking create with quote + draft payment) DONE — Stage 8.4.8 (2026-06-02): booking-first flow enabled behind MANUAL_BOOKING_ENABLED=true + STAFF_ACTIONS_ENABLED=true; calculateWolfhouseQuote() called server-side from request body; amounts never trusted from client; UPDATE bookings sets total_amount_cents/deposit_required_cents/balance_due_cents/requested_room_type + quote_snapshot in metadata; UPDATE payments sets payment_kind (deposit_only/full_amount from payment_choice) + amount_due_cents = payment_link_amount_cents from quote; UI embeds BC_STAFF_ACTIONS/BC_MANUAL_BOOKING server flags; bcUpdateCreateButton() gates create button (requires both flags + bcLastQuote + form valid); runManualBookingCreate() POSTs to /staff/manual-bookings/create; renderCreateResult() shows booking_code + amounts + no-Stripe notice; flags=false → 403 verified; local proof: booking MB-WOLFHO-20260915-e0c89a created, total=81300¢, deposit=20000¢, payment_kind=deposit_only, quote_snapshot present, beds=R1-B1+R1-B2; test cleaned up; verifiers 50+237+33+77=397/397 PASS; no DB migration needed; no Stripe/WhatsApp/n8n.** Prior: **Slice 5b (add-ons selector) DONE — Stage 8.4.7 (2026-06-02): compact add-ons section added to manual booking form with checkboxes for wetsuit/soft-top/hard-board rentals, combos (wetsuit+soft-top, wetsuit+hard-board), surf lessons (qty, auto single vs bundle), yoga classes (qty); `buildAddOns()` builds payload from form state; `bcInitAddOns()` wires checkbox→qty enable/disable; combos suppress individual rentals in payload; `runQuotePreview` sends `buildAddOns()` result; `bcClearSelection` resets all add-on controls; local proof: wetsuit 3d + 2 lessons → total=32400¢ (items: package=24900, wetsuit_rental=1500, surf_lesson_multi=6000); combo 4d → total=30900¢ (items: package=24900, wetsuit_soft_top_combo=6000); `verify-staff-bed-calendar-ui.js` 222/222 PASS; no DB writes; Create disabled.** Prior: **Slice 5a (room type selector) DONE — Stage 8.4.6 (2026-06-02): `bk-room-type` select (shared/private/double) added to manual booking form; `runQuotePreview` reads selected room type (no longer hardcodes shared); private/double sends +€10/person/night supplement to calculator; reset clears back to shared; local proof: shared total=24900¢ (no supplement), private total=31900¢ (room_supplement line item); `verify-staff-bed-calendar-ui.js` 201/201 PASS; no DB writes; Create Manual Booking stays disabled. Prior: Slice 5 (quote preview UI + form cleanup) DONE — Stage 8.4.5 (2026-06-02): manual booking form wired to `POST /staff/quote-preview`; package is now a dropdown (malibu/uluwatu/waimea/package_none/manual_override); language field removed; multi-bed selection supported (bcSelectedBeds array, shared date range, per-bed highlighting, auto guest count); booking detail closes on new selection; "Calculate Quote" button calls `/staff/quote-preview` and displays itemized line items (per-night/proration, room supplement, add-ons, totals, deposit, payment link, balance, formula summary, warnings); "Create Manual Booking" remains disabled; booking drawer deduplicates assignment rows; `scripts/verify-staff-bed-calendar-ui.js` 194/194 PASS.**

**Parent:** [`STAGE-8.3-STAFF-PORTAL-BED-CALENDAR-OPERATIONS-PLAN.md`](STAGE-8.3-STAFF-PORTAL-BED-CALENDAR-OPERATIONS-PLAN.md) · §4 (manual booking creation)
**Builds on:** Stage 8.3e write-gate plan, 8.3i/8.3j SQL helper proofs, 8.3k rollback proof, 8.3l preview UI wiring.

**Flags (unchanged, must stay false):** `STAFF_ACTIONS_ENABLED=false`, `MANUAL_BOOKING_ENABLED=false`, `WHATSAPP_DRY_RUN=true`, all n8n workflows inactive. **Pilot decision: NO_GO.**

---

## 1. Why Stage 8.4 was re-scoped

The first attempt at Stage 8.4 wired a single "confirmed manual booking create" route end-to-end (Bed Calendar selection → `POST /staff/manual-bookings/create` → `bookings` + `booking_beds` + a `payments` row). That implementation was **stopped and unwired** because it baked in **pricing/payment/invoice assumptions** before a real pricing/payment engine exists:

- it inserted a `payments` row directly from raw staff-entered `deposit_amount_cents` / `total_amount_cents`,
- it chose a `payment_status` from a free-form UI dropdown,
- it had no quote snapshot, no canonical price source, and no Stripe truth.

**The real risk is not test-data mutation. The risk is shipping a write path with the wrong data shape or missing the pricing/payment source of truth.** Manual booking creation must therefore be split into separate, individually gated slices, each behind disabled flags, with the pricing/payment engine built first.

---

## 2. Required slice order (each gated, each shippable independently)

Manual booking creation may only be enabled after these slices land **in order**:

1. **Pricing/payment engine plan** — define the canonical price source (package/season/length-of-stay rules), currency handling, deposit policy, and where the price snapshot is stored. **DONE (8.4.1)** — [`STAGE-8.4.1-WOLFHOUSE-PRICING-PAYMENT-CONFIG-PLAN.md`](STAGE-8.4.1-WOLFHOUSE-PRICING-PAYMENT-CONFIG-PLAN.md).
2. **Quote calculator** — pure, tested function that turns `{client, dates, beds, package, guests}` into a priced quote (no DB writes, no Stripe). **DONE (8.4.3)** — `scripts/lib/wolfhouse-quote-calculator.js` + verifier 77/77 PASS. Formula B per-night ceil5 selected.
3. **Quote preview endpoint** — read-only API that returns a quote snapshot for staff review (mirrors the existing availability preview pattern). **DONE (8.4.4)** — `POST /staff/quote-preview` + verifier 33/33 PASS. No DB. Local proof PASS.
4. **Manual booking create using a quote snapshot + payment records** — the real create path. It must consume a quote snapshot (not free-form staff price entry) and create `bookings` + `booking_beds` + payment records derived from that snapshot, in one transaction.
5. **Stripe payment-link / invoice creation from a payment record** — create the payment link/invoice *from* the stored payment record (still no auto-charge of the guest by the bot).
6. **Stripe webhook payment truth** — payment status becomes authoritative from Stripe webhooks, not staff guesses.
7. **UI enablement behind gates** — only now is the Bed Calendar "Create Manual Booking" button wired and enabled, behind `MANUAL_BOOKING_ENABLED` + role + auth gates.

Slices 1–3 do not write. Slice 4 is the first write and depends on 1–3. Slices 5–6 add Stripe. Slice 7 is UI.

---

## 3. What exists in code today (and its exact safety status)

| Artefact | State |
|---|---|
| `scripts/lib/staff-manual-booking-create-sql.js` | Proven SQL helper (8.3i/8.3j/8.3k). Not changed in 8.4. |
| `POST /staff/manual-bookings/create` (`handleManualBookingCreate` in `scripts/staff-query-api.js`) | **Provisional, DISABLED-by-default, UI-UNWIRED stub.** Gated by `MANUAL_BOOKING_ENABLED` (default false → `403`). Documented in-code as "do not enable until pricing engine exists". |
| Bed Calendar "Create Manual Booking" button | **Still disabled.** Not connected to the create route. UI stays preview-only. |
| `scripts/verify-staff-manual-booking-create-api.js` | New verifier asserting the route is gated, provisional, UI-unwired, transaction-safe, conflict-checked, and free of Stripe/WhatsApp/n8n side effects. |

### Safety guarantees of the gated stub
- Returns `403` whenever `MANUAL_BOOKING_ENABLED` is false (the default everywhere, including Azure staging).
- Never reachable from the UI: there is **no `fetch()` to `/staff/manual-bookings/create` in `buildUiHtml`** (enforced by verifier check `L40`).
- Creates **no Stripe session, invoice, or payment link** (verifier `L41`), **no WhatsApp**, **no n8n** (verifier `I31`–`I34`).
- If ever enabled, it runs inside `BEGIN/COMMIT`, re-checks overlap server-side, and `ROLLBACK`s on any blocker.
- The stub still embeds a `payments`-row pricing assumption via the SQL helper, which is exactly why it must not be enabled until slice 1–4 replace it with a quote snapshot.

---

## 4. Hard rule until the pricing/payment engine exists

> **Do not flip `MANUAL_BOOKING_ENABLED` (or `STAFF_ACTIONS_ENABLED`) to true. Do not wire the create route to the UI. Do not create Stripe sessions, invoices, or payment links. Manual booking creation cannot be safely enabled until slices 1–6 above are built and proven.**

---

## 5. Verification (Stage 8.4 checkpoint)

- `npm run verify:staff-manual-booking-create-api` — 41/41 PASS (route gated/provisional/unwired/transaction-safe/no side effects).
- `npm run verify:staff-bed-calendar-ui` — 167/167 PASS (Create button still disabled; no client-side create handler; "Creation remains disabled" messaging intact).
- `npm run verify:staff-manual-booking-preview-api` — PASS (no `MANUAL_BOOKING_ENABLED = true` assignment in the API file).
- `node --check scripts/staff-query-api.js` — clean.

No runtime create was performed. No booking was created. No Stripe/WhatsApp/n8n call happened.

---

---

## Stage 8.4.9 — Create Stripe payment link from draft payment record (DONE)

**Commit:** `feat(stage8.4.9): create Stripe link from draft payment`

### Goal
After a manual booking is created (Stage 8.4.8), staff can generate a Stripe Checkout payment link from the draft payment record. Payment truth (marking the payment paid) is deferred to a later webhook slice.

### Endpoint
```
POST /staff/payments/:payment_id/create-stripe-link
```
Path param routing matches the existing `WRITE_HANDOFF_RE` regex pattern.

### Gates (all must pass)
1. `STAFF_ACTIONS_ENABLED=true`
2. `STRIPE_LINKS_ENABLED=true` — new dedicated flag, **default false**
3. `STRIPE_SECRET_KEY` present in env (test mode: `sk_test_...`)
4. `STRIPE_CHECKOUT_SUCCESS_URL` and `STRIPE_CHECKOUT_CANCEL_URL` present in env
5. Auth: `requireAuth(req, res, 'operator')`
6. Payment exists, `status='draft'`, `amount_due_cents > 0`, `currency='EUR'`
7. Payment has a `booking_id`

Flag gating decision: `MANUAL_BOOKING_ENABLED` is **not** required for payment link creation — it gates booking creation, not link generation from an existing record. `STRIPE_LINKS_ENABLED` is the dedicated gate.

### Stripe session
- `mode: 'payment'`, `currency: 'eur'`
- `unit_amount` = `payments.amount_due_cents` (from DB, never from client request)
- `metadata`: `client_slug`, `booking_id`, `booking_code`, `payment_id`, `payment_kind`, `source: 'staff_portal_manual_booking'`
- `success_url` / `cancel_url` from env

### DB update (after session created)
| Column | Value |
|--------|-------|
| `payments.status` | `checkout_created` (schema enum) |
| `payments.stripe_checkout_session_id` | `session.id` |
| `payments.checkout_url` | `session.url` |
| `payments.expires_at` | `session.expires_at` (UTC) |
| `payments.metadata` | stripe session info merged via `||` |

**No change to:** `amount_paid_cents`, `bookings.payment_status`, `bookings.status`, `bookings.confirmed`.

### Idempotency
If `payment.status` is already `checkout_created` and `checkout_url` is present, returns the existing URL with `idempotent: true` — no new Stripe session created.

### Safety guarantees
- Does **not** set `status='paid'`
- Does **not** update `booking.payment_status` to any paid state
- Does **not** confirm booking
- No WhatsApp, no n8n, no Azure
- Stripe test mode enforced (key from env only)
- `no_payment_truth_recorded: true` in every response

### New files
- `scripts/verify-staff-stripe-payment-link-api.js` — 55/55 PASS
- `stripe` added to `package.json` dependencies
- `infra/.env` loaded as dotenv fallback in `staff-query-api.js`

### Verification
- `node scripts/verify-staff-stripe-payment-link-api.js` — 55/55 PASS
- All prior verifiers: 397 total, 0 failures
- **Grand total: 452/452 checks**

### Local proof (2026-06-02)
| Test | Result |
|------|--------|
| `STRIPE_LINKS_ENABLED` not set → `403` `stripe_links_enabled: false` | ✓ |
| `STAFF_ACTIONS_ENABLED=true`, `STRIPE_LINKS_ENABLED=true`, infra/.env loaded → Stripe session created | ✓ |
| `stripe_checkout_session_id`: `cs_test_a1XIPhaV3nTD3hILkB4wXKDEv6aIQc9AtCzHfyQb5S66Rv7iwrBCoL8OgU` | ✓ |
| `payment.status`: `checkout_created` | ✓ |
| `payment.amount_paid_cents`: `0` (not paid) | ✓ |
| `booking.status`: `confirmed` (unchanged) | ✓ |
| `booking.payment_status`: `not_requested` (not paid) | ✓ |
| Test data cleaned up | ✓ |

### Next step
Stage 8.4.10 — Staff Portal create/copy Stripe payment link. **Done — see below.**

---

## Stage 8.4.10 — Staff Portal create/copy Stripe payment link (DONE)

**Commit:** `ui(stage8.4.10): show and copy Stripe payment link`

### Goal
After a manual booking is created (8.4.8) and a Stripe session can be generated (8.4.9), staff can trigger link creation from the UI result panel and copy it. No send via WhatsApp/email yet.

### UI changes in `scripts/staff-query-api.js`

#### Server-side flag embedding
`var BC_STRIPE_LINKS = ${STRIPE_LINKS_ENABLED};` — interpolated at render time, alongside `BC_STAFF_ACTIONS` and `BC_MANUAL_BOOKING`.

#### State variable
`var bcLastPaymentId = null;` — stores payment_id from the last successful manual booking create response.

#### Backend: `payment_id` added to create response
`UPDATE payments ... RETURNING id AS payment_id` was added so `result._payment_id` is captured and returned in the 201 response as `payment_id`.

#### `renderCreateResult(res)` updated
- Shows `payment_id` (monospace, small)
- Shows payment status pill: `draft`
- Shows "Create Stripe Payment Link" button (`id="bc-sel-stripe-link"`)
  - **Enabled** when `BC_STRIPE_LINKS && BC_STAFF_ACTIONS && payment_id` are all truthy
  - **Disabled** (greyed, with tooltip) when any flag is off or payment_id missing
- Shows `<div id="bc-stripe-link-result">` for Stripe session result

#### `runManualBookingCreate()` updated
- After success: sets `bcLastPaymentId = res.data.payment_id`
- After `cr.innerHTML = renderCreateResult(res)`: wires `bc-sel-stripe-link` click → `runCreateStripeLink()`

#### New `runCreateStripeLink()`
- Gate checks: `BC_STRIPE_LINKS && BC_STAFF_ACTIONS && bcLastPaymentId`
- POSTs to `/staff/payments/{bcLastPaymentId}/create-stripe-link` (Staff API — **never calls Stripe directly from browser**)
- Renders result in `bc-stripe-link-result`
- Wires `bc-copy-payment-link` click → `navigator.clipboard.writeText(url)` (falls back to `prompt()`)
- Re-enables button after completion (idempotent re-use supported)
- No WhatsApp. No email. No n8n.

#### New `renderStripeLinkResult(res)`
- Success: shows checkout_url, session ID (truncated), `Copy Payment Link` button, payment status pill
- Warning: "Stripe test link created — payment is NOT marked paid until webhook confirms."
- Error: shows friendly error message

#### `renderBookingContextDrawer()` payment section
- After existing payment amount rows, checks `pmt.rows` for any row with `checkout_url`
- If present: shows link (truncated) + inline `Copy` button (wired via inline onclick using `navigator.clipboard`)
- Note: `getBookingPaymentsQuery` doesn't yet return `checkout_url` — this code path is ready for when that query is updated. A future sub-task: add `checkout_url` to `staff-booking-detail-queries.js`.

#### `bcClearSelection()` reset
Resets `bcLastPaymentId = null` and clears `bc-stripe-link-result`.

### Safety
- All Stripe API calls made server-side only (`/staff/payments/:id/create-stripe-link`)
- `STRIPE_SECRET_KEY` never exposed to browser
- `no_payment_truth_recorded: true` in every success response
- No amount_paid_cents updated
- No booking confirmed/paid
- No WhatsApp, email, n8n

### Verifier changes (`verify-staff-bed-calendar-ui.js`)
23 new checks (210–218) covering: `BC_STRIPE_LINKS` embedding, `bcLastPaymentId`, `bcClearSelection` reset, `runCreateStripeLink` endpoint + flags + clipboard + no-WhatsApp/n8n, `renderStripeLinkResult` content + webhook warning + no-paid-state-update, `renderCreateResult` Stripe button + `bc-stripe-link-result`, no direct Stripe calls from browser, `runManualBookingCreate` sets `bcLastPaymentId`.

**Total: 260/260 PASS** (was 237)

### Full verifier suite: 475/475 PASS
- `verify-staff-bed-calendar-ui.js`: 260/260
- `verify-staff-manual-booking-create-api.js`: 50/50
- `verify-staff-stripe-payment-link-api.js`: 55/55
- `verify-staff-quote-preview-api.js`: 33/33
- `verify-wolfhouse-quote-calculator.js`: 77/77

### Local proof (2026-06-02)
| Test | Result |
|------|--------|
| `BC_STRIPE_LINKS` embedded in UI source | ✓ |
| `bc-sel-stripe-link` button in UI source | ✓ |
| `Copy Payment Link` in UI source | ✓ |
| Create booking → `payment_id` returned | `ecd0c780-ac3a-4aba-9faa-7ba1dc3236f7` ✓ |
| POST to `/staff/payments/:id/create-stripe-link` → 200 | ✓ |
| `stripe_checkout_session_id` | `cs_test_a1ShoGwTulIU…` ✓ |
| `status = checkout_created` | ✓ |
| `no_payment_truth_recorded = true` | ✓ |
| Idempotent 2nd call → `idempotent: true`, same URL | ✓ |
| `payment.amount_paid_cents = 0` | ✓ |
| `booking.status = confirmed` (unchanged) | ✓ |
| `booking.payment_status = not_requested` | ✓ |
| Test data cleaned up | ✓ |

### Drawer note
`renderBookingContextDrawer` is ready for `checkout_url` display once `getBookingPaymentsQuery` is updated to return that column. Not a blocker for this stage.

---

## Stage 8.4.11 — Stripe webhook payment truth  ✅ PASS  (commit pending)

**Goal:** When a guest pays a Stripe Checkout link, the webhook marks the payment as paid and updates booking payment fields. No messages, no n8n, no confirmation.

### Implementation

| Component | Detail |
|---|---|
| Route | `POST /staff/stripe/webhook` |
| Handler | `handleStripeWebhook(req, res)` |
| Auth model | No session auth — Stripe HMAC signature (or `STRIPE_WEBHOOK_SKIP_VERIFY=true` for local dev) |
| Signature verification | `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)` |
| Skip flag | `STRIPE_WEBHOOK_SKIP_VERIFY=true` in env — local/dev only, never production |
| Body reading | `readBodyRaw()` — returns Buffer for exact signature matching |
| Supported event | `checkout.session.completed` |
| Unsupported events | `200 ignored:true` |
| Payment lookup | `metadata.payment_id` → fallback to `stripe_checkout_session_id` |
| Idempotency | Already-paid → `200 idempotent:true`, no double-count |
| Payment update | `status=paid`, `amount_paid_cents`, `paid_at=NOW()`, `stripe_payment_intent_id`, event metadata |
| Booking update | `amount_paid_cents`, `balance_due_cents`, `payment_status` (`deposit_paid` / `paid` / `waiting_payment`) |
| Transaction | `BEGIN/COMMIT/ROLLBACK` — payment + booking update atomic |
| Booking status | NOT changed to `confirmed` here — payment truth only slice |
| Response | `success, event_type, payment_id, booking_id, amount_paid_cents, booking_amount_paid_cents, booking_balance_due_cents, payment_status, idempotent` |
| Safety flags | `no_whatsapp:true, no_email:true, no_n8n:true, no_confirmation_sent:true` |

### Verifier
`scripts/verify-staff-stripe-webhook-api.js` — 60/60 checks:
- A: Constants (3), B: readBodyRaw (3), C: Route (4), D: Handler (8), E: Payment match (5)
- F: Idempotency (3), G: Payment update (6), H: Booking update (8), I: Response (8)
- J: Safety (9), K: No Azure (1), L: Audit log (2)

### Local proof (STRIPE_WEBHOOK_SKIP_VERIFY=true — fixture, no Stripe CLI needed)

| Check | Result |
|---|---|
| BEFORE: pm_status=checkout_created | ✓ |
| POST fixture checkout.session.completed → 200 success | ✓ |
| amount_paid_cents=20000 in response | ✓ |
| payment_status=deposit_paid in response | ✓ |
| no_whatsapp / no_n8n in response | ✓ |
| AFTER DB: pm_status=paid | ✓ |
| AFTER DB: pm_paid_cents=20000 | ✓ |
| AFTER DB: bk_amount_paid_cents=20000 | ✓ |
| AFTER DB: bk_payment_status=deposit_paid | ✓ |
| POST same event again → idempotent:true | ✓ |
| No double-count (amounts unchanged) | ✓ |
| Unsupported event → 200 ignored:true | ✓ |
| Cleanup confirmed | ✓ |

### Next step
Stage 8.4.12 — Show webhook payment truth in Staff Portal booking detail drawer. ✅ Done — see section below.

---

## Stage 8.4.12 — Show Stripe payment truth in booking drawer  ✅ PASS  (commit pending)

**Goal:** Update the booking detail drawer to surface all Stripe payment truth fields after a webhook fires. Read-only display only.

### Implementation

**`scripts/lib/staff-booking-detail-queries.js` — `getBookingPaymentsQuery()`:**

Added 4 new columns (previously missing, query unchanged since initial build):
- `p.payment_kind::text`
- `p.currency`
- `p.checkout_url`
- `p.stripe_checkout_session_id`

**`scripts/staff-query-api.js` — `renderBookingContextDrawer()` payment section:**

Full rewrite of the `/* 4. Payment */` section:

| Element | Behavior |
|---|---|
| Booking status banner | Green ✓ banner for `deposit_paid` / `paid`; pill for other statuses |
| `bkPayLabel()` helper | Human-readable booking payment_status labels |
| Booking totals | Total / Deposit required / Booking paid / Balance due |
| Payment record card | Per-row card for each `payments` row |
| Card color | Green tint if paid, blue tint if checkout_created, neutral otherwise |
| `pmtStatusLabel()` helper | "Draft payment" / "Checkout link created" / "Paid ✓" / etc. |
| payment_kind | "Deposit only" / "Full payment" label in card |
| Amount due / Amount paid | Shown in card |
| paid_at | Formatted date/time — only shown when set |
| Waiting banner | "⏳ Payment link created — waiting for Stripe webhook." when checkout_created |
| Stripe IDs | Session ID (truncated) / payment intent ID (truncated) |
| Checkout URL copy | Link + Copy button using `bcCopyUrl()` |
| No-payment fallback | "No payment record yet." |

### Verifier
`scripts/verify-staff-bed-calendar-ui.js` — 283/283 checks:
- 23 new checks (219a–219q + 220a–220e):
  - paid_at, amount_paid_cents, balance_due, checkout_url, payment_kind, session/intent IDs
  - deposit-paid / paid-in-full labels, waiting-for-webhook text, no-payment fallback
  - bcCopyUrl used, no Stripe API calls, no WhatsApp/n8n, no DB writes
  - getBookingPaymentsQuery query fields verified in lib file
- Updated check 65 to accept "Balance due" (renamed from "Remaining balance")

### Local proof (DB + webhook fixture)

| Check | Result |
|---|---|
| BEFORE: payment_status=checkout_created | ✓ |
| BEFORE: payment_kind=deposit_only | ✓ |
| BEFORE: currency=EUR | ✓ |
| BEFORE: checkout_url present (real Stripe test URL) | ✓ |
| BEFORE: stripe_checkout_session_id present | ✓ |
| BEFORE: paid_at=null | ✓ |
| POST fixture webhook → 200 success | ✓ |
| AFTER: payment_status=paid | ✓ |
| AFTER: amount_paid_cents=20000 | ✓ |
| AFTER: paid_at set (2026-06-02T18:18:39.745Z) | ✓ |
| AFTER: bk_payment_status=deposit_paid | ✓ |
| AFTER: bk_amount_paid=20000 | ✓ |
| Cleanup confirmed | ✓ |

No Stripe API calls. No WhatsApp. No n8n. No email. No Azure deploy.

### Stage 8.4.13 — Azure staging batch deploy + E2E proof — **PASS** (2026-06-02)

**Status:** PASS. Manual booking/payment MVP chain proven on hosted Azure staging. Stripe webhook is payment truth. WhatsApp send NOT enabled. n8n untouched. No messages sent. No confirmation triggered. Safety flags confirmed in every response.

**Goal:** Deploy local HEAD to Azure staging, enable feature flags, prove the full manual booking MVP flow end-to-end on hosted staging.

**Azure deploy:**
- Built new image `wh-staff-api:9e5502f-stage8412-manual-booking-mvp` from local HEAD via `az acr build`
- Updated `wh-staging-staff-api` Container App revision `--0000014` (100% traffic, RunningAtMaxScale)
- Set flags: `STAFF_ACTIONS_ENABLED=true`, `MANUAL_BOOKING_ENABLED=true`, `STRIPE_LINKS_ENABLED=true`, `WHATSAPP_DRY_RUN=true`
- Applied `scripts/fixtures/stage7.2c-auth-seed.sql` to staging DB (added test staff users)
- Updated Key Vault: `stripe-secret-key` (valid `sk_test_51TayI4G36q...`), `stripe-webhook-secret` (real endpoint secret `whsec_QF79KU...`)
- Created Stripe test webhook endpoint `we_1TdxY1G36qRefvdPmdvzA0Tm` pointing to `https://staff-staging.lunafrontdesk.com/staff/stripe/webhook`

**E2E proof (browser + API + DB):**

| Step | Result |
|---|---|
| Login as `operator.stage72c@example.test` on staging | ✓ |
| Navigate to Bed Calendar | ✓ |
| Select 7 cells (DEMO-R1-B1, July 5–11 2026) | ✓ |
| Fill manual booking form (Stage8413Test, malibu, shared, 1 guest) | ✓ |
| Calculate Quote → Total €299.00, Deposit €200.00 | ✓ |
| Create Manual Booking → `MB-WOLFHO-20260705-30e9d3` visible on calendar | ✓ |
| DB: booking_code+total_amount_cents=29900+draft payment created | ✓ |
| Create Stripe link (via API) → `cs_test_a1Mzhctx5...`, `checkout_url` present | ✓ |
| DB: pm_status=checkout_created, checkout_url set | ✓ |
| POST signed `checkout.session.completed` webhook (HMAC signed with `whsec_QF79KU...`) | ✓ |
| Webhook 200: `{"success":true,"payment_status":"deposit_paid","amount_paid_cents":20000}` | ✓ |
| DB AFTER: pm_status=paid, pm_paid=20000, paid_at set, stripe_pi_id set | ✓ |
| DB AFTER: bk_payment_status=deposit_paid, amount_paid_cents=20000, balance_due=9900 | ✓ |
| Drawer: green "✓ Deposit paid ✓" banner | ✓ |
| Drawer: Total €299, Deposit €200, Paid €200, Balance €99 | ✓ |
| Drawer: paid_at "2 Jun 2026, 21:08", session/intent IDs, checkout URL+copy | ✓ |

**Safety confirmation:**
- `no_whatsapp: true` · `no_email: true` · `no_n8n: true` · `no_confirmation_sent: true` in every webhook response.
- `WHATSAPP_DRY_RUN=true` on staging — no WhatsApp messages sent at any point.
- n8n workflows untouched — no workflow triggered.
- Stripe is test mode only (`sk_test_...`). No real charges.

**Redaction note:** Stripe signing secrets (`whsec_...`) and API keys (`sk_test_...`) are truncated in this document. Full values live only in Azure Key Vault (`wh-staging-kv`). Do not commit full secret values to this repo.

**Notes:**
- Stripe Checkout iframe blocked by browser automation → Stripe link creation done via authenticated staff API call (`POST /staff/payments/:id/create-stripe-link`); webhook fired as properly HMAC-signed event using the registered endpoint secret (`whsec_[redacted]` stored in KV) — no `STRIPE_WEBHOOK_SKIP_VERIFY` bypass used on staging.
- "Staff actions disabled" badge on login page is static HTML (not dynamic); actual write flags confirmed via `az containerapp show`.

### Next step
**Next phase: Luna bot uses the same booking/pricing/payment engine.** The quote calculator (`wolfhouse-quote-calculator.js`), booking create path (`/staff/manual-bookings/create`), Stripe link endpoint (`/staff/payments/:id/create-stripe-link`), and webhook handler (`/staff/stripe/webhook`) are now proven on staging. The next slice wires the WhatsApp-inbound bot flow to the same engine so guest payments go through the same Stripe truth path. WhatsApp send remains disabled until that slice ships.

---

## 6. Next recommended prompt

> **Stage 8.4.3 DONE.** `scripts/lib/wolfhouse-quote-calculator.js` (pure JS, no DB/API/Stripe) + `scripts/verify-wolfhouse-quote-calculator.js` 77/77 PASS. Formula B selected (per-night ceil5). All 3 packages × 3 seasons × 7-night and proration paths covered. REQUIRED_FROM_STAFF markers retained (add-on charge timing, deposit variance, edge months).
>
> **Stage 8.4.4 DONE.** `POST /staff/quote-preview` added to `scripts/staff-query-api.js`. Auth-gated (viewer+), no DB, calls `calculateWolfhouseQuote()`, returns `preview_only/no_write_performed/creates_booking/creates_payment/creates_stripe_link` all safe. Verifier 33/33 PASS. Local proof: Malibu 7n=24900¢ deposit=20000¢; Malibu 4n=16000¢ deposit=10000¢.
>
> **Next: Stage 8.4.5** — Manual booking create path that consumes a quote snapshot. Requires: quote from `calculateWolfhouseQuote()` confirmed by staff → create `bookings` + `booking_beds` + a `payments` draft row derived from quote output (not free-form staff entry), all in one transaction. Gate: `MANUAL_BOOKING_ENABLED` must be flipped explicitly and pricing/payment engine confirmed before enabling.
