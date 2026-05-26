# Phase 3b.4 — Manual Entries Queue (local PG mirror) (proposal)

**Status:** Proposal only — **no implementation**, workflow JSON edits, hosted import, production Sheets/Airtable writes, or production cutover.  
**Prerequisites:** Phase **3b.0**–**3b.3b** complete and frozen ([`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md), latest bed-ops commit `dfcf3c4`).  
**Parents:** [`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md), [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md), [`workflow-dependency-map.md`](workflow-dependency-map.md)

**Explicitly out of scope for 3b.4 (this proposal and any substeps until approved):**

- **3b.5** Operator Room Release  
- **Phase 3c** / Main Postgres integration  
- Editing **hosted** n8n exports (`n8n/Wolfhouse - Manual Entries Queue Processor.json` — read-only input)  
- Import or activation on **hosted** n8n Cloud  
- **Production** Google Sheets or Airtable base (test copy / PAT only for local E2E)  
- **`payments`**, **`payment_events`**, Stripe Create Session / Webhook, Main, Send Confirmation  
- **`conversations`**, **`messages`** (WhatsApp path)  
- **`database/migrations/*`** (unless a later approved substep adds only `booking_beds` natural-key index already proposed in 3b.2)  
- Changing Apps Script UX or sheet layout (staff columns stay as today)

---

## Executive summary

Today, staff create and maintain **manual staff bookings** via the **Google Sheets “Manual Entries”** tab. **Apps Script** posts one queue item at a time to n8n **`wolfhouse-manual-entries-queue`**, and **Wolfhouse - Manual Entries Queue Processor** writes **Airtable Bookings + Booking Beds** (and updates the sheet sync columns). **Postgres is not updated** in the hosted workflow.

Phase **3b.4** adds a **local-only** dual-write pattern consistent with 3b.1c–3b.3b:

1. **Read** the same queue row semantics (from webhook body or sheet snapshot).  
2. **Write Postgres first** (`bookings`, `booking_beds`; optionally `manual_entries` mirror).  
3. **Run existing Airtable + Sheets nodes** unchanged in behavior.  
4. Return structured JSON with PG + AT outcomes and `partial_failure`.

Manual Entries is **both booking creation and explicit bed assignment** — staff enter **Room / Bed** codes (e.g. `R7-B1,R7-B2`); the processor does **not** call **Choose Beds** or the Assign webhook. That differs from WhatsApp → Assign automation paths.

**Recommended substeps:** **3b.4a** impact report → **3b.4b** Postgres CLI mirror → **3b.4c** local n8n fork (`build-manual-entries-local.js`).

---

## 1. Current Manual Entries flow (hosted)

### 1.1 Workflow and trigger

| Attribute | Value |
|-----------|--------|
| **Workflow** | Wolfhouse - Manual Entries Queue Processor |
| **Export (read-only)** | [`n8n/Wolfhouse - Manual Entries Queue Processor.json`](../n8n/Wolfhouse%20-%20Manual%20Entries%20Queue%20Processor.json) |
| **Webhook path** | `POST /webhook/wolfhouse-manual-entries-queue` |
| **Webhook ID** | `a17ba7e1-7a97-4613-9f8b-d35b50460017` (shared UUID with Send Confirmation — **different paths**; fix on Azure import) |
| **Caller** | Google Sheets **Apps Script** ([`apps-script/code.gs`](../apps-script/code.gs)) |
| **Production URL (today)** | `https://tywoods.app.n8n.cloud/webhook/wolfhouse-manual-entries-queue` (see [`webhook-map.md`](webhook-map.md)) |

**Not** triggered by Airtable automations. **Not** called from Main.

### 1.2 Apps Script / sheet source

| Item | Detail |
|------|--------|
| **Sheet tab** | `Manual Entries` (`WOLFHOUSE_CONFIG.manualEntriesSheetName`) |
| **Read range (n8n)** | `Manual Entries!A1:R1000` (HTTP Google Sheets node) |
| **Sync columns written** | `P:R` per row — **Sync Status**, **Airtable Booking ID**, **Error** (see `HTTP - Mark Queue Item Synced*`) |
| **Menu action** | “Sync Manual Entries Now” → `{ "action": "manual_sync_button" }` (processes next eligible row) |

**Sheet columns** (from Apps Script headers + [`airtable-field-usage.md`](airtable-field-usage.md)):

`Manual Entry ID`, `Created At`, `Created By`, `Guest Name`, `Package`, `Deposit Paid`, `Phone`, `Email`, `Check In`, `Check Out`, `Guest Count`, `Room / Bed`, `Status`, `Payment Status`, `Notes`, `Sync Status`, `Airtable Booking ID`, `Error`

**Manual Entry ID format:** `MAN-…` (generated in Apps Script).

### 1.3 Queue processing model

| Behavior | Detail |
|----------|--------|
| **Concurrency** | **One row per webhook invocation** — `Code - Pick Next Manual Queue Item` selects a single highest-priority row |
| **Priority** | `delete processing` → `delete ready` → `update processing` → `update ready` → `processing` → `ready` |
| **Action mapping** | Sync Status → `create` / `update` / `delete` |
| **Resume** | Rows stuck in `*processing` can be picked up on rerun |

### 1.4 Airtable tables read/written

| Table | ID (export) | Operations |
|-------|-------------|------------|
| **Bookings** | `tblYWm3zKFafe4qu7` | **Create** (create path), **Update** (update + cancel/delete booking) |
| **Booking Beds** | `tblO1ByvTMXS4SalB` | **Search** (bed validation, delete search), **Create** (create path), **Delete** (delete path) |
| **Beds** | (inventory) | **Search** by `Bed ID` formula from sheet `Room / Bed` codes |

**Does not write:** Guests, Conversations, Messages, Payments (Stripe), Operator Release tables.

### 1.5 Does it create Bookings?

**Yes** on **create** (`Sync Status` = `Ready` / `Processing`):

- Node: **Create Airtable Booking - Queue**
- Typical fields: Guest Name, Check In/Out, Guest Count, Status (default **Confirmed**), Payment Status (default **waiting_payment**), Package, Phone, Email, **Booking Source = Manual Staff**, Staff Notes (includes `Manual Entry ID`), **Assignment Status = Assigned**, Deposit Paid from sheet

**Booking ID** (`WH-rec…`) is set by separate Airtable automation **“Create Booking ID”** (not in this workflow) after create.

### 1.6 Does it create Booking Beds? Does it assign?

| Question | Answer |
|----------|--------|
| Creates **Booking Beds**? | **Yes** on create — one AT row per bed in `Room / Bed` |
| Calls **Assign** / **Choose Beds**? | **No** — staff list beds explicitly; no `assign-beds-to-booking` HTTP |
| Assigns rooms/beds? | **Yes, manually** — validates bed codes exist in AT **Beds**, then creates rows with **Assignment Type = Manual Staff** |
| **Assignment Status** on booking | Set to **Assigned** on create (not Unassigned → automation assign) |

Create path (simplified):

```
Validate Beds For Create → Create Airtable Booking → Build Booking Beds For Create
  → Create Airtable Booking Bed (loop) → Mark sheet Synced
```

### 1.7 Update and delete paths

| Action | Bookings | Booking Beds | Sheet |
|--------|----------|--------------|-------|
| **update** | **Update Airtable Booking - Queue** (guest/dates/status/payment fields from sheet) | **Does not** add/remove/reassign beds in hosted workflow | Synced + AT booking id |
| **delete** | **Update Airtable Booking - Cancelled Queue** (Status **Cancelled**) | **Search** → **Delete Airtable Booking Beds - Queue** (all beds linked to booking) | Deleted status columns |

**Gap (hosted):** If staff change **Room / Bed** on an existing row and set **Update Ready**, the workflow updates the **booking** record only — **not** bed rows. Bed changes today require manual AT edits, **Reassign**, or a future enhancement. **3b.4** should document this; optional 3b.4+ could chain local **Reassign** when `bed_ids` change on update.

### 1.8 Status fields updated (Airtable)

| Field | Create | Update | Delete |
|-------|--------|--------|--------|
| **Status** | From sheet or **Confirmed** | From sheet | **Cancelled** |
| **Payment Status** | From sheet or **waiting_payment** | From sheet | (unchanged in cancel node — verify live) |
| **Assignment Status** | **Assigned** | (typically unchanged on update) | Effectively cleared when beds deleted; cancel node may set review fields |
| **Availability Check Status** | Not always set on create | — | — |
| **Deposit Paid** | From sheet | From sheet | — |
| **Booking Source** | **Manual Staff** | — | — |

Postgres enums map via existing sync/assign tooling (`manual_staff`, `deposit_paid`, etc.) — see [`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md) §4.1.

### 1.9 What hosted Manual Entries does **not** touch

| System | Notes |
|--------|--------|
| **Postgres** | Not used in hosted export |
| **`payments` / `payment_events`** | Sheet **Deposit Paid** / **Payment Status** → AT booking fields only; **not** Stripe `payments` rows |
| **Stripe / Main / Send Confirmation** | No |
| **Conversations / Messages** | No |
| **Planning Sheet sync** | No direct write (reads assignments indirectly via AT) |
| **Cancel / Assign / Reassign webhooks** | No HTTP to those paths (delete path deletes AT beds inline; does not call `cancel-booking-beds`) |

---

## 2. Phase 3b.4 goal

### 2.1 What Postgres should mirror (local)

| Entity | On create | On update | On delete |
|--------|-----------|-----------|-----------|
| **`bookings`** | INSERT after resolve client; set `booking_source = manual_staff`, dates, guest_count, status, payment_status (mirror sheet), `airtable_record_id` after AT create | UPDATE booking fields from sheet | UPDATE `status = cancelled` (mirror AT); do not DELETE booking row |
| **`booking_beds`** | INSERT one row per validated bed (natural key); `assignment_type` manual; dates = check_in/check_out | **Proposal:** no bed mutation unless explicit bed-diff sub-feature; else document “AT-only bed edits” | DELETE all rows for `booking_id` (mirror AT bed deletes) |
| **`manual_entries`** (optional) | UPSERT by `(client_id, manual_entry_code)` with sync_status, sheet_row_number, error | UPDATE sync + `booking_id` FK | UPDATE sync_status / error |
| **`beds` / `rooms`** | Read-only lookup by `bed_code` | — | — |

**Does not mirror in 3b.4:** `payments`, `payment_events`, `conversations`, `messages`, `guests` (unless later backfill links phone → guest).

### 2.2 Source of truth (during 3b.4 local phase)

| Layer | Role |
|-------|------|
| **Google Sheets Manual Entries** | **Staff queue UX** — create/edit/delete intent, sync status, errors (unchanged layout) |
| **Airtable Bookings / Booking Beds** | **Staff operational mirror** — what Ale/Cami see today; hosted processor still writes AT in parallel during local test |
| **Postgres** | **Local authority for planning/drift/assign/cancel/reassign tooling** — written **before** AT in the fork (same pattern as 3b.2c) |

Production cutover (Phase 4+) is **not** in scope; local fork uses **test** PAT/base and optionally a **copy** of the Manual Entries tab.

### 2.3 Booking creation vs bed assignment

| Capability | In scope for 3b.4? |
|------------|-------------------|
| **Create booking** | **Yes** |
| **Assign explicit beds from sheet** | **Yes** (not Choose Beds) |
| **Auto-assign via Assign webhook** | **No** (unless optional future flag) |
| **Update booking metadata** | **Yes** |
| **Cancel + remove beds** | **Yes** |
| **Reassign on sheet bed change** | **Optional follow-up** (chain local 3b.3b when `Room / Bed` changes on update) |

---

## 3. Data mapping

### 3.1 Manual Entries sheet → queue item (Code - Pick Next Manual Queue Item)

| Sheet column | Queue JSON field | Notes |
|--------------|------------------|-------|
| Manual Entry ID | `manual_entry_id` | Required; `MAN-…` |
| Sync Status | `action` via `ready` / `update ready` / `delete ready` | |
| Guest Name | `guest_name` | Required except delete |
| Package | `package` | Normalized Malibu/Uluwatu/Waimea/Custom |
| Deposit Paid | `deposit_paid` | Number → AT **Deposit Paid** |
| Phone / Email | `phone`, `email` | |
| Check In / Check Out | `check_in`, `check_out` | ISO date slice `YYYY-MM-DD` |
| Guest Count | `guest_count` | Default 1 |
| Room / Bed | `room_bed`, `bed_ids[]`, `bed_filter_formula` | Comma-separated `R7-B1`, … |
| Status | `status` | Default Confirmed on create |
| Payment Status | `payment_status` | Default waiting_payment |
| Notes | `notes` | Appended to Staff Notes / assignment notes |
| Airtable Booking ID | `airtable_booking_record_id` | Required for update/delete |

### 3.2 Airtable Bookings (create/update)

| Airtable field | Postgres `bookings` | 3b.4 notes |
|----------------|---------------------|------------|
| Booking ID | `booking_code` | `WH-rec…` after AT automation; PG may use temp code until backfill |
| (record id) | `airtable_record_id` | Backfill after AT create |
| Guest Name | `guest_name` | |
| Status | `status` | enum map |
| Payment Status | `payment_status` | **Mirror only** — no Stripe |
| Check In / Out | `check_in`, `check_out` | |
| Guest Count | `guest_count` | |
| Assignment Status | `assignment_status` | Create → `assigned` |
| Package | `package_code` | |
| Booking Source | `booking_source` | `manual_staff` |
| Staff Notes | `staff_notes` | |
| Deposit Paid | `deposit_paid_cents` or metadata | Align with existing sync script |
| Phone / Email | optional guest link later | Not required for 3b.4 MVP |

### 3.3 Airtable Booking Beds (create)

| Airtable field | Postgres `booking_beds` | 3b.4 notes |
|----------------|-------------------------|------------|
| Booking | `booking_id` FK | |
| Bed / Bed ID | `bed_id` FK + `bed_code` | Resolve via `beds.bed_code` |
| Room ID | `room_code` | Denormalized from bed |
| Assignment Start/End Date | `assignment_start_date`, `assignment_end_date` | Usually = booking check_in/out |
| Assignment Type | `assignment_type` | `Manual Staff` |
| Assignment Notes | `assignment_notes` | |
| (record id) | `airtable_record_id` | After AT create |

**Natural key (same as 3b.2):** `(booking_code, bed_code, assignment_start_date, assignment_end_date)` — see [`scripts/lib/bed-drift-keys.js`](../scripts/lib/bed-drift-keys.js).

### 3.4 Rooms / beds (inventory)

| Source | Postgres | Changed in 3b.4? |
|--------|----------|------------------|
| Seed + CSV sync | `rooms`, `beds` | **Read-only** |

Bed validation: sheet codes must exist in `beds` for client `wolfhouse-somo` (mirror **Search Beds - Create**).

### 3.5 Optional `manual_entries` table

Schema exists ([`database/migrations/001_init.sql`](../database/migrations/001_init.sql)); renamed to `client_id` in 003.

| Sheet / queue | `manual_entries` column |
|---------------|-------------------------|
| Manual Entry ID | `manual_entry_code` UNIQUE per client |
| row | `sheet_row_number` |
| action | `action` enum (`create`/`update`/`delete`) |
| Sync Status | `sync_status` |
| booking link | `booking_id` FK after PG booking exists |
| Error | `error_message` |

**Proposal:** 3b.4b may mirror queue state for debugging; not required for 3b.4c MVP if sheet remains canonical queue log.

---

## 4. Risks

| Risk | Scenario | Mitigation (proposal) |
|------|----------|------------------------|
| **Duplicate bookings** | Webhook retry after AT create but before sheet marks Synced | UPSERT PG booking on `airtable_record_id` or `manual_entry_id`; idempotent create if `booking_code` already exists |
| **Duplicate bed assignments** | Retry create bed loop | Natural-key skip (3b.2b pattern); store AT id on PG row |
| **Missing guest info** | Empty Guest Name | Hosted throws — keep; PG gate before AT |
| **Date format mismatch** | Sheet locale vs ISO | Keep `slice(0,10)` + `toIsoDateString`; validate `check_out > check_in` |
| **Manual edits after sync** | Staff edit AT or sheet without re-queue | Drift report; document “edit via sheet → Update Ready”; optional repair job AT→PG (read-only) later |
| **Assigning occupied beds** | Sheet lists bed already booked for dates | PG overlap check before INSERT (assign-plan logic); surface in 3b.4a report |
| **Payment status confusion** | Sheet says deposit paid but no Stripe `payments` row | **Policy:** 3b.4 mirrors `bookings.payment_status` only; never write `payments` / `payment_events` |
| **Update without bed sync** | Staff changes Room/Bed on update row | Document limitation; 3b.4a flags bed diff; future: chain reassign |
| **Wrong row / row_number** | Sheet batchUpdate off-by-one | Keep hosted `P{row}:R{row}` math; test with copy tab |
| **AT automation race** | Create Booking ID automation lags | PG may lack `booking_code` until backfill; impact report warns |
| **Production sheet write** | Local fork points at prod spreadsheet id in export | **Test copy** of sheet or mock HTTP in E2E; never prod write from dev without approval |
| **Shared webhook UUID** | Import collision with Send Confirmation | New webhook id in **local** fork only (build script) |

---

## 5. Safety and idempotency

### 5.1 Principles (align with 3b.1c–3b.3b)

1. **Postgres write before Airtable** on create (INSERT booking + beds → AT create → backfill `airtable_record_id`).  
2. **Destructive delete:** PG DELETE `booking_beds` then AT deletes (or AT first only if PG gate fails — match cancel pattern).  
3. **Never** mutate `payments`, `payment_events`, or Stripe workflows.  
4. **Never** DELETE `bookings` row — cancel updates status only.

### 5.2 Natural keys

| Entity | Key | Idempotency |
|--------|-----|-------------|
| `bookings` | `(client_id, booking_code)` UNIQUE | Second create with same `rec` → update/backfill |
| `booking_beds` | `(booking_code, bed_code, start, end)` logical; `airtable_record_id` UNIQUE | Skip INSERT if exists (3b.2b) |
| `manual_entries` | `(client_id, manual_entry_code)` UNIQUE | UPSERT sync_status |

### 5.3 Detect repeated manual entry

| Signal | Use |
|--------|-----|
| `manual_entry_id` | Primary business key for queue row |
| Sheet **Sync Status** = `Synced` | Skip unless `Update Ready` / `Delete Ready` |
| `Airtable Booking ID` column | Tie update/delete to `bookings.airtable_record_id` |
| PG `manual_entries.synced_at` | Optional mirror |

### 5.4 Avoid duplicate `booking_beds`

| Mechanism | When |
|-----------|------|
| Pre-insert overlap query | Same as assign (3b.2a plan) |
| Natural-key skip on retry | Same bed/dates/booking |
| Delete-all on delete path | Before recreate (not on update MVP) |

### 5.5 Partial booking already exists

| Case | Behavior |
|------|----------|
| AT booking exists, PG missing | 3b.4a report: would INSERT PG; 3b.4b `--execute` upserts |
| PG booking exists, AT missing | `partial_failure`; do not delete PG without ops approval |
| Create called twice for same `MAN-` id | Second run: PG skip + AT errors or no-op; sheet should be `Synced` |

---

## 6. Proposed substeps

| Step | Deliverable | Writes? |
|------|-------------|---------|
| **3b.4a** | `db:report:manual-entry-impact` — given `--manual-entry-id=MAN-…` or sheet row snapshot: would-create/update/delete booking + beds, overlaps, payments untouched | **Read-only** |
| **3b.4b** | `db:manual-entry:sync` or `process-manual-entry-postgres.js` — PG mirror for create/update/delete (CLI `--execute`) | PG only (AT optional flag off) |
| **3b.4c** | `build-manual-entries-local.js` → `n8n/phase3b/Wolfhouse - Manual Entries Queue Processor (local PG).json` | PG + AT + Sheets (test) |

**Order:** 3b.4a → 3b.4b → 3b.4c (same as cancel/assign/reassign).

### 6.1 Proposed local workflow order (3b.4c)

```
Webhook wolfhouse-manual-entries-queue
  → Code - Parse Manual Entry Webhook (optional; normalize body from Apps Script)
  → HTTP - Read Manual Entries (hosted) OR trust webhook payload
  → Code - Pick Next Manual Queue Item (hosted)
  → Switch - Queue Action
       ├─ create
       │     → Postgres - Upsert Booking + Insert Beds (3b.4b SQL)
       │     → Code - Validate PG Manual Create
       │     → [hosted AT path: Search Beds → Create Booking → Create Beds]
       │     → Postgres - Backfill airtable_record_id
       │     → HTTP - Mark Queue Item Synced
       ├─ update
       │     → Postgres - Update Booking
       │     → Update Airtable Booking - Queue (hosted)
       │     → (optional future: if bed_ids changed → HTTP reassign local)
       └─ delete
             → Postgres - Delete booking_beds + cancel booking
             → [hosted AT: delete beds → cancel booking]
             → HTTP - Mark Queue Item Deleted
  → Code - Build Manual Entry Response → Respond
```

**Deactivate** duplicate `wolfhouse-manual-entries-queue` on local n8n if hosted copy is present.

### 6.2 Proposed response JSON (3b.4c)

| Field | Meaning |
|-------|---------|
| `ok` | PG + AT + sheet mark succeeded for this action |
| `manual_entry_id` | `MAN-…` |
| `action` | `create` \| `update` \| `delete` |
| `booking_code` | `WH-rec…` when known |
| `record_id` | Airtable `rec…` |
| `pg_booking_created` / `pg_booking_updated` | booleans |
| `pg_beds_inserted_count` / `pg_beds_deleted_count` | counts |
| `airtable_booking_ok` / `airtable_beds_ok` | booleans |
| `sheet_sync_ok` | Sheet columns P–R updated |
| `partial_failure` | e.g. `pg_ok_airtable_failed`, `pg_overlap_conflicts` |
| `errors[]` | codes |

---

## 7. Test plan

**Environment:** Local n8n + Postgres + **test** Google Sheet tab + **test** Airtable PAT. Pause **Assign Beds When Unassigned** if testing create paths that set Unassigned in experiments.

| # | Scenario | Pass criteria |
|---|----------|---------------|
| T1 | `npm run db:sync` | Baseline |
| T2 | **New manual booking** — create row `Ready`, beds `R1-B1,R1-B2`, guest_count=2 | PG booking + 2 beds; AT booking + beds; sheet `Synced` |
| T3 | **Duplicate manual entry** — replay same `MAN-` while Synced | No duplicate PG natural keys; graceful skip or error |
| T4 | **Manual booking with beds** | `assignment_type` manual; `assignment_status` assigned |
| T5 | **Manual booking with no beds** (create) | Hosted throws — 3b.4a reports actionable `missing_beds` |
| T6 | **Overlap/conflict** — beds occupied on dates | 3b.4a exit 2; fork sets `partial_failure` / no silent insert |
| T7 | **Missing fields** — no guest name / dates | Fail before PG/AT with clear error |
| T8 | **Update** — change guest count / dates | PG + AT booking updated; beds unchanged (document) |
| T9 | **Delete** | PG beds gone; booking cancelled; AT beds deleted |
| T10 | `db:report:bed-drift` | Exit 0 or documented exceptions |
| T11 | `planning:report:postgres` | Rows reflect manual beds |
| T12 | `test:phase2f-resolver` | 10/10 |
| T13 | `db:sync` | Restore baseline |

**Local E2E helpers (when implemented):**

- `scripts/test-manual-entries-webhook.ps1`  
- `scripts/run-manual-entry-e2e-local.js` (optional)

---

## 8. Rollback

| Action | Command / step |
|--------|----------------|
| **Restore PG beds/bookings from CSV** | `npm run db:sync` |
| **Remove PG rows for one test booking** | `npm run db:cancel:booking-beds -- --booking-code=WH-rec… --execute` |
| **Deactivate local fork** | n8n UI: deactivate Manual Entries (local PG) |
| **Re-import hosted processor** | Import read-only `n8n/Wolfhouse - Manual Entries Queue Processor.json` on local n8n if needed |
| **Regenerate fork** | `npm run build:manual-entries-local` |
| **Clear test sheet rows** | Manual — test tab only |
| **Payment rollback** | **Never** via 3b.4 tooling |

---

## 9. Files if approved (implementation — not started)

| Action | Path |
|--------|------|
| **Create** | `docs/PHASE-3b-4a.md` (impact runbook) |
| **Create** | `docs/PHASE-3b-4b.md` (PG CLI runbook) |
| **Create** | `docs/PHASE-3b-4.md` (local n8n runbook) |
| **Create** | `scripts/report-manual-entry-impact.js` |
| **Create** | `scripts/lib/manual-entry-plan.js` (optional) |
| **Create** | `scripts/process-manual-entry-postgres.js` (or `manual-entry-postgres.js`) |
| **Create** | `scripts/lib/manual-entry-pg-sql.js` |
| **Create** | `scripts/build-manual-entries-local.js` |
| **Create** | `n8n/phase3b/Wolfhouse - Manual Entries Queue Processor (local PG).json` (+ `.n8n-import.json`) |
| **Create** | `scripts/test-manual-entries-webhook.ps1` |
| **Create** | `scripts/run-manual-entry-e2e-local.js` (optional) |
| **Modify** | `package.json` — `db:report:manual-entry-impact`, `db:manual-entry:postgres`, `build:manual-entries:local` |
| **Modify** | `n8n/phase3b/README.md`, `docs/regression-test-plan.md` |

**Reuse (no fork):**

| Path | Use |
|------|-----|
| `scripts/lib/assign-booking-beds-plan.js` | Overlap / bed validation |
| `scripts/lib/bed-drift-keys.js` | Natural keys |
| `n8n/Wolfhouse - Manual Entries Queue Processor.json` | Hosted node source |

**Not modified:**

| Path | Reason |
|------|--------|
| `n8n/Wolfhouse - Manual Entries Queue Processor.json` | Hosted export |
| `n8n/Wolfhouse - Bed Assignment.json`, Cancel, Reassign | Hosted exports |
| `n8n/phase2/*` | Main / Stripe / Send Confirmation |
| `apps-script/code.gs` | Unless explicit staff-approved change later |
| `database/migrations/*` | No migration in initial 3b.4 |

---

## 10. Prerequisites (commit reference)

| Stage | Commit | Notes |
|-------|--------|-------|
| 3b freeze doc | `4e1ea90` | [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md) |
| 3b.3b Reassign fork | `dfcf3c4` | Chained assign pattern |
| 3b.2c Assign fork | `1085e56` | PG insert + AT create |
| 3b.1c Cancel fork | `9556297` | PG delete pattern |
| 3b.0 drift | `140d434` | Drift tooling |

---

## 11. Approval checklist

- [ ] Owner accepts **PG-first create** for manual staff bookings with **explicit sheet beds** (no Choose Beds).  
- [ ] Owner accepts **update does not change beds** in MVP (or approves reassign chain for bed diffs).  
- [ ] Test **Google Sheet** is a copy, not production planning/manual tab.  
- [ ] Test **Airtable** base/PAT only for local webhooks.  
- [ ] **No** `payments` / Stripe / Main changes in 3b.4.  
- [ ] **No** hosted Cloud import of local fork.  
- [ ] 3b.4a impact report approved before 3b.4b execute script.  

---

## 12. Next stages (out of scope)

| Stage | Status |
|-------|--------|
| **3b.4a–c** Manual Entries local mirror | This proposal |
| **3b.5** Operator Room Release | Not started |
| **Phase 3c** Main + Postgres booking creation | Not started |
| **Production cutover** | Much later — Sheets layout unchanged until then |

---

## References

| Item | Location |
|------|----------|
| Hosted Manual Entries export | `n8n/Wolfhouse - Manual Entries Queue Processor.json` |
| Apps Script | `apps-script/code.gs`, `ManualBookingDialog.html`, `UpdateManualBookingDialog.html` |
| Webhook map | `docs/webhook-map.md` |
| Workflow dependencies | `docs/workflow-dependency-map.md` §3 |
| Regression §4 | `docs/regression-test-plan.md` |
| Phase 3b parent | `docs/PHASE-3b-PROPOSAL.md` |
| Phase 3b freeze | `docs/PHASE-3b-FREEZE.md` |
| Stripe / manual deposit policy | `docs/stripe-payment-design.md` |
