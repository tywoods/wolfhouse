# Phase 3b.2b — Assign booking beds (Postgres only)

**Status:** Implemented (local). **Does not** call Airtable, n8n (3b.2c), or Reassign (3b.3).

**Parents:** [`PHASE-3b-2b-PROPOSAL.md`](PHASE-3b-2b-PROPOSAL.md), [`PHASE-3b-2a.md`](PHASE-3b-2a.md)

## Goal

INSERT `booking_beds` for an explicit `--beds` list and UPDATE `bookings.assignment_status` / `availability_check_status` — same inventory effect as hosted **Bed Assignment** for those beds, **Postgres only**.

Does **not** run `Code - Choose Beds`. Supply beds from CLI or from 3b.2a impact report.

## Commands

```powershell
# Dry-run (default)
npm run db:assign:booking-beds -- --booking-code=WH-rechKjCcySkfLzxUD --beds=R7-B1,R7-B2,R7-B3 --check-in=2026-08-07 --check-out=2026-08-12

# Apply
npm run db:assign:booking-beds -- --booking-code=WH-rechKjCcySkfLzxUD --beds=R7-B1,R7-B2,R7-B3 --check-in=2026-08-07 --check-out=2026-08-12 --execute
```

Docker tools:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:assign:booking-beds -- --booking-code=WH-rec... --beds=R7-B1 --execute
```

### Options

| Flag | Description |
|------|-------------|
| `--booking-code` / `--airtable-record-id` | Booking lookup (one required) |
| `--beds` | **Required** comma-separated bed codes |
| `--check-in` / `--check-out` | Default: booking dates |
| `--execute` | Mutate (default: dry-run) |
| `--assignment-type` | Default `Auto Assigned` |
| `--strict-guest-count` | Refuse `--execute` if beds ≠ `guest_count` |
| `--allow-conflict` | On PG overlap: set `needs_review` / `conflict` instead of failing |

## Before first execute

```powershell
npm run db:report:assign-impact -- --booking-code=WH-rec... --beds=R7-B1,R7-B2 --check-in=... --check-out=...
```

## Mutations (`--execute` only)

| Action | Detail |
|--------|--------|
| INSERT | `booking_beds` for each missing natural key |
| UPDATE | `assignment_status`, `availability_check_status` only |
| Untouched | `status`, `payment_status`, `payments`, `payment_events` |

Single transaction. Idempotent second run: **0** inserts.

## Undo / restore

| Action | Command |
|--------|---------|
| Remove PG beds for booking | `npm run db:cancel:booking-beds -- --booking-code=WH-rec... --execute` |
| Rebuild from CSV | `npm run db:sync` |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (including idempotent 0 inserts) |
| 1 | Error: not found, unknown bed, overlap (without `--allow-conflict`), strict guest count, etc. |

## Test plan

```powershell
npm run db:report:assign-impact -- ...
npm run db:assign:booking-beds -- ...           # dry-run
npm run db:assign:booking-beds -- ... --execute
npm run db:assign:booking-beds -- ... --execute  # idempotent
npm run db:report:bed-drift
npm run planning:report:postgres
npm run test:phase2f-resolver
npm run db:sync   # restore after tests
```

## Out of scope

- Hosted / local n8n Assign (3b.2c)
- Reassign (3b.3)
- Airtable / Sheets / payments
