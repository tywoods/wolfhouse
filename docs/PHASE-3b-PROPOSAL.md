# Phase 3b — Bed & staff operations (proposal)

**Status:** Proposal only — **no implementation**, migrations, workflow exports, or production changes.  
**Prerequisites:** Phase 2 local signed off; Phase **3.0b** (ID link + drift) and **3a** (Postgres planning report) passed.

**Explicitly out of scope for Phase 3b planning / implementation:**

- Hosted n8n Cloud (`tywoods.app.n8n.cloud`) — exports remain read-only inputs  
- Production Airtable base — no automation toggles, no live staff cutover  
- Stripe / payment workflows (`Create Payment Session`, webhook, Main payment paths)  
- Send Confirmation (local or hosted)  
- Main WhatsApp assistant dual-write (Phase 3 proposal **3j** — last)  
- Phase 3c+ as separate proposal documents (this doc covers bed/staff ops through **3b.x** substeps only)

---

## Executive summary

Phase 3b moves **bed inventory mutations** from Airtable-only toward **Postgres-first + Airtable mirror**, so availability, planning (3a), and future Main paths share one assignment model. Staff continue using **Airtable + Google Sheets** unchanged until Phase 4; local n8n forks and scripts prove dual-write before any production URL switch.

**Recommended first step:** **3b.0** — extend audit/drift tooling and add a **read-only** Postgres availability/overlap report (no workflow writes). **First dual-write:** **3b.1 Cancel Bed Assignments** (smallest delete surface). **Core assign path:** **3b.2 Bed Assignment**, then **3b.3 Reassign**. Manual Entries and Operator Release are **3b.4 / 3b.5** — still part of Phase 3b scope but after cancel/assign/reassign are stable locally.

---

## 1. What Phase 3b should own

| Domain | In scope | Notes |
|--------|----------|--------|
| **Bed assignments** | Yes | Create `booking_beds` rows when guests/staff get beds |
| **`booking_beds` lifecycle** | Yes | Insert, update dates/notes, delete on cancel/reassign |
| **Room changes / rooming** | Partial | Guest rooming updates booking fields → triggers **Reassign**; 3b owns bed rows, not LLM rooming in Main |
| **Manual staff reassignment** | Yes (later substep) | Via **Reassign** webhook + **Manual Entries** processor |
| **Availability checks** | Read-first | Main `Code - Check Bed Availability - WA` today reads Airtable; 3b.0 proves same logic on Postgres SELECT before any write path switch |
| **Operator / manual bookings** | Later in 3b | **Manual Entries Queue** creates bookings + beds; **Operator Room Release** splits/blocks rooms — staff-critical; after 3b.2–3b.3 |
| **Planning sheet paint** | No | Owned by **3a** (read-only Postgres report); 3b must not break 3a row shape |
| **Payments / holds / WhatsApp** | No | Phase 2 frozen paths |

### Phase 3b substeps (implementation order — all within this proposal)

| ID | Name | Dual-write? | Workflow (hosted export reference) |
|----|------|-------------|-----------------------------------|
| **3b.0** | Bed inventory audit | Read-only | Scripts only; extend `report-airtable-postgres-drift.js` |
| **3b.1** | Cancel assignments | PG delete → AT delete | `n8n/Wolfhouse - Cancel Bed Assignments.json` |
| **3b.2** | Assign beds | PG insert → AT create | `n8n/Wolfhouse - Bed Assignment.json` |
| **3b.3** | Reassign beds | PG delete+ready → AT same | `n8n/Wolfhouse - Reassign Bed Assignments.json` |
| **3b.4** | Manual Entries | PG booking+beds → AT | `n8n/Wolfhouse - Manual Entries Queue Processor.json` |
| **3b.5** | Operator room release | PG blocks → AT | `n8n/Wolfhouse - Operator Room Release.json` |

**Out of 3b (defer):** Main inline availability/hold creation, Airtable automations replacement, hosted webhook URL changes.

---

## 2. Current source of truth

### 2.1 Authority today (staff-facing)

| Layer | Role |
|-------|------|
| **Airtable Bookings** | Staff UI, automations, status, assignment_status, linked Booking Beds |
| **Airtable Booking Beds** | One row per bed-night assignment; planning sync reads this |
| **Google Sheets Manual Entries** | Staff create/update queue; processor writes Airtable |
| **Postgres (local)** | Mirror from CSV sync (`npm run db:sync`); payment truth for Stripe (Phase 2); planning report (3a) |

