# Phase 2a — `client_id` rename + payment schema prep

**Done in repo:** migrations, scripts, verify. **Not done:** Stripe workflows, hosted systems.

## What changed

| Before | After |
|--------|--------|
| Table `hostels` | `clients` |
| Column `hostel_id` | `client_id` (all tables) |
| `payments.kind` | `payments.payment_kind` (`deposit_only` \| `full_amount`) |
| `payments.amount_cents` | `payments.amount_due_cents` + `amount_paid_cents` |
| `payment_status` enum | + `payment_link_sent`, `expired` |

Wolfhouse Somo data is **preserved** (no DB reset).

## Commands to run (in order)

From `C:\Users\tywoo\Desktop\WH`:

### 1. Apply migrations

**If you have Node/npm locally:**

```powershell
cd C:\Users\tywoo\Desktop\WH
npm install
npm run db:migrate:2a
```

**Otherwise (Docker tools — same as Phase 1):**

```powershell
cd C:\Users\tywoo\Desktop\WH
docker compose -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools sh -c "npm install && npm run db:migrate:2a"
```

**Expected:** Each file prints `OK: database/migrations/003_...` and `OK: database/migrations/004_...` with no `ROLLBACK`.

### 2. Quick SQL checks

```powershell
docker exec -it wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c "SELECT slug FROM clients;"
docker exec -it wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c "SELECT COUNT(*) FROM bookings;"
docker exec -it wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c "SELECT column_name FROM information_schema.columns WHERE table_name='payments' AND column_name LIKE 'amount%';"
```

**Expected:**

- `wolfhouse-somo`
- `9` bookings
- Columns: `amount_due_cents`, `amount_paid_cents`

### 3. Re-sync CSV + verify (idempotent)

```powershell
docker compose -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools sh -c "npm run db:sync && npm run db:verify"
```

**Expected sync output:**

```text
CSV sync complete: { guests: 1, bookings: 9, booking_beds: 12, conversations: 1, messages: 8 }
```

**Expected verify:** all lines with `✓`, ending with **All checks passed.**

## If migration fails

Do **not** reset the database without asking. Send the error text; we can fix forward-only SQL.

**Do not** re-run `001_init.sql` on a database that already has data.

**Fresh database only** (empty volume): run `001_init.sql`, then `003`, then `002` (pricing needs `clients`), then `004`.

## Next: Phase 2b

Stripe test workflows (`create-payment-session`, `stripe-webhook`) on local n8n only.
