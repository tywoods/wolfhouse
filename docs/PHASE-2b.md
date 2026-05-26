# Phase 2b — Stripe test workflows (local only)

**Scope:** Local Docker n8n + local Wolfhouse Postgres. No hosted cloud, Airtable, WhatsApp, Apps Script, Azure, or Main workflow changes.

Do **not** reset the database.

---

## Verified test result (deposit_only)

Local deposit test **passed** with:

| Check | Result |
|-------|--------|
| Create Payment Session | `ok: true`, `checkout_url` returned |
| Stripe test card | Payment completed |
| Webhook executions | Success |
| `bookings.payment_status` | `deposit_paid` |
| `bookings.deposit_paid_cents` / `amount_paid_cents` | `20000` |
| `bookings.send_confirmation` | `true` |
| `bookings.status` | `payment_pending` (correct — Send Confirmation sets Confirmed) |
| `payments.status` | `paid`, `payment_kind` = `deposit_only` |
| `payments.amount_due_cents` / `amount_paid_cents` | `20000` |
| Stripe Checkout UI | **€200.00** (not €0 when `deposit_required_cents` is 0 in DB) |
| Success page | “Thank you — payment received” |
| `payment_events` | `checkout.session.completed`, `processed = true` |

### deposit_only amount rule

Create Payment Session uses:

1. `bookings.deposit_required_cents` **only when > 0**
2. Otherwise `STRIPE_DEFAULT_DEPOSIT_CENTS` (default **20000** = €200)

`0` and `null` both fall back to the default. CSV sync normalizes `Deposit Required` of 0/empty to `NULL` in Postgres.

---

## Fixes applied in repo (post-test)

| Issue | Repo fix |
|-------|----------|
| Code node could not read `$env` | `docker-compose.local.yml`: `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` |
| `fetch` / `URLSearchParams` unavailable in Code | Create Session uses **`this.helpers.httpRequest`** + manual form encoding |
| Webhook signature failed (parsed body) | Verify node: raw `binary` path for **production**; `STRIPE_WEBHOOK_SKIP_VERIFY=true` for **local only** |
| Duplicate NULL `stripe_payment_intent_id` | Migration `005` partial unique index; insert omits PI until webhook |
| Success URL 404 | New workflow **`Wolfhouse - Stripe Checkout Success`** (GET HTML page) |
| `deposit_required_cents = 0` → €0 Checkout | Create Session treats **0 as unset** → `STRIPE_DEFAULT_DEPOSIT_CENTS` (20000); sync stores NULL not 0 |

**Production rule:** `STRIPE_WEBHOOK_SKIP_VERIFY=false` and signature verification must succeed on the raw Stripe body. Never skip verify in production.

---

## 1. Stripe account and keys

