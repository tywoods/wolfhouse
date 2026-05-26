# Phase 3a — Postgres planning report (read-only)

**Status:** **passed** (2026-05-26). Phase **3b not started** (requires explicit approval).

**Scope:** `npm run planning:report:postgres` → `reports/planning-postgres-<timestamp>.csv`. SELECT-only on `booking_beds` + `bookings`. No n8n, Airtable, Sheets, dual-write, or payment changes.

**Prerequisite:** Phase 3.0b-1 passed — [`PHASE-3-0b.md`](PHASE-3-0b.md).

---

## 3a sign-off (passed 2026-05-26)

| Check | Result |
|-------|--------|
| `npm run test:planning-row-format` | OK (incl. Nights from ISO / `Date` fix) |
| `npm run planning:report:postgres` | `reports/planning-postgres-2026-05-26T10-53-57.csv`, **12 rows** |
| CSV shape | 20 columns (Bookings Sync tab) |
| Check In / Check Out | ISO `YYYY-MM-DD` |
| Nights | Populated (e.g. 2026-05-31→2026-06-04 = 4; 2026-06-04→2026-06-09 = 5; 2026-08-03→2026-08-07 = 4; 2026-08-06→2026-08-11 = 5) |
| Postgres mutations | None (read-only SELECT) |
| `npm run test:phase2f-resolver` | All 10 fixtures passed |
| `npm run db:report:drift` | `missing_airtable_record_id=0`, `wrong_airtable_record_id=0` |
| Hosted / phase2 n8n | Unchanged |

**Non-blocking:** Bookings CSV=9 vs Postgres=28 (Phase 2 local-only test bookings). Same as 3.0b.

---

## Commands

```powershell
cd C:\Users\tywoo\Desktop\WH
docker compose -f infra/docker-compose.local.yml up -d

npm run test:planning-row-format
npm run planning:report:postgres
npm run test:phase2f-resolver
npm run db:report:drift
```

Optional date window:

```powershell
npm run planning:report:postgres -- --from=2026-08-01 --to=2026-08-31
```

Docker tools:

```powershell
docker compose -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools sh -c "npm install && npm run planning:report:postgres"
```

## CSV columns (Bookings Sync shape)

`Booking Record ID`, `Booking ID`, `Booking Source`, `Guest Name`, `Guest Count`, `Check In`, `Check Out`, `Nights`, `Room ID`, `Bed ID`, `Requested Room Type`, `Room Preference`, `Guest Gender / Group Type`, `Status`, `Payment Status`, `Assignment Status`, `Display Text`, `Color Type`, `Last Synced At`, `Notes`.

## Compare to Airtable path

1. Export **Bookings Sync** tab from planning spreadsheet (or test copy) to CSV.  
2. Run `npm run planning:report:postgres`.  
3. Diff on `Booking ID` + `Bed ID` + `Check In` + `Check Out` + `Nights`.

## Rollback

Remove scripts and npm script; delete `reports/planning-postgres-*.csv`. No DB migration was added.

## See also

- [`PHASE-3-PROPOSAL.md`](PHASE-3-PROPOSAL.md)
- [`PHASE-3-0b-3a-IMPLEMENTATION-PLAN.md`](PHASE-3-0b-3a-IMPLEMENTATION-PLAN.md)
- Hosted reference (unchanged): `n8n/Wolfhouse - Sync Planning Sheet.json`
