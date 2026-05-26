# Phase 3b.0 — Bed / booking_beds drift audit (read-only)

**Status:** Implemented (local). **Does not** start 3b.1 Cancel/Assign/Reassign or any dual-write.

## Goal

Before changing bed/staff workflows, prove we can detect:

1. Airtable/CSV `booking_beds` keys missing in Postgres  
2. Postgres `booking_beds` keys missing in CSV export  
3. Per-booking bed row count mismatches  
4. Overlapping Postgres bed assignments (same `bed_id`, date ranges intersect)  
5. Duplicate Postgres rows by natural key `(booking_id, bed_id, start, end)`  
6. Bookings with payment/confirmed state but odd assignment state  

## What runs

| Command | Output |
|---------|--------|
| `npm run db:report:bed-drift` | `reports/bed-drift-<timestamp>.json` |
| `npm run db:report:bed-drift -- --overlap-from=2026-06-01 --overlap-to=2026-08-31` | Same JSON; overlap section filtered by window |
| `npm run test:bed-drift-keys` | Unit checks for date/bed key normalization |

Existing reports unchanged:

- `npm run db:report:drift` — bookings `airtable_record_id` audit (exit 1 only on missing/wrong ID)  
- `npm run planning:report:postgres` — planning CSV from Postgres  

## Tables read (SELECT only)

| Source | Data |
|--------|------|
| `database/Booking Beds-Active Bed Assignments.csv` | Bed assignment natural keys |
| `database/Bookings-Grid view.csv` | Booking codes + status fields (classify local-only) |
| Postgres `clients` | Resolve `wolfhouse-somo` |
| Postgres `bookings` | Status, payment, assignment_status |
| Postgres `booking_beds` | Rows, duplicates, overlaps |
| Postgres `beds` | `bed_code` for overlap report |

**No writes** to Postgres, Airtable, Google Sheets, or n8n.

## Report fields (`reports/bed-drift-*.json`)

| Section | Fields |
|---------|--------|
| `summary` | Row counts, actionable vs local-only key counts, duplicate/overlap/weird counts |
| `per_booking_bed_counts[]` | `booking_code`, `csv_bed_rows`, `postgres_bed_rows`, `delta`, `in_csv_export`, `likely_local_only_booking`, `count_mismatch_actionable` |
| `keys_only_in_csv[]` | `natural_key`, dates, `actionable` (booking in CSV export) |
| `keys_only_in_postgres[]` | Same + `booking_bed_id`, `likely_local_only_booking` |
| `postgres_duplicate_natural_keys[]` | `booking_code`, `bed_code`, dates, `row_count`, `booking_bed_ids[]` |
| `postgres_overlapping_assignments[]` | Two bookings, bed, date ranges, `booking_bed_id_a/b` |
| `weird_assignment_state[]` | `issues[]` e.g. paid but no beds, assigned but zero rows |

Natural key: `booking_code|bed_code|assignment_start_date|assignment_end_date` (ISO dates).

## Actionable vs local-only

- **Likely local-only:** booking exists in Postgres but **not** in `Bookings-Grid view.csv` (Phase 2 test bookings).  
- **Actionable:** booking **is** in the CSV export; key/count/overlap/duplicate/weird flags count toward exit code 1.  

Postgres-only keys on local-only bookings are reported but **not** actionable.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | No actionable bed drift for CSV-export bookings |
| 1 | Actionable: CSV-only keys, PG-only keys (export booking), count mismatch, duplicates, overlaps, or weird state (export booking) |

## Rollback

Delete or revert:

- `scripts/report-booking-bed-drift.js`  
- `scripts/lib/bed-drift-keys.js`  
- `scripts/test-bed-drift-keys.js`  
- `docs/PHASE-3b-0.md`  
- `package.json` script entries  

No DB migrations or workflow changes to undo.

## Test plan

```bash
npm run test:phase2f-resolver
npm run test:planning-row-format
npm run test:bed-drift-keys
npm run db:report:drift
npm run db:report:bed-drift
npm run planning:report:postgres
```

### Pass criteria

- All tests exit 0  
- `db:report:drift`: `missing_airtable_record_id=0`, `wrong_airtable_record_id=0`  
- `db:report:bed-drift`: exit 0 **or** exit 1 with only **actionable** rows explained (no surprise PG mutations)  
- JSON written under `reports/`; console states `No Postgres, Airtable, or Sheets mutations`  

### Expected local notes

- Many Postgres-only bookings / bed keys (`likely_local_only_booking`) — Phase 2 tests  
- Bed drift exit 0 is OK if mismatches are only on local-only bookings  

## Out of scope (3b.1+)

- n8n Cancel / Assign / Reassign  
- Airtable or Sheets writes  
- Dual-write  
- Unique indexes / migrations on `booking_beds`  

See `docs/PHASE-3b-PROPOSAL.md` for 3b.1–3b.5.
