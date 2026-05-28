# Phase 3d.1 — Stripe isolated planning gate

**Status:** 3d.4 CPS **PASS** · **3d.5b** webhook **PASS** · **3d.6** Send Confirmation **PASS** (dry-run) · **3d.7b** Main-integrated real Stripe payment-link **PASS** (2026-05-28). Next: **3d.8** pay + isolated webhook on a **new** disposable booking (separate window).

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

### Post-run requirements (3d.5b — completed)

1. Deactivate Stripe Webhook Handler immediately. ✓
2. Re-verify Send Confirmation still inactive and did not execute. ✓
3. Archive: execution id, HTTP response, before/after SQL snapshots. ✓ (below)
4. Leave `send_confirmation=true` on booking until Send Confirmation gate (3d.6+) — **do not** toggle flag manually unless aborting the chain.

---

## 3d.5b — isolated Stripe Webhook Handler runtime — PASS (2026-05-28)

### Scope honored

- One crafted `POST http://localhost:5678/webhook/stripe-webhook` only (Option A).
- **Only** `KZUQvwR6SPWpvaZ5` active during test window; deactivated immediately after response.
- `STRIPE_WEBHOOK_SKIP_VERIFY=true` (no Stripe CLI; no browser pay).
- Send Confirmation schedule node **disabled** in n8n DB; `active=false`; no Send Confirmation execution during test.

### Event payload

| Field | Value |
|-------|--------|
| `id` (Stripe event) | `evt_test_phase3d5b_001` |
| `type` | `checkout.session.completed` |
| `data.object.id` | `cs_test_a1Htl0ZjasUd3Gik7G6tVFkDDFLUIPyJ8ljGYimITsmAH1gcy0KpehvhvT` |
| `metadata.booking_id` | `33ac2766-537c-4b95-85d4-91c01c862beb` |
| `metadata.payment_kind` | `deposit_only` |
| `amount_total` | `20000` |
| `payment_intent` | `pi_test_phase3d5b_001` |

**Do not** replay the same `evt_test_phase3d5b_001` (idempotent no-op).

### Execution evidence

| Item | Value |
|------|--------|
| Workflow | Wolfhouse - Stripe Webhook Handler |
| Workflow id | `KZUQvwR6SPWpvaZ5` |
| Execution id | **1058** (prior webhook on this id: **615**) |
| Status / mode | `success` / `webhook` |
| Started | 2026-05-28 13:32:27 UTC |

### HTTP response

```json
{
  "received": true,
  "processed": true,
  "booking_id": "33ac2766-537c-4b95-85d4-91c01c862beb",
  "payment_status": "deposit_paid",
  "send_confirmation": true,
  "payment_kind": "deposit_only"
}
```

### Target booking / payment (before → after)

| Field | Before | After |
|-------|--------|-------|
| `booking_code` | `WH-260528-1493` | unchanged |
| `status` | `payment_pending` | **`payment_pending`** (not confirmed) |
| `payment_status` | `payment_link_sent` | **`deposit_paid`** |
| `send_confirmation` | `false` | **`true` (expected)** |
| `confirmation_sent_at` | `NULL` | **`NULL`** |
| `deposit_paid_cents` | NULL | `20000` |
| `amount_paid_cents` | NULL | `20000` |
| `balance_due_cents` | NULL | `0` |
| Payment `10ad0f21-…` status | `checkout_created` | **`paid`** |
| Payment `amount_paid_cents` | `0` | `20000` |
| `paid_at` | NULL | set |
| `stripe_payment_intent_id` | NULL | `pi_test_phase3d5b_001` |

### Payments / payment_events

| Metric | Before | After |
|--------|--------|-------|
| Global `payment_events` | 3 | **4** (+1) |
| Booking `payment_events` | 0 | **1** |
| Event | — | `checkout.session.completed` / `evt_test_phase3d5b_001` / `processed=true` |

### Side-effect safety (PASS)

| Check | Result |
|-------|--------|
| Send Confirmation max execution | **1057** (unchanged) |
| Main latest execution | **1036** (unchanged) |
| CPS latest execution | **1050** (unchanged) |
| `booking_beds` | **0** |
| Booking confirmed | **No** |
| All relevant workflows after run | **inactive** |

