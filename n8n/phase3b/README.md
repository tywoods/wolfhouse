# Phase 3b — Local n8n (bed / staff ops)

Import **only** into **local** n8n (`http://localhost:5678`). Do **not** import into hosted n8n Cloud.

## Cancel Bed Assignments (3b.1c)

**Runbook:** [`docs/PHASE-3b-1c.md`](../../docs/PHASE-3b-1c.md)

1. Regenerate from hosted export (read-only):

   ```powershell
   npm run build:cancel-beds:local
   ```

2. Import `Wolfhouse - Cancel Bed Assignments (local PG).json` (first time), or re-import:

   ```powershell
   docker cp "n8n/phase3b/Wolfhouse - Cancel Bed Assignments (local PG).n8n-import.json" n8n-main:/tmp/cancel-import.json
   docker exec n8n-main n8n import:workflow --input=/tmp/cancel-import.json
   docker restart n8n-main n8n-worker
   ```

3. Map credentials in n8n UI (first import only; `.n8n-import.json` preserves local credential ids):
   - **Wolfhouse Postgres (local)** — same as Phase 2 forks
   - **Airtable** — test PAT / base only (not production unless approved)

4. **Deactivate** the hosted `Wolfhouse - Cancel Bed Assignments` workflow on local n8n if imported — only one workflow may use path `cancel-booking-beds`.

5. Activate the **(local PG)** fork.

6. Test:

   ```powershell
   scripts/test-cancel-beds-webhook.ps1 -RecordId recXXXXXXXX
   ```

   Or:

   ```powershell
   npm run db:report:cancel-impact -- --booking-code=WH-rec...
   npm run db:cancel:booking-beds -- --booking-code=WH-rec... --execute
   ```

## Order of operations (local fork)

1. Postgres: DELETE `booking_beds` + UPDATE assignment fields (`needs_review`)  
2. Airtable: delete Booking Beds + update Bookings (hosted behaviour)

## Bed Assignment (3b.2c)

**Runbook:** [`docs/PHASE-3b-2c.md`](../../docs/PHASE-3b-2c.md)

1. Regenerate from hosted export (read-only):

   ```powershell
   npm run build:assign-beds:local
   ```

2. Re-import:

   ```powershell
   docker cp "n8n/phase3b/Wolfhouse - Bed Assignment (local PG).n8n-import.json" n8n-main:/tmp/assign-import.json
   docker exec n8n-main n8n import:workflow --input=/tmp/assign-import.json
   docker exec n8n-main n8n publish:workflow --id=B3c2AssignLocalPg01
   docker restart n8n-main n8n-worker
   ```

3. Map credentials (Postgres + Airtable test PAT).

4. **Deactivate** hosted `Wolfhouse - Bed Assignment` on local n8n — only one workflow may use `assign-beds-to-booking`.

5. Test (Airtable booking must be **Unassigned** for full path):

   ```powershell
   npm run db:report:assign-impact -- --booking-code=WH-rec... --beds=R7-B1,R7-B2
   scripts/test-assign-beds-webhook.ps1 -RecordId rec...
   ```

## Order of operations (Assign local fork)

1. Postgres: INSERT `booking_beds` + UPDATE assignment fields  
2. Airtable: create Booking Beds + update Bookings (hosted behaviour)  
3. Postgres: backfill `airtable_record_id`; mirror assigned/available  

## Reassign Bed Assignments (3b.3b)

**Runbook:** [`docs/PHASE-3b-3.md`](../../docs/PHASE-3b-3.md)

1. Regenerate:

   ```powershell
   npm run build:reassign-beds:local
   ```

2. Re-import:

   ```powershell
   docker cp "n8n/phase3b/Wolfhouse - Reassign Bed Assignments (local PG).n8n-import.json" n8n-main:/tmp/reassign-import.json
   docker exec n8n-main n8n import:workflow --input=/tmp/reassign-import.json
   docker exec n8n-main n8n publish:workflow --id=B3c3ReassignLocal01
   docker restart n8n-main n8n-worker
   ```

