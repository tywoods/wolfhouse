# Phase 3b.1b — Postgres-only cancel booking beds

**Status:** Implemented (local). **Does not** call Airtable, touch payments, or start 3b.1c.

**Parents:** [`PHASE-3b-1-PROPOSAL.md`](PHASE-3b-1-PROPOSAL.md), [`PHASE-3b-1b-PROPOSAL.md`](PHASE-3b-1b-PROPOSAL.md), [`PHASE-3b-1a.md`](PHASE-3b-1a.md)

## What it does

For one booking (by `--booking-code` or `--airtable-record-id`):

1. **DELETE** all `booking_beds` for that `booking_id` (scoped by `client_id`)  
2. **UPDATE** `bookings.assignment_status` and `availability_check_status` → `needs_review`  

**Does not:** change `bookings.status`, `payment_status`, `payments`, `payment_events`, or delete the booking row.

Matches hosted **Cancel Bed Assignments** inventory effect in Postgres only.

## Commands

```powershell
# Dry-run (default)
npm run db:cancel:booking-beds -- --booking-code=WH-rechKjCcySkfLzxUD

# Apply
npm run db:cancel:booking-beds -- --booking-code=WH-rechKjCcySkfLzxUD --execute
```

Docker:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools `
  npm run db:cancel:booking-beds -- --booking-code=WH-rechKjCcySkfLzxUD --execute
```

### Flags

| Flag | Description |
|------|-------------|
| `--booking-code=WH-rec…` | Required* |
| `--airtable-record-id=rec…` | Alternative lookup* |
| `--client=wolfhouse-somo` | Client slug |
| `--execute` | Mutate (otherwise dry-run) |
| `--dry-run` | Explicit dry-run (same as default) |
| `--require-status-cancelled` | Refuse `--execute` unless `status` is `cancelled` or `expired` |

## Recommended flow

```powershell
npm run db:report:cancel-impact -- --booking-code=WH-rec...
npm run db:cancel:booking-beds -- --booking-code=WH-rec...
npm run db:cancel:booking-beds -- --booking-code=WH-rec... --execute
npm run db:report:bed-drift
npm run planning:report:postgres
```

## Recovery

Restore PG `booking_beds` from CSV export:

```powershell
npm run db:sync
```

**Local only** — rebuilds client data from `database/*.csv`. Never use to “rollback” payments.

## Idempotency

Second `--execute` on the same booking: **0** `booking_beds` deleted, exit **0**.

## Airtable drift

After execute, CSV export may still list beds → `db:report:bed-drift` may show actionable mismatch until **3b.1c** or manual AT delete. Expected.

## Out of scope

- 3b.1c n8n PG → AT mirror  
- Assign / Reassign  