### Post-3d.5b chain state (hold for 3d.6)

Booking `WH-260528-1493` is in **webhook-success** state: `deposit_paid`, `send_confirmation=true`, still `payment_pending`, `confirmation_sent_at=NULL`. Use this row for isolated Send Confirmation sign-off.

### Recommended gate after 3d.5b

**3d.6** — isolated Send Confirmation only:

- Webhook handler **inactive** (`KZUQvwR6SPWpvaZ5`).
- For **direct-webhook** isolated tests: keep schedule node **`disabled: true`** (see §3d.6e). Re-enable schedule only for a future **schedule-poll** gate.
- `WHATSAPP_DRY_RUN=true` unless real WhatsApp test is explicitly approved.
- Do **not** combine with webhook POST in the same window.

---

## 3d.6 — isolated Send Confirmation (local) — PASS (2026-05-28)

### Scope

- Sign off **Send Confirmation** on booking `WH-260528-1493` after **3d.5b** webhook truth (`deposit_paid`, `send_confirmation=true`, still `payment_pending`).
- **Option B:** direct `POST /webhook/send-confirmation-local` with `booking_id` filter (not schedule poll).
- `WHATSAPP_DRY_RUN=true` — no production WhatsApp Graph API call.
- Stripe Webhook Handler, Main, CPS, and stub **inactive** for all 3d.6 runtime windows.

### Substeps (summary)

| Step | Result | Notes |
|------|--------|-------|
| **3d.6a** | Preflight PASS | Eligibility SQL, credentials, schedule disabled, isolation |
| **3d.6b** | Safe / functional FAIL | Exec **1059** — stopped at Airtable Conversation (0 rows) |
| **3d.6c** | Fix (no runtime) | Postgres credential display-name alignment; SQL returns 1 row |
| **3d.6d** | Patch committed `324c104` | `alwaysOutputData=true` on Conversation + Booking Beds Airtable nodes |
| **3d.6e** | BLOCKED | POST **404** — webhook not registered after CLI publish without n8n restart |
| **3d.6e retry** | **PASS** | Exec **1061** — full chain through dry-run WhatsApp → Mark Confirmed |

### Target booking (3d.6 sign-off)

| Field | Value |
|-------|--------|
| `booking_code` | `WH-260528-1493` |
| `booking_id` | `33ac2766-537c-4b95-85d4-91c01c862beb` |
| `payment_id` | `10ad0f21-0aa4-42c9-9adb-571a82f91698` |
| `phone` | `+353399990329` |

### Workflow / delivery (3d.6e retry)

| Item | Value |
|------|--------|
| Workflow | Wolfhouse - Send Confirmation (local) |
| Workflow id | `gxivKRJexzTCw9x6` |
| Path | `send-confirmation-local` |
| Mode | webhook (`booking_id` in JSON body) |
| Schedule `Schedule - Poll Postgres` | **`disabled: true`** (unchanged for isolated test) |
| Activation | `n8n publish:workflow --id=gxivKRJexzTCw9x6` + **`docker restart n8n-main n8n-worker`** |
| Deactivation | `n8n unpublish:workflow --id=gxivKRJexzTCw9x6` immediately after POST |

**Operational note:** CLI `publish:workflow` alone may not register production webhooks in a **running** n8n instance. After publish, **restart** `n8n-main` and `n8n-worker` (or activate via UI) and verify `webhook_entity` maps `send-confirmation-local` → `gxivKRJexzTCw9x6` before POST.

### Execution evidence (3d.6e retry — PASS)

| Item | Value |
|------|--------|
| Execution id | **1061** (prior Send Confirmation on this workflow: **1060**) |
| Status / mode | `success` / `webhook` |
| Started / stopped | 2026-05-28 16:47:30–39 UTC (~8.8s) |
| `lastNodeExecuted` | `Postgres - Mark Booking Confirmed` |

**Node chain:**

```text
Webhook → Parse → List Pending (Webhook Filter) → IF Pending → Format
  → Search Conversation → Search Booking Beds → Summarize Assigned Rooms
  → Anthropic → Send confirmation reply → Code - Send WhatsApp
  → IF WhatsApp Sent OK → Postgres - Mark Booking Confirmed
```

### Airtable fallback (3d.6d patch proven)

