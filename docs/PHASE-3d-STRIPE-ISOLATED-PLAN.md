# Phase 3d.1 — Stripe isolated planning gate

**Status:** 3d.4 CPS **PASS** · 3d.5 plan **done** · **3d.5a** preflight + schedule isolation **done** (2026-05-28). Next: **3d.5b** webhook runtime (activate only `KZUQvwR6SPWpvaZ5` for one POST).

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

## 3d.4a / 3d.4b preflight (completed before runtime)

- Out-of-scope workflows deactivated: Stripe Webhook Handler (`KZUQvwR6SPWpvaZ5`), Send Confirmation (`gxivKRJexzTCw9x6`).
- Intended Create Payment Session workflow for local runtime: **`esuDIT96iPT63OaQ`** (sole `webhook_entity` mapping for `create-payment-session`).
- Stripe env verified test-mode; success/cancel URLs local/test-safe (`fb6ceb9` documents cancel URL in `infra/.env.example`).
- Four duplicate CPS workflow definitions remain in n8n DB; only `esuDIT96iPT63OaQ` may be activated for this gate.

## 3d.4 direct isolated Create Payment Session — PASS (2026-05-28)

### Scope honored

- One direct `POST http://localhost:5678/webhook/create-payment-session` only.
- No Main, stub, Stripe Webhook Handler, or Send Confirmation activation/execution.
- Workflow activated for test window: **`esuDIT96iPT63OaQ` only**; deactivated immediately after POST.

### Payload

```json
{
  "booking_id": "33ac2766-537c-4b95-85d4-91c01c862beb",
  "payment_kind": "deposit_only"
}
```

### Candidate booking

| Field | Before | After |
|-------|--------|-------|
| `booking_id` | `33ac2766-537c-4b95-85d4-91c01c862beb` | unchanged |
| `booking_code` | `WH-260528-1493` | unchanged |
| `status` | `payment_pending` | `payment_pending` (not confirmed) |
| `payment_status` | `waiting_payment` | `payment_link_sent` |
| `send_confirmation` | `false` | `false` |
| `confirmation_sent_at` | `NULL` | `NULL` |
| `booking_beds` | 0 | 0 |

### Execution evidence

| Item | Value |
|------|--------|
| n8n execution id | **1050** (prior CPS on `esuDIT96iPT63OaQ`: 953) |
| Workflow id | `esuDIT96iPT63OaQ` |
| Status / mode | `success` / `webhook` |
| Path | `reused=false` → new session branch → **Respond - New Session** |

### HTTP response (Stripe test mode)

- `ok=true`, `reused=false`, `payment_kind=deposit_only`
- `amount_due_cents=20000`
- `checkout_url`: Stripe test checkout (`checkout.stripe.com`, `cs_test_...` in URL)
- `stripe_checkout_session_id`: `cs_test_a1Htl0ZjasUd3Gik7G6tVFkDDFLUIPyJ8ljGYimITsmAH1gcy0KpehvhvT`

### Payments / payment_events

| Metric | Before | After |
|--------|--------|-------|
| Global `payments` | 23 | 24 (+1) |
| Global `payment_events` | 3 | 3 (unchanged) |
| Booking `payments` | 0 | 1 |
| Booking `payment_events` | 0 | 0 |

New payment row: `10ad0f21-0aa4-42c9-9adb-571a82f91698` — `deposit_only`, `checkout_created`, `amount_due_cents=20000`, same `cs_test_...` session id as response.

### Side-effect safety (PASS)

- Stripe Webhook Handler latest execution unchanged (**615**).
- Send Confirmation latest execution unchanged (**1049**).
- Main latest execution unchanged (**1036**); stub unchanged (**1037**).
- No `payment_events` write for target booking; no `booking_beds` write; booking not confirmed.

### Post-run workflow state

All relevant workflows returned **inactive** (intended CPS, other CPS copies, Main, stub, webhook handler, Send Confirmation).

### Not in scope for 3d.4 (still separate gates)