1. Create or open a [Stripe Dashboard](https://dashboard.stripe.com) account.
2. Turn **Test mode** ON (toggle top-right).
3. **Developers → API keys** → copy **Secret key** (`sk_test_...`).

Add to `infra/.env` (never commit real keys):

```env
STRIPE_SECRET_KEY=sk_test_xxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxx
STRIPE_DEFAULT_DEPOSIT_CENTS=20000
STRIPE_CHECKOUT_SUCCESS_URL=http://localhost:5678/webhook/stripe-checkout-success?session_id={CHECKOUT_SESSION_ID}
STRIPE_CHECKOUT_CANCEL_URL=https://www.wolf-house.com/surfcampsomo
```

**Webhook secret:** use Stripe CLI (recommended for local), not a Dashboard URL yet:

```powershell
stripe listen --forward-to http://localhost:5678/webhook/stripe-webhook
```

CLI prints `whsec_...` — put that in `STRIPE_WEBHOOK_SECRET`.

---

## 2. Docker / n8n environment (already in compose)

`infra/docker-compose.local.yml` passes Stripe vars and Code-node settings to **`n8n`** and **`n8n-worker`**:

- `env_file: .env`
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`
- `NODE_FUNCTION_ALLOW_BUILTIN=crypto`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_DEFAULT_DEPOSIT_CENTS`, checkout URLs
- `STRIPE_WEBHOOK_SKIP_VERIFY` (default `false`; set `true` in `infra/.env` for local if strict verify fails)

After changing `.env` or compose:

```powershell
cd C:\Users\tywoo\Desktop\WH
docker compose -f infra/docker-compose.local.yml up -d n8n n8n-worker
```

### DB migration 005 (payment intent index)

```powershell
docker compose -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:migrate:005
```

Safe on existing DB; no reset.

---

## 3. Install Stripe CLI on Windows

1. Download: https://github.com/stripe/stripe-cli/releases/latest  
   - Asset: `stripe_X.X.X_windows_x86_64.zip` (or arm64 if applicable).
2. Unzip `stripe.exe` to a folder on your PATH (e.g. `C:\Users\tywoo\bin`).
3. Open a **new** PowerShell:

```powershell
stripe --version
stripe login
```

Browser opens → authorize → return to terminal.

Keep this running during tests:

```powershell
stripe listen --forward-to http://localhost:5678/webhook/stripe-webhook
```

Leave the window open. Events appear when you complete Checkout.

---

## 4. n8n local credentials to create

Open http://localhost:5678 → **Credentials** → **Add credential**.

### A. Wolfhouse Postgres (local) — **required**

| Field | Value |
|-------|--------|
| Host | `wolfhouse-postgres` |
| Port | `5432` |
| Database | `wolfhouse` |
| User | `wolfhouse` (or your `WOLFHOUSE_DB_USER`) |
| Password | same as `infra/.env` `WOLFHOUSE_DB_PASSWORD` |
| SSL | disable |

Use this name exactly so import mapping is easy: **Wolfhouse Postgres (local)**

### B. Stripe API (test) — **optional**

Only if you **do not** set `STRIPE_SECRET_KEY` on the n8n container.

| Type | Header Auth |
| Name | `Authorization` |
| Value | `Bearer sk_test_xxxxxxxx` |

Name: **Stripe API (test)**

---

## 5. Workflow import order

1. `n8n/phase2/Wolfhouse - Stripe Checkout Success.json`
2. `n8n/phase2/Wolfhouse - Stripe Webhook Handler.json`
3. `n8n/phase2/Wolfhouse - Create Payment Session.json`
4. Map **Wolfhouse Postgres (local)** on Postgres nodes
5. **Activate** all three workflows

See `n8n/phase2/README.md`. Re-import or patch Code nodes after pulling repo updates.

---

## 6. Commands to run (test deposit_only)

### Step A — Pick a test booking

```powershell
docker exec -it wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c "
SELECT id, booking_code, status, payment_status, deposit_required_cents, total_amount_cents
FROM bookings
WHERE status = 'payment_pending'
ORDER BY created_at DESC
LIMIT 5;
"
```

Copy a row’s `id` (UUID). Example below uses placeholder `BOOKING_UUID`.

### Step B — Start Stripe listener (separate terminal)

```powershell
stripe listen --forward-to http://localhost:5678/webhook/stripe-webhook
```

### Step C — Create checkout session

```powershell
cd C:\Users\tywoo\Desktop\WH
.\scripts\test-stripe-deposit.ps1 -BookingId "BOOKING_UUID"
```

Or manually:

```powershell
$body = @{ booking_id = "BOOKING_UUID" } | ConvertTo-Json
Invoke-RestMethod -Method POST -Uri "http://localhost:5678/webhook/create-payment-session" -ContentType "application/json" -Body $body
```

**Expected JSON:**

```json
{
  "ok": true,
  "reused": false,
  "booking_id": "...",
  "payment_kind": "deposit_only",
  "amount_due_cents": 20000,
  "checkout_url": "https://checkout.stripe.com/c/pay/cs_test_...",
  "stripe_checkout_session_id": "cs_test_...",
  "payment_id": "..."
}
```

Re-run the same command → `"reused": true` and the **same** `checkout_url` (idempotency).

### Step D — Pay in browser

Open `checkout_url`. Pay with:

- Card: `4242 4242 4242 4242`
- Expiry: any future date
- CVC: any 3 digits

After pay, Stripe redirects to a simple HTML page (`/webhook/stripe-checkout-success`) — not a 404.

### Step E — Verify webhook wrote money (not status)

```powershell
docker exec -it wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c "
SELECT booking_code, status, payment_status, deposit_paid_cents, amount_paid_cents, balance_due_cents, send_confirmation
FROM bookings WHERE id = 'BOOKING_UUID';

SELECT payment_kind, status, amount_due_cents, amount_paid_cents, stripe_checkout_session_id
FROM payments WHERE booking_id = 'BOOKING_UUID' ORDER BY created_at DESC LIMIT 1;

SELECT event_type, processed, stripe_event_id FROM payment_events ORDER BY created_at DESC LIMIT 3;
"
```

**Expected after successful deposit:**

| Field | Expected |
|-------|----------|
| `bookings.status` | Still `payment_pending` (unchanged by webhook) |
| `bookings.payment_status` | `deposit_paid` |
| `bookings.deposit_paid_cents` | `20000` |
| `bookings.amount_paid_cents` | `20000` |
| `bookings.send_confirmation` | `t` (true) |
| `payments.status` | `paid` |
| `payments.payment_kind` | `deposit_only` |
| `payments.amount_paid_cents` | `20000` |
| `payments.amount_due_cents` | `20000` |
| Stripe Checkout UI | **€200.00** (not €0 when `deposit_required_cents` is 0 in DB) |
| Success page | “Thank you — payment received” |

### Step F — Send Confirmation (separate, optional)

Run your existing **Send Confirmation** workflow (still Airtable-driven today) or wait for Phase 2c. The webhook only sets `send_confirmation = true`; **Confirmed** status is set by Send Confirmation, not Stripe.

---

## 7. Optional: test full_amount (schema only)

Pick a booking with `total_amount_cents` set, or set it once for test:

```powershell
docker exec -it wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c "
UPDATE bookings SET total_amount_cents = 50000 WHERE id = 'OTHER_BOOKING_UUID';
"
```

```powershell
$body = @{ booking_id = "OTHER_BOOKING_UUID"; payment_kind = "full_amount" } | ConvertTo-Json
Invoke-RestMethod -Method POST -Uri "http://localhost:5678/webhook/create-payment-session" -ContentType "application/json" -Body $body
```

After pay: `bookings.payment_status` = `paid` (not `deposit_paid`).

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `$env` undefined in Code | `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` on n8n; restart containers |
| `fetch is not defined` / `URLSearchParams` | Re-import Create Payment Session JSON (uses `this.helpers.httpRequest`) |
| Invalid Stripe signature (local) | Set `STRIPE_WEBHOOK_SKIP_VERIFY=true` in `.env` **for local only**; restart n8n |
| Invalid signature (production) | `SKIP_VERIFY=false`; fix raw body delivery; never use parsed JSON for HMAC |
| `stripe_payment_intent_id` duplicate key | Run `npm run db:migrate:005` |
| Success redirect 404 | Import + activate **Stripe Checkout Success** workflow |
| Checkout shows €0.00 | Re-import Create Payment Session; `deposit_required_cents=0` must use default 20000 |
| `STRIPE_WEBHOOK_SECRET` mismatch | Must match **current** `stripe listen` session |
| Postgres from n8n | Host `wolfhouse-postgres`, port `5432` |
| No money update after pay | n8n execution log; metadata must include `booking_id` |

---

## Next: Phase 2c

Wire **Create Payment Session** into a local copy of Main (or a thin test webhook) — still not hosted cloud.
