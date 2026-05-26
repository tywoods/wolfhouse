# Phase 3b.4c — Manual Entries local n8n fork (proposal)

**Status:** Proposal only — **no implementation**, workflow JSON edits, hosted export edits, production Airtable/Sheets changes, or production cutover.  
**Prerequisites:** Phase **3b.4a** (`41d2547`), **3b.4b** (`3c1f9c7`), **3b.0**–**3b.3b** frozen ([`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md)).  
**Parents:** [`PHASE-3b-4-PROPOSAL.md`](PHASE-3b-4-PROPOSAL.md), [`PHASE-3b-4b.md`](PHASE-3b-4b.md), [`PHASE-3b-4a.md`](PHASE-3b-4a.md)

**Explicitly out of scope for 3b.4c:**

- Editing or re-importing **hosted** `n8n/Wolfhouse - Manual Entries Queue Processor.json` into n8n Cloud  
- **Production** Google Sheets tab or **production** Airtable base (test PAT + test sheet copy only)  
- **`payments`**, **`payment_events`**, Stripe / Main / Send Confirmation  
- **`conversations`**, **`messages`**, Operator Room Release (**3b.5**)  
- **Phase 3c** / Main Postgres integration  
- **`database/migrations/*`** (unless separately approved)  
- Changing Apps Script UX or sheet column layout  
- Auto-assign / Choose Beds / Assign webhook for manual create path  

---

## Executive summary

3b.4c adds a **local-only n8n fork** of **Wolfhouse - Manual Entries Queue Processor** that:

1. Receives the same **`wolfhouse-manual-entries-queue`** webhook as hosted.  
2. Picks and validates the next Manual Entries queue row (hosted Code nodes, unchanged behavior).  
3. Runs the **Postgres mirror** using logic proven in **3b.4b** (`manual-entry-postgres.js` / `manual-entry-pg-sql.js`) **before** Airtable + Sheets.  
4. Runs the **existing hosted Airtable + Google Sheets path** (copied nodes from read-only export).  
5. On **create**, **backfills** Postgres `bookings.airtable_record_id` and `booking_code` (`WH-rec…`) after AT booking exists.  
6. Returns structured JSON with PG + AT + sheet outcomes and **`partial_failure`** codes.

Hosted export remains the **read-only source** for node wiring; output lives under **`n8n/phase3b/`** only.

---

## 1. Current hosted Manual Entries workflow

### 1.1 Identity and trigger

| Attribute | Value |
|-----------|--------|
| **Workflow name** | Wolfhouse - Manual Entries Queue Processor |
| **Hosted export (read-only)** | [`n8n/Wolfhouse - Manual Entries Queue Processor.json`](../n8n/Wolfhouse%20-%20Manual%20Entries%20Queue%20Processor.json) |
| **Webhook path** | `POST /webhook/wolfhouse-manual-entries-queue` |
| **Webhook ID** | `a17ba7e1-7a97-4613-9f8b-d35b50460017` (same UUID as Send Confirmation — **different path**; local import must not collide) |
| **Trigger source** | Google Sheets **Apps Script** ([`apps-script/code.gs`](../apps-script/code.gs)) — menu “Sync Manual Entries Now” or row-driven sync |
| **Production URL** | `https://tywoods.app.n8n.cloud/webhook/wolfhouse-manual-entries-queue` ([`webhook-map.md`](webhook-map.md)) |

**Not** triggered by Airtable automations. **Not** called from Main.

### 1.2 Expected webhook payload

| Source | Body shape |
|--------|------------|
| **Apps Script (typical)** | `{ "action": "manual_sync_button" }` — processor reads sheet and picks next row |
| **Direct test / E2E** | Optional full queue item JSON matching **`Code - Pick Next Manual Queue Item`** output (see §1.4) |
| **Resume** | Rows in `*processing` sync status are eligible on rerun |

Local fork should accept **both** patterns: trust pick-node output when present; otherwise run hosted sheet read + pick logic.

### 1.3 Google Sheet tab and columns

| Item | Detail |
|------|--------|
| **Tab** | `Manual Entries` |
| **Read range (hosted HTTP node)** | `Manual Entries!A1:R1000` |
| **Columns read (A–O intent)** | Staff input fields for queue item |
| **Columns written (P–R)** | **Sync Status**, **Airtable Booking ID**, **Error** |

| Col | Header | Read / write |
|-----|--------|--------------|
| A | Manual Entry ID | Read |
| B | Created At | Read |
| C | Created By | Read |
| D | Guest Name | Read |
| E | Package | Read |
| F | Deposit Paid | Read |
| G | Phone | Read |
| H | Email | Read |
| I | Check In | Read |
| J | Check Out | Read |
| K | Guest Count | Read |
| L | Room / Bed | Read |
| M | Status | Read |
| N | Payment Status | Read |
| O | Notes | Read |
| P | Sync Status | **Write** |
| Q | Airtable Booking ID | **Write** |
| R | Error | **Write** |

**3b.4c:** Sheet nodes copied from hosted export; point at **test** spreadsheet ID in local n8n credentials only.

### 1.4 Queue item shape (`Code - Pick Next Manual Queue Item`)

| Field | Source column / rule |
|-------|----------------------|
| `manual_entry_id` | `MAN-…` |
| `action` | `create` / `update` / `delete` from Sync Status |
| `guest_name`, `check_in`, `check_out`, `guest_count` | Sheet |
| `room_bed`, `bed_ids[]`, `bed_filter_formula` | Room / Bed (comma-separated `R7-B1`, …) |
| `status`, `payment_status`, `package` | Sheet (normalized) |
| `phone`, `email`, `notes`, `deposit_paid` | Sheet |
| `airtable_booking_record_id` | Column Q (update/delete) |
| `sheet_row_number` | For `P{row}:R{row}` batchUpdate |

**Priority (one row per invocation):** `delete processing` → `delete ready` → `update processing` → `update ready` → `processing` → `ready`.

### 1.5 Airtable tables

| Table | Operations |
|-------|------------|
| **Bookings** (`tblYWm3zKFafe4qu7`) | Create (create path); Update (update + cancel on delete) |
| **Booking Beds** (`tblO1ByvTMXS4SalB`) | Search (validation, delete); Create (create path); Delete (delete path) |
| **Beds** (inventory) | Search by bed code |

**Does not write:** Guests, Conversations, Messages, Payments, Operator Release.

### 1.6 Create / update / delete behavior (hosted)

| Action | Bookings | Booking Beds | Sheet |
|--------|----------|--------------|-------|
| **create** | INSERT booking (**Manual Staff**, **Assigned**, dates, guest_count, payment fields from sheet) | INSERT one row per bed in Room / Bed | Mark **Synced** + AT record id |
| **update** | UPDATE booking metadata from sheet | **No bed changes** in hosted MVP | Synced |
| **delete** | UPDATE Status **Cancelled** | DELETE all beds for booking | Deleted / error columns |

**Create path (simplified):**

```
Validate Beds → Create Airtable Booking → Build Booking Beds → Create Booking Bed (loop) → Mark Synced
```

**Booking code `WH-rec…`:** Set by separate AT automation **“Create Booking ID”** after create (not in this workflow).

**Gap (documented):** Update with changed Room / Bed does **not** reassign beds in hosted flow — PG fork matches 3b.4b MVP (booking fields only on update).

### 1.7 What hosted does **not** touch

| System | Notes |
|--------|--------|
| **Postgres** | Not used today |
| **`payments` / `payment_events`** | Sheet payment fields → AT booking only |
| **Stripe / Main / Send Confirmation** | No |
| **Conversations / Messages** | No |
| **Cancel / Assign / Reassign webhooks** | No (delete removes AT beds inline) |
| **Planning Sheet direct write** | No |

---

## 2. Local fork goal

| Objective | Detail |
|-----------|--------|
| **Generate local fork** | `n8n/phase3b/Wolfhouse - Manual Entries Queue Processor (local PG).json` (+ `.n8n-import.json`) via `build-manual-entries-local.js` |
| **Postgres mirror** | Embed or invoke **3b.4b** logic per action (`create` / `update` / `delete`) |
| **Preserve AT + Sheets** | Copy hosted nodes after PG step; same field mapping and sheet P–R updates |
| **Hosted export** | **Read-only** input to build script — never committed as modified |
| **No hosted import** | Local n8n only (`http://localhost:5678` or docker `n8n-main`) |
| **Dual-write order** | **Postgres first**, then Airtable, then sheet status — align with 3b.1c / 3b.2c pattern |
| **Create backfill** | After AT booking create: UPDATE PG `airtable_record_id`, `booking_code` when `rec…` / `WH-rec…` known |
| **Webhook uniqueness** | Deactivate hosted Manual Entries on **local** n8n if both imported; only one active on `wolfhouse-manual-entries-queue` |

### Relationship to 3b.4a / 3b.4b

| Tool | Role in 3b.4c |
|------|----------------|
| [`db:report:manual-entry-impact`](../scripts/report-manual-entry-impact.js) | Pre-flight / debugging; same flags as fork payload |
| [`db:manual-entry:postgres`](../scripts/manual-entry-postgres.js) | **Source of truth** for PG mutations; build script keeps n8n SQL in sync |
| [`scripts/lib/manual-entry-pg-sql.js`](../scripts/lib/manual-entry-pg-sql.js) | Shared INSERT/UPDATE/DELETE helpers |
| [`scripts/lib/manual-entry-impact-plan.js`](../scripts/lib/manual-entry-impact-plan.js) | Parse, validate, overlap, guest-count gates |

**Implementation choice (proposal):** Prefer **Postgres nodes** with SQL blocks generated from `manual-entry-pg-sql.js` (same pattern as [`build-cancel-beds-local.js`](../scripts/build-cancel-beds-local.js)), plus **Code** nodes for validation/response. Alternative: **HTTP Request** to `wolfhouse-tools` container running `npm run db:manual-entry:postgres -- … --execute` — only if SQL duplication becomes unmaintainable.

---

## 3. Workflow order (local fork)

### 3.1 Top-level flow

```
Webhook POST /webhook/wolfhouse-manual-entries-queue
  → Code - Parse Webhook Body (optional normalize)
  → HTTP - Read Manual Entries sheet OR use webhook queue item
  → Code - Pick Next Manual Queue Item (hosted copy)
  → IF no row → Respond 200 { ok: true, skipped: true }
  → Code - Validate Required Fields (shared rules with 3b.4a)
  → Switch - Queue Action (create | update | delete)
       ├─ create branch
       ├─ update branch
       └─ delete branch
  → Code - Build Manual Entry Response
  → Respond to Webhook
```

### 3.2 Create branch

```
Switch create
  → Postgres - Manual Entry Create (3b.4b: upsert booking + insert beds)
  → IF pg_gate_failed → Mark sheet Error + partial_failure (skip AT)
  → [hosted] Search Beds - Create
  → [hosted] Create Airtable Booking - Queue
  → [hosted] Build Booking Beds + Create Airtable Booking Bed (loop)
  → Postgres - Backfill booking_code + airtable_record_id
  → [hosted] HTTP - Mark Queue Item Synced (P:R)
```

**Create PG notes:**

- Use `WH-pending-{manual_entry_id}` until backfill.  
- Skip bed INSERT for unknown codes / strict overlap (fail branch).  
- `metadata.manual_entry_id` set on booking row.  
- **Do not** write `payments` / `payment_events`.

### 3.3 Update branch

```
Switch update
  → Postgres - Manual Entry Update (booking fields only; explicitFields semantics)
  → IF pg_gate_failed → sheet Error
  → [hosted] Update Airtable Booking - Queue
  → [hosted] HTTP - Mark Queue Item Synced
```

**No bed mutation** in PG or AT on update (MVP). Warn in response if `bed_ids` changed vs PG (future: chain local Reassign).

### 3.4 Delete branch

```
Switch delete
  → Postgres - Manual Entry Delete (DELETE booking_beds; status=cancelled; payment_status unchanged)
  → IF pg_gate_failed → sheet Error
  → [hosted] Search Booking Beds → Delete Airtable Booking Beds - Queue
  → [hosted] Update Airtable Booking - Cancelled Queue
  → [hosted] HTTP - Mark Queue Item Deleted / Synced
```

**Never** `DELETE FROM bookings` in PG (same as 3b.4b).

### 3.5 Stable local workflow id (proposed)

| Item | Value |
|------|--------|
| **Workflow id** | `B3c4ManualEntriesLocal01` (assign at first import; document in runbook) |
| **New webhook id** | Generate fresh UUID in build script (avoid Send Confirmation collision) |

---

## 4. Data safety

| Rule | Implementation |
|------|----------------|
| **No payment tables** | No SQL touching `payments` / `payment_events`; assert row counts unchanged (3b.4b pattern) |
| **No booking DELETE** | Delete path: beds removed + `status=cancelled` only |
| **Provisional bookings** | `WH-pending-MAN-*` allowed for PG-first create; backfill after AT; cleanup via `db:sync` or documented DELETE when 0 beds / 0 payments |
| **Idempotent queue replay** | Natural-key skip on `booking_beds`; booking upsert by `manual_entry_id` metadata / `airtable_record_id` |
| **Duplicate prevention** | Reject second `MAN-…` linked to different booking; skip duplicate bed natural keys |
| **Overlap** | Default **fail** PG create (strict); optional fork flag `allow_conflict` → `needs_review` / `conflict` (3b.4b `--allow-conflict`) |
| **Guest count** | Warn on mismatch; optional strict gate refuses PG create before AT |
| **Missing fields** | Fail before PG + AT with sheet **Error** column; no partial AT create |
| **Cancelled booking** | Refuse PG bed insert on `cancelled` / `expired` |
| **payment_status** | Mirror from sheet on create; update only when sheet column explicitly drives change; **never** on delete |
| **Partial failure** | Continue to response builder; do not throw unhandled — set `ok: false`, `partial_failure`, `errors[]` |

### Postgres-first vs Airtable-first on create

| Step | Rationale |
|------|-----------|
| PG before AT | Planning/drift tooling sees intent immediately; matches Phase 3b dual-write pattern |
| AT before sheet mark | Hosted order preserved for staff UX |
| Backfill after AT | Resolve `WH-rec…` / `rec…` so PG aligns with operational ids |

If PG create fails (overlap, unknown bed), **do not** run AT create (avoid AT-only booking without PG mirror).

---

## 5. Partial failure matrix

| Scenario | PG | Airtable | Sheet P–R | `partial_failure` (proposed) | Operator action |
|----------|----|----------|-----------|------------------------------|-----------------|
| PG ok, AT fails | ✓ | ✗ | Error set | `pg_ok_airtable_failed` | Fix AT; rerun or manual AT repair; PG already mirrored |
| PG fails, AT ok | ✗ | ✓ | May show Synced | `airtable_ok_pg_failed` | **Avoid** — gate should skip AT when PG fails; if race, `db:sync` / manual PG fix |
| PG ok, AT ok, sheet fails | ✓ | ✓ | ✗ | `sheet_sync_failed` | Rerun webhook; row may be `*processing` |
| Create: AT booking ok, beds fail | ✓ partial | booking only | Error | `airtable_beds_failed` | PG may have beds; AT missing beds — repair AT or delete PG beds |
| Create: PG beds ok, AT booking fails | beds ✓ | ✗ | Error | `pg_ok_airtable_booking_failed` | Remove PG provisional or retry |
| Delete: PG ok, AT bed delete fails | ✓ | partial | Error | `pg_ok_at_bed_delete_failed` | Manual AT bed cleanup |
| Delete: AT ok, PG fails | ✗ | ✓ | Synced? | `at_ok_pg_failed` | Run `db:manual-entry:postgres --action=delete --execute` or `db:sync` |
| Update: PG ok, AT fail | ✓ | ✗ | Error | `pg_ok_airtable_update_failed` | Retry update |
| Overlap / unknown bed (gate) | ✗ | ✗ | Error | `pg_validation_failed` | Fix sheet beds/dates; rerun |
| Idempotent replay (Synced) | skip | skip | — | `already_synced` or `idempotent_noop` | None |

**Response `ok` definition (proposed):** `true` only when PG gate passed **and** AT path succeeded **and** sheet mark succeeded for the action.

---

## 6. Rollback

| Action | Command / step |
|--------|----------------|
| **Deactivate local fork** | n8n UI → deactivate “(local PG)” Manual Entries |
| **Re-activate hosted copy on local** | Import read-only export if needed for comparison (not Cloud) |
| **Regenerate fork** | `npm run build:manual-entries:local` |
| **Restore PG from CSV** | `npm run db:sync` |
| **Remove PG beds for one booking** | `npm run db:cancel:booking-beds -- --booking-code=WH-rec… --execute` (does not cancel booking) |
| **Delete provisional test booking** | Only when safe: `WH-pending-MAN-*`, 0 beds, 0 payments (see 3b.4b cleanup) |
| **Clear test sheet rows** | Manual — **test tab only** |
| **Payment rollback** | **Never** via 3b.4 tooling |

---

## 7. Test plan

**Environment:** Local docker stack (`wolfhouse-postgres`, `n8n-main`, `wolfhouse-tools`); **test** Airtable PAT; **test** Manual Entries sheet copy; pause **Assign Beds When Unassigned** if it races with manual creates.

| # | Scenario | Pass criteria |
|---|----------|---------------|
| T0 | `npm run db:sync` | Baseline |
| T1 | `db:report:manual-entry-impact` for row | exit 0 before E2E |
| T2 | **Clean create** — sheet `Ready`, 2 beds, guest_count=2 | PG booking + 2 beds; AT booking + beds; sheet Synced; backfill `rec…` / `WH-rec…` |
| T3 | **Repeat create** same `MAN-…` | Idempotent; no duplicate PG natural keys; sheet stable |
| T4 | **Update** existing AT/PG booking | PG + AT fields updated; beds unchanged |
| T5 | **Delete** | PG beds 0; cancelled; AT beds gone; sheet marked |
| T6 | **Repeat delete** | Idempotent |
| T7 | **Overlap** occupied bed/dates | `partial_failure`; no silent PG/AT insert (or `allow_conflict` path documented) |
| T8 | **Unknown bed** | Validation error; sheet Error |
| T9 | **Missing fields** (no guest name / beds on create) | Fail before mutations |
| T10 | `db:report:bed-drift` | exit 0 or documented exceptions |
| T11 | `planning:report:postgres` | Manual beds visible |
| T12 | `test:phase2f-resolver` | 10/10 |
| T13 | `npm run db:sync` | Restore baseline after test bookings |

**Helpers (when implemented):**

```powershell
scripts/test-manual-entries-webhook.ps1 -ManualEntryId MAN-test ...
# optional: scripts/run-manual-entry-e2e-local.js
```

**Suggested test booking:** reuse `recBtWzIvmjQ5mmo0` for update/delete only after confirm test base; prefer new `MAN-…` rows for create.

---

## 8. Files if approved (implementation — not started)

| Action | Path |
|--------|------|
| **Create** | `scripts/build-manual-entries-local.js` |
| **Create** | `scripts/lib/manual-entry-pg-n8n-sql.js` (optional — SQL strings for Postgres nodes, synced from `manual-entry-pg-sql.js`) |
| **Create** | `n8n/phase3b/Wolfhouse - Manual Entries Queue Processor (local PG).json` |
| **Create** | `n8n/phase3b/Wolfhouse - Manual Entries Queue Processor (local PG).n8n-import.json` |
| **Create** | `docs/PHASE-3b-4c.md` |
| **Create** | `scripts/test-manual-entries-webhook.ps1` |
| **Create** | `scripts/run-manual-entry-e2e-local.js` (optional) |
| **Modify** | `package.json` — `"build:manual-entries:local": "node scripts/build-manual-entries-local.js"` |
| **Modify** | `n8n/phase3b/README.md` — Manual Entries section |
| **Modify** | `docs/regression-test-plan.md` — § Phase 3b.4c |

**Reuse (no fork):**

| Path | Use |
|------|-----|
| [`scripts/manual-entry-postgres.js`](../scripts/manual-entry-postgres.js) | Mutation semantics reference |
| [`scripts/lib/manual-entry-pg-sql.js`](../scripts/lib/manual-entry-pg-sql.js) | SQL source |
| [`scripts/lib/manual-entry-impact-plan.js`](../scripts/lib/manual-entry-impact-plan.js) | Validation / parse |
| [`n8n/Wolfhouse - Manual Entries Queue Processor.json`](../n8n/Wolfhouse%20-%20Manual%20Entries%20Queue%20Processor.json) | Hosted node copy source |
| [`build-cancel-beds-local.js`](../scripts/build-cancel-beds-local.js) | Build/import pattern |

**Must not modify in 3b.4c:**

- Hosted `n8n/Wolfhouse - Manual Entries Queue Processor.json`  
- `apps-script/code.gs` (unless separate approved change)  
- Payment / Main / Stripe workflows  
- `database/migrations/*`  

---

## Approval checklist

- [ ] PG-before-AT order acceptable for create (with backfill after AT booking id)  
- [ ] Test sheet + test Airtable base only for local E2E  
- [ ] Update MVP: no bed changes in fork (documented gap)  
- [ ] `partial_failure` matrix sufficient for ops  
- [ ] New local webhook UUID on import (no Send Confirmation collision)  
- [ ] Hosted Manual Entries deactivated on local n8n when fork active  

**Next step after approval:** implement 3b.4c only; update [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md) when signed off.
