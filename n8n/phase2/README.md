# Phase 2 — Local Stripe (`n8n/phase2/`)

Import **only** into **local** n8n (`http://localhost:5678`). Do not import into hosted n8n Cloud.

## Phase 2c — Main fork

See **`docs/PHASE-2c.md`**.

- `Wolfhouse Booking Assistant - Main (local Stripe).json` — import **after** Phase 2b workflows
- Regenerate from hosted Main: `npm run build:main:local-stripe`
- Do **not** edit `n8n/Wolfhouse Booking Assistant - Main.json`

**Ensure Booking In Postgres** (Main fork): query params must use sentinel `__NULL__` when empty; SQL uses `NULLIF($n, '__NULL__')`. `airtable_record_id` is `NULL` in SQL for now. Preserved in `scripts/build-main-local-stripe.js` — regenerate, do not hand-edit the fork.

## Phase 2f — Main routing (local fork build)

See **`docs/PHASE-2f.md`**. Resolver is injected by `scripts/build-main-local-stripe.js` (not hand-edited).

```powershell
npm run test:phase2f-resolver
node scripts/build-main-local-stripe.js
```

---

## Phase 2d — Send Confirmation fork

See **`docs/PHASE-2d.md`**.

- `Wolfhouse - Send Confirmation (local).json` — import after Phase 2c
- Regenerate: `npm run build:send-confirmation:local`
- Do **not** edit `n8n/Wolfhouse - Send Confirmation.json`

---

## Phase 2b prerequisites

1. `infra/.env` with Stripe test keys (see `docs/PHASE-2b.md`).
2. `infra/docker-compose.local.yml` already sets:
   - `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`
   - `NODE_FUNCTION_ALLOW_BUILTIN=crypto`
   - Stripe env vars on `n8n` + `n8n-worker`
3. DB migration `005` (payment intent partial unique index):

```powershell
docker compose -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:migrate:005
```

## Workflow import order

**Phase 2b:**

1. `Wolfhouse - Stripe Checkout Success.json`
2. `Wolfhouse - Stripe Webhook Handler.json`
3. `Wolfhouse - Create Payment Session.json`

**Phase 2c (after 2b active):**

4. `Wolfhouse Booking Assistant - Main (local Stripe).json`

**Phase 2d (after 2c + migration 006):**

5. `Wolfhouse - Send Confirmation (local).json`

Apply migration:

```powershell
docker compose -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:migrate:006
```

After import:

- Map **Wolfhouse Postgres (local)** on all Postgres nodes (2b + **Main 2c branch**)
- Map **Airtable** credential on Main fork
- **Activate** 2b workflows; activate Main fork only for local testing

## Re-import after repo updates

If workflows already exist in n8n, either delete the old copies and re-import, or manually update the **Code** nodes from the JSON files in this folder.

## Webhook URLs (local)

| Workflow | Method | Path |
|----------|--------|------|
| Create Payment Session | POST | `create-payment-session` |
| Stripe Webhook Handler | POST | `stripe-webhook` |
| Checkout Success | GET | `stripe-checkout-success` |
| Send Confirmation (local) | POST | `send-confirmation-local` |

Stripe CLI:

```text
stripe listen --forward-to http://localhost:5678/webhook/stripe-webhook
```

## Signature verification

| Environment | `STRIPE_WEBHOOK_SKIP_VERIFY` | Behaviour |
|-------------|------------------------------|-----------|
| **Production / staging** | `false` (default) | HMAC verify on **raw** body (`rawBody` + binary). Fail closed. |
| **Local n8n** | `true` only if verify fails | Parses pre-parsed JSON — **not secure**; dev only |

## Defaults

- `payment_kind`: `deposit_only`
- **Amount (`deposit_only`):** `deposit_required_cents` if **> 0**, else `STRIPE_DEFAULT_DEPOSIT_CENTS` (20000). Zero is **not** a valid deposit.
- **Amount (`full_amount`):** `total_amount_cents` must be **> 0**
- Webhook: money fields + `send_confirmation=true`; does **not** set `bookings.status`
