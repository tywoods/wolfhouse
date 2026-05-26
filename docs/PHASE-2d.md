# Phase 2d — Send Confirmation from Postgres (local)

Close the booking loop after Stripe deposit: read `send_confirmation=true` from **Postgres**, send WhatsApp confirmation, then set `status=confirmed` — **only after** a successful send.

**Status:** Verified locally (May 2026). Example: `WH-recSyn7QcPdVrYa1D` with `WHATSAPP_DRY_RUN=true`.

**Not in scope:** hosted n8n Cloud, production WhatsApp (unless you explicitly opt in), Airtable Send Confirmation checkbox (2c-b deferred), Phase 3 dual-write.

**Prerequisite:** Phase 2c E2E pass. See `docs/PHASE-2c-CHECKPOINT.md`.

---

## 1. Files created / modified

| File | Action |
|------|--------|
| `database/migrations/006_confirmation_sent_at.sql` | **Created** — `confirmation_sent_at` column + partial index |
| `scripts/build-send-confirmation-local.js` | **Created** — generates local fork from hosted Send Confirmation |
| `n8n/phase2/Wolfhouse - Send Confirmation (local).json` | **Created** (generated) |
| `scripts/test-phase2d-send-confirmation.ps1` | **Created** — manual trigger + DB checks |
| `docs/PHASE-2d.md` | **Created** (this file) |
| `docs/PHASE-2c-CHECKPOINT.md` | **Created** — frozen Phase 2c reference |
| `docs/PROJECT-ROADMAP.md` | Updated |
| `docs/regression-test-plan.md` | Updated (section 8 local) |
| `n8n/phase2/README.md` | Updated |
| `package.json` | `build:send-confirmation:local`, `db:migrate:006` |
| `infra/.env.example` | WhatsApp dry-run vars |
| `infra/docker-compose.local.yml` | Pass WhatsApp env to n8n |

**Untouched:** `n8n/Wolfhouse - Send Confirmation.json` (hosted export), Phase 3 workflows.

Regenerate fork:

```powershell
node scripts/build-send-confirmation-local.js
```

---

## 2. Workflow import order

Import into **local n8n only** (`http://localhost:5678`):

**Phase 2b (if not already active):**

1. `Wolfhouse - Stripe Checkout Success.json`
2. `Wolfhouse - Stripe Webhook Handler.json`
3. `Wolfhouse - Create Payment Session.json`

**Phase 2c:**

4. `Wolfhouse Booking Assistant - Main (local Stripe).json`

**Phase 2d:**

5. `Wolfhouse - Send Confirmation (local).json`

Apply migration **before** activating Phase 2d:

```powershell
docker compose -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:migrate:006
```

Then **activate** `Wolfhouse - Send Confirmation (local)` only (keep hosted Send Confirmation **inactive** on local n8n if imported).

---

## 3. Credentials to check

| Credential | Used on |
|------------|---------|
| **Wolfhouse Postgres (local)** | List pending, Mark confirmed |
| **Anthropic account** | `Send confirmation reply` LLM |
| **Airtable Personal Access Token account** | Read-only: conversation language + booking beds |

**Env on `n8n` / `n8n-worker`** (`infra/.env`):

```env
WHATSAPP_DRY_RUN=true
# WHATSAPP_ACCESS_TOKEN=        # leave unset for dry-run
# WHATSAPP_PHONE_NUMBER_ID=     # leave unset for dry-run
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
```

Restart after changes:

```powershell
docker compose -f infra/docker-compose.local.yml up -d n8n n8n-worker
```

To send a **real** test WhatsApp (not production number — use Meta test number):

```env
WHATSAPP_DRY_RUN=false
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
```

---

## 4. How the local trigger works

Two entry points (same processing path):

```text
Schedule - Poll Postgres (every 3 min)
  → Postgres - List Pending Confirmations

Webhook POST /webhook/send-confirmation-local  { "booking_id": "<uuid>" }
  → Code - Parse Webhook Filter
  → Postgres - List Pending (Webhook Filter)

→ IF Pending Booking Found
→ Code - Format Booking For LLM
→ Search Conversation - Confirmation (Airtable read, language)
→ Search Booking Beds - Confirmation (Airtable read, room summary)
→ Code - Summarize Assigned Rooms
→ Send confirmation reply (LLM)
→ Code - Send WhatsApp
→ IF WhatsApp Sent OK
→ Postgres - Mark Booking Confirmed
```