**Production truth for beds today:** **Airtable Booking Beds**, written by:

1. Airtable automation → `assign-beds-to-booking` (Bed Assignment workflow)  
2. Cancel / Reassign webhooks  
3. Manual Entries processor  
4. Operator Room Release (blocks / split bookings)  
5. Possible duplicate/legacy paths inside **Main** (availability check reads AT; does not replace Bed Assignment)

### 2.2 Which workflow changes what

| Workflow | Trigger | Writes Bookings | Writes Booking Beds | Updates assignment_status |
|----------|---------|-----------------|---------------------|---------------------------|
| **Bed Assignment** | Webhook `assign-beds-to-booking` (+ AT automation) | Read; may update assignment fields | **Create** rows | → Assigned / Needs Review |
| **Cancel Bed Assignments** | Webhook `cancel-booking-beds` | Update assignment / conflict | **Delete** linked rows | → Needs Review |
| **Reassign Bed Assignments** | Webhook `reassign-booking-beds` | Reset for re-assign | **Delete** old rows | → Unassigned / Assigning |
| **Manual Entries Queue** | Sheet + webhook | Create/update/cancel | Create/update/delete via processor | Varies |
| **Operator Room Release** | AT record / webhook | Create block bookings | Assign all beds in room | Blocked |
| **Main (local Stripe)** | WhatsApp | Hold, guest fields | **Does not** create bed rows (calls Reassign HTTP to **hosted** URL today) | Via AT only |
| **Sync Planning Sheet** | Schedule | None | None (read AT) | None |
| **3a planning script** | CLI | None | None (read PG) | None |

### 2.3 Fields: Airtable vs Postgres today

| Entity | In Airtable (staff) | In Postgres | Populated how |
|--------|---------------------|-------------|---------------|
| **Bookings** | All operational fields | `bookings` + enums; `airtable_record_id`; money fields | CSV sync + Phase 2 `Ensure Booking` for Stripe path only |
| **Booking Beds** | Assignment ID, dates, bed link, notes | `booking_beds` + `bed_code`, `room_code`, dates | CSV sync replaces all `booking_beds` per sync |
| **Rooms / Beds** | Static config | `rooms`, `beds` seeded | Seed + CSV |
| **assignment_status** | Booking field | `bookings.assignment_status` | Sync from AT Status fields |
| **Availability overlap** | AT views + Main/Bed Assignment queries | `idx_booking_beds_availability` | Not used by workflows yet |

**Gap (known):** Postgres may have **more** bookings than CSV (Phase 2 local tests); **fewer** `booking_beds` if beds only exist in AT after local tests. Phase 3.0b drift documents this; 3b must not assume PG is complete until dual-write runs.

---

## 3. Proposed first safe implementation step

### 3b.0 — Read / audit only (implement first)

| Deliverable | Purpose |
|-------------|---------|
| Extend `scripts/report-airtable-postgres-drift.js` | Per-booking bed row counts; list AT-export vs PG mismatches on `(booking_code, bed_code, start, end)` |
| New `scripts/report-bed-availability-postgres.js` (optional) | Given date range, list occupied beds from PG overlap query (same rules as Bed Assignment) — **SELECT only** |
| Compare to 3a CSV | Same bookings should appear in planning report and bed inventory report |
| Local fork **not required** for 3b.0 |

**Exit 3b.0:** Drift report explains every booking with `assignment_status = assigned` in AT export vs PG bed row count; overlap script matches Bed Assignment spot-check for one week.

### 3b.1 — First dual-write: Cancel (local fork)

| Item | Detail |
|------|--------|
| Why first | Deletes only; tests PG→AT sync pattern without inventing assignment algorithm |
| Pattern | Webhook → load booking by `booking_code` / `airtable_record_id` → **DELETE** `booking_beds` in PG → delete AT Booking Bed records → update `bookings.assignment_status` both sides |
| Staff impact | **None** until local webhook URL used; hosted unchanged |
| Test | Regression §3.1 |

### 3b.2 — Assign beds (local fork)