- Stripe Webhook Handler (`checkout.session.completed` / payment truth)
- Send Confirmation chain
- Main-integrated payment-details path with real Stripe URL
- Idempotency reuse path (`reused=true`) — not exercised this run

### Recommended next gate

**3d.5** — isolated Stripe Webhook Handler planning (below). Runtime is **3d.5a+** after preflight; do not combine with Send Confirmation in one test window.

---

## 3d.5 isolated Stripe Webhook Handler test plan (planning only — no execution)

### Scope boundary

| In scope (future 3d.5 runtime) | Out of scope |
|--------------------------------|--------------|
| One `checkout.session.completed` delivery to local `stripe-webhook` | Main, Create Payment Session, stub CPS |
| `Wolfhouse - Stripe Webhook Handler` only active during test window | Send Confirmation (schedule **and** `send-confirmation-local` webhook) |
| Intentional PG writes: `payment_events`, `payments`, `bookings` money fields + **`send_confirmation = TRUE`** | `bookings.status` → `confirmed` |
| Verify booking stays `payment_pending`, `confirmation_sent_at` NULL | WhatsApp / Anthropic / Airtable confirmation path |
| | Browser checkout completion unless explicitly chosen as delivery path |
| | `stripe listen` running concurrently with Send Confirmation active |

**Planning-only for 3d.5:** no workflow activation, no webhook POST, no Stripe CLI send, no checkout pay.

### Safety model (what “isolated” means)

The webhook handler **always** sets `bookings.send_confirmation = TRUE` on successful deposit apply (frozen Phase 2b contract). That is **expected** for this gate and is **not** a failure.

Isolation means:

1. **Send Confirmation must not run** — `active=false` alone was **insufficient** in local n8n queue mode (see §3d.5a). The schedule node was disabled in the **n8n DB** for the test window; webhook path must not run either, so `send_confirmation = TRUE` does not cascade to `status = confirmed`, WhatsApp, or `confirmation_sent_at`. **Re-enable schedule before 3d.6.**
2. **No other workflows active** — especially Main and Create Payment Session (duplicate CPS copies in n8n DB remain a preflight risk).
3. **Do not combine gates** — run webhook sign-off in a separate window from Send Confirmation sign-off (3d.6+).

```text
checkout.session.completed
        │
        ▼
Stripe Webhook Handler  ──►  payments.paid, payment_events row
        │                    bookings.deposit_paid*, send_confirmation=TRUE
        │                    bookings.status UNCHANGED (payment_pending)
        ▼
   [STOP — Send Confirmation INACTIVE]
        │
        ✗  (later gate, separate window)
        ▼
Send Confirmation  ──►  status=confirmed, confirmation_sent_at, WhatsApp
```

### Target artifacts (continue 3d.4 chain — recommended)

Reuse the **3d.4 PASS** booking and payment row so the webhook SQL can join on `stripe_checkout_session_id`:

| Artifact | Value (3d.4 evidence) |
|----------|-------------------------|
| Workflow id (CPS, inactive) | `esuDIT96iPT63OaQ` |
| Workflow id (webhook, inactive until runtime) | `KZUQvwR6SPWpvaZ5` |
| Workflow id (Send Confirmation, must stay inactive) | `gxivKRJexzTCw9x6` |
| `booking_id` | `33ac2766-537c-4b95-85d4-91c01c862beb` |
| `booking_code` | `WH-260528-1493` |
| `payment_id` | `10ad0f21-0aa4-42c9-9adb-571a82f91698` |
| `stripe_checkout_session_id` | `cs_test_a1Htl0ZjasUd3Gik7G6tVFkDDFLUIPyJ8ljGYimITsmAH1gcy0KpehvhvT` |
| Pre-webhook `payments.status` | `checkout_created` |
| Pre-webhook `bookings.payment_status` | `payment_link_sent` |
| Pre-webhook `send_confirmation` | `false` |

**Do not** start a second CPS POST on this booking in the webhook window (would create duplicate checkout noise). **Do not** use this booking in a Send Confirmation test window without a documented reset.

Alternative (only if 3d.4 row is reset or abandoned): new disposable booking + fresh CPS run in an **earlier** gate, then webhook on that session — two-step, not same window as Send Confirmation.