3. Map credentials (Postgres + Airtable test PAT).

4. **Deactivate** hosted `Wolfhouse - Reassign Bed Assignments` on local n8n — only one workflow may use `reassign-booking-beds`.

5. **Activate** local Assign fork (`assign-beds-to-booking`) — Reassign chains HTTP to it.

6. Test:

   ```powershell
   npm run db:report:reassign-impact -- --booking-code=WH-recBtWzIvmjQ5mmo0 --beds=R1-B1,R1-B2,R1-B3 --check-in=2026-06-05 --check-out=2026-06-10
   scripts/test-reassign-beds-webhook.ps1 -RecordId recBtWzIvmjQ5mmo0 -GuestCount 3
   ```

## Order of operations (Reassign local fork)

1. Postgres: DELETE all `booking_beds` for booking  
2. Airtable: delete old Booking Beds → mark **Unassigned** / **Not Checked**  
3. Postgres: mirror `unassigned` / `unknown` (AT Not Checked)  
4. HTTP → local **Assign** fork (Choose Beds → PG insert → AT create)  

## Manual Entries Queue (3b.4c)

**Runbook:** [`docs/PHASE-3b-4c.md`](../docs/PHASE-3b-4c.md) — **MVP signed off** 2026-05-27.

1. Regenerate from hosted export (read-only):

   ```powershell
   docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools node scripts/build-manual-entries-local.js --generate
   docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools node scripts/build-manual-entries-local.js --verify-targets
   ```

2. Re-import:

   ```powershell
   docker cp "n8n/phase3b/Wolfhouse - Manual Entries Queue Processor (local PG).n8n-import.json" n8n-main:/tmp/manual-entries-import.json
   docker exec n8n-main n8n import:workflow --input=/tmp/manual-entries-import.json
   docker restart n8n-main
   ```

3. Map credentials (Postgres + Google OAuth + Airtable **test** PAT).

4. **Deactivate** hosted `Wolfhouse - Manual Entries Queue Processor` on local n8n if imported — only one workflow may use `wolfhouse-manual-entries-queue`.

5. Keep workflow **inactive** except during controlled tests. After activate/deactivate, **restart `n8n-main`** so the webhook registers correctly.

6. Test (sheet row must be queue-ready; body is ignored):

   ```powershell
   docker exec n8n-main n8n update:workflow --id=B3c4ManualEntriesLocal01 --active=true
   docker restart n8n-main
   curl.exe -s -X POST "http://localhost:5678/webhook/wolfhouse-manual-entries-queue" -H "Content-Type: application/json" -d "{}"
   docker exec n8n-main n8n update:workflow --id=B3c4ManualEntriesLocal01 --active=false
   docker restart n8n-main
   ```

**Stable workflow id:** `B3c4ManualEntriesLocal01`  
**Test Sheet:** `1JIY22nrtHXWEi6gPWvvpDfgG8Xe0jT6hmGGzkNXRs10` · **Test Airtable:** `appiyO4FmkKsyHZdK`

## Order of operations (Manual Entries local fork)

| Action | Order |
|--------|--------|
| **Create** | PG create → AT booking + beds → PG backfill AT ids → sheet Synced |
| **Update** | PG update booking → AT update booking → sheet Synced (beds unchanged) |
| **Delete** | PG cancel + delete beds → AT cancel + delete booking beds → sheet Deleted |

CLI mirror (no n8n): `npm run db:manual-entry:postgres` — see [`PHASE-3b-4b.md`](../docs/PHASE-3b-4b.md).

## Do not edit by hand

Regenerate with `npm run build:cancel-beds:local`, `npm run build:assign-beds:local`, `npm run build:reassign-beds:local`, or `node scripts/build-manual-entries-local.js --generate`. Hosted sources under `n8n/Wolfhouse - *.json` (read-only).