| Node | Airtable records | Behavior |
|------|------------------|----------|
| Search Conversation - Confirmation | **0** (1 placeholder item via `alwaysOutputData`) | Chain continued; language fell back to Format node (`en`) |
| Search Booking Beds - Confirmation | **0** (placeholder) | Summarize ran; empty `assigned_room_summary` / “Not assigned yet” LLM path |

When Airtable rows exist, behavior is unchanged (first matching row still used).

### WhatsApp dry-run evidence

```json
{
  "whatsapp_sent": true,
  "dry_run": true,
  "booking_id": "33ac2766-537c-4b95-85d4-91c01c862beb",
  "to": "+353399990329"
}
```

`Postgres - Mark Booking Confirmed` ran **only after** `IF - WhatsApp Sent OK` (true branch). No real WhatsApp message sent.

### Target booking (before → after 3d.6e retry)

| Field | Before | After |
|-------|--------|-------|
| `status` | `payment_pending` | **`confirmed`** |
| `payment_status` | `deposit_paid` | **`deposit_paid`** (unchanged) |
| `send_confirmation` | `true` | **`false`** |
| `confirmation_sent_at` | `NULL` | **`2026-05-28 16:47:39+00`** |
| `deposit_paid_cents` / `amount_paid_cents` / `balance_due_cents` | 20000 / 20000 / 0 | unchanged |
| `booking_beds` | 0 | **0** |

### Side-effect safety (PASS)

| Check | Result |
|-------|--------|
| Stripe Webhook Handler max execution | **1058** (unchanged) |
| Main max execution | **1036** (unchanged) |
| CPS max execution | **1050** (unchanged) |
| Global `payment_events` | **4** (unchanged) |
| Target `payment_events` | **1** (unchanged) |
| Wrong / multiple bookings confirmed | No |
| Send Confirmation after run | **unpublished** (`active=false`) |

### Isolated Stripe chain on `WH-260528-1493` (complete through confirmation)

| Gate | Execution | Booking state after |
|------|-----------|---------------------|
| 3d.4 CPS | 1050 | `payment_link_sent`, payment `checkout_created` |
| 3d.5b Webhook | 1058 | `deposit_paid`, `send_confirmation=true`, not confirmed |
| **3d.6 Send Confirmation** | **1061** | **`confirmed`**, `send_confirmation=false`, `confirmation_sent_at` set |

### Remaining exclusions (not covered by 3d.6 / 3d.7)

- **Real WhatsApp send** — not tested (`WHATSAPP_DRY_RUN=true` only).
- **Integrated chain** — Main → real Stripe CPS → webhook → confirmation in **one** run not tested (3d.7b stops at checkout URL only).
- **Schedule poll mode** — separate from direct-webhook sign-off; schedule node remains **`disabled: true`** until a future schedule gate intentionally re-enables it.
- **Rooming / reassign E2E** — deferred until hosted reassign URL remap (see Phase 3c residuals).

### Recommended next gate

**3d.8** — pay + isolated Stripe Webhook Handler on a **new** disposable booking (see §3d.7 future chain). Do **not** pay `WH-260528-5369` checkout unless starting that gate with a deliberate plan.

---

## 3d.7 — Main-integrated real Stripe payment-link gate — **PASS** (2026-05-28)

Sign-off booking: **`WH-260528-5369`** (`3dd17e1b-b0c4-46f9-beaf-b2d8653aa0c8`) · phone **`+353399990330`**. Stop point honored: Stripe test **checkout URL created**; **no** browser pay, **no** `stripe-webhook`, **no** Send Confirmation.

| Sub-gate | Status | Notes |
|----------|--------|--------|
| **3d.7a** | **Done** | Env `N8N_CREATE_PAYMENT_SESSION_URL` → real CPS on main + worker; `docker compose` recreate; static reports PASS |
| **3d.7b** (1st) | **FAIL** (safe) | Main exec **1062** — `Send Typing Indicator` WhatsApp **#131009** on `wamid.PHASE3D7B.001`; no booking/conversation/CPS mutations |
| **3d.7c** | **Done** | Commit `e620822` — typing guard `^wamid\.PHASE[0-9A-Z]+`; rebuild + re-import Main inactive |
| **3d.7b** (retry) | **PASS** | Main **1063** / **1064**; CPS **1065**; see §3d.7b runtime evidence |

