# Stage 8.4 — Manual Booking Creation (PLAN / GATE CHECKPOINT)

**Status:** PLAN + GATED STUB ONLY (2026-06-02). **Manual booking creation is NOT enabled and NOT wired to the UI.** A pricing/payment engine is a hard prerequisite before a real create path can ship. **Slice 1 (pricing/payment config plan) DONE — [`STAGE-8.4.1-WOLFHOUSE-PRICING-PAYMENT-CONFIG-PLAN.md`](STAGE-8.4.1-WOLFHOUSE-PRICING-PAYMENT-CONFIG-PLAN.md) (2026-06-02): known Wolfhouse config captured (packages/seasons/double-room/deposits/hold/add-ons in cents), REQUIRED_FROM_STAFF gaps listed, quote input/output contracts, payment-record/invoice model, quote-snapshot storage, override + handoff rules, and the hard gate before `MANUAL_BOOKING_ENABLED`.** **Slice 2 (pricing config fixture) DONE — `config/clients/wolfhouse-somo.pricing.json` created; `scripts/verify-wolfhouse-pricing-config.js` 63/63 PASS (2026-06-02).** **Slice 3 (quote calculator) DONE — `scripts/lib/wolfhouse-quote-calculator.js` (pure JS, no DB); `scripts/verify-wolfhouse-quote-calculator.js` 77/77 PASS (2026-06-02). Formula B per-night ceil5 selected: weekly_price÷7 rounded up to nearest €5/night × nights × guests. All 3 packages × all 3 seasons, 7-night flat, proration, supplement, all add-ons, blockers covered.** **Slice 4 (quote preview endpoint) DONE — `POST /staff/quote-preview` in `scripts/staff-query-api.js`; `scripts/verify-staff-quote-preview-api.js` 33/33 PASS (2026-06-02). Auth-gated (viewer+). No DB reads or writes. No Stripe. Calls `calculateWolfhouseQuote()`. Returns `preview_only:true`, `no_write_performed:true`, `creates_booking:false`, `creates_payment:false`, `creates_stripe_link:false`. Local proof PASS (Malibu 7n total=24900¢ deposit=20000¢; Malibu 4n total=16000¢ deposit=10000¢). `MANUAL_BOOKING_ENABLED` and `STAFF_ACTIONS_ENABLED` remain false.**

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

## 6. Next recommended prompt

> **Stage 8.4.3 DONE.** `scripts/lib/wolfhouse-quote-calculator.js` (pure JS, no DB/API/Stripe) + `scripts/verify-wolfhouse-quote-calculator.js` 77/77 PASS. Formula B selected (per-night ceil5). All 3 packages × 3 seasons × 7-night and proration paths covered. REQUIRED_FROM_STAFF markers retained (add-on charge timing, deposit variance, edge months).
>
> **Stage 8.4.4 DONE.** `POST /staff/quote-preview` added to `scripts/staff-query-api.js`. Auth-gated (viewer+), no DB, calls `calculateWolfhouseQuote()`, returns `preview_only/no_write_performed/creates_booking/creates_payment/creates_stripe_link` all safe. Verifier 33/33 PASS. Local proof: Malibu 7n=24900¢ deposit=20000¢; Malibu 4n=16000¢ deposit=10000¢.
>
> **Next: Stage 8.4.5** — Manual booking create path that consumes a quote snapshot. Requires: quote from `calculateWolfhouseQuote()` confirmed by staff → create `bookings` + `booking_beds` + a `payments` draft row derived from quote output (not free-form staff entry), all in one transaction. Gate: `MANUAL_BOOKING_ENABLED` must be flipped explicitly and pricing/payment engine confirmed before enabling.
