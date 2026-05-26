# Phase 2c — Main (local Stripe) fork

Wire **Create Payment Session** into the **local Main** workflow on `payment_details_provided`. Hosted systems unchanged.

**Deferred:** 2c-b (auto-check Airtable Send Confirmation from webhook).

**Checkpoint:** `docs/PHASE-2c-CHECKPOINT.md` (frozen — regenerate fork from build script only).

---

## Verified end-to-end (local)

Phase 2c passed locally with a **new** WhatsApp booking (example: `WH-recSyn7QcPdVrYa1D`):

| Step | Result |
|------|--------|
| Ensure Booking In Postgres | Row created/found; `booking_id` returned |
| Create Payment Session | `checkout.stripe.com` URL |
| Airtable Payment Link | Updated |
| Stripe Checkout | **€200.00** |
| Webhook | `deposit_paid`, `send_confirmation=true`, `payments.status=paid` |
| `bookings.status` | Still `payment_pending` (Send Confirmation sets Confirmed later) |

---

## Ensure Booking — `__NULL__` query parameters

n8n Postgres **drops empty** optional query parameters, which **shifts** `$1`, `$2`, … and breaks SQL.

**Fix (preserved in build script):**

1. Every query parameter expression uses sentinel `__NULL__` when the Airtable value is empty.
2. SQL uses `NULLIF($n, '__NULL__')` for all bound values.
3. `airtable_record_id` is set to **`NULL`** in SQL (not passed as `$12` yet).

Regenerate after changes: `npm run build:main:local-stripe`

---

## What changed in the fork

File: `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json`

Built from hosted export via:

```powershell
node scripts/build-main-local-stripe.js
```

**Branch** (after `Update Hold With Guest Details`):

```text
IF Use Stripe Checkout (USE_STRIPE_CHECKOUT=true)
  → Postgres Ensure Booking In Postgres (lookup by booking_code, or insert from Airtable hold)
  → IF booking_id ready
      → HTTP POST create-payment-session (deposit_only)
      → IF checkout_url
          → Airtable update Payment Link
  → (any failure) continue without link — no placeholder
→ Update Conversation - Guest Details → … → Reply - Payment Pending
```

New WhatsApp bookings are **inserted into Postgres automatically** (no manual `db:sync`). `deposit_required_cents` is NULL so Create Payment Session uses €200 default.

- **Removed** placeholder from `Update Hold With Guest Details`
- **Reply - Payment Pending** reads link from `Update Booking - Stripe Payment Link` only
- **Payment claim** path untouched
- **Send Confirmation** workflow untouched

---

## 1. Files created / modified

| File | Action |
|------|--------|
| `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` | **Created** (generated fork) |
| `scripts/build-main-local-stripe.js` | **Created** (regenerate fork after hosted Main export updates) |
| `scripts/test-phase2c-stripe-branch.ps1` | **Created** (branch dependency test) |
| `docs/PHASE-2c.md` | **Created** (this file) |
| `docs/PROJECT-ROADMAP.md` | Updated |
| `docs/regression-test-plan.md` | Updated (7.8) |
| `n8n/phase2/README.md` | Updated |
| `infra/.env.example` | Updated |
| `infra/docker-compose.local.yml` | Updated |
| `package.json` | Added `build:main:local-stripe` |

**Not modified:** `n8n/Wolfhouse Booking Assistant - Main.json` (hosted export).

---

## 2. Workflow import order (local n8n)

1. `Wolfhouse - Stripe Checkout Success.json` (Phase 2b)
2. `Wolfhouse - Stripe Webhook Handler.json` (Phase 2b)
3. `Wolfhouse - Create Payment Session.json` (Phase 2b) — **Active**
4. `Wolfhouse Booking Assistant - Main (local Stripe).json` (Phase 2c)

Activate **Create Payment Session** before Main. Only activate **one** Main workflow locally (do not activate hosted Main copy if imported).

After import, open Main (local Stripe) and verify credentials on:

- All **new Postgres** nodes (Phase 2c branch)
- **Update Booking - Stripe Payment Link** (Airtable)
- Recreate Postgres nodes in the UI if credential refs break (same as Phase 2b lesson)

---

## 3. Local n8n credentials to check

| Credential | Used on |
|------------|---------|
| **Wolfhouse Postgres (local)** | `Postgres - Ensure Booking In Postgres` |
| **Airtable Personal Access Token account** | All Airtable nodes (same as Main) |
| **Anthropic** | LLM nodes (same as Main) |
| **WhatsApp** | Outbound sends (if testing full WhatsApp path) |