### Workflow contract (repo source of truth)

File: `n8n/phase2/Wolfhouse - Stripe Webhook Handler.json`

| Step | Behavior |
|------|----------|
| `POST /webhook/stripe-webhook` | `rawBody: true` for production HMAC |
| `Code - Verify Signature` | Strict HMAC unless `STRIPE_WEBHOOK_SKIP_VERIFY=true` (local direct POST) |
| `Code - Parse Stripe Event` | Processes only `checkout.session.completed`; other types → `skip: true`, no PG write |
| `Postgres - Apply Payment Success` | Joins `payments` on `stripe_checkout_session_id = session.id`; inserts `payment_events`; sets payment `paid`; updates booking money fields + **`send_confirmation = TRUE`** |
| Response | Does **not** call Send Confirmation; does **not** set `bookings.status` |

Required event fields for the paid path:

- `type`: `checkout.session.completed`
- `id`: unique Stripe event id (use a fresh `evt_test_…` per attempt; idempotent replay uses same id → no duplicate `payment_events`)
- `data.object.id`: must equal existing `payments.stripe_checkout_session_id`
- `data.object.metadata.booking_id`: must equal target `booking_id`
- `data.object.metadata.payment_kind`: `deposit_only` (or `full_amount` for alternate tests)
- `data.object.amount_total`: cents paid (expect `20000` for 3d.4 deposit)
- `data.object.payment_intent`: string or object with `id` (may be synthetic `pi_test_…` for local POST)

### Delivery options (ranked for future 3d.5 runtime)

#### Option A — Direct POST with `STRIPE_WEBHOOK_SKIP_VERIFY=true` (**recommended**)

Best control for an isolated gate.

1. Set `STRIPE_WEBHOOK_SKIP_VERIFY=true` in `infra/.env`; restart n8n + worker containers.
2. Activate **only** `KZUQvwR6SPWpvaZ5` (Stripe Webhook Handler).
3. Single `POST http://localhost:5678/webhook/stripe-webhook` with `Content-Type: application/json` and a crafted `checkout.session.completed` body (see payload skeleton below).
4. No `Stripe-Signature` header required when skip-verify is on.
5. Deactivate webhook workflow immediately after POST + read-only verification.

Pros: no Stripe CLI, no browser pay, no accidental parallel workflows.  
Cons: not a full HMAC/raw-body test (defer strict signature test to staging or a dedicated preflight sub-step with `stripe listen`).

#### Option B — Browser pay + `stripe listen` forward

Real Stripe test-mode event after guest completes Checkout.

1. Preconditions: webhook handler **only** active; Send Confirmation **inactive**; **do not** activate CPS.
2. Use existing `checkout_url` from 3d.4 (session still open until expired).
3. In a **separate** terminal: `stripe listen --forward-to http://localhost:5678/webhook/stripe-webhook` (copy `whsec_…` into `STRIPE_WEBHOOK_SECRET` if using strict verify; or use skip-verify for local).
4. Pay with test card `4242…` in browser.
5. Stripe delivers `checkout.session.completed` to listener → n8n.

Pros: end-to-end Stripe signing path possible.  
Cons: timing coupling; listener must not run while Send Confirmation is active; harder to hard-stop mid-flight.

#### Option C — `stripe trigger checkout.session.completed` (**not recommended**)

Default fixture event will **not** match `cs_test_a1Htl0Z…` / metadata for `WH-260528-1493`. Postgres join returns no row or wrong row. Use only after customizing fixture metadata to match a known session (extra work, no benefit over Option A).

### Payload skeleton (Option A — future runtime; do not send in 3d.5 planning)

Use a **new** `evt_test_…` id each first-time test; reuse same id only when testing idempotent no-op.

