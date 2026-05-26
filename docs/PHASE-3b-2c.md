# Phase 3b.2c — Bed Assignment workflow local fork (PG + Airtable)

**Status:** Implemented (local). **Import local n8n only** — not hosted Cloud.

**Parents:** [`PHASE-3b-2c-PROPOSAL.md`](PHASE-3b-2c-PROPOSAL.md), [`PHASE-3b-2b.md`](PHASE-3b-2b.md), [`PHASE-3b-1c.md`](PHASE-3b-1c.md)

## What it does

Webhook `POST /webhook/assign-beds-to-booking` (same path as hosted):

1. **Parse** `record_id` / optional `booking_code` (`__NULL__` sentinel for Postgres params).  
2. **Airtable** — hosted path through **Code - Choose Beds** (unchanged scorer).  
3. **Postgres** — INSERT `booking_beds` + UPDATE assignment fields (3b.2b rules) **before** AT create.  
4. **Airtable** — Create Booking Beds + update Bookings (hosted nodes, `continueOnFail`).  
5. **Postgres** — backfill `airtable_record_id`; mirror `assigned` / `available`.  
6. **JSON response** via Respond to Webhook.

Conflict branch: PG `needs_review` / `conflict` → AT conflict update (no bed INSERT).

## Build and import

```powershell
npm run build:assign-beds:local
```

```powershell
docker cp "n8n/phase3b/Wolfhouse - Bed Assignment (local PG).n8n-import.json" n8n-main:/tmp/assign-import.json
docker exec n8n-main n8n import:workflow --input=/tmp/assign-import.json
docker restart n8n-main n8n-worker
```

See [`n8n/phase3b/README.md`](../n8n/phase3b/README.md).

**Stable workflow id (local):** `B3c2AssignLocalPg01`

## Webhook body

```json
{ "record_id": "recXXXXXXXXXXXXXX" }
```

Optional: `"booking_code": "WH-rec…"`.

## Response fields

| Field | Meaning |
|-------|---------|
| `ok` | PG + Airtable success paths completed |
| `booking_code` | `WH-rec…` |
| `record_id` | Airtable `rec…` |
| `pg_inserted_count` | New `booking_beds` rows |
| `pg_skipped_count` | Natural key already existed |
| `pg_conflict_count` | PG overlap conflicts (blocks insert) |
| `airtable_create_ok` | Create Booking Beds succeeded |
| `airtable_update_ok` | Bookings assignment update succeeded |
| `partial_failure` | e.g. `pg_ok_airtable_failed`, `postgres_overlap_conflicts` |
| `idempotent` | Second run: 0 PG inserts (and/or skipped) |
| `errors[]` | Codes / messages |
| `skipped_reason` | e.g. `already_assigned_or_ineligible` |

## Preconditions

- `bookings.airtable_record_id` backfilled for test bookings.  
- Local Postgres + Airtable credentials on workflow.  
- **Deactivate** duplicate `assign-beds-to-booking` workflow on local n8n (hosted Assign vs this fork).  
- Test **Airtable base/PAT** only unless explicitly approved.  
- **Airtable `Assignment Status` = Unassigned** (and not Cancelled/Expired) — otherwise the hosted `IF - Needs Bed Assignment` skips the run and the response returns `skipped_reason: already_assigned_or_ineligible` with no PG/AT mutations.

## Recommended test flow

**Automated success-path E2E** (verified on `recSyn7QcPdVrYa1D`):

```powershell
npm run build:assign-beds:local
# import + publish workflow (see above)
docker compose -f infra/docker-compose.local.yml --profile tools run --rm `
  -e N8N_WEBHOOK_URL=http://host.docker.internal:5678/webhook/ `
  wolfhouse-tools node scripts/run-assign-e2e-local.js --record-id=recSyn7QcPdVrYa1D --guest-count=2
npm run db:report:bed-drift
npm run planning:report:postgres
npm run test:phase2f-resolver
npm run db:sync
```

`prep-assign-e2e-airtable.js` clears AT Booking Beds and sets Unassigned; call the webhook immediately after prep (hosted Airtable automations can race).

**Manual:**

```powershell
npm run db:sync
node scripts/prep-assign-e2e-airtable.js --record-id=recYOURTEST --guest-count=2
scripts/test-assign-beds-webhook.ps1 -RecordId recYOURTEST
scripts/test-assign-beds-webhook.ps1 -RecordId recYOURTEST
npm run db:report:bed-drift
npm run planning:report:postgres
npm run test:phase2f-resolver
npm run db:sync
```

Clear PG beds only: `npm run db:cancel:booking-beds -- --booking-code=WH-rec… --execute`

## SQL sync

Postgres statements live in [`scripts/lib/assign-booking-beds-pg-sql.js`](../scripts/lib/assign-booking-beds-pg-sql.js). Regenerate workflow after SQL changes:

`npm run build:assign-beds:local`

## Failure handling

| Scenario | Recovery |
|----------|----------|
| PG ok, AT fail | Retry webhook; backfill AT ids; `db:report:bed-drift` |
| AT ok, PG fail | `db:assign:booking-beds --execute` with beds from AT/impact |
| Overlap | Fix dates/beds; do not use `--allow-conflict` in fork (blocked) |
| Wrong test data | `db:sync` or `db:cancel:booking-beds --execute` |

**Never** modifies `payments`, `payment_events`, or `bookings.payment_status`.

## Out of scope

Reassign (3b.3), Main, Stripe, Send Confirmation, hosted export edits, production Airtable automations.