Env on `n8n` / `n8n-worker` (in `infra/.env`):

```env
USE_STRIPE_CHECKOUT=true
N8N_CREATE_PAYMENT_SESSION_URL=http://localhost:5678/webhook/create-payment-session
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_DEFAULT_DEPOSIT_CENTS=20000
STRIPE_WEBHOOK_SKIP_VERIFY=true
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
```

Restart after changes:

```powershell
docker compose -f infra/docker-compose.local.yml up -d n8n n8n-worker
```

---

## 4. Test methods

### A. Branch dependency test (recommended first)

Confirms Postgres lookup + Create Payment Session for a synced booking:

```powershell
cd C:\Users\tywoo\Desktop\WH
.\scripts\test-phase2c-stripe-branch.ps1 -BookingCode "WH-recXXXX"
```

Use any `booking_code` from Airtable (Ensure step creates Postgres row if missing).

### B. Partial n8n execution (Stripe branch only)

1. Open **Main (local Stripe)** in n8n.
2. Ensure a hold exists in Airtable with `Status=Payment_Pending` and guest details for a phone you control.
3. Run workflow from **`Postgres - Ensure Booking In Postgres`** with pinned data, or execute from **`IF - Use Stripe Checkout`** after a real run reached `Update Hold With Guest Details`.
4. Inspect **`Update Booking - Stripe Payment Link`** output — `Payment Link` should start with `https://checkout.stripe.com/`.

### C. Full test webhook (local only)

Main test webhook (does **not** change production WhatsApp):

```powershell
$body = @{
  phone = "+34600000000"
  guest_message = "Maria Garcia maria.test@example.com"
  source = "test"
} | ConvertTo-Json

Invoke-RestMethod -Method POST `
  -Uri "http://localhost:5678/webhook/e22ec0ce-5f25-448d-beb2-f004aa992987" `
  -ContentType "application/json" `
  -Body $body
```

**Requires:** existing **Hold** for that phone in Airtable with guest details. Postgres row is created by **Ensure Booking In Postgres** if needed.

---

## 5. Expected successful output

After guest details on a synced booking:

| Check | Expected |
|-------|----------|
| Main execution | Phase 2c nodes green through `Update Booking - Stripe Payment Link` |
| Airtable **Payment Link** | `https://checkout.stripe.com/c/pay/cs_test_...` |
| WhatsApp reply (if sent) | Contains Stripe checkout URL; **not** placeholder |
| Stripe Checkout | **€200.00** |
| After pay + webhook (Phase 2b) | `payment_status=deposit_paid`, `deposit_paid_cents=20000`, `send_confirmation=true`, `status=payment_pending`; `payments.status=paid`; `payment_events` has `checkout.session.completed` processed |
| **Payment claim** route | Still does **not** set paid |

If **Ensure Booking** fails (empty params / shifted `$n`): re-import fork built with `npm run build:main:local-stripe`; confirm Query Parameters use `__NULL__` sentinel. Workflow continues without link — **Payment Link** stays empty; reply has **no** URL (no invented link).

---

## 6. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Ensure Booking node errors or returns no row | Re-import fork; verify all 11 query params use `__NULL__` when empty |
| SQL `$n` mismatch / wrong column values | Same — n8n dropped an empty param; never leave optional params blank |
| Postgres node stops branch silently | Node has `alwaysOutputData: true`; check **IF - Booking ID Ready** false branch |
| Credential not persisting after import | Recreate Postgres node in n8n UI (Phase 2b lesson) |

---

## 7. Rollback

1. **Deactivate** `Wolfhouse Booking Assistant - Main (local Stripe)` in local n8n.
2. Set `USE_STRIPE_CHECKOUT=false` in `infra/.env`; restart n8n.
3. Do **not** import or activate the fork on hosted n8n Cloud.
4. Hosted Main export in `n8n/` is unchanged — nothing to revert in git for production.
5. To regenerate fork after pulling hosted Main updates: `npm run build:main:local-stripe`.

---

## Prerequisites

- Phase 2b complete and active
- `npm run db:sync` still useful for bulk CSV mirror; **not required** for new WhatsApp bookings in Phase 2c
- `stripe listen --forward-to http://localhost:5678/webhook/stripe-webhook` when testing payment completion

---

## Next (not Phase 3)

**Phase 2d** — local Send Confirmation from Postgres (`send_confirmation=true`). See `docs/PROJECT-ROADMAP.md`.

Deferred: **2c-b** (Airtable Send Confirmation checkbox from webhook).