```json
{
  "id": "evt_test_3d5_WH2605281493_001",
  "object": "event",
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "cs_test_a1Htl0ZjasUd3Gik7G6tVFkDDFLUIPyJ8ljGYimITsmAH1gcy0KpehvhvT",
      "object": "checkout.session",
      "amount_total": 20000,
      "payment_intent": "pi_test_3d5_placeholder",
      "metadata": {
        "booking_id": "33ac2766-537c-4b95-85d4-91c01c862beb",
        "booking_code": "WH-260528-1493",
        "payment_kind": "deposit_only",
        "client_id": "<client_uuid_from_booking_row_if_known>"
      }
    }
  }
}
```

Optional negative control (separate run): `type: "checkout.session.expired"` → expect HTTP 200, `processed: false`, **no** PG writes.

### Workflow activation boundary (future runtime)

| Workflow | Required state |
|----------|----------------|
| `Wolfhouse - Stripe Webhook Handler` (`KZUQvwR6SPWpvaZ5`) | **Active only** |
| `Wolfhouse - Create Payment Session` (`esuDIT96iPT63OaQ` + duplicates) | Inactive |
| `Wolfhouse - Create Payment Session (stub local)` | Inactive |
| `Wolfhouse Booking Assistant - Main (local Stripe)` | Inactive |
| `Wolfhouse - Send Confirmation (local)` (`gxivKRJexzTCw9x6`) | **Inactive (mandatory)** |
| `Wolfhouse - Stripe Checkout Success` | Inactive (unless testing redirect separately) |

Pre-POST checks:

- `stripe-webhook` maps **only** to `KZUQvwR6SPWpvaZ5` in n8n `webhook_entity`.
- `npm run db:report:stripe-contract` exits 0.
- Latest execution ids recorded for: Webhook Handler, Send Confirmation, Main, CPS.

### Baseline checks (future runtime, read-only before POST)

Record:

- Global: `COUNT(*)` on `payments`, `payment_events`
- Target booking: `status`, `payment_status`, `send_confirmation`, `confirmation_sent_at`, `deposit_paid_cents`, `amount_paid_cents`, `balance_due_cents`
- Target booking: `payments` row `10ad0f21-…` — `status`, `stripe_checkout_session_id`, `amount_due_cents`
- Target booking: `payment_events` count; `booking_beds` count
- n8n: latest `execution_entity` id for webhook (**615** at 3d.4 sign-off), Send Confirmation (**1049**), Main (**1036**)

### Expected effects (future runtime — success)

| Area | Expected |
|------|----------|
| HTTP response | `received: true`, `processed: true`, `payment_status` = `deposit_paid`, `send_confirmation` = `true` in response body |
| `payment_events` | +1 row for target booking; `event_type` = `checkout.session.completed`; `processed` = true |
| `payments` | `10ad0f21-…` → `status=paid`, `amount_paid_cents=20000`, `paid_at` set |
| `bookings.payment_status` | `payment_link_sent` → `deposit_paid` |
| `bookings.send_confirmation` | `false` → **`true` (in scope)** |
| `bookings.status` | **`payment_pending` (unchanged)** |
| `bookings.confirmation_sent_at` | **`NULL` (unchanged)** |
| `booking_beds` | 0 |
| Send Confirmation | **No new execution** |
| Main / CPS | **No new execution** |

Global counters (illustrative): `payment_events` 3 → 4; `payments` count unchanged at 24.

### Hard stops (future runtime)

Stop immediately and deactivate webhook if any occur:

- Send Confirmation workflow executes (schedule or webhook).
- `bookings.status` becomes `confirmed` (or any non-`payment_pending` status change).
- `confirmation_sent_at` becomes non-NULL.
- `booking_beds` count increases.
- Main or Create Payment Session executes.
- Wrong workflow active or duplicate `stripe-webhook` mapping.
- `payments` row not found / webhook succeeds but **no** `payment_events` insert (session id mismatch).
- Live Stripe key or hosted webhook URL detected.
- Cannot deactivate webhook workflow after test.

**Not** a hard stop: `send_confirmation` flipping to `true` — that is the contract under test.

## 3d.5a — webhook preflight (read-only + schedule isolation)

**Completed 2026-05-28.** No webhook POST, no booking/payment mutations, repo workflow JSON unchanged.

### Static checks (PASS)