| Item | Detail |
|------|--------|
| Risk | Medium — core inventory |
| Pattern | Run assignment logic against **Postgres** beds/rooms + `booking_beds` occupancy → INSERT PG → CREATE AT rows with returned `airtable_record_id` stored on PG |
| Deprecate | Main inline assignment only after 3b.2 stable (separate sub-PR) |
| Test | Regression §2.1–2.6 |

### 3b.3 — Reassign (local fork)

Depends on 3b.1 delete pattern + 3b.2 insert pattern.

### 3b.4 / 3b.5 — Staff sheets

Only after 3b.1–3b.3 pass locally; Sheets UI unchanged.

---

## 4. Data mapping

### 4.1 Bookings

| Airtable field | Postgres column | Dual-write notes |
|----------------|-----------------|------------------|
| Booking ID | `booking_code` | `WH-rec…` unique per `client_id` |
| (record id) | `airtable_record_id` | Set on AT create; backfill (3.0b) |
| Guest Name | `guest_name` | |
| Status | `status` | enum map `Hold` → `hold`, etc. |
| Payment Status | `payment_status` | **Mirror only** in 3b — no payment workflow changes |
| Check In / Check Out | `check_in`, `check_out` | Booking-level dates; bed rows use assignment dates |
| Guest Count | `guest_count` | |
| Assignment Status | `assignment_status` | Critical for assign pipeline |
| Package | `package_code` | |
| Guest Gender / Group Type | `guest_gender_group_type` | |
| Requested Room Type / Room Preference | `requested_room_type`, `room_preference` | |
| Rooming Notes | `rooming_notes` | |
| Booking Source | `booking_source` | `manual_staff`, `whatsapp`, `operator` |
| Staff Notes | `staff_notes` | Manual entries |
| Operator Name / Block Type / Room to Block | `operator_name`, `block_type`, `room_to_block_id` | Operator release |
| Deposit / payment money | `deposit_*`, `amount_*` | **Do not change in 3b** |

### 4.2 Booking Beds

| Airtable field | Postgres column | Dual-write notes |
|----------------|-----------------|------------------|
| (record id) | `airtable_record_id` | UNIQUE when set |
| Assignment ID | `assignment_label` | Display label, not globally unique |
| Booking / Booking ID | `booking_id` FK + `booking_code` via join | |
| Bed / Bed ID | `bed_id` FK + `bed_code` | `R7-B1` |
| Room ID | `room_code` | denormalized |
| Assignment Start/End Date | `assignment_start_date`, `assignment_end_date` | Overlap index |
| Assignment Type | `assignment_type` | e.g. Auto Assigned, Manual Staff |
| Assignment Notes | `assignment_notes` | |
| Planning Row Label | `planning_row_label` | 3a display |
| Guest Name | `guest_name` | denormalized copy |

### 4.3 Rooms & beds (reference data)

| Airtable | Postgres | Changed in 3b? |
|----------|----------|----------------|
| Rooms | `rooms` | **Read-only** in 3b |
| Beds | `beds` | **Read-only** in 3b |

### 4.4 Natural keys (for sync logic — future migration candidate)

| Table | Proposed business key | Current DB constraint |
|-------|----------------------|------------------------|
| `bookings` | `(client_id, booking_code)` | **UNIQUE** ✓ |
| `booking_beds` | `(client_id, booking_id, bed_id, assignment_start_date, assignment_end_date)` | **Not UNIQUE** today — add in migration when implementing 3b.2 |
| `booking_beds` | `airtable_record_id` | **UNIQUE** nullable |

---

## 5. Drift risks

| Risk | Scenario | Mitigation |
|------|----------|------------|
| **Booking in AT not PG** | Staff/manual row never synced | Drift report; `db:sync` after export; dual-write creates PG on next assign |
| **Booking in PG not AT** | Phase 2 local test (`WH-rec…` only in PG) | Expected until Main dual-write; exclude from staff parity checks or label `local_only` in metadata |
| **booking_beds count mismatch** | 3 beds in AT, 2 in PG | Per-booking diff in extended drift; block 3b.2 go-live until explained |
| **Bed released in one system** | Cancel AT only or PG only | 3b.1 must delete PG **then** AT in one workflow; failed AT → `automation_errors` + retry |
| **Staff edits AT after PG write** | Manual date change in AT UI | Treat AT as mirror; optional one-way repair job AT→PG (read) until Phase 4; document “don’t edit beds in AT” during dual-write testing |
| **Duplicate booking_beds** | Re-run assign without reassign | Reassign deletes by `booking_id`; assign uses upsert on natural key; regression §2.6 |
| **Date format / timezone** | Off-by-one on assignment dates | Use ISO dates in PG; same as 3a `toIsoDateString` lesson |
| **Main calls hosted Reassign** | Local PG beds unchanged while AT changes | Local Main fork must point Reassign to **local** n8n in 3b.test env only — **not** in 3b.0–3b.1 |
| **Planning desync** | 3a shows PG beds AT doesn’t have | Run 3a report after each 3b substep; compare row counts |

