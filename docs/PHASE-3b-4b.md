# Phase 3b.4b — Manual Entry Postgres mirror (local only)

**Status:** Implemented (local). **Does not** call Airtable, Google Sheets, n8n (3b.4c), or payment tables.

**Parents:** [`PHASE-3b-4b-PROPOSAL.md`](PHASE-3b-4b-PROPOSAL.md), [`PHASE-3b-4a.md`](PHASE-3b-4a.md)

## Goal

Mirror a **Manual Entries** queue row into **Postgres only**: create booking + manual beds, update booking fields, or delete beds + cancel booking.

## Before first execute

```powershell
npm run db:report:manual-entry-impact -- --action=create --manual-entry-id=MAN-... --guest-name=... --check-in=... --check-out=... --beds=...
```

Exit **0** required (no actionable items) unless using `--allow-conflict` intentionally.

## Commands

```powershell
# Dry-run (default)
npm run db:manual-entry:postgres -- --action=create --manual-entry-id=MAN-test --guest-name=Guest --check-in=2026-06-05 --check-out=2026-06-10 --guest-count=2 --beds=R1-B1,R1-B2

# Apply
npm run db:manual-entry:postgres -- --action=create --manual-entry-id=MAN-test ... --execute

# Update
npm run db:manual-entry:postgres -- --action=update --manual-entry-id=MAN-upd --airtable-record-id=recBtWzIvmjQ5mmo0 --guest-name=Updated --execute

# Delete
npm run db:manual-entry:postgres -- --action=delete --manual-entry-id=MAN-del --airtable-record-id=recBtWzIvmjQ5mmo0 --execute
```

Docker tools:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:manual-entry:postgres -- --action=create --manual-entry-id=MAN-test --guest-name=Ty --check-in=2026-06-05 --check-out=2026-06-10 --guest-count=2 --beds=R1-B1,R1-B2 --execute
```

### Options

| Flag | Description |
|------|-------------|
| `--execute` | Mutate (default: dry-run) |
| `--strict-guest-count` | Refuse create `--execute` if beds ≠ `guest_count` |
| `--allow-conflict` | On overlap: `needs_review` / `conflict` instead of failing |
| `--no-strict-overlap` | Allow execute despite overlaps (not recommended) |
| (impact flags) | Same as [`PHASE-3b-4a.md`](PHASE-3b-4a.md) |

## Mutations (`--execute` only)

| Action | INSERT | UPDATE | DELETE |
|--------|--------|--------|--------|
| **create** | `bookings` (if missing), `booking_beds` | booking fields, assignment/availability | — |
| **update** | — | `bookings` fields only | — |
| **delete** | — | `status=cancelled`, assignment fields | all `booking_beds` |

**Untouched:** `payments`, `payment_events`.  
**Delete:** `payment_status` unchanged.  
**Create/update:** `payment_status` mirrored from `--payment-status` on booking row only.

Single transaction per run. Idempotent repeat: 0 bed inserts / 0 deletes when already applied.

## Undo / restore

| Action | Command |
|--------|---------|
| Restore from CSV | `npm run db:sync` |
| Remove beds only | `npm run db:cancel:booking-beds -- --booking-code=WH-rec… --execute` |
| Provisional booking cleanup | `db:sync` or documented SQL in proposal |

## Regression

```powershell
npm run db:report:bed-drift
npm run planning:report:postgres
npm run test:phase2f-resolver
```

**3b.4c+** not started.