### 3d.7b runtime evidence — PASS (retry)

**Pre-checks (retry):** git clean on `e620822`; `N8N_CREATE_PAYMENT_SESSION_URL=http://n8n:5678/webhook/create-payment-session` (main + worker); Stripe **test** (`sk_test…`); `db:report:stripe-contract`, `build-main-local-stripe --verify-targets`, `db:report:main-payment-contract` PASS; only Main + real CPS active; Send Confirmation schedule **`disabled: true`**; phone `+353399990330` had **0** bookings; baseline `payments=24`, `payment_events=4`, `booking_beds=0`.

**POST #1** (`wamid.PHASE3D7B.001` — `booking_flow`):

| Item | Value |
|------|--------|
| Main execution | **1063** — **success** |
| Typing guard | No WhatsApp Graph **#131009** (patch validated vs failed **1062**) |
| Booking | `WH-260528-5369` / `3dd17e1b-b0c4-46f9-beaf-b2d8653aa0c8` — `hold` / `not_requested` |
| Conversation | created; `current_hold_booking_id` → booking UUID |
| Airtable | `airtable_record_id=recJLWBVonS7UEG3t` |
| Side effects | `payments` / `payment_events` unchanged; `booking_beds=0`; CPS / webhook / Send Confirmation / stub **did not run** |

**POST #2** (`wamid.PHASE3D7B.002` — `payment_details_provided`):

| Item | Value |
|------|--------|
| Main execution | **1064** — **success** |
| Route / hold | `payment_details_provided`; fresh hold `WH-260528-5369` / same UUID |
| Ensure | executed; PG → `payment_pending` / `payment_link_sent` |
| Guest / email | `Real Stripe Test` · `phase3d.realstripe.test+330@example.com` |
| Real CPS | **1065** — **success** (stub max stayed **1037**) |
| Stripe session | `cs_test_a1izqISOeaPkavMYxmDJmJJHLxKunHC0CKi1HpQ5U4G8feWqnvVj6wps6O` |
| Checkout URL | `checkout.stripe.com` / `cs_test_…` |
| Payment row | `389a5fdd-daa7-4bc1-a5e0-2bf105a5f471` — `checkout_created` → booking `3dd17e1b-…` |
| `payments` global | **24 → 25** |
| `payment_events` global | **4** (unchanged) |
| Safety | `send_confirmation=false`; `confirmation_sent_at` NULL; not `confirmed`; `booking_beds=0`; webhook max **1058**; Send Confirmation max **1061** |

**Post-run:** Main + CPS deactivated; temp payload files removed; git clean.

**Notes:**

- Airtable **Payment Link** field not re-fetched this run — optional UI spot-check on `recJLWBVonS7UEG3t` should match PG `payments.checkout_url`.
- **Do not** open/pay the checkout URL unless starting **3d.8+** deliberately.
- **Keep** evidence: booking `WH-260528-5369`, payment `389a5fdd-…`, executions **1063**, **1064**, **1065**.

**Do not reuse** for another isolated gate without documented reset: `WH-260528-1493` (confirmed chain), `WH-260528-5369` (3d.7 sign-off), `WH-260528-9437` (3c.g stub) unless reset.

---

## 3d.7 — planning reference (preflight + boundary)

### Purpose

Prove **one integrated guest path** from Main through **real** Create Payment Session (Stripe test checkout URL), without re-running isolated CPS / webhook / Send Confirmation gates and **without** completing payment.

Isolated chain already proven on `WH-260528-1493` (execs **1050 → 1058 → 1061**). **Do not reuse** that booking (now `confirmed`). **Do not reuse** `WH-260528-9437` unless deliberately reset — it remains `payment_pending` / `waiting_payment` from **3c.g.2l** stub path.

### Sub-gate split (recommended sequencing)

| Gate | Scope | Stop point |
|------|--------|------------|
| **3d.7a** | Preflight (read-only + env/workflow map) | Before any Main POST |
| **3d.7b** | Runtime: `booking_flow` → `payment_details_provided` → real CPS | **Stop after** Stripe test `checkout_url` returned and Airtable Payment Link updated — **no browser pay**, **no** `stripe-webhook` POST |
| **3d.8** (future) | Pay + isolated webhook on new booking | `deposit_paid`, `send_confirmation=true`, still not confirmed |
| **3d.9** (future) | Send Confirmation or full integrated confirmation | Separate window; dry-run or real WhatsApp per approval |