---

## 6. Idempotency strategy

### 6.1 Principles

1. **Postgres first** on destructive path: delete PG `booking_beds` where `booking_id = ?`, then delete AT records by `airtable_record_id`.  
2. **Postgres first** on create path: INSERT PG with client-generated UUID; AT create returns `rec…` → UPDATE PG `airtable_record_id`.  
3. **Never** second-guess payment state in assign/cancel workflows.  
4. **Re-run safe:** Cancel twice → zero bed rows both sides. Assign twice without reassign → prevented by unique key or explicit “already assigned” guard.

### 6.2 Avoid duplicate `booking_beds`

| Mechanism | When |
|-----------|------|
| **Reassign before re-assign** | Existing webhook pattern — keep |
| **Upsert on natural key** | `(booking_id, bed_id, assignment_start_date, assignment_end_date)` |
| **Transaction** | Single PG transaction per booking assign: delete stale + insert new in reassign only |
| **`assignment_status` gate** | Bed Assignment skips if already `assigned` unless `force=true` (match current AT behavior) |
| **Store AT id on PG** | Prevents duplicate AT creates on retry |

### 6.3 Unique keys needed (proposal — implement with migration in 3b.2)

```sql
-- Proposal only — not applied until 3b.2 approved
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_beds_natural_key
  ON booking_beds (
    client_id,
    booking_id,
    bed_id,
    assignment_start_date,
    assignment_end_date
  );
```

Keep existing `airtable_record_id` UNIQUE for mirror retries.

### 6.4 Safe re-runs

| Operation | Re-run behavior |
|-----------|-----------------|
| Cancel | `DELETE … WHERE booking_id` idempotent; AT delete skip if already gone |
| Reassign | Delete all PG beds for booking_id; reset status; trigger assign |
| Assign | Upsert beds; update assignment_status only if row count matches guest_count |
| Drift script | Read-only — unlimited re-runs |

---

## 7. Rollback

### 7.1 Per substep

| Substep | Rollback |
|---------|----------|
| **3b.0** | Remove new scripts; no DB impact |
| **3b.1–3b.5** | `DATA_SOURCE=airtable` env on local fork; disable PG nodes; re-import workflow JSON from git tag `phase3a-pass` |
| **Bad PG data** | `npm run db:sync` from fresh CSV (wipes `booking_beds` from export — **local only**) |

### 7.2 Fall back to Airtable-only

1. Local n8n: use hosted-equivalent branches (PG nodes disabled).  
2. Do **not** delete AT Booking Beds.  
3. Postgres can remain ahead/behind — use drift report for diagnosis only.  
4. Re-enable hosted webhooks for staff (production) — unchanged during local 3b work.

### 7.3 Must never delete

| Data | Rule |
|------|------|
| **`payments` / `payment_events`** | No DELETE in bed workflows; no rollback of paid state |
| **AT production records** | Local forks target test base or dry-run credentials only |
| **Bookings with `payment_status` ∈ paid/deposit_paid** | Cancel workflow must respect business rules (same as today) |
| **Seed `rooms` / `beds`** | Static inventory |
| **Phase 2 commit history / hosted exports** | Read-only |

---

## 8. Test plan

### 8.1 Phase 3b-local tests (no production)

