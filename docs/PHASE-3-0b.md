# Phase 3.0b — ID backfill & drift report (local only)

**Status:** **3.0b-1 passed** (2026-05-25). Phase **3a not started** (requires explicit approval).

**Scope:** Postgres `bookings.airtable_record_id` backfill + CSV vs Postgres audit. No Airtable API, no Sheets, no n8n changes, no payment mutations.

---

## 3.0b-1 sign-off (passed 2026-05-25)

| Check | Result |
|-------|--------|
| `npm run db:backfill:airtable-ids -- --dry-run` | OK |
| `npm run db:backfill:airtable-ids` | **2** rows updated |
| `npm run db:report:drift` | `missing_airtable_record_id: []`, `wrong_airtable_record_id: []` |
| `npm run test:phase2f-resolver` | All **10** fixtures passed |
| Payment tables | Read-only in drift script — no mutations |
| Hosted / phase2 n8n workflows | Unchanged |

### Backfill summary (local run)

| Metric | Value |
|--------|-------|
| WH-rec* bookings scanned | 11 |
| Already linked | 9 |
| Filled (null/empty → rec…) | 2 |
| Mismatched | 0 |
| Could not derive rec id | 0 |
| Updated | 2 |

### Drift summary (local run)

| Metric | Value |
|--------|-------|
| `missing_airtable_record_id` | `[]` |
| `wrong_airtable_record_id` | `[]` |
| CSV bookings | 9 |
| Postgres bookings | 28 |
| Delta | +19 (expected) |

**Non-blocking for 3.0b:** `npm run db:verify` still reports Bookings CSV=9 vs Postgres=28. The **19** Postgres-only rows are **Phase 2 local test bookings** (e.g. Tier B/C E2E). Drift report lists them under `only_in_postgres`; actionable drift (missing/wrong `airtable_record_id`) is clean. Re-run `db:sync` after a fresh Airtable CSV export if you want counts to align.

---

## Commands

```powershell
cd C:\Users\tywoo\Desktop\WH

npm run db:backfill:airtable-ids -- --dry-run
npm run db:backfill:airtable-ids
npm run db:report:drift
npm run db:verify
npm run test:phase2f-resolver
```

## Mapping rule

`WH-recnO7hgHBR5ixUEc` → `airtable_record_id = recnO7hgHBR5ixUEc` (strip `WH-` prefix).

Only updates rows where `airtable_record_id` is null or empty. Mismatches require `--fix-mismatches`.

## Rollback

Re-sync from CSV (restores ids from export):

```powershell
npm run db:sync
```

Or clear backfilled ids only (does **not** touch payments):

```sql
UPDATE bookings
SET airtable_record_id = NULL, updated_at = NOW()
WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
  AND booking_code LIKE 'WH-rec%';
```

## See also

- [`PHASE-3-PROPOSAL.md`](PHASE-3-PROPOSAL.md)
- [`PHASE-3-0b-3a-IMPLEMENTATION-PLAN.md`](PHASE-3-0b-3a-IMPLEMENTATION-PLAN.md)
- [`regression-test-plan.md`](regression-test-plan.md) — Phase 3.0b-1 row
- Phase **3a** — [`PHASE-3a.md`](PHASE-3a.md) (**passed** 2026-05-26)
