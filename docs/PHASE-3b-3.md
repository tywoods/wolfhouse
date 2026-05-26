# Phase 3b.3b — Reassign workflow local fork (PG + Airtable + chained Assign)

**Status:** Implemented (local). **Import local n8n only** — not hosted Cloud.

**Parents:** [`PHASE-3b-3-PROPOSAL.md`](PHASE-3b-3-PROPOSAL.md), [`PHASE-3b-3a.md`](PHASE-3b-3a.md), [`PHASE-3b-2c.md`](PHASE-3b-2c.md), [`PHASE-3b-1c.md`](PHASE-3b-1c.md)

## What it does

Webhook `POST /webhook/reassign-booking-beds` (same path as hosted):

1. **Parse** `record_id` / `booking_code` (`__NULL__` sentinel for Postgres).  
2. **Airtable** — Get Booking → Normalize → **IF can reassign** (hosted).  
3. **Postgres** — DELETE all `booking_beds` for booking.  
4. **Airtable** — delete old Booking Beds → **Unassigned** / **Not Checked** (hosted).  
5. **Postgres** — mirror `unassigned` / `unknown` (maps AT **Not Checked**).  
6. **HTTP** — `POST` local **Assign (local PG)** fork (`assign-beds-to-booking`).  
7. **JSON response** — aggregated reset + assign metrics.

Bed codes come from **Code - Choose Beds** in the Assign fork (not the Reassign webhook). Use [`PHASE-3b-3a.md`](PHASE-3b-3a.md) `db:report:reassign-impact` with `--beds` to preview explicit targets.

## Build and import

```powershell
npm run build:reassign-beds:local
```

```powershell
docker cp "n8n/phase3b/Wolfhouse - Reassign Bed Assignments (local PG).n8n-import.json" n8n-main:/tmp/reassign-import.json
docker exec n8n-main n8n import:workflow --input=/tmp/reassign-import.json
docker exec n8n-main n8n publish:workflow --id=B3c3ReassignLocal01
docker restart n8n-main n8n-worker
```

See [`n8n/phase3b/README.md`](../n8n/phase3b/README.md).

**Stable workflow id (local):** `B3c3ReassignLocal01`

**Chained Assign URL:** the HTTP node calls `http://n8n-main:5678/webhook/assign-beds-to-booking` (workers cannot use `localhost`). Override at build time: `N8N_ASSIGN_WEBHOOK_URL=... npm run build:reassign-beds:local`.

## Webhook body

```json
{ "record_id": "recXXXXXXXXXXXXXX", "guest_count": 3 }
```

Optional: `"booking_code": "WH-rec…"` (Main-style fields ignored for bed list).

## Response fields

| Field | Meaning |
|-------|---------|
| `ok` | Reset + assign both succeeded |
| `booking_code` | `WH-rec…` |
| `record_id` | Airtable `rec…` |
| `pg_deleted_count` | PG beds removed in reset step |
| `pg_reassign_ready` | PG booking set to unassigned / unknown |
| `airtable_delete_ok` | AT bed deletes succeeded |
| `airtable_reset_ok` | Mark Unassigned update succeeded |
| `assign_triggered` | Local Assign HTTP was called |
| `pg_inserted_count` | From Assign leg |
| `pg_skipped_count` | From Assign leg |
| `pg_conflict_count` | From Assign leg |
| `airtable_create_ok` | From Assign leg |
| `airtable_update_ok` | From Assign leg |
| `partial_failure` | e.g. `assign_failed_after_reset`, `pg_ok_airtable_reset_failed` |
| `idempotent` | Always `false` for whole reassign (destructive reset) |
| `errors[]` | Codes / messages |

## Preconditions

- Local **Assign (local PG)** active on `assign-beds-to-booking`.  
- **Deactivate** hosted Reassign (and hosted Assign) on local n8n if paths collide.  
- Test **Airtable** PAT/base only.  
- Booking must pass **can_reassign** gate (check-in/out, guest count > 0).  
- **Disable or pause** Airtable automation **“Assign Beds When Booking Is Unassigned”** on the test base during E2E (same race as 3b.2c — automation can assign before the chained HTTP assign runs).

## Recommended test flow

```powershell
npm run build:reassign-beds:local
# import + publish (see above)
npm run db:sync
npm run db:report:reassign-impact -- --booking-code=WH-recBtWzIvmjQ5mmo0 --beds=R1-B1,R1-B2,R1-B3 --check-in=2026-06-05 --check-out=2026-06-10
node scripts/prep-reassign-e2e-airtable.js --record-id=recBtWzIvmjQ5mmo0 --guest-count=3
scripts/test-reassign-beds-webhook.ps1 -RecordId recBtWzIvmjQ5mmo0 -GuestCount 3
scripts/test-reassign-beds-webhook.ps1 -RecordId recBtWzIvmjQ5mmo0 -GuestCount 3
npm run db:report:bed-drift
npm run planning:report:postgres
npm run test:phase2f-resolver
npm run db:sync
```

**Automated E2E** (tools container):

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm `
  -e N8N_WEBHOOK_URL=http://host.docker.internal:5678/webhook/ `
  wolfhouse-tools node scripts/run-reassign-e2e-local.js --record-id=recBtWzIvmjQ5mmo0
```

## SQL sync

- [`scripts/lib/reassign-booking-beds-pg-sql.js`](../scripts/lib/reassign-booking-beds-pg-sql.js) — reset DELETE + mirror UPDATE  
- Assign leg: [`scripts/lib/assign-booking-beds-pg-sql.js`](../scripts/lib/assign-booking-beds-pg-sql.js)

Regenerate after SQL changes: `npm run build:reassign-beds:local`

## Failure handling

| `partial_failure` | Meaning | Recovery |
|-------------------|---------|----------|
| `pg_reset_failed` | PG delete did not run | Fix booking lookup; retry |
| `pg_ok_airtable_reset_failed` | PG cleared; AT reset failed | Fix AT creds; manual cleanup |
| `assign_failed_after_reset` | Reset OK; Assign HTTP/flow failed | `test-assign-beds-webhook.ps1` or `db:assign:booking-beds --execute` |
| `reassign_gate_failed` | Dates/guest count gate | Fix booking in AT |

**Never** modifies `payments`, `payment_events`, or `bookings.payment_status`.

## Out of scope

- Hosted Cloud import  
- Manual Entries / Operator Release (3b.4 / 3b.5)  
- Production Airtable automations until cutover