| ID | Test | Pass criteria |
|----|------|----------------|
| B0.1 | Extended drift report | Lists per-booking bed count AT vs PG |
| B0.2 | PG overlap vs AT query | Same occupied beds for sample week (allow PG-only local bookings labeled) |
| B1.1 | Cancel webhook (local) | PG + AT: zero beds; assignment_status needs_review |
| B2.1 | Assign 3 guests shared | 3 `booking_beds` PG + AT; assigned |
| B2.2 | Female-only | PG uses R5/R8 preference logic |
| B2.3 | Private room | Private-like room selection |
| B2.4 | Fully booked | needs_review / conflict |
| B2.6 | Re-run assign | No duplicate rows (PG unique index) |
| B3.1 | Reassign after rooming | Old beds gone; can assign again |
| B3.2 | Main → local reassign URL | 200; PG+AT consistent (local fork only) |
| B4.x | Manual entry create/update/delete | Sheet columns unchanged; PG+AT |
| B5.x | Operator release | Block booking + beds PG+AT |

### 8.2 Drift / audit checks (after each substep)

```powershell
npm run db:report:drift
# Target: missing_airtable_record_id = 0 for WH-rec* in scope
# booking_beds: document PG-only / AT-only keys; trend down after dual-write
npm run planning:report:postgres
# Row count for assigned bookings should match bed rows where applicable
```

### 8.3 Phase 2 regression (must stay green)

| Check | Command |
|-------|---------|
| Resolver | `npm run test:phase2f-resolver` |
| Builds | `npm run build:main:local-stripe`, `npm run build:send-confirmation:local` |
| Planning format | `npm run test:planning-row-format` |
| ID backfill | `npm run db:backfill:airtable-ids -- --dry-run` |
| Tier B/C | Only if payment paths touched — **3b must not touch** |

**Non-blocking (documented):** `db:verify` bookings CSV count vs PG when local test bookings exist.

### 8.4 Staff workflow safety (local)

- Use **test Airtable base** or test bookings prefixed `TEST-` / staging slug when available.  
- Manual Entries: copy of sheet or test tab — **never** production sheet write from dev forks.  
- Compare planning: export Bookings Sync tab vs `planning-postgres-*.csv`.

---

## 9. Local implementation constraints (when approved)

| Rule | Detail |
|------|--------|
| Fork location | `n8n/phase2/Wolfhouse - … (local).json` via **new** build scripts — do not hand-edit hosted exports |
| `DATA_SOURCE` | `airtable` \| `postgres` \| `dual` per workflow |
| PG access | Postgres nodes or `run-sql` helper; same `client_id` / `wolfhouse-somo` |
| AT mirror branch | Failure → insert `automation_errors` (when table wired) + do not roll back PG payment data |
| Main | Point `reassign-booking-beds` / `assign-beds-to-booking` to **localhost** only in local test env |

---

## 10. Success criteria (Phase 3b complete)

Phase 3b is **complete** when substeps **3b.0–3b.3** (minimum) pass locally:

- Cancel, Assign, Reassign dual-write PG→AT with idempotent bed rows  
- Drift actionable fields clean for synced bookings  
- 3a planning report still correct (ISO dates, Nights)  
- Phase 2 Tier A + resolver green  
- Hosted exports and production AT unchanged  
- Manual Entries / Operator (3b.4–3b.5) optional stretch in same phase or follow-on PRs under same doc

**Not required for 3b sign-off:** Main dual-write, Phase 4 flip, Azure deploy.

---

## 11. References

| Doc / asset | Use |
|-------------|-----|
| [`PHASE-3-PROPOSAL.md`](PHASE-3-PROPOSAL.md) | Full Phase 3 sequence (3j = Main last) |
| [`PHASE-3-0b.md`](PHASE-3-0b.md) | ID backfill + drift |
| [`PHASE-3a.md`](PHASE-3a.md) | Planning report |
| [`airtable-field-usage.md`](airtable-field-usage.md) | Field mapping |
| [`workflow-dependency-map.md`](workflow-dependency-map.md) | Webhooks + dependencies |
| [`regression-test-plan.md`](regression-test-plan.md) | §2–§4 bed tests |
| [`migration-risks.md`](migration-risks.md) | Duplicate assignment logic |
| Hosted workflows | `n8n/Wolfhouse - Bed Assignment.json`, `Cancel…`, `Reassign…`, `Manual Entries…`, `Operator Room Release.json` |

---

## Approval (not yet)

| Role | Name | Date | Notes |
|------|------|------|-------|
| Engineer | | | |
| Owner | | | Approve 3b.0 first, then 3b.1 |

**Do not implement Phase 3b until this proposal and the first substep (3b.0) are explicitly approved.**