**Postgres selection criteria:**

- `send_confirmation = true`
- `status = payment_pending`
- `payment_status IN (deposit_paid, paid)`
- `confirmation_sent_at IS NULL`
- `phone` present

**Idempotency:**

- Rows with `confirmation_sent_at` set are never selected again.
- `Mark Booking Confirmed` updates only when `send_confirmation=true`, `status=payment_pending`, and `confirmation_sent_at IS NULL`.
- If WhatsApp fails: `send_confirmation` stays `true` → retry on next poll/webhook.
- **`status` is never set to `confirmed` before WhatsApp succeeds.**

**Default dry-run:** `WHATSAPP_DRY_RUN=true` counts as success for local testing without calling Graph API.

---

## 5. Test command / manual steps

### A. Automated script (recommended)

Polls Postgres for up to **20s** after the webhook (workflow finishes async):

```powershell
cd C:\Users\tywoo\Desktop\WH
.\scripts\test-phase2d-send-confirmation.ps1 -BookingCode "WH-recSyn7QcPdVrYa1D"
```

Optional wait tuning:

```powershell
.\scripts\test-phase2d-send-confirmation.ps1 -BookingCode "WH-rec..." -MaxWaitSeconds 30 -PollIntervalSeconds 2
```

Optional: pass Postgres UUID directly:

```powershell
.\scripts\test-phase2d-send-confirmation.ps1 -BookingId "00000000-0000-0000-0000-000000000000"
```

### B. Manual webhook

```powershell
$bookingId = (docker exec wolfhouse-postgres psql -U wolfhouse -d wolfhouse -t -A -c `
  "SELECT id FROM bookings WHERE booking_code = 'WH-recSyn7QcPdVrYa1D' LIMIT 1;").Trim()

Invoke-RestMethod -Method POST `
  -Uri "http://localhost:5678/webhook/send-confirmation-local" `
  -ContentType "application/json" `
  -Body (@{ booking_id = $bookingId } | ConvertTo-Json)
```

Then inspect n8n execution for `Wolfhouse - Send Confirmation (local)`.

### C. Full chain from Phase 2c booking

Use a booking that already has `send_confirmation=true` after Stripe webhook (Phase 2b/2c). Run script or wait for schedule poll (3 min).

---

## 6. Expected DB state

### Before (ready to confirm)

Example after Phase 2c + Stripe webhook:

| Column | Value |
|--------|-------|
| `booking_code` | `WH-rec…` |
| `status` | `payment_pending` |
| `payment_status` | `deposit_paid` (or `paid`) |
| `send_confirmation` | `true` |
| `confirmation_sent_at` | `NULL` |
| `deposit_paid_cents` | `20000` (if deposit path) |

### After successful run

| Column | Value |
|--------|-------|
| `status` | `confirmed` |
| `send_confirmation` | `false` |
| `confirmation_sent_at` | timestamp (non-null) |
| `payment_status` | unchanged (`deposit_paid` or `paid`) |

### After WhatsApp failure

| Column | Value |
|--------|-------|
| `status` | `payment_pending` (unchanged) |
| `send_confirmation` | `true` (unchanged — retry) |
| `confirmation_sent_at` | `NULL` |

### Re-run idempotency

Second trigger on same booking: **no row selected** (already `confirmation_sent_at` set or `send_confirmation=false`).

---

## 7. Rollback

1. **Deactivate** `Wolfhouse - Send Confirmation (local)` in local n8n.
2. Optionally reset a test booking:
   ```sql
   UPDATE bookings SET
     status = 'payment_pending',
     send_confirmation = true,
     confirmation_sent_at = NULL
   WHERE booking_code = 'WH-recYOURCODE';
   ```
3. Do **not** import or activate the local fork on hosted n8n Cloud.
4. Hosted `n8n/Wolfhouse - Send Confirmation.json` is unchanged.
5. Migration `006` is additive (`confirmation_sent_at` nullable) — no rollback required for local dev.

---

## Behaviour vs hosted Send Confirmation

| | Hosted | Phase 2d local |
|---|--------|----------------|
| Trigger | Airtable `Send Confirmation` checkbox | Postgres `send_confirmation=true` |
| Sets Airtable Confirmed | Yes | **No** |
| Sets Postgres confirmed | No (Phase 3) | **Yes**, after WhatsApp OK |
| WhatsApp token | Hardcoded in export | `$env` + dry-run default |
