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

## Do not edit by hand

Regenerate with `npm run build:cancel-beds:local` or `npm run build:assign-beds:local`. Hosted sources under `n8n/Wolfhouse - *.json` (read-only).