**Answer for first integrated test:** **Yes — stop at payment-link creation.** Do not complete Checkout or fire webhook in the same window as 3d.7b.

### Integrated test boundary (3d.7b runtime)

| Component | Required state |
|-----------|----------------|
| **Main** (`RBfGNtVgrAkvhBHJ`) | **Active** only for test window (`booking-assistant` webhook) |
| **Create Payment Session** (`esuDIT96iPT63OaQ`) | **Active** — Main HTTP-calls `create-payment-session` (worker URL must be reachable; see env) |
| **Stripe Webhook Handler** (`KZUQvwR6SPWpvaZ5`) | **Inactive** — no `checkout.session.completed` in this gate |
| **Send Confirmation** (`gxivKRJexzTCw9x6`) | **Inactive**; schedule node **`disabled: true`** |
| **CPS stub** (`whCreatePaymentStubLocal01`) | **Inactive**; env must **not** point at stub URL |
| **Stripe Checkout Success** / bed-op local forks | Inactive unless explicitly in scope |
| **Guest message** | `payment_details_provided` (after fresh `booking_flow` hold on same conversation) |
| **Stripe** | Test-mode key only; real Checkout Session API via CPS |

### Preflight blockers (3d.7a — observed 2026-05-28)

| Check | Planning snapshot |
|-------|-------------------|
| `npm run db:report:stripe-contract` | **PASS** (`Overall OK: true`) |
| `node scripts/build-main-local-stripe.js --verify-targets` | **PASS**; Main `active=false`; `Payment SQL hits: 0`; CPS URL fallback = `create-payment-session` in fork JSON |
| `node scripts/report-main-payment-contract.js` | **PASS**; Ensure promotes hold; Main has no direct Stripe API; Airtable hold search + reassign URL warning deferred |
| `N8N_CREATE_PAYMENT_SESSION_URL` on **n8n-main** | Currently **`http://n8n:5678/webhook/create-payment-session-stub-local`** — **must switch to real** `…/webhook/create-payment-session` before 3d.7b + container restart |
| `STRIPE_SECRET_KEY` on n8n | **test** mode (`sk_test…`) at planning time — re-verify; **hard stop** if `sk_live` |
| Webhook path uniqueness | One workflow per path: `booking-assistant`→Main, `create-payment-session`→`esuDIT96iPT63OaQ`, stub→`whCreatePaymentStubLocal01` (inactive) |
| Send Confirmation schedule | `disabled: true` in DB |
| Active workflows in DB (planning) | Only unrelated local PG bed workflows (`B3c2…`, `Kchh…`); Stripe/Main/CPS/confirmation **inactive** |

### Candidate booking strategy (recommended)

**Fresh two-POST E2E** (mirror **3c.g.2l**, replace stub with real CPS):

1. **POST #1 — `booking_flow`** via `booking-assistant` with a **new** `wamid` / trace id and controlled test phone (e.g. dedicated `+353…` test line).
2. Record: `booking_code`, `booking_id` (UUID), Airtable hold `recordId`, conversation `current_hold_booking_id`.
3. **POST #2 — `payment_details_provided`** on the **same** conversation/phone with guest email + payment intent text (same resolver path as 3c.g.2l: `R2F_PAYMENT_DETAILS…`).
4. Verify **Search Hold** selects the **fresh** Airtable row (not `recIP3DFb0nCx8gBh` / not `WH-260528-1493`).
5. **Do not** select `WH-260528-1493` (terminal `confirmed`) or `WH-260528-9437` unless a **documented reset** clears stub state and payments.

Optional alternate (higher risk): reset `WH-260528-9437` Postgres + Airtable hold to pre-payment state — **not recommended** vs disposable fresh hold.

### Expected outcomes (3d.7b success)

