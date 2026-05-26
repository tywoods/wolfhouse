# Phase 3.0b + 3a — Implementation plan (approved scope)

**Status:** Plan only — **no code, migrations, or workflow changes yet.**  
**Approved:** Postgres-first direction later; **Main last**; start with ID link + read-only planning audit.  
**Prerequisite:** Phase 2 local signed off (`91461ea`).

**Hard rules (this slice):**

- Phase 2 regression (Tiers A–C) must stay green  
- No payment row rollback  
- No Main / Stripe / Send Confirmation workflow changes  
- No hosted n8n Cloud edits or imports  
- No production Airtable, WhatsApp, or Stripe webhook changes  
- No Azure/live, no short pay URLs  
- **No dual-write to Airtable** in 3.0b or 3a  

---

## Summary answers (quick reference)

| # | Question | Answer |
|---|----------|--------|
| 1 | Files to create/modify | See §1 — **new scripts + docs only**; optional SQL **view** migration |
| 2 | Migrations | **None required** for 3.0b; **optional** `007_planning_views.sql` (views only) for 3a |
| 3 | Commands | See §3 |
| 4 | Read-only data | Postgres: `rooms`, `beds`, `bookings`, `booking_beds` (SELECT); CSV exports for drift |
| 5 | Dual-write | **Nothing** — Postgres backfill of `airtable_record_id` only; no Airtable writes |
| 6 | Rollback | Delete new scripts/reports; drop views if added; no workflow revert needed |
| 7 | Test without production | Local Docker + CSV exports + optional **copy** of planning spreadsheet |
| 8 | Success | See §8 |

---

## 1. Exact files to create / modify

### Create (new)

| File | Purpose |
|------|---------|
| [`scripts/backfill-airtable-record-ids.js`](../scripts/backfill-airtable-record-ids.js) | 3.0b — set `airtable_record_id` on `bookings` (and `booking_beds` where mappable) from `booking_code` + CSV |
| [`scripts/report-airtable-postgres-drift.js`](../scripts/report-airtable-postgres-drift.js) | 3.0b — drift/audit report (counts, missing links, field samples) |
| [`scripts/planning-report-from-postgres.js`](../scripts/planning-report-from-postgres.js) | 3a — emit planning rows (same column shape as Sync Planning “Bookings Sync” tab) |
| [`scripts/lib/planning-row-format.js`](../scripts/lib/planning-row-format.js) | Shared row builder (port logic from hosted `Code - Prepare Bookings Sync Rows` without n8n) |
| [`scripts/test-planning-row-format.js`](../scripts/test-planning-row-format.js) | Unit tests for color type / bed id normalization (no n8n) |
| [`docs/PHASE-3-0b-3a.md`](../docs/PHASE-3-0b-3a.md) | Short runbook: when to run scripts, how to compare reports |
| `reports/.gitkeep` | Git-tracked folder for generated CSV/JSON (add `reports/*.csv` to `.gitignore`) |

Optional (only if you want SQL in-repo for 3a):

| File | Purpose |
|------|---------|
| [`database/migrations/007_planning_views.sql`](../database/migrations/007_planning_views.sql) | **Views only** — `v_planning_active_assignments` (no table changes) |

### Modify (minimal)

| File | Change |
|------|--------|
| [`package.json`](../package.json) | Add npm scripts: `db:backfill:airtable-ids`, `db:report:drift`, `planning:report:postgres` |
| [`.gitignore`](../.gitignore) | Ignore `reports/*.csv`, `reports/*.json` (keep `.gitkeep`) |
| [`scripts/sync-csv-to-postgres.js`](../scripts/sync-csv-to-postgres.js) | **Small:** set `booking_beds.airtable_record_id` when CSV gains a record-id column; document `booking_code` → `rec` rule in header comment |
| [`scripts/verify-local-db.js`](../scripts/verify-local-db.js) | **Small:** assert % of bookings with non-null `airtable_record_id` where `booking_code LIKE 'WH-rec%'` |
| [`docs/PHASE-3-PROPOSAL.md`](PHASE-3-PROPOSAL.md) | Link to this plan; mark 3.0b/3a as “planned” |
| [`docs/regression-test-plan.md`](regression-test-plan.md) | Add §3.0 / §3a checklist rows (manual pass notes) |

### Do **not** modify

| Path | Reason |
|------|--------|
| `n8n/Wolfhouse Booking Assistant  - Main.json` | Hosted export — read-only |
| `n8n/Wolfhouse - Send Confirmation.json` | Hosted export — read-only |
| `n8n/Wolfhouse - Sync Planning Sheet.json` | Production planning path — unchanged in 3a |
| `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` | No Main migration |
| `n8n/phase2/*Stripe*`, `*Send Confirmation*` | Phase 2 frozen |
| `scripts/build-main-local-stripe.js` | No Ensure Booking / resolver changes |
| `infra/.env` | Local secrets only (never commit) |

### Explicitly **not** in this slice

