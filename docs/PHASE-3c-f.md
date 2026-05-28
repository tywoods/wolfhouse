# Phase 3c.f — Payment/confirmation contract checks

**Status:** **3c.f.1 complete; 3c.f.2 static checker added** (both read-only; no runtime payment test).

## Scope (3c.f.1)

Read-only contract audit across:
- Main local fork payment path (`payment_details_provided`)
- Create Payment Session interface
- Stripe Webhook Handler ownership of payment truth
- Send Confirmation handoff and confirmation semantics

No workflow activation, no webhook call, no Stripe call, no data writes.

## Main payment path map (`payment_details_provided`)

Current Main local fork (`n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json`) path:

1. `Router - Classify Message` -> `Code - Parse Route` -> `Code - Booking State Resolver` -> `Switch`
2. `payment_details_provided` branch enters hold lookup/update side:
   - `Code - Extract Guest Details`
   - `IF - Should Search Hold`
   - `Search Hold With Guest Details` -> `IF - Hold Found`
   - `Update Hold With Guest Details`
3. Stripe branch injection:
   - `Code - Prepare Stripe Payment Context`
   - `IF - Use Stripe Checkout`
   - `Postgres - Ensure Booking In Postgres`
   - `IF - Booking ID Ready`
   - `Code - Call Create Payment Session`
   - `IF - Checkout URL Ready`
   - `Update Booking - Stripe Payment Link` (Airtable mirror field only)
4. Reply/continuation:
   - `Update Conversation - Guest Details`
   - `Code - Summarize Payment Pending`
   - `Code - Build Rooming Question`
   - `IF - Payment Link Safe For Reply`
   - `Reply - Payment Pending` (or fallback reply)

## Create Payment Session contract

Main -> Create Payment Session call (from `Code - Call Create Payment Session`):
- URL:
  - `$env.N8N_CREATE_PAYMENT_SESSION_URL || 'http://localhost:5678/webhook/create-payment-session'`
- Method: `POST`
- Body:
  - `booking_id` (required)
  - `payment_kind: 'deposit_only'`
- Main does **not** send booking code, hold record id, guest profile fields in this request.

Expected success payload consumed by Main:
- `ok: true`
- `checkout_url`
- optional: `reused`, `amount_due_cents`, `stripe_checkout_session_id`

## Stripe Webhook Handler contract

Source of truth:
- `n8n/phase2/Wolfhouse - Stripe Webhook Handler.json`
- Only webhook path writes `payments` / `payment_events` and money truth.

Observed contract:
- Processes `checkout.session.completed` events.
- Requires `metadata.booking_id`; throws if missing.
- Uses `metadata.payment_kind` (`deposit_only` default, `full_amount` optional).
- Updates:
  - `payment_events` insert (`processed=true`)
  - `payments` status/paid fields and payment intent/session linkage
  - `bookings.payment_status` -> `deposit_paid` or `paid`
  - `bookings.send_confirmation = true`
- Does **not** set `bookings.status = confirmed` (left to confirmation workflow).

## Send Confirmation contract

Source:
- `docs/PHASE-2d.md`
- `n8n/phase2/Wolfhouse - Send Confirmation (local).json`

Selection gate (Postgres):
- `send_confirmation = true`
- `status = payment_pending`
- `payment_status in (deposit_paid, paid)`
- `confirmation_sent_at is null`

Ordering guarantee:
1. Build/send WhatsApp confirmation
2. Only on WhatsApp success: mark booking `confirmed`, set `send_confirmation=false`, set `confirmation_sent_at`
3. On send failure: remains `payment_pending` and retriable

Main contract implication:
- Main should **not** confirm booking directly.
- Main should only progress to payment pending/link state and leave payment truth + confirmation completion to webhook/confirmation workflows.

## Ensure promote audit (`Postgres - Ensure Booking In Postgres`)

`scripts/lib/main-ensure-booking-pg-sql.js` and injected Main node confirm:
- Promotes `hold` -> `payment_pending` + `waiting_payment`
- Idempotent refresh for existing `payment_pending`
- Inserts backward-compatible row when missing and required core fields present
- Blocks terminal statuses (`confirmed`, `checked_in`, `cancelled`, `expired`)
- Returns `booking_id` and action flags (`created`, `promoted`, `action`)
- Uses sentinel-bound params (`__NULL__`) to prevent `$n` drift
- Does **not** write `payments` / `payment_events`
- Uses `(client_id, booking_code)` conflict strategy to avoid duplicate booking rows

## Risks before payment runtime

1. Payment session accidentally created during non-payment route (guard/route drift).
2. Wrong `booking_id` handed to Create Payment Session (context mismatch across hold sources).
3. Duplicate checkout sessions if idempotency precheck in Create Payment Session is bypassed.
4. Hold lookup miss causing ensure insert on wrong/blank fields.
5. Airtable `Current Hold ID` mismatch vs PG `current_hold_booking_id` linkage.
6. Payment status drift between `bookings.payment_status` and `payments.status`.
7. Duplicate/early confirmation if confirmation workflow trigger criteria are bypassed.
8. Stripe webhook environment not isolated (wrong secret/listener/endpoint target).

## Recommended 3c.f ladder

1. **3c.f.1** Read-only contract audit (**this step**).
2. **3c.f.2** Add optional static report checker (path inventory + forbidden payment writers in Main).
3. **3c.f.3** Controlled `payment_details_provided` runtime with **stub/local Create Payment Session endpoint only**.
4. **3c.f.4** Stripe webhook + Send Confirmation contract validation (local test isolation checks first).
5. **3c.f.5** Phase 3c.f sign-off doc with explicit pass/fail evidence and residual risks.

## 3c.f.2 static checker

Read-only checker script:
- `npm run db:report:main-payment-contract -- --help`
- `npm run db:report:main-payment-contract`

Outputs:
- Console summary
- JSON report: `reports/main-payment-contract-<timestamp>.json`

Checks:
- Required `payment_details_provided` path nodes exist
- Create Payment Session request contract from Main (`booking_id`, `payment_kind=deposit_only`, env/local URL fallback)
- Ensure node contract flags (booking_id return, terminal-status block, no payments/event SQL)
- Forbidden `payments` / `payment_events` SQL writers in Main
- Send Confirmation reference audit + known risks/warnings

Flags:
- `read_only: true`
- `no_mutations: true`
