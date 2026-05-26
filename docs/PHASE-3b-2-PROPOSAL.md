# Phase 3b.2 — Assign beds (local Postgres mirror) (proposal)

**Status:** Proposal only — **no implementation**, workflow JSON edits, hosted import, production Airtable changes, migrations, or code.  
**Prerequisites:** Phase **3b.0** (`140d434`), **3b.1** cancel path through **3b.1c** (`9556297`) — drift audit, cancel impact, Postgres cancel CLI, local Cancel fork.  
**Parents:** [`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md), [`PHASE-3b-1c.md`](PHASE-3b-1c.md), [`PHASE-3b-1-PROPOSAL.md`](PHASE-3b-1-PROPOSAL.md)

**Explicitly out of scope for 3b.2 (this proposal and any work until separately approved):**

- Editing or importing **`n8n/Wolfhouse - Bed Assignment.json`** on hosted n8n Cloud  
- **Production** Airtable base writes (except documented local/test PAT + base)  
- **Google Sheets** (Planning sync, Manual Entries)  
- **`payments`**, **`payment_events`**, Stripe, Main, Send Confirmation  
- **`bookings` DELETE**, status/payment field changes as part of assign  
- **3b.3 Reassign** (separate proposal; do not start)  
- **Migrations** (unique indexes may be *proposed* here but not applied until approved)  
- Porting **Main** inline availability (`Code - Check Bed Availability - WA`) into Postgres  

---

## Executive summary

Today, **Wolfhouse - Bed Assignment** assigns inventory only in **Airtable**: it searches beds/rooms/occupancy in AT, runs a large **Code - Choose Beds** scorer, **creates Booking Beds rows**, and updates **Bookings** assignment fields. Postgres is updated only indirectly via **`npm run db:sync`** from CSV export.

Phase **3b.2** adds a **local-only** path that **mirrors new bed assignments into Postgres** while keeping **Airtable as staff source of truth** for the assignment algorithm and UI. The recommended delivery matches 3b.1 cancel: **substeps 3b.2a → 3b.2b → 3b.2c**, with **Reassign deferred to 3b.3**.

**Core pattern (3b.2c target):** After bed selection is known (from existing **Code - Choose Beds**), **INSERT `booking_beds` in Postgres** → **CREATE Airtable Booking Beds** (hosted nodes) → **backfill `booking_beds.airtable_record_id`** → **UPDATE `bookings` assignment fields in PG** (hosted AT update unchanged).

---

## 1. Current Assign flow (hosted)

### 1.1 Trigger and entry

| Attribute | Value |
|-----------|--------|
| **Workflow** | Wolfhouse - Bed Assignment |
| **Export (read-only)** | `n8n/Wolfhouse - Bed Assignment.json` |
| **Webhook path** | `POST /webhook/assign-beds-to-booking` |
| **Webhook ID** | `76de4db6-f820-41db-b47c-65bd056a04d6` |
| **Body** | `{ "record_id": "<Airtable Bookings rec…>" }` |
| **Called by** | Airtable automation **“Assign Beds When Booking Is Unassigned”** ([`airtable-automations.md`](airtable-automations.md) §3) |

**Automation preconditions (Airtable):**

| Condition | Value |
|-----------|--------|
| Assignment Status | **Unassigned** |
| Check In / Check Out | not empty |
| Status | not **Cancelled**, not **Expired** |
| Availability Check Status | **Not Checked** *(AT label; maps to `unknown` in Postgres)* |
| Guest Count | **> 0** |

**n8n gate (`IF - Needs Bed Assignment`):** Skips assignment when **Assignment Status** is already **Assigned**, **Assigning**, or **Needs Review**, or when **Status** is **Cancelled** / **Expired**. True branch continues to assign.

### 1.2 Node flow (hosted)

```
Assign Beds to Booking - Webhook
  → Get Booking                           (Airtable READ: Bookings by record_id)
  → IF - Needs Bed Assignment             (skip if already assigned / cancelled)
  → Update Booking - Mark Assigning       (Airtable UPDATE: Assignment Status = Assigning)
  → Search Active Beds                    (Airtable SEARCH: Beds, Active + Sellable)
  → Search Existing Bed Assignments       (Airtable SEARCH: Booking Beds, date overlap)
  → Search Rooms                          (Airtable SEARCH: Rooms)
  → Code - Choose Beds                    (~23k LOC: scoring, operator block, conflict)
  → IF - Bed Assignment Conflict
       ├─ true  → Update Booking Assignment Status - Conflict
       │          (Availability = Conflict, Assignment = Needs Review)
       └─ false → Create Booking Bed Assignment  (Airtable CREATE: one row per bed)
                  → Update Booking Assignment Status
                     (Assignment = Assigned, Availability = Available)
```

### 1.3 Airtable tables read/written

| Table | Table ID (export) | Operations |
|-------|-------------------|------------|
| **Bookings** | `tblYWm3zKFafe4qu7` | **Read** (Get Booking); **Update** (Assigning → Assigned or Needs Review) |
| **Beds** | `tblEkF4SG4TLaNmW4` | **Search** (active, sellable) |
| **Booking Beds** | `tblO1ByvTMXS4SalB` | **Search** (overlapping assignments); **Create** (one per chosen bed) |
| **Rooms** | *(Rooms table in export)* | **Search** (fill priority, gender strategy, capacity) |

### 1.4 Booking Beds — creates rows

**Yes.** Hosted assign **creates** new **Booking Beds** records (not in-place update of existing bed rows).

**Create node fields** (`Create Booking Bed Assignment`):

| Airtable field | Source (from Code - Choose Beds) |
|----------------|----------------------------------|
| **Booking** | `booking_record_id` (linked rec) |
| **Bed** | `bed_record_id` (linked rec) |
| **Assignment Type** | `assignment_type` (e.g. Auto Assigned, Auto Assigned - Multi Room, Manual Staff Assignment) |
| **Assignment Start Date** | `check_in` |
| **Assignment End Date** | `check_out` |
| **Assignment Notes** | `notes` |
| **Guest Gender / Group Type** | `gender_group` |
| **Rooming Notes** | `rooming_notes` |
| **Room Preference** | `room_preference` |

**Assignment ID** is Airtable-generated (read-only formula/display).

### 1.5 Bookings fields updated

| Node | Assignment Status | Availability Check Status | Other |
|------|-------------------|---------------------------|--------|
| **Update Booking - Mark Assigning** | **Assigning** | *(unchanged)* | — |
| **Update Booking Assignment Status** (success) | **Assigned** | **Available** | — |
| **Update Booking Assignment Status - Conflict** | **Needs Review** | **Conflict** | **Conflict Notes** set from Code output |

**Not updated by Bed Assignment workflow:**

| Field | Notes |
|-------|--------|
| **Status** (Confirmed / Payment_Pending / etc.) | Unchanged |
| **Payment Status**, deposit/paid amounts | Unchanged |
| **Send Confirmation** | Unchanged |
| **Booking Beds** link field | Populated indirectly via new Booking Beds rows |

### 1.6 Postgres mapping today (sync only)

| Airtable / workflow | Postgres |
|---------------------|----------|
| Booking Beds rows | `booking_beds` via `db:sync` from `database/Booking Beds-Active Bed Assignments.csv` |
| Assignment Status | `bookings.assignment_status` enum (`assigned`, `unassigned`, `needs_review`, …) |
| Availability Check Status | `bookings.availability_check_status` |
| Bed code `R7-B1` | `beds.bed_code` + `booking_beds.bed_code` |
| Overlap detection | **AT formula** in Search Existing Bed Assignments; PG has `idx_booking_beds_availability` but **workflows do not query PG yet** |

### 1.7 What hosted Assign does **not** touch

| System | Notes |
|--------|--------|
| **Postgres** | Not written by workflow |
| **payments** / Stripe | Not touched |
| **Conversations / Messages** | Not touched |
| **Google Sheets** | Not touched |
| **Main** workflow | Does not call `assign-beds-to-booking` today; has separate inline availability check |

### 1.8 Duplicate logic risk

[`workflow-dependency-map.md`](workflow-dependency-map.md): Main runs **`Code - Check Bed Availability - WA`** for WhatsApp holds; **Bed Assignment** is the authoritative assigner for staff/automation. Phase 3b.2 does **not** merge these paths; deprecating Main inline assign remains a **later** sub-PR after 3b.2c is stable.

---

## 2. Phase 3b.2 goal

| Goal | Detail |
|------|--------|
| **Local Postgres mirror** | When assign runs locally, **`booking_beds` rows exist in PG** with correct `bed_id`, dates, and `airtable_record_id` after AT create |
| **Airtable remains SoT for algorithm** | Keep **Code - Choose Beds** and AT searches unchanged in 3b.2c; do not rewrite scorer in first cut |
| **Staff path unchanged on Cloud** | Hosted **Bed Assignment** export stays read-only until explicit cutover |
| **Safe inventory** | PG overlap checks available for 3b.2b dry-run and optional hard guards before INSERT |
| **Symmetry with 3b.1** | Cancel deletes PG then AT; Assign should **reserve PG** then **confirm AT**, with drift tooling to detect half-failures |

**Non-goals for 3b.2:**

- Replacing Planning Sheet / Sheets sync  
- Changing payment or confirmation gates  
- **Reassign** (3b.3)  

---

## 3. Data changes needed

### 3.1 `bookings` — assignment fields only

| Column | Assign may set (PG mirror) | Must NOT change |
|--------|----------------------------|-----------------|
| `assignment_status` | `assigning` → `assigned` or `needs_review` | `status`, `payment_status` |
| `availability_check_status` | `unknown` → `available` or `conflict` | `check_in` / `check_out` *(unless separate date-change workflow)* |
| `conflict_notes` | On conflict branch | Money columns, `send_confirmation` |

Enum map (AT → PG): **Assigned** → `assigned`, **Assigning** → `assigning`, **Needs Review** → `needs_review`, **Available** → `available`, **Conflict** → `conflict`, **Not Checked** → `unknown`.

### 3.2 `booking_beds` — INSERT behaviour

| Field | Source |
|-------|--------|
| `client_id` | `wolfhouse-somo` |
| `booking_id` | Resolved from `bookings.airtable_record_id` or `booking_code` |
| `bed_id` | Lookup `beds.id` WHERE `bed_code` = chosen `bed_id` (e.g. `R7-B1`) |
| `bed_code`, `room_code` | Denormalized from `beds` / `rooms` |
| `assignment_start_date`, `assignment_end_date` | ISO dates from `check_in` / `check_out` (D/M/Y safe parse — same as 3b.0) |
| `assignment_type`, `assignment_notes` | From Code output |
| `assignment_label` | Optional; AT **Assignment ID** after create |
| `guest_name` | Copy from `bookings.guest_name` |
| `planning_row_label` | Optional; can mirror AT formula later |
| `airtable_record_id` | **NULL on PG INSERT**; set after AT **Create** returns `rec…` |

**Never on assign:** DELETE `payments`; UPDATE `payment_status`; DELETE `bookings`.

### 3.3 `bed_id` / `room_id` mapping

| Step | Rule |
|------|------|
| Code output | `bed_id` string like `R7-B1`, `room_id` like `R7` |
| PG lookup | `SELECT id FROM beds WHERE client_id = ? AND bed_code = ?` |
| Missing bed | **Fail closed** — do not INSERT; surface `bed_not_found_in_postgres` |
| Room | `room_code` denormalized; optional FK `rooms` read for validation |

Seed/sync: `database/Beds-Grid view.csv`, `Rooms-Grid view.csv` → `beds` / `rooms` (unchanged in 3b.2).

### 3.4 `airtable_record_id` handling

| Stage | `bookings.airtable_record_id` | `booking_beds.airtable_record_id` |
|-------|------------------------------|-------------------------------------|
| Webhook input | Required `record_id` | — |
| PG booking resolve | Must match `rec…` (3.0b backfill) | — |
| After AT create | Unchanged | **UPDATE** each new PG row with AT record id |

If booking exists in AT but not PG: **block PG assign** or run `db:sync` / Ensure Booking path first (document in runbook).

### 3.5 Status / payment fields — must not change

| Table.column | Rule |
|--------------|------|
| `bookings.status` | No UPDATE in assign mirror |
| `bookings.payment_status` | No UPDATE |
| `payments`, `payment_events` | No INSERT/UPDATE/DELETE |
| `bookings.send_confirmation` | No UPDATE |

3b.2b/3b.2c should include a **post-condition check** (COUNT payments unchanged), same pattern as 3b.1b cancel script.

### 3.6 Optional schema hardening (proposal only — not a migration in 3b.2)

| Change | Purpose | When |
|--------|---------|------|
| **UNIQUE** `(client_id, booking_id, bed_id, assignment_start_date, assignment_end_date)` on `booking_beds` | Enforce natural key at DB level | Separate approved migration before or with 3b.2b `--execute` |
| **UNIQUE** `airtable_record_id` | Already exists (nullable) | No change |

Until UNIQUE exists, idempotency relies on **application-level** `ON CONFLICT DO NOTHING` or pre-SELECT by natural key ([`bed-drift-keys.js`](../scripts/lib/bed-drift-keys.js)).

---

## 4. Idempotency

### 4.1 Natural key strategy

Canonical key (already used in 3b.0):

```text
{booking_code}|{bed_code}|{assignment_start_date}|{assignment_end_date}
```

Built by `assignmentNaturalKey()` in [`scripts/lib/bed-drift-keys.js`](../scripts/lib/bed-drift-keys.js).

### 4.2 Avoid duplicate `booking_beds`

| Guard | Behaviour |
|-------|-----------|
| **Pre-INSERT SELECT** | Skip insert if natural key already exists for client |
| **Webhook re-run** | `IF - Needs Bed Assignment` false once AT shows **Assigned** — hosted path no-ops; PG path must not add beds |
| **Partial PG from failed AT** | Drift: keys only in PG; repair by DELETE PG row or complete AT create manually |
| **Future UNIQUE index** | `INSERT … ON CONFLICT DO NOTHING` |

### 4.3 Assign runs twice (same booking, still “Unassigned” in AT)

Unlikely if first run succeeded (AT → **Assigned**). If automation fires twice before AT updates:

| System | Second run |
|--------|------------|
| **Hosted IF** | May still pass if status lagging → risk duplicate AT beds |
| **PG mirror (proposed)** | INSERT skipped for existing natural keys; warn `already_assigned_in_postgres` |
| **AT Create** | May duplicate without AT-side dedupe — **drift report** catches duplicate keys |

**Mitigation in 3b.2c:** Before PG INSERT, check `bookings.assignment_status` and existing `booking_beds` count; optional **early exit** JSON if already assigned in PG.

### 4.4 Some beds already exist (partial assignment)

| Scenario | Proposed behaviour |
|----------|-------------------|
| Booking has 1 of 3 beds in PG (manual/sync) | INSERT only missing beds; set **Partially Assigned** only if AT does (hosted uses **Assigned** when any create succeeds) |
| Code chose 3 beds, 1 exists | Insert 2; log `skipped_existing_keys[]` |
| Guest count vs bed count | **Warn** if `COUNT(booking_beds) != guest_count` after run; do not auto-delete extras in 3b.2 |

### 4.5 Overlap conflicts

| Layer | Check |
|-------|--------|
| **Hosted** | `Search Existing Bed Assignments` + Code conflict object → **Needs Review** / no creates |
| **PG (3b.2b+)** | Query overlapping `booking_beds` on same `bed_id` and intersecting dates (exclude same `booking_id`) using `idx_booking_beds_availability` |
| **Both** | PG check can **warn in dry-run**; in 3b.2c **block INSERT** if PG overlap detected even when AT search missed (local safety net) |

**Reassign note:** Changing dates/beds after assign is **3b.3** — assign idempotency does not replace reassign.

---

## 5. Safety checks

| Check | Failure code (proposed) | Action |
|-------|-------------------------|--------|
| Booking exists in PG | `booking_not_found_in_postgres` | Abort; no INSERT |
| Ambiguous booking lookup | `booking_ambiguous_in_postgres` | Abort |
| `airtable_record_id` matches webhook | `record_id_mismatch` | Abort |
| Each `bed_code` exists in `beds` | `bed_not_found_in_postgres` | Abort bed row; partial_failure |
| `assignment_end_date > assignment_start_date` | `invalid_date_range` | Abort |
| PG overlap on bed/dates | `bed_overlap_in_postgres` | Abort or conflict branch |
| Guest count vs beds | `guest_count_mismatch` | **Warn** in report; optional strict mode in 3b.2b |
| Payments unchanged | `payments_touched` | Abort transaction (3b.2b) |
| `payment_status` unchanged | `payment_status_changed` | Abort |
| Booking cancelled/expired | `booking_not_assignable` | Align with `IF - Needs Bed Assignment` |

---

## 6. Rollback

### 6.1 Restore from Airtable / CSV (local)

| Method | Use when |
|--------|----------|
| **`npm run db:sync`** | Rebuild all `booking_beds` from `database/Booking Beds-Active Bed Assignments.csv` (**client-scoped DELETE + re-INSERT**) |
| **Export fresh CSV** from test AT base after fixing assignments | Source of truth recovery |

Same pattern as [`PHASE-3b-1b.md`](PHASE-3b-1b.md) § restore.

### 6.2 Undo local PG assignment only

| Action | Command / step |
|--------|----------------|
| **Remove beds for one booking** | Reuse **`npm run db:cancel:booking-beds -- --booking-code=WH-rec… --execute`** (3b.1b) — deletes PG `booking_beds`, sets assignment fields to `needs_review` |
| **Does not delete AT beds** | Run hosted/local **Cancel** fork or manual AT delete if AT must match |
| **Wrong beds assigned in PG only** | DELETE specific `booking_beds` by id or run cancel + re-assign |

### 6.3 What never gets deleted by Assign rollback

| Data | Rule |
|------|------|
| **`payments`, `payment_events`** | Never |
| **`bookings` row** | Never DELETE |
| **`beds`, `rooms`** | Seed inventory |
| **`conversations`, `messages`** | Phase 2 history |
| **Airtable rows** | PG rollback does not remove AT; staff fixes AT separately |

---

## 7. Proposed substeps

| Step | Deliverable | Type |
|------|-------------|------|
| **3b.2a** | **Assign impact report** — read-only: booking resolve, beds Code *would* assign (from AT export or webhook dry-run), PG beds to INSERT, overlap warnings, guest-count check | `scripts/report-assign-impact.js`, `docs/PHASE-3b-2a.md` |
| **3b.2b** | **Postgres-only assign** — `--dry-run` default; `--execute` INSERT `booking_beds` + UPDATE assignment fields; accepts `--booking-code` / `--airtable-record-id` and optional `--bed-codes` / JSON plan file | `scripts/assign-booking-beds-postgres.js` |
| **3b.2c** | **Local n8n fork** — inject PG nodes into copy of hosted export; output `n8n/phase3b/Wolfhouse - Bed Assignment (local PG).json`; `npm run build:assign-beds:local` | Build script + test webhook helper |
| **3b.3** | **Reassign** | **Separate proposal** — not started |

### 3b.2a — Assign impact report (sketch)

**Inputs:** `--booking-code=WH-rec…` or `--airtable-record-id=rec…`

**Outputs (JSON + stdout):**

- Resolved `booking_id`, `guest_count`, dates, current `assignment_status`
- Existing `booking_beds` in PG (count + natural keys)
- **Would insert** rows (bed_code, dates, natural_key)
- **Would skip** (already exists)
- PG overlap conflicts with other bookings
- `payments_count`, `payment_status` (unchanged assertion)
- `airtable_would_create_count` (from AT link count or simulated bed list)

No mutations.

### 3b.2b — Postgres-only assign (sketch)

**Default:** dry-run.

**Execute:**

1. Resolve booking (same guards as 3b.1b).
2. For each planned bed: resolve `bed_id`; check natural key + overlap.
3. `INSERT INTO booking_beds (…)`.
4. `UPDATE bookings SET assignment_status = 'assigned', availability_check_status = 'available'` (or `needs_review` / `conflict` if plan says conflict).
5. Verify payments unchanged.

**Does not** call Airtable — expect bed-drift “keys only in PG” until 3b.2c or manual AT.

**Optional:** `--plan=file.json` from impact report for explicit bed list (operator override path).

### 3b.2c — Local n8n fork (sketch)

**Order (proposed):**

```
Webhook → Parse (record_id, __NULL__ sentinels)
  → Get Booking (AT, hosted)
  → IF - Needs Bed Assignment (hosted)
  → Update Booking - Mark Assigning (AT, hosted)
  → Search Active Beds / Existing Assignments / Rooms (AT, hosted)
  → Code - Choose Beds (hosted, unchanged)
  → IF - Bed Assignment Conflict (hosted)
  → [conflict branch: AT update only + PG assignment fields mirror]
  → Postgres - Insert Booking Beds (new)
  → Create Booking Bed Assignment (AT, hosted)
  → Postgres - Backfill airtable_record_id (new)
  → Update Booking Assignment Status (AT, hosted)
  → Postgres - Update Booking Assignment Status (new)
  → Build Assign Response → Respond to Webhook
```

**Alternative considered:** PG INSERT after AT create (simpler ids, worse if AT fails after PG reserves). **Rejected** for 3b.2c primary path — prefer PG-first inventory, match 3b.1c cancel ordering philosophy.

**Postgres nodes:** `__NULL__` query params where needed (lesson from 3b.1c).

**Response JSON fields (proposed):** `ok`, `booking_code`, `record_id`, `pg_inserted_count`, `pg_skipped_count`, `airtable_create_ok`, `partial_failure`, `idempotent`, `errors[]`.

---

## 8. Test plan

Use **local n8n** + **test Airtable base** (or AT-disabled dry-run for 3b.2a/3b.2b). Restore with **`npm run db:sync`** between destructive tests.

| ID | Scenario | Expected |
|----|----------|----------|
| T0 | `npm run db:report:bed-drift` | Baseline **0 actionable** after sync |
| T1 | **Assign new booking** (0 beds, Unassigned, valid dates) | PG + AT: `guest_count` bed rows; `assignment_status=assigned`; `pg_inserted_count=N` |
| T2 | **Assign same booking again** | Idempotent: `pg_inserted_count=0`; no duplicate natural keys; AT IF may skip |
| T3 | **Partially assigned** (1 bed in PG/AT, need 2 more) | Inserts only missing beds; drift count matches |
| T4 | **Overlapping bed** (another booking holds bed in PG) | Conflict or `bed_overlap_in_postgres`; no silent double-book |
| T5 | `npm run db:report:bed-drift` after T1 | **0** actionable key mismatch |
| T6 | `npm run planning:report:postgres` | New beds appear in planning CSV rows |
| T7 | `npm run test:phase2f-resolver` | 10/10 (no regression) |
| T8 | Payments | `payments_count` unchanged; `payment_status` unchanged |
| T9 | 3b.2b only (no AT) | Drift shows keys only in PG until AT create or sync |

Regression doc: add § **Phase 3b.2** to [`regression-test-plan.md`](regression-test-plan.md) (on implementation).

---

## 9. Files that would be touched if approved

| Action | Path |
|--------|------|
| **Create** | `docs/PHASE-3b-2-PROPOSAL.md` (this file) |
| **Create** | `docs/PHASE-3b-2a.md`, `docs/PHASE-3b-2b.md`, `docs/PHASE-3b-2c.md` (after each substep) |
| **Create** | `scripts/report-assign-impact.js` (3b.2a) |
| **Create** | `scripts/assign-booking-beds-postgres.js` (3b.2b) |
| **Create** | `scripts/build-assign-beds-local.js` (3b.2c) |
| **Create** | `scripts/test-assign-beds-webhook.ps1` (3b.2c helper) |
| **Create** | `n8n/phase3b/Wolfhouse - Bed Assignment (local PG).json` (+ `.n8n-import.json`) |
| **Modify** | `package.json` — `db:report:assign-impact`, `db:assign:booking-beds`, `build:assign-beds:local` |
| **Modify** | `docs/regression-test-plan.md`, `n8n/phase3b/README.md` |

**Not modified:**

| Path | Reason |
|------|--------|
| `n8n/Wolfhouse - Bed Assignment.json` | Hosted export — read-only input to build script |
| `n8n/Wolfhouse - Cancel Bed Assignments.json` | Hosted |
| `n8n/Wolfhouse - Reassign Bed Assignments.json` | 3b.3 |
| `n8n/phase2/*` Main / Stripe / Send Confirmation | Out of scope |
| `database/migrations/*` | No migration until separate approval |
| `scripts/sync-csv-to-postgres.js` | Unless assign reveals required sync field (separate PR) |

---

## 10. Approval checklist

- [ ] Owner approves **PG-before-AT** insert order for 3b.2c (or documents AT-first exception)  
- [ ] Owner accepts **keeping Code - Choose Beds on Airtable data** for first cut (no full PG scorer port)  
- [ ] Test Airtable base / PAT for local assign webhook tests  
- [ ] Owner confirms **no** hosted Cloud import of local fork until cutover plan  
- [ ] Optional **UNIQUE** on `booking_beds` natural key — approve migration separately or defer  
- [ ] **Reassign (3b.3)** remains out of scope  
- [ ] Main / Stripe / Send Confirmation / payments unchanged  

---

## 11. Sequence in Phase 3b

```
3b.0   bed drift audit (read-only)           ✅ 140d434
3b.1   Cancel (impact → PG script → local n8n) ✅ through 9556297
3b.2a  assign impact report (read-only)      ← proposed first
3b.2b  assign-booking-beds-postgres.js        ← proposed
3b.2c  local n8n Assign fork (PG → AT)       ← proposed
3b.3   Reassign dual-write                    not started (separate proposal)
```

---

## References

| Item | Location |
|------|----------|
| Hosted Assign export | `n8n/Wolfhouse - Bed Assignment.json` |
| Webhook map | `docs/webhook-map.md` |
| AT automation | `docs/airtable-automations.md` §3 |
| Workflow map | `docs/workflow-dependency-map.md` §2 |
| Natural keys | `scripts/lib/bed-drift-keys.js` |
| Parent 3b plan | `docs/PHASE-3b-PROPOSAL.md` §3b.2 |
| Cancel local fork pattern | `scripts/build-cancel-beds-local.js`, `docs/PHASE-3b-1c.md` |
| Regression §2 | `docs/regression-test-plan.md` §2 Bed Assignment |
| Schema | `database/migrations/001_init.sql` (`booking_beds`, `bookings`) |
