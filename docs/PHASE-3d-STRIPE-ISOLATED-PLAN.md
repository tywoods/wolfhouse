# Phase 3d.1 — Stripe isolated planning gate

**Status:** Planning only through 3d.3 (no runtime execution in these phases).

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

## 3d.2 static checker

Read-only command set:
- `node scripts/report-stripe-contract.js --help`
- `node scripts/report-stripe-contract.js`
- `npm run db:report:stripe-contract`

Expected output flags:
- `read_only=true`
- `no_mutations=true`

## 3d.3 direct isolated Create Payment Session test plan (no execution in this step)

### Scope boundary

- **In scope (future 3d.3 runtime):** one direct HTTP POST to local Create Payment Session workflow only.
- **Out of scope:** Main webhook, Main execution path, Stripe Webhook Handler, Send Confirmation gate, Airtable/Sheets mutations.
- **Intentional limited PG writes (future runtime only):** `payments` insert or reuse path; `bookings.payment_status` update to `payment_link_sent` per workflow contract. **No** `payment_events` writes from Create Payment Session workflow.

### Disposable booking criteria

Use a dedicated local/test booking that satisfies all of:

| Criterion | Requirement |
|-----------|-------------|
| Environment | Local wolfhouse DB only; not production/hosted prototype data |
| Booking identity | Explicit `booking_id` (UUID) and `booking_code` recorded before test |
| Status | `payment_pending` preferred; `hold` acceptable if promoted immediately before test |
| Payment status | `waiting_payment` or `not_requested` at start; must not be terminal (`confirmed`, `cancelled`, `expired`, `checked_in`) |
| Confirmation | `send_confirmation=false`, `confirmation_sent_at=NULL` |
| Beds | `booking_beds` count for target booking = 0 |
| Payment rows | **Default:** no active reusable `payments` row for same `booking_id` + `deposit_only` with open checkout (clean new-session path). **Optional variant:** pre-seed one open checkout row only when explicitly testing idempotency reuse |
| Prior Stripe noise | Not used in prior stub/Main E2E payment-link runs for this same test window |

Suggested candidate pattern: create via existing hold tooling or select an unused `WH-*` test booking; do **not** reuse `WH-260528-9437` from 3c.g.2l stub evidence unless intentionally resetting payment rows first.

### Exact request payload (future runtime)

Direct POST body (JSON):

```json
{
  "booking_id": "<disposable-booking-uuid>",
  "payment_kind": "deposit_only"
}
```

Endpoint (local, intentional):

- `POST http://localhost:5678/webhook/create-payment-session`
- Content-Type: `application/json`

Do **not** call via Main `N8N_CREATE_PAYMENT_SESSION_URL` override in this gate.

### Workflow activation boundary (future runtime)

| Workflow | Required state during test window |
|----------|----------------------------------|
| `Wolfhouse - Create Payment Session` (`n8n/phase2/Wolfhouse - Create Payment Session.json`, path `create-payment-session`) | **Active only this workflow** |
| `Wolfhouse Booking Assistant - Main (local Stripe)` | Inactive |
| `Wolfhouse - Create Payment Session (stub local)` | Inactive |
| All legacy/hosted Create Payment Session forks | Inactive |
| `Wolfhouse - Stripe Webhook Handler` | Inactive |
| `Wolfhouse - Send Confirmation (local)` | Inactive (recommended; avoids ambient schedule side effects) |

Pre-POST webhook registration check:

- `create-payment-session` must map only to the intended real Create Payment Session workflow id in local n8n DB.

### Stripe safety prerequisites (future runtime)

Before activation/POST:

1. `STRIPE_SECRET_KEY` (or Stripe API credential) verified as **test mode** (`sk_test_...`); hard stop if live key pattern detected.
2. No hosted/prod URL in target endpoint (`localhost` or `http://n8n:5678` only).
3. `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` reviewed (local success/cancel URLs only).
4. Workflow active-state table above satisfied.
5. Rollback plan prepared: deactivate Create Payment Session immediately after single POST completes.

### Baseline checks (future runtime, read-only before POST)

Record and keep:

- Global: `COUNT(*)` on `payments`, `payment_events`
- Target booking: `status`, `payment_status`, `send_confirmation`, `confirmation_sent_at`, `booking_code`
- Target booking: `COUNT(*)` on `payments` and `payment_events` filtered by `booking_id`
- Target booking: `COUNT(*)` on `booking_beds` filtered by `booking_id`
- Latest execution ids: Create Payment Session, Stripe Webhook Handler, Send Confirmation (n8n `execution_entity`)

### Expected effects (future runtime)

| Area | Expected |
|------|----------|
| HTTP response | `ok: true`, `checkout_url` present, Stripe-hosted URL (`https://checkout.stripe.com/...` or test equivalent) |
| Stripe API | Real checkout session created (or `reused: true` if idempotency path intentionally tested) |
| `payments` | New row with `status=checkout_created` on new-session path, or reuse response on existing-open-checkout path |
| `payment_events` | **No change** from Create Payment Session workflow |
| `bookings.payment_status` | May become `payment_link_sent` per workflow SQL |
| `bookings.status` | Must **not** become `confirmed` |
| `send_confirmation` | Must remain `false` |
| `confirmation_sent_at` | Must remain `NULL` |
| `booking_beds` | No new rows |

### Hard stops (future runtime)

Stop immediately and deactivate if any occur:

- Live Stripe key detected.
- Wrong workflow active (Main, stub, webhook handler, or unexpected Create Payment Session duplicate).
- Stripe Webhook Handler execution occurs.
- Send Confirmation changes target booking (`send_confirmation`, `confirmation_sent_at`, or `status=confirmed`).
- Unexpected `payment_events` rows appear for target booking.
- Booking becomes `confirmed`.
- Duplicate unexpected checkout sessions beyond idempotency test intent.
- Workflow cannot be deactivated after POST.

### 3d.3 execution step (not done here)

When approved, next runtime step is exactly one direct POST + post-read verification + immediate deactivation. No second POST, no Main, no webhook replay.