| Area | Expected |
|------|----------|
| Main execution | `success`; `resolved_route=payment_details_provided` |
| Hold selection | Fresh hold / `booking_id` matches POST #1 |
| Ensure | `promoted` or `refreshed`; `status=payment_pending`, `payment_status=waiting_payment` or `payment_link_sent` after CPS |
| CPS call | Main → `Code - Call Create Payment Session` → HTTP **200** to real CPS; CPS execution **> 1050** |
| Stripe | Response `checkout_url` host `checkout.stripe.com`; `stripe_checkout_session_id` `cs_test_…` |
| Airtable | **Payment Link** on **fresh** hold record = Stripe test URL (not `example.test`) |
| Postgres `payments` | **+1** row for target `booking_id` (or documented reuse if idempotent) |
| Postgres `payment_events` | **Unchanged** global count |
| Booking | **Not** `confirmed`; `send_confirmation=false`; `confirmation_sent_at` NULL |
| `booking_beds` | **0** (no assign in this path) |
| Side effects | Webhook Handler max exec **1058**; Send Confirmation max exec **1061**; no stub exec |

### Hard stops (3d.7b runtime)

Stop and deactivate workflows if any occur:

- **`sk_live`** or production Stripe webhook URL detected.
- Wrong workflow active or duplicate path mapping (e.g. stub + real CPS both receiving calls).
- **`N8N_CREATE_PAYMENT_SESSION_URL`** still points at stub after restart.
- **Stripe Webhook Handler** executes (max exec **> 1058**).
- **Send Confirmation** executes (max exec **> 1061**) or schedule fires.
- **`payment_events`** global count increases.
- **`booking_beds`** count increases for target booking.
- Booking **`status=confirmed`** or **`confirmation_sent_at`** set.
- **`send_confirmation=true`** (webhook not in scope).
- **Wrong hold** selected (old `WH-260528-1493` or unintended row).
- **Duplicate** unexpected checkout sessions for same booking/kind without documented idempotency.
- Main calls **hosted** reassign URL (rooming — out of scope).
- Cannot deactivate Main + CPS after test.

### Evidence checklist (3d.7b)

**Before POST #1 (baseline):**

- Git clean; record global `payments` / `payment_events` counts.
- Latest execution ids: Main, CPS, Webhook, Send Confirmation, stub.
- `workflow_entity.active` + `webhook_entity` map screenshot or SQL.
- Env: `N8N_CREATE_PAYMENT_SESSION_URL`, `STRIPE_SECRET_KEY` mode (names only in log).

**After POST #1:**

- Main exec id; fresh `booking_code` / `booking_id`; Airtable hold id; PG hold row `status=hold`.

**After POST #2:**

- Main exec id; node evidence: resolver route, Search Hold record id, Ensure output.
- CPS exec id; HTTP response body (`checkout_url`, `stripe_checkout_session_id`, `payment_id`).
- Airtable Payment Link field on correct record.
- PG: target booking payment fields; new `payments` row; `payment_events` unchanged.
- Side-effect max exec ids unchanged for webhook / Send Confirmation.

### Cleanup policy (3d.7b)

1. **Deactivate** Main and CPS immediately after evidence capture.
2. **Do not** pay the Checkout URL in this gate.
3. Optional: `docker restart n8n-main n8n-worker` after unpublish to drop webhook registrations (same lesson as 3d.6e).
4. Restore or document env if temporarily pointed at real CPS (team choice: dedicated `infra/.env` line for 3d.7 vs stub default for day-to-day 3c.g).
5. Delete temp WhatsApp payload files; git clean.
6. Label disposable booking in runbook (code + ids) for optional later **3d.8** webhook test.

### Future integrated chain (explicitly out of 3d.7)

Not in one run:

```text
Main (booking_flow + payment_details)
  → real CPS (checkout URL)     ← 3d.7b stops here
  → guest pays (browser)        ← 3d.8
  → stripe-webhook              ← 3d.8
  → send_confirmation=true      ← 3d.8
  → Send Confirmation           ← 3d.9 (dry-run or real WA)
  → confirmed
```

### Recommended next step (after 3d.7b PASS)

1. **3d.8** — on a **new** disposable booking (or documented reset): guest pays test Checkout URL → isolated `stripe-webhook` only; Send Confirmation **inactive**; schedule **disabled**.
2. **3d.9** (future) — Send Confirmation or full integrated confirmation — separate window.
3. Do **not** combine pay + webhook + Send Confirmation in one test window.

