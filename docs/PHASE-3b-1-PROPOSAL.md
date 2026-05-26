# Phase 3b.1 — Cancel bed assignments (proposal)

**Status:** Proposal only — **no implementation**, migrations, workflow edits, or production changes.  
**Prerequisites:** Phase 2 local signed off; Phase **3.0b**, **3a**, and **3b.0** passed (`140d434`, bed drift audit).  
**Parent:** [`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md)

**Explicitly out of scope for 3b.1:**

- Hosted n8n Cloud (`tywoods.app.n8n.cloud`) — exports remain read-only  
- **Assign** (`assign-beds-to-booking`) and **Reassign** (`reassign-booking-beds`) — 3b.2 / 3b.3  
- Stripe / `payments` / `payment_events` workflow or column changes  
- Main WhatsApp assistant, Send Confirmation, Manual Entries dual-write (3b.4+)  
- Google Sheets writes  
- Unique indexes on `booking_beds` (deferred to 3b.2 proposal)  
- Deleting or cancelling **bookings** rows in Postgres (bed release only)

---

## Executive summary

Today, when a **Bookings** row’s **Status** becomes **Cancelled** (staff UI, Manual Entries delete, or other paths), an **Airtable automation** calls n8n **`cancel-booking-beds`**, which **deletes all linked Booking Beds records** and sets **Assignment Status** / **Availability Check Status** to **Needs Review**. It does **not** set Status to Cancelled (that already happened) and does **not** touch payments or conversations.

Phase **3b.1** introduces a **local-only** path that performs the **same inventory effect in Postgres** before (eventually) mirroring deletes to Airtable. **First deliverable:** read-only “cancel impact” report and/or a **Postgres-only** cancel script with `--dry-run`. **Last deliverable in 3b.1:** local n8n fork: **DELETE `booking_beds` in PG → delete AT Booking Beds → update assignment fields both sides**, with hosted workflow unchanged until explicitly approved.

---

## 1. Current Cancel flow

### 1.1 What triggers cancellation vs bed release

| Step | System | What happens |
|------|--------|----------------|
| 1 | **Staff / sheet / other** | **Bookings.Status** set to **Cancelled** (e.g. Manual Entries `delete` → `Update Airtable Booking - Cancelled Queue`; planning manual delete; staff Airtable UI) |
| 2 | **Airtable automation** | **“Cancel Booking Beds When Booking Cancelled”** — when Status = **Cancelled** AND **Booking Beds** is not empty → POST webhook |
| 3 | **n8n** | **Wolfhouse - Cancel Bed Assignments** (`n8n/Wolfhouse - Cancel Bed Assignments.json`) runs |

**Reference:** [`docs/airtable-automations.md`](airtable-automations.md) §4, [`docs/webhook-map.md`](webhook-map.md).

**Important:** The Cancel workflow is **not** responsible for flipping **Status** to Cancelled. It assumes the booking is already cancelled (or in a state where bed rows must be cleared). **Main** may set **Status = Cancelled** on some paths (hosted export); it does **not** call `cancel-booking-beds` directly in the export — the **Airtable automation** bridges Status → webhook.

### 1.2 Workflow: Wolfhouse - Cancel Bed Assignments

| Attribute | Value |
|-----------|--------|
| **File (read-only)** | `n8n/Wolfhouse - Cancel Bed Assignments.json` |
| **Webhook path** | `POST /webhook/cancel-booking-beds` |
| **Webhook ID** | `8ab9d454-04d3-48c1-9cf4-8b0f305e26e7` |
| **Body** | `{ "record_id": "<Airtable Bookings rec…>" }` |

**Node sequence (hosted export):**

```
Webhook
  → Get Cancelled Booking          (Airtable: read Bookings by record_id)
  → Code - Prepare Booking Beds    (expand fields['Booking Beds'] linked IDs)
  → Delete Booking Beds Assignments (Airtable: deleteRecord per Booking Bed)
  → Update Cancelled Booking Assignment Status (Airtable: update Bookings)
```

### 1.3 Airtable tables and fields

#### Read

| Table | ID (export) | Fields used |
|-------|-------------|-------------|
| **Bookings** | `tblYWm3zKFafe4qu7` | Record `id`; **Booking ID**; **Booking Beds** (array of linked Booking Bed record IDs) |

#### Write

| Table | Operation | Fields set |
|-------|-----------|------------|
| **Booking Beds** | **deleteRecord** (one per linked id) | — (row removed) |
| **Bookings** | **update** | **Assignment Status** = `Needs Review`; **Availability Check Status** = `Needs Review` |

#### Not written by this workflow

| Area | Notes |
|------|--------|
| **Bookings.Status** | Already **Cancelled** before automation fires |
| **Payment Status**, deposit/money fields | Untouched |
| **Check In / Out**, guest fields | Untouched |
| **Conversations / Messages** | Untouched |
| **Guests** | Untouched |
| **Rooms / Beds** inventory | Untouched (static inventory) |
| **Google Sheets** | Untouched by this workflow |

**Planning sheet:** **Sync Planning Sheet** (separate scheduled workflow) repaints from active Booking Beds. When beds are deleted and booking is Cancelled, planning cells clear on the next sync — regression §5.2. Cancel workflow does **not** call Sheets APIs.

### 1.4 Behaviour summary

| Question | Answer |
|----------|--------|
| Deletes **Booking Beds** rows? | **Yes** (hard delete in Airtable) |
| Updates **Booking** status to Cancelled? | **No** (precondition) |
| Releases beds for availability? | **Yes** — removing `booking_beds` rows frees inventory in AT; Postgres must mirror for PG-based availability |
| Sets **Assignment Status**? | **Yes** → **Needs Review** (not `Unassigned`) |
| Touches payments? | **No** |
| Touches conversations? | **No** |

### 1.5 Postgres today (local)

- `booking_beds` may exist for cancelled bookings if Status was set in Airtable but PG was never updated (drift).  
- **3b.0** `npm run db:report:bed-drift` detects per-booking bed key/count mismatches and overlaps.  
- No local Cancel script or n8n fork exists yet.

---

## 2. Desired Phase 3b.1 goal

### 2.1 Phased intent

| Phase | Scope | Staff / hosted impact |
|-------|--------|------------------------|
| **3b.1a** | Read-only **cancel impact report** (PG + optional compare to CSV export) | None |
| **3b.1b** | **Postgres-only** cancel script (`--dry-run` default) | None |
| **3b.1c** | Local n8n fork: PG delete → AT delete → AT/PG assignment fields | **None** until local webhook URL used; hosted unchanged |

### 2.2 What Postgres should do when a booking is cancelled (inventory slice)

For a resolved `bookings.id` (via `booking_code` and/or `airtable_record_id`):

1. **DELETE** all `booking_beds` rows where `booking_id = ?` (and `client_id = wolfhouse-somo`).  
2. **UPDATE** `bookings` set `assignment_status = 'needs_review'`, `availability_check_status = 'needs_review'`.  
3. **Do not** change `bookings.status` if already `cancelled` (script may **refuse** or **no-op** if status is not cancelled unless `--force` for local test harness only).  
4. **Do not** change `payment_status`, money columns, or any `payments` / `payment_events` rows.  
5. **Do not** DELETE the `bookings` row (would CASCADE-delete `payments` — see §3).

### 2.3 Source of truth during 3b.1

| Concern | Source of truth (3b.1) |
|---------|-------------------------|
| **Whether booking is cancelled** | **Airtable** (automation trigger) + mirrored `bookings.status` in PG when synced |
| **Bed assignment rows** | **Dual-write target:** PG delete first, then AT delete (3b.1c) |
| **Payment state** | **Postgres `payments` + Stripe** (Phase 2) — Cancel must not alter |
| **Staff Sheets UI** | **Unchanged** — still driven by AT until Phase 4 |
| **Planning display (3a report)** | **Postgres read-only** — should show fewer rows after PG cancel |

---

## 3. Data changes needed

### 3.1 `bookings`

| Column | On Cancel (3b.1) | Notes |
|--------|------------------|--------|
| `status` | **No change** in bed-cancel workflow | Set to `cancelled` **before** webhook (AT automation / staff / Manual Entries) |
| `payment_status` | **No change** | Mirror-only elsewhere; never “refund” via Cancel |
| `assignment_status` | **`needs_review`** | Maps AT **Assignment Status** = `Needs Review` |
| `availability_check_status` | **`needs_review`** | Maps AT **Availability Check Status** = `Needs Review` |
| `check_in`, `check_out`, guest fields | **No change** | Historical record |
| `metadata` | Optional audit | e.g. `{ "beds_cancelled_at": "ISO", "beds_cancelled_by": "local-script" }` without migration |

**Enum mapping (existing):** AT `Needs Review` → PG `needs_review`; AT `Cancelled` → PG `cancelled`.

### 3.2 `booking_beds`

| Behaviour | Detail |
|-----------|--------|
| **Operation** | **Hard DELETE** (match Airtable `deleteRecord`) |
| **Scope** | `WHERE booking_id = $booking_id AND client_id = $client_id` |
| **No soft-delete column** | Not in schema today; do not add in 3b.1 |
| **`airtable_record_id`** | Deleted with row; AT delete uses stored id on retry |

**Natural key** (for audit, not unique index yet):  
`(client_id, booking_id, bed_id, assignment_start_date, assignment_end_date)` — see 3b.0 drift report.

### 3.3 Timestamps

| Field | Proposal |
|-------|----------|
| `bookings.updated_at` | Auto via trigger on UPDATE |
| `cancelled_at` on `bookings` | **Not required for 3b.1** — no migration; use `metadata` if audit needed |
| `booking_beds` | Rows removed — no tombstone |

### 3.4 Payments — must remain untouched

| Rule | Rationale |
|------|-----------|
| **No UPDATE** to `payments` / `payment_events` in Cancel path | Phase 2 freeze; refunds are operational, not inventory |
| **No DELETE** from `bookings` | `payments.booking_id` → `ON DELETE CASCADE` would destroy payment history |
| **No change** to `bookings.payment_status` in Cancel workflow | Hosted Cancel workflow does not touch it today |

Paid bookings may still be **Cancelled** in AT (staff); beds must release; **payment rows stay** for reconciliation.

### 3.5 Related tables (no 3b.1 writes)

| Table | Action |
|-------|--------|
| `conversations`, `messages` | None |
| `rooms`, `beds` | None |
| `guests` | None |
| `manual_entries` (PG if present) | None in 3b.1 |

---

## 4. Idempotency

### 4.1 Cancel runs twice (same booking)

| System | Second run behaviour |
|--------|----------------------|
| **Postgres** | `DELETE … WHERE booking_id` → **0 rows**; UPDATE assignment fields → idempotent same values |
| **Airtable** | Code returns `no_booking_beds_found` when **Booking Beds** empty; delete loop no-ops; update still sets Needs Review |
| **Webhook** | Safe to replay; must not error on empty bed list |

### 4.2 Avoid deleting wrong bed rows

| Guard | Implementation |
|-------|----------------|
| **Scope by booking** | Never delete by `bed_id` alone; always `booking_id` (+ `client_id`) |
| **Resolve booking once** | Lookup by `airtable_record_id` OR `booking_code`; fail if ambiguous/zero rows |
| **Do not use guest phone** | Wrong booking risk on shared phones |
| **AT deletes** | Use `booking_beds.airtable_record_id` from PG when mirroring; fallback to AT **Booking Beds** link list from Get Booking |
| **Reassign vs Cancel** | Reassign deletes beds then sets **Unassigned/Assigning**; Cancel sets **needs_review** — different workflow; do not call Reassign webhook for cancel |

### 4.3 Natural keys and `booking_id` strategy

| Key | Use in 3b.1 |
|-----|-------------|
| **`bookings.id` (UUID)** | Primary scope for PG DELETE |
| **`bookings.booking_code`** (`WH-rec…`) | CLI/report input; UNIQUE per client |
| **`bookings.airtable_record_id`** | Webhook payload `record_id`; backfilled in 3.0b |
| **`booking_beds` natural key** | Audit/drift only in 3b.1; unique index deferred to 3b.2 |

**Order of operations (3b.1c dual-write):**  
1) DELETE PG `booking_beds` → 2) DELETE AT Booking Beds (by `airtable_record_id` list) → 3) UPDATE AT + PG `assignment_status` / `availability_check_status`.

If AT delete fails after PG delete: log to `automation_errors` (future), PG ahead of AT — detect via `db:report:bed-drift`.

---

## 5. Rollback

### 5.1 Return to Airtable-only Cancel

1. Stop using local n8n fork / local cancel script URLs.  
2. Re-import or disable PG nodes in any local fork (`DATA_SOURCE=airtable` pattern from Phase 3b parent doc).  
3. Hosted **`cancel-booking-beds`** + Airtable automation unchanged — production path unchanged.  
4. Postgres drift: run `npm run db:sync` from CSV (**local only**) to rebuild `booking_beds` from export if PG was cleared incorrectly.

### 5.2 Postgres rows that must never be deleted by Cancel

| Data | Rule |
|------|------|
| **`payments`, `payment_events`** | No DELETE/UPDATE in Cancel |
| **`bookings` row** | No DELETE (CASCADE risk) |
| **`rooms`, `beds`** | Inventory seed data |
| **`conversations`, `messages`** | Phase 2 WhatsApp history |

### 5.3 Recover from partial cancel

| Failure mode | Recovery |
|--------------|----------|
| **PG deleted, AT beds remain** | Re-run AT delete via hosted or local fork; drift report shows keys only in CSV |
| **AT deleted, PG beds remain** | Re-run PG cancel script or `DELETE` by `booking_id`; drift report shows keys only in PG |
| **Assignment status out of sync** | UPDATE PG to match AT (`needs_review`) or re-run full cancel idempotently |
| **Wrong booking cancelled** | **No auto-undo** — restore from AT backup / re-create beds via Manual Entries or Assign (3b.2); document incident |

---

## 6. Test plan

### 6.1 Local fixture booking

Use a **local test booking** with known beds (create via Phase 2 flow or `db:sync` from CSV export row):

- Has `booking_code` `WH-rec…` with `airtable_record_id` backfilled  
- Has **≥1** `booking_beds` row in Postgres  
- For full E2E (3b.1c): same booking exists in **local/test Airtable** or dry-run AT credentials  

**Suggested checks:** Tier B/C reference bookings only if reproducing cancel is safe; prefer a dedicated `WH-rec…` test row.

### 6.2 Procedure

| Step | Action | Expected |
|------|--------|----------|
| T0 | `npm run db:report:bed-drift` | Baseline JSON; note `per_booking_bed_counts` for fixture |
| T0 | `npm run planning:report:postgres` | Fixture beds appear in CSV rows |
| T0 | `npm run db:report:drift` | `missing_airtable_record_id=0` for scoped `WH-rec*` |
| T1 | Set booking **Cancelled** in AT (or simulate webhook payload) | Status cancelled before bed workflow |
| T2 | **Cancel once** (script or local webhook) | PG: 0 `booking_beds`; `assignment_status=needs_review`; AT: 0 beds |
| T3 | **Cancel again** | No errors; still 0 beds; idempotent |
| T4 | `npm run db:report:bed-drift` | No actionable key mismatch for fixture; overlap none for freed beds |
| T5 | `npm run planning:report:postgres` | Fixture bed rows gone (cancelled bookings excluded by 3a filters) |
| T6 | Phase 2 regression | All green (below) |

### 6.3 Phase 2 / 3 regression (must still pass)

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run test:phase2f-resolver
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run test:planning-row-format
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run test:bed-drift-keys
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:drift
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:bed-drift
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run planning:report:postgres
```

| Suite | Why |
|-------|-----|
| `test:phase2f-resolver` | Main routing unchanged |
| `test:planning-row-format` | 3a columns unchanged |
| `test:bed-drift-keys` / `db:report:bed-drift` | Bed parity tooling still valid |
| `db:report:drift` | ID linkage not regressed |
| `planning:report:postgres` | Read path still works |

**Pass criteria (3b.1):** Regression §3.1 — *Cancel booking with beds → beds removed; assignment needs review* — satisfied in **both** PG and AT for test booking.

---

## 7. Recommended first implementation step

**Do not start with n8n dual-write.**

### 7.1 Step A — Read-only cancel impact report (preferred first)

| Item | Detail |
|------|--------|
| **Script (proposed)** | `scripts/report-cancel-impact.js` |
| **npm script** | `db:report:cancel-impact -- --booking-code=WH-rec…` |
| **Reads** | `bookings`, `booking_beds`, optional CSV export row |
| **Writes** | None |
| **Output** | `reports/cancel-impact-<timestamp>.json` — lists PG rows that **would** be deleted, fields that **would** be updated, payment rows (read-only warning), AT link ids if present |

Validates resolution and scope before any DELETE.

### 7.2 Step B — Postgres-only cancel script

| Item | Detail |
|------|--------|
| **Script (proposed)** | `scripts/cancel-booking-beds-postgres.js` |
| **Flags** | `--dry-run` (default), `--booking-code=`, `--apply` |
| **Writes** | PG only: DELETE `booking_beds`; UPDATE `bookings` assignment fields |
| **Guards** | Refuse if `status` not `cancelled` unless `--allow-uncancelled-status` (local test only) |

Run T0–T5 in §6 using this script before touching n8n.

### 7.3 Step C — Local n8n fork (after A + B pass)

| Item | Detail |
|------|--------|
| **Build (proposed)** | `scripts/build-cancel-beds-local.js` → `n8n/phase3b/Cancel Bed Assignments (local PG).json` |
| **Pattern** | Postgres nodes before existing AT delete/update; hosted export untouched |
| **Webhook** | Local `http://localhost:5678/webhook/cancel-booking-beds` — **do not** register on Cloud |

### 7.4 Documentation / regression

- Update [`PHASE-3b-0.md`](PHASE-3b-0.md) cross-link when 3b.1a ships.  
- Add **Phase 3b.1** section to [`regression-test-plan.md`](regression-test-plan.md) after implementation (not in this proposal commit).

---

## 8. Approval checklist (before any 3b.1 code)

- [ ] Owner approves **Postgres DELETE** scope (`booking_beds` only)  
- [ ] Owner approves **assignment_status → needs_review** (matches hosted AT, not `unassigned`)  
- [ ] Test Airtable base / credentials for local AT delete mirror (3b.1c)  
- [ ] Confirm **no payment column** changes in Cancel PR  
- [ ] Confirm **Assign / Reassign** remain out of scope  

---

## References

| Doc / file | Content |
|------------|---------|
| `n8n/Wolfhouse - Cancel Bed Assignments.json` | Hosted export (read-only) |
| `docs/airtable-automations.md` | Automation trigger conditions |
| `docs/webhook-map.md` | Webhook path and payload |
| `docs/airtable-field-usage.md` | Field ↔ Postgres mapping |
| `docs/PHASE-3b-PROPOSAL.md` | Parent 3b scope and dual-write order |
| `docs/PHASE-3b-0.md` | Bed drift audit (prerequisite) |
| `database/migrations/001_init.sql` | `bookings`, `booking_beds`, `payments` FK behaviour |