- New `n8n/phase2/` workflow fork for planning (deferred — script-first is lower risk; optional 3a.1 later)  
- Airtable API nodes against production base  
- Google Sheets **write** to production “Bookings Sync” tab  

---

## 2. Migrations

| Migration | Required? | Contents |
|-----------|-----------|----------|
| **None for 3.0b** | — | `airtable_record_id` columns already exist on `bookings`, `booking_beds`, etc. (`001_init.sql`) |
| **`007_planning_views.sql` (optional, 3a)** | No | `CREATE OR REPLACE VIEW v_planning_active_assignments AS …` — read-only join of `booking_beds` + `bookings` + `beds` + `rooms`, filtering cancelled/expired |

**Backfill is data-only (SQL in script), not a migration file:**

```sql
-- Example logic inside backfill script (not a committed migration)
UPDATE bookings
SET airtable_record_id = SUBSTRING(booking_code FROM 4)
WHERE client_id = $client_id
  AND booking_code LIKE 'WH-rec%'
  AND (airtable_record_id IS NULL OR airtable_record_id = '');
```

**Booking ID convention (already in Phase 1 sync):** `WH-recSyn7QcPdVrYa1D` → `airtable_record_id = recSyn7QcPdVrYa1D` via `bookingCodeToAirtableId()` in [`scripts/sync-csv-to-postgres.js`](../scripts/sync-csv-to-postgres.js).

**Gap:** Phase 2 local bookings created only through Postgres (`Ensure Booking In Postgres`) may have `airtable_record_id = NULL` until also created in Airtable or backfilled from a fresh CSV export. The backfill script reports these rows; it does not invent IDs.

**`booking_beds`:** CSV export has no Airtable assignment `rec…` column today — backfill by composite key `(booking_code, bed_code, assignment_start_date, assignment_end_date)` for drift only; set `airtable_record_id` only when CSV/API provides it later.

---

## 3. Exact scripts / commands

### Prerequisites (every session)

```powershell
cd C:\Users\tywoo\Desktop\WH
docker compose -f infra/docker-compose.local.yml up -d
```

### 3.0b — Link IDs + drift (after refreshing CSVs in `database/`)

```powershell
# Optional: refresh mirror from exports (no Airtable API)
npm run db:sync

# Backfill airtable_record_id on bookings (Postgres only)
npm run db:backfill:airtable-ids

# Drift / audit report → reports/drift-YYYYMMDD.json + console summary
npm run db:report:drift

# Existing verification (must still pass)
npm run db:verify
```

### Phase 2 regression (must stay green — no n8n re-import required for 3.0b)

```powershell
npm run test:phase2f-resolver
npm run build:main:local-stripe
npm run build:send-confirmation:local
```

Tier B/C: only if you touched payment paths (you should not in this slice).

### 3a — Planning report from Postgres (read-only)

```powershell
# Default: write reports/planning-postgres-YYYYMMDD.csv
npm run planning:report:postgres

# Optional flags (to be implemented):
#   --from 2026-08-01 --to 2026-08-31
#   --json
```

### Compare Airtable-path vs Postgres-path (manual, no production)

1. Run hosted workflow **locally** only if you already have a **test copy** of the planning spreadsheet — **or** export “Bookings Sync” tab to CSV after a scheduled sync.  
2. Run `npm run planning:report:postgres`.  
3. Diff CSVs (Excel / `fc` / small compare script in 3a.1 if needed).

**Do not** point new scripts at production Google Sheet ID `1eISph-eVZpylAEFVRS22hxRvWydBj07vz6G-vO7T_cc` for writes.

---

## 4. What data is read-only

| Source | Tables / files | Access |
|--------|----------------|--------|
| **Postgres (local)** | `clients`, `rooms`, `beds` | SELECT — static inventory |
| **Postgres** | `bookings` | SELECT for planning + drift; **UPDATE** only `airtable_record_id` in 3.0b backfill |
| **Postgres** | `booking_beds` | SELECT for planning; optional UPDATE `airtable_record_id` when mappable |
| **Postgres** | `payments`, `payment_events` | SELECT in drift report only — **no UPDATE/DELETE** |
| **Postgres** | `conversations`, `messages`, `guests` | SELECT for drift counts only |
| **CSV exports** | `database/*.csv` | Read-only inputs for drift comparison |
| **Airtable (production)** | — | **Not accessed** by new scripts |
| **Google Sheets (production)** | — | **Not written** in this slice |

**3a planning query (conceptual):** active assignments where booking status ∉ (`cancelled`, `expired`), bed assigned, date range present — mirrors hosted formula on Booking Beds:

```text
AND bed present, start/end dates present,
booking status not Cancelled/Expired
```

---

## 5. What is dual-written?

| Action | 3.0b | 3a |
|--------|------|-----|
| Write Airtable | **No** | **No** |
| Write Postgres business data | **Only** `airtable_record_id` backfill on existing rows | **No** |
| Write Google Sheets | **No** | **No** (report to local `reports/` only) |
| Write payments | **No** | **No** |

Dual-write starts in **Phase 3b+** (Cancel Bed Assignments), not here.

