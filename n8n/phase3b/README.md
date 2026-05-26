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

## Do not edit by hand

Regenerate with `npm run build:cancel-beds:local`. Hosted source: `n8n/Wolfhouse - Cancel Bed Assignments.json` (read-only).