| Command | Result |
|---------|--------|
| `npm run db:report:stripe-contract` | exit 0; `Overall OK: true` |
| `node scripts/build-main-local-stripe.js --verify-targets` | exit 0; Main fork `RBfGNtVgrAkvhBHJ` `active=false`; `Payment SQL hits: 0` |

### Workflow / webhook map (pre-fix)

| Path | Workflow id | `active` (DB) |
|------|-------------|---------------|
| `stripe-webhook` | `KZUQvwR6SPWpvaZ5` | false (sole mapping) |
| `create-payment-session` | `esuDIT96iPT63OaQ` | false |
| `create-payment-session-stub-local` | `whCreatePaymentStubLocal01` | false |
| `send-confirmation-local` | `gxivKRJexzTCw9x6` | false |
| `booking-assistant` | `RBfGNtVgrAkvhBHJ` | false |

Duplicate workflow **names** in n8n DB (6× Stripe Webhook Handler, 4× CPS); only the ids above are registered on target paths.

### Send Confirmation schedule finding (critical)

`gxivKRJexzTCw9x6` had **`active=false`** but the **schedule trigger still fired every ~3 minutes** (local n8n queue mode). Observed executions: **1055** (13:15), **1056** (13:18), **1057** (13:21).

After webhook, Send Confirmation’s poll query would match `send_confirmation=true` + `deposit_paid` + `payment_pending` — accidental confirmation risk.

### 3d.5a-fix — schedule isolation (local n8n DB only)

**Not** repo JSON. Applied on `workflow_entity` + `workflow_history` for `gxivKRJexzTCw9x6`:

- Set **`disabled: true`** on node `Schedule - Poll Postgres` (`n8n-nodes-base.scheduleTrigger`).
- `active=false` on Send Confirmation, webhook, CPS, stub, Main, and **Stripe Checkout Success** `kipSFRdsnXfTPLUc` (was active; hygiene only).
- Restart `n8n-main` + `n8n-worker` twice (once after `active=false`, once after schedule disable).

**Proof:** 4+ minute wait after second restart → **no execution 1058+**; `max_exec_id` remains **1057**.

**Before 3d.6:** re-enable the schedule node (`disabled: false` or re-import from `n8n/phase2/Wolfhouse - Send Confirmation (local).json`).

### Delivery option (chosen for 3d.5b)

**Option A** — crafted `checkout.session.completed` direct POST + `STRIPE_WEBHOOK_SKIP_VERIFY=true` (already set on `n8n-main` / `n8n-worker`; test-mode Stripe key verified).

Option B (Stripe CLI signed forward) deferred.

### Baseline at end of 3d.5a (unchanged — ready for webhook)

| Check | Value |
|--------|--------|
| Booking `WH-260528-1493` | `payment_pending` / `payment_link_sent` |
| `send_confirmation` | false |
| `confirmation_sent_at` | NULL |
| Payment `10ad0f21-…` | `checkout_created`; `cs_test_a1Htl0Z…` |
| Global `payment_events` | 3; booking events 0 |
| Webhook latest execution | **615** |

### 3d.5b runtime allowed only when

1. **Only** `KZUQvwR6SPWpvaZ5` is active for the test window (re-verify others inactive after any n8n restart — startup may log “Activated workflow” for unrelated ids).
2. Send Confirmation: `active=false` **and** schedule node `disabled=true`.
3. Single POST; deactivate webhook immediately after.
4. Send Confirmation `max_exec_id` must not advance during test window.

### Post-run requirements (future runtime)

1. Deactivate Stripe Webhook Handler immediately.
2. Re-verify Send Confirmation still inactive and did not execute.
3. Archive: execution id, HTTP response, before/after SQL snapshots.
4. Leave `send_confirmation=true` on booking until Send Confirmation gate (3d.6+) or explicit reset — **do not** toggle flag manually unless aborting the chain.

### Recommended gate after 3d.5 runtime sign-off

**3d.6** — isolated Send Confirmation only, with webhook **inactive**, targeting bookings that already have `send_confirmation=true` and `deposit_paid` from webhook sign-off; `WHATSAPP_DRY_RUN=true` unless real message test is approved.