---

## 6. Rollback

| Layer | Rollback |
|-------|----------|
| **Postgres backfill** | `UPDATE bookings SET airtable_record_id = NULL WHERE …` only if needed; safer: re-run `npm run db:sync` from CSV after restore DB snapshot |
| **Views (007)** | `DROP VIEW IF EXISTS v_planning_active_assignments;` |
| **Scripts** | `git revert` commit that added 3.0b/3a scripts |
| **Reports** | Delete `reports/*` |
| **Workflows** | **Unchanged** — nothing to revert in n8n |
| **Payments** | **Never delete or rollback** `payments` / `payment_events` rows |

No hosted export rollback needed (no edits).

---

## 7. How to test without touching production

| Test | Method |
|------|--------|
| **ID backfill** | Local Postgres only; use DB from Phase 2 tests + `npm run db:sync` with **your** CSV exports (staging copy of base, not live API) |
| **Drift report** | Compare `database/*.csv` row counts to Postgres — same as Phase 1 `db:verify`, extended with `airtable_record_id` coverage |
| **Planning report** | Generate `reports/planning-postgres-*.csv`; compare to exported “Bookings Sync” tab from **test** spreadsheet or last local n8n run |
| **Phase 2 guard** | Tier A scripts unchanged; do not re-import Main unless you changed build (you won’t) |
| **Payment safety** | Drift script read-only on `payments`; no DELETE in any new script |
| **Production isolation** | No `appOCWIN47Bui9CSS` API calls; no production webhook URL; no `tywoods.app.n8n.cloud` deploy |

**Recommended test booking codes (from sign-off):**

- `WH-recSyn7QcPdVrYa1D` (Tier B)  
- `WH-recnO7hgHBR5ixUEc` (Tier C chain)  

After backfill, both should show `airtable_record_id` = substring after `WH-` if `booking_code` follows `WH-rec*`.

---

## 8. What success looks like

### Phase 3.0b — complete when

| Criterion | Target |
|-----------|--------|
| `airtable_record_id` on bookings | 100% of rows where `booking_code LIKE 'WH-rec%'` (report lists exceptions) |
| Drift: booking count | Postgres `bookings` count = CSV `Bookings-Grid view.csv` row count (±0 after sync) |
| Drift: booking_beds count | Postgres `booking_beds` = CSV assignment export count (±0 after sync) |
| Unlinked Phase 2-only rows | Documented in report (null `airtable_record_id`, no matching CSV row) — acceptable if explained |
| `npm run db:verify` | Exit 0 |
| Phase 2 Tier A | Exit 0 |
| No workflow changes | `git diff n8n/` shows no changes to hosted or phase2 Main/Stripe/Send Confirmation |

### Phase 3a — complete when

| Criterion | Target |
|-----------|--------|
| Planning CSV generated | `reports/planning-postgres-*.csv` has columns aligned with Sync Planning “Bookings Sync” tab |
| Row sanity | Every row has `Bed ID`, `Check In`, `Check Out`, `Color Type`, `Display Text` |
| Spot-check | For a known week, ≥95% of bed-night rows match Airtable-exported sync tab on `Booking ID` + `Bed ID` + dates (allow status text normalization) |
| No side effects | No Airtable/Sheets/Main/Stripe/Confirmation changes; Tier A still green |
| Read-only proof | Script has no INSERT/UPDATE except none (SELECT only) |

### Not required in this slice

- Painting the live Planning calendar colors  
- Replacing scheduled `Wolfhouse - Sync Planning Sheet`  
- Perfect match for Phase-2-only Postgres bookings not in CSV  

---

## Implementation order (when you approve coding)

1. **3.0b-1** — `backfill-airtable-record-ids.js` + npm script + verify-local-db check  
2. **3.0b-2** — `report-airtable-postgres-drift.js` + `reports/` gitignore  
3. **3a-1** — `planning-row-format.js` + unit tests (extract from hosted Sync Planning code)  
4. **3a-2** — `planning-report-from-postgres.js` (+ optional `007_planning_views.sql`)  
5. **3a-3** — `docs/PHASE-3-0b-3a.md` + regression checklist rows  
6. **Checkpoint commit** — e.g. `Phase 3.0b-3a: ID backfill and Postgres planning report`  

---

## Reference: current hosted Sync Planning flow (unchanged)

```text
Schedule (30m) → Airtable Search Booking Beds
              → Code - Prepare Bookings Sync Rows
              → Clear Bookings Sync (Google Sheets)
              → Append rows → batchUpdate paint Planning tab
```

**3a parallel path (new, local only):**

```text
npm run planning:report:postgres
              → SQL SELECT (booking_beds ⨝ bookings ⨝ beds)
              → planning-row-format.js (same row shape)
              → reports/planning-postgres-YYYYMMDD.csv
```

---

## Approval to implement

| Role | Name | Date |
|------|------|------|
| Engineer | | |
| Owner | | |

**After approval:** implement files in §1 only; run tests in §7–§8; single git commit per sub-step optional.
