# Phase 3b.1c — Cancel workflow local fork (PG + Airtable)

**Status:** Implemented (local). **Import local n8n only** — not hosted Cloud.

**Parents:** [`PHASE-3b-1c-PROPOSAL.md`](PHASE-3b-1c-PROPOSAL.md), [`PHASE-3b-1b.md`](PHASE-3b-1b.md)

## What it does

Webhook `POST /webhook/cancel-booking-beds` (same path as hosted):

1. **Postgres** — same mutations as [`cancel-booking-beds-postgres.js`](../scripts/cancel-booking-beds-postgres.js) `--execute`  
2. **Airtable** — hosted nodes: delete Booking Beds, update Assignment / Availability → Needs Review  

JSON response includes `pg_deleted_count`, `airtable_update_ok`, `partial_failure`, `idempotent`.

## Build and import

```powershell
npm run build:cancel-beds:local
```

Import: `n8n/phase3b/Wolfhouse - Cancel Bed Assignments (local PG).json`

See [`n8n/phase3b/README.md`](../n8n/phase3b/README.md).

## Webhook body

```json
{ "record_id": "recXXXXXXXXXXXXXX" }
```

Optional: `"booking_code": "WH-rec…"`. Parse accepts `record_id`, `RecordId`, or `WH-rec…` (normalized to `rec…`).

**Postgres query params:** n8n drops empty bound parameters. The build uses `__NULL__` sentinel + `NULLIF($n, '__NULL__')` (same pattern as Phase 2c Ensure Booking). Without this, `record_id`-only POSTs fail with `there is no parameter $2`.

## Re-import after `npm run build:cancel-beds:local`

```powershell
docker cp "n8n/phase3b/Wolfhouse - Cancel Bed Assignments (local PG).n8n-import.json" n8n-main:/tmp/cancel-import.json
docker exec n8n-main n8n import:workflow --input=/tmp/cancel-import.json
docker restart n8n-main n8n-worker
```

Uses stable workflow id `KchhRC9b3MIdkzPT` (local instance).

## Response fields (examples)

| Field | Meaning |
|-------|---------|
| `ok` | PG and Airtable both succeeded |
| `record_id` | Airtable `rec…` used for lookup |
| `booking_code` | `WH-rec…` from Postgres or parse |
| `pg_deleted_count` | Rows removed from `booking_beds` |
| `pg_updated` | Booking assignment fields updated in PG |
| `airtable_delete_ok` | Booking Beds deletes succeeded |
| `airtable_update_ok` | Bookings update node succeeded |
| `idempotent` | Second run: 0 PG deletes, AT already clean |
| `partial_failure` | `pg_ok_airtable_failed`, `pg_resolve_failed`, etc. |
| `errors[]` | Non-fatal codes (e.g. AT delete messages) |

## Preconditions

- `bookings.airtable_record_id` backfilled (3.0b) for `WH-rec*`  
- Local Postgres credential on workflow  
- **Deactivate** duplicate `cancel-booking-beds` workflow on local n8n  

## Recommended test flow

```powershell
npm run db:report:cancel-impact -- --booking-code=WH-rechKjCcySkfLzxUD
scripts/test-cancel-beds-webhook.ps1 -RecordId recFromPostgres
# second call for idempotency
npm run db:report:bed-drift
npm run planning:report:postgres
npm run test:phase2f-resolver
```

Restore beds after test: `npm run db:sync`

## Failure handling

| `partial_failure` | Meaning |
|-------------------|---------|
| `pg_ok_airtable_failed` | PG cleared; fix AT creds and retry webhook or delete beds in AT manually |
| `pg_failed_airtable_ok` | AT changed; run `db:cancel:booking-beds --execute` |
| `pg_resolve_failed` | Booking not found / ambiguous in Postgres |

## Out of scope

- Hosted Cloud import  
- Assign / Reassign (3b.2+)  
- Payment / Main / Send Confirmation changes  
