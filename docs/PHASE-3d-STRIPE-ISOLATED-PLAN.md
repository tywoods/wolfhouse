# Phase 3d.1 — Stripe isolated planning gate

**Status:** Planning only (no runtime execution in this phase).

## Boundary

This gate defines how real-Stripe testing will be done safely after Phase 3c closeout.

In scope for 3d.1:
- Documented planning only.
- Static contract and workflow inventory.
- Preconditions, evidence checklist, and hard-stop criteria.

Out of scope for 3d.1:
- No Main activation.
- No webhook POSTs.
- No Stripe checkout session creation.
- No Stripe webhook event processing tests.
- No Send Confirmation runtime tests.
- No Airtable/Sheets/Postgres data mutation.

## Stripe workflow inventory (planning baseline)

- **Main local fork call site**
  - File: `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json`
  - Node contract: `Code - Call Create Payment Session`
  - Request: `POST` to `$env.N8N_CREATE_PAYMENT_SESSION_URL` (local fallback exists)
  - Body: `booking_id`, `payment_kind=deposit_only`

- **Local stub workflow**
  - File: `n8n/phase2/Wolfhouse - Create Payment Session (stub local).json`
  - Workflow id: `whCreatePaymentStubLocal01`
  - Path: `create-payment-session-stub-local`
  - Returns `https://example.test/...` checkout URL (no Stripe API call)

- **Real Create Payment Session workflow (legacy/real path)**
  - File: `n8n/phase2/Wolfhouse - Create Payment Session.json`
  - Path: `create-payment-session`
  - Uses Postgres + Stripe API path behavior

- **Stripe Webhook Handler**
  - File: `n8n/phase2/Wolfhouse - Stripe Webhook Handler.json`
  - Path: `stripe-webhook`
  - Owns `payments` / `payment_events` writes from Stripe events

- **Send Confirmation workflow**
  - File: `n8n/phase2/Wolfhouse - Send Confirmation (local).json`
  - Trigger: schedule + optional local webhook
  - Intended to run only after webhook-driven payment truth conditions

- **Active-state expectation before any future Stripe test**
  - Only workflows explicitly required for that test are active.
  - Main, legacy Create Payment Session variants, Stripe Webhook Handler, and Send Confirmation must be intentionally controlled (not left implicitly active).

## Real-Stripe test prerequisites (future step, not executed here)

1. Stripe credentials are **test-mode only** (never live key).
2. `N8N_CREATE_PAYMENT_SESSION_URL` explicitly targets the intended local endpoint (no hosted/prod URL).
3. Worker-reachable URL requirement is satisfied for queue mode.
4. Pre-test workflow active-state checklist is recorded (Main/stub/legacy/webhook/confirmation).
5. Baseline counters are captured:
   - global `payments`, `payment_events`
   - per-target booking `payments`, `payment_events`, `booking_beds`
6. Disposable target booking is prepared and explicitly identified.
7. Send Confirmation is excluded unless that gate is intentionally in scope.
8. Deactivation/rollback steps are prepared before any POST.

## Evidence checklist for a future isolated Stripe test

- Create Payment Session produced a Stripe **test-mode** checkout session.
- Exactly expected payment/write behavior occurred:
  - `payments` rows
  - `payment_events` rows
  - booking `status` / `payment_status` transitions
- `send_confirmation` behavior matches scope:
  - remains unchanged unless Send Confirmation gate is explicitly included
  - `confirmation_sent_at` remains `NULL` unless confirmation gate is under test
- No duplicate checkout sessions for same booking/payment kind.
- No `booking_beds` writes.
- No legacy workflow accidental execution.
- All workflows deactivated back to expected idle state after test.

## Hard stops (future execution gates)

Stop immediately if any of the following is observed:
- Live Stripe key detected.
- Hosted/prod Create Payment Session URL detected.
- Unexpected `payments` / `payment_events` writes.
- Send Confirmation fires unexpectedly.
- Legacy Create Payment Session workflow executes unexpectedly.
- Workflow cannot be deactivated after test.
- Stripe Webhook Handler receives unexpected event(s) outside planned scenario.

## Recommended next gate after 3d.1

Choose one (do not execute in this document phase):
1. Build a static Stripe contract checker (read-only safety/contract report), then run it.
2. Run an isolated direct Create Payment Session test with a disposable booking and strict hard stops.

Recommended order:
1) static checker first, 2) isolated Create Payment Session test, 3) separate Stripe Webhook Handler gate, 4) separate Send Confirmation gate.

