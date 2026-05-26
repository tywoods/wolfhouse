# Phase 3b.4b — Postgres-only Manual Entry mirror (proposal)

**Status:** Proposal only — **no implementation**, migrations, workflow edits, hosted export edits, Airtable/Sheets API calls, or production changes.  
**Prerequisites:** Phase **3b.4a** (`41d2547` — manual entry impact report).  
**Parents:** [`PHASE-3b-4-PROPOSAL.md`](PHASE-3b-4-PROPOSAL.md), [`PHASE-3b-4a.md`](PHASE-3b-4a.md), [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md)

**Explicitly out of scope for 3b.4b:**

- **3b.4c** local n8n fork (`build-manual-entries-local.js`, `n8n/phase3b/…`)  
- Hosted **`n8n/Wolfhouse - Manual Entries Queue Processor.json`** — read-only reference  
- **Airtable** API (no create/update/delete of Bookings or Booking Beds)  
- **Google Sheets** read/write (no Apps Script, no sync columns P–R)  
- **`payments`**, **`payment_events`**, Stripe / Main / Send Confirmation  
- **`conversations`**, **`messages`**  
- **`database/migrations/*`** (unless a later approved substep adds only an index already listed in 3b.4 parent)  
- **3b.5** Operator Room Release  
- **Phase 3c** / Main Postgres integration  

---

## Executive summary

3b.4b adds a **local CLI script** that mirrors a **Manual Entries** queue row into **Postgres only**: create booking + manual bed assignments, update booking metadata, or delete beds + cancel booking — matching the **inventory and status effect** described in [`PHASE-3b-4-PROPOSAL.md`](PHASE-3b-4-PROPOSAL.md) §2–3 and validated by [`db:report:manual-entry-impact`](PHASE-3b-4a.md) (3b.4a).

**Airtable and Google Sheets remain the staff operational source of truth** during local development. This script does not call them. Staff (or a later 3b.4c fork) still create/update AT rows; 3b.4b lets planning, drift, and bed-ops tooling see the same state in PG without waiting for a full CSV `db:sync`.

**Dry-run is the default.** Mutations require **`--execute`**. Run **`db:report:manual-entry-impact`** before every first execute on a new `MAN-…` row or booking.

---

## 1. Script goal

| Objective | Detail |
|-----------|--------|
| **Mirror manual entry into Postgres** | One queue row → one CLI invocation (`create` / `update` / `delete`) |
| **Create** | INSERT `bookings` if missing; INSERT `booking_beds` for each validated bed; set `assignment_status` / `availability_check_status` |
| **Update** | UPDATE `bookings` fields from CLI/sheet snapshot **only** (MVP: no bed add/remove/reassign) |
| **Delete** | DELETE all `booking_beds` for booking; UPDATE `bookings.status = cancelled` (mirror hosted Manual Entries delete path) |
| **Manual bed assignment** | Beds from `--beds` (not Choose Beds / Assign webhook); `assignment_type` = **Manual Staff** (or enum-safe equivalent used elsewhere in PG) |
| **Booking source** | `booking_source = manual_staff` on create |
| **Preserve payment tables** | **No** INSERT/UPDATE/DELETE on `payments` or `payment_events` |
| **Booking-level payment mirror (optional, explicit)** | **May** set `bookings.payment_status` from sheet/CLI on create/update — same field AT already mirrors from sheet; **not** Stripe `payments` rows |
| **Preserve booking row on delete** | **Never** `DELETE FROM bookings` |
| **Local only** | No webhook, no hosted URL, no sheet sync columns |
| **Reuse 3b.4a plan** | Share parse/validate/overlap logic with [`scripts/lib/manual-entry-impact-plan.js`](../scripts/lib/manual-entry-impact-plan.js) |

### Alignment with hosted Manual Entries Processor

Hosted export `n8n/Wolfhouse - Manual Entries Queue Processor.json` (read-only):

| Action | Hosted (AT + sheet) | 3b.4b (PG only) |
|--------|---------------------|-----------------|
| **create** | Create AT Booking + Booking Beds; sheet Synced | INSERT PG booking + beds; optional provisional `booking_code` until AT id known |
| **update** | Update AT Booking fields | UPDATE PG booking fields only |
| **delete** | Delete AT beds; cancel AT booking | DELETE PG beds; `status = cancelled` |

3b.4b does **not** replace hosted processing; it is the **Postgres mirror CLI** that 3b.4c will call before/after AT in a transaction-like sequence.

### Relationship to 3b.4a

| Tool | Role |
|------|------|
| [`report-manual-entry-impact.js`](../scripts/report-manual-entry-impact.js) | **Before** execute: read-only plan + `reports/manual-entry-impact-*.json` |
| **`manual-entry-postgres.js`** (proposed) | **Execute** the plan when `--execute` |

**Recommendation:** Extract shared “plan” from `manual-entry-impact-plan.js` into `scripts/lib/manual-entry-plan.js` (or extend the impact module with `buildExecutePlan`) so 3b.4a and 3b.4b cannot drift.

---

## 2. Command design

### Proposed script and npm entry

| Item | Value |
|------|--------|
| **Script** | `scripts/manual-entry-postgres.js` |
| **npm** | `db:manual-entry:postgres` |

*(Alternate name `sync-manual-entry-postgres.js` / `db:sync:manual-entry` rejected for clarity: this is action-oriented, not full CSV sync.)*

### Invocation

```powershell
# Default: dry-run (no mutations) — same flags as impact report
npm run db:manual-entry:postgres -- --action=create --manual-entry-id=MAN-20260526-0001 `
  --guest-name="Guest Name" --check-in=2026-06-05 --check-out=2026-06-10 `
  --guest-count=2 --beds=R1-B1,R1-B2

# Apply mutations
npm run db:manual-entry:postgres -- --action=create --manual-entry-id=MAN-... `
  --guest-name="Guest" --check-in=2026-06-05 --check-out=2026-06-10 --guest-count=2 `
  --beds=R1-B1,R1-B2 --execute

# Update (booking must exist in PG)
npm run db:manual-entry:postgres -- --action=update --manual-entry-id=MAN-... `
  --airtable-record-id=recBtWzIvmjQ5mmo0 --guest-name="Updated" --check-out=2026-06-11 --execute

# Delete
npm run db:manual-entry:postgres -- --action=delete --manual-entry-id=MAN-... `
  --airtable-record-id=recBtWzIvmjQ5mmo0 --execute

# Queue snapshot from n8n pick-node
npm run db:manual-entry:postgres -- --json-file=./fixtures/manual-entry-row.json --execute
```

Docker tools:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools `
  npm run db:manual-entry:postgres -- --action=create --manual-entry-id=MAN-test ... --execute
```

### Flags (proposed)

| Flag | Default | Description |
|------|---------|-------------|
| `--action=create\|update\|delete` | — | **Required** (or derive via `--sync-status`) |
| `--manual-entry-id=MAN-…` | — | **Required** business key for audit/idempotency notes |
| `--guest-name=…` | — | **Required** on create |
| `--check-in=YYYY-MM-DD` | — | **Required** on create |
| `--check-out=YYYY-MM-DD` | — | **Required** on create |
| `--guest-count=N` | `1` on create | Guest count |
| `--beds=R1-B1,R1-B2` | — | **Required** on create |
| `--status=Confirmed` | `confirmed` | Maps to `bookings.status` enum |
| `--payment-status=waiting_payment` | sheet default | Maps to `bookings.payment_status` only |
| `--package=malibu` | `malibu` | `bookings.package_code` |
| `--phone` / `--email` / `--notes` | — | Optional booking fields / `staff_notes` |
| `--deposit-paid=N` | — | Optional `deposit_paid_cents` if aligned with sync conventions |
| `--booking-code=WH-rec…` | — | Lookup or set final code (create backfill) |
| `--airtable-record-id=rec…` | — | Lookup (update/delete) or backfill after AT create |
| `--sync-status=ready` | — | Derive `action` if `--action` omitted |
| `--client=wolfhouse-somo` | `wolfhouse-somo` | Client slug |
| `--json-file=path.json` | — | Full queue item blob (same as 3b.4a) |
| `--dry-run` | **on** (implicit) | Print plan; no mutations |
| `--execute` | off | Run mutations in a single transaction |
| `--strict-guest-count` | off | Refuse `--execute` if bed count ≠ `guest_count` on create |
| `--strict-overlap` | **on for execute** | Refuse `--execute` on PG overlap (default true) |
| `--allow-conflict` | off | On overlap: insert beds but set `needs_review` / `conflict` |
| `--backfill-booking-code=WH-rec…` | — | Replace provisional `WH-pending-MAN-…` after AT automation |
| `--json-log` | off | Write `reports/manual-entry-execute-<MAN>-<timestamp>.json` |

**Design choice:** Same as 3b.1b / 3b.2b — absence of `--execute` = dry-run.

### Exit codes (proposed)

| Code | Meaning |
|------|---------|
| 0 | Success (dry-run or execute; idempotent no-op counts as success) |
| 1 | Missing args, booking not found, ambiguous lookup, client not found |
| 2 | Actionable gate failed (unknown beds, overlaps, strict guest count, invalid dates) — no transaction committed |

### Create: `booking_code` strategy (PG-only local)

| Case | Proposed behavior |
|------|-------------------|
| `--booking-code=WH-rec…` provided | Use as `bookings.booking_code`; upsert by `(client_id, booking_code)` |
| `--airtable-record-id=rec…` only | Upsert by `airtable_record_id`; `booking_code` from `--booking-code` or provisional until backfill |
| Neither (PG-first test) | `booking_code = WH-pending-<manual_entry_id>`; document that `db:sync` / `--backfill-booking-code` fixes drift vs AT |

---

## 3. Exact DB mutations if executed

All mutations run inside **one transaction** per invocation. Roll back on any error.

### Tables written

| Table | create | update | delete |
|-------|--------|--------|--------|
| `bookings` | INSERT or UPDATE (upsert) | UPDATE | UPDATE (`status`) |
| `booking_beds` | INSERT (skip existing natural keys) | **none** (MVP) | DELETE (all for booking) |
| `manual_entries` | optional UPSERT | optional UPSERT | optional UPSERT |
| `payments` | **never** | **never** | **never** |
| `payment_events` | **never** | **never** | **never** |

### Create (`--execute`)

1. **Resolve client** — `SELECT id FROM clients WHERE slug = $1`.
2. **Booking upsert**
   - If row exists (`booking_code` and/or `airtable_record_id`): **UPDATE** mutable fields (guest_name, dates, guest_count, status, payment_status, package_code, phone, email, staff_notes append with `Manual Entry ID: MAN-…`).
   - Else: **INSERT** `bookings` with:
     - `booking_source = manual_staff`
     - `status` from `--status` (default `confirmed`)
     - `payment_status` from `--payment-status` (default `waiting_payment`)
     - `assignment_status = assigned`, `availability_check_status = available` (unless overlap gate → `needs_review` / `conflict`)
     - `check_in`, `check_out`, `guest_count`
     - `metadata` JSONB: `{ "manual_entry_id": "MAN-…" }` for traceability
3. **Bed inserts** (per `--beds` code, dates = check_in/check_out):
   - Resolve `bed_id` from `beds.bed_code`.
   - Skip if natural key `(booking_code, bed_code, start, end)` already exists for this booking.
   - **INSERT** `booking_beds` with `assignment_type` = Manual Staff (label consistent with CSV/sync), `room_code` denormalized, `guest_name` copied.
4. **Post-insert booking UPDATE** (if any beds inserted or conflict policy applied):
   - Success path: `assignment_status = assigned`, `availability_check_status = available`
   - `--allow-conflict` with overlaps: `needs_review`, `conflict`
5. **Optional `manual_entries`** — UPSERT `(client_id, manual_entry_code)` with `action=create`, `sync_status=synced`, `booking_id` FK, `synced_at=now()` (deferred if scope trimmed).

**Not done on create:** INSERT into `payments`; Stripe fields; `guests` row (optional later).

### Update (`--execute`)

1. **Resolve booking** — require `--booking-code` or `--airtable-record-id`; fail if not found or ambiguous.
2. **UPDATE `bookings`** only for fields present on CLI that differ from current row (same set as 3b.4a `update_phase.booking_fields_would_update`).
3. **No `booking_beds` INSERT/DELETE/UPDATE** in MVP.
4. If `--beds` passed: **no-op** with console warning `bed_changes_not_applied_in_3b4b_mvp` (document; chain 3b.3b reassign in future).

**Not done on update:** `payment_status` change only if explicitly passed and differs (mirror sheet); never touch `payments` table.

### Delete (`--execute`)

Mirror hosted Manual Entries **delete** path (not Cancel Bed Assignments alone):

1. **Resolve booking** — require `--booking-code` or `--airtable-record-id`.
2. **DELETE** all `booking_beds` WHERE `client_id` AND `booking_id`.
3. **UPDATE `bookings`**
   - `status = cancelled`
   - `payment_status` — **unchanged** (hosted cancel node typically leaves payment status; match live AT if verified)
   - `assignment_status` / `availability_check_status` — set to `needs_review` or leave as-is per [`PHASE-3b-4a`](PHASE-3b-4a.md) delete impact; **proposal:** `needs_review` after bed removal for planning consistency with cancel-bed PG tooling
4. **Never** `DELETE FROM bookings`.

### Dry-run (`--execute` omitted)

- Run identical validation and plan as 3b.4a.
- Print summary: would-insert booking?, would-insert N beds, would-update fields, would-delete N beds.
- No SQL mutations.

---

## 4. Safety checks

| Check | When | On failure |
|-------|------|------------|
| **Required fields** | All actions | Exit **1** (missing `manual_entry_id`, `action`; create missing guest/dates/beds; update/delete missing booking lookup) |
| **Valid date range** | create / update with dates | Exit **2** if `check_out <= check_in` |
| **Known bed codes** | create | Exit **2** if any code ∉ `beds` for client |
| **Overlap conflicts** | create (`--strict-overlap` default) | Exit **2** unless `--allow-conflict` |
| **Guest count match** | create | Warning; exit **2** if `--strict-guest-count` and beds ≠ `guest_count` |
| **Duplicate `manual_entry_id`** | create | If `metadata->manual_entry_id` or `manual_entries` row already linked to a **different** booking → exit **2** `duplicate_manual_entry_id` |
| **Existing booking detection** | create with `--airtable-record-id` | Upsert path; warn if bed natural keys already exist (skip insert) |
| **Booking not found** | update / delete | Exit **1** |
| **Ambiguous lookup** | any | Exit **1** if >1 booking row |
| **Cancelled booking** | create beds | Warn; optional refuse execute unless `--force` (proposal: refuse insert on `cancelled`/`expired`) |
| **Payments tables** | always | Hard guard: no SQL touching `payments` / `payment_events` |

**Pre-flight:** Caller should run `npm run db:report:manual-entry-impact -- …` and confirm exit 0 before first `--execute`.

---

## 5. Idempotency

### Natural keys

| Entity | Key | Behavior on repeat |
|--------|-----|-------------------|
| `bookings` | `(client_id, booking_code)` UNIQUE | Second create with same code → **UPDATE** backfill fields, no second row |
| `bookings` | `airtable_record_id` UNIQUE | Upsert when `rec…` known |
| `booking_beds` | Logical: `(booking_code, bed_code, assignment_start_date, assignment_end_date)` | **Skip INSERT** if row exists (same as 3b.2b) |
| `manual_entries` | `(client_id, manual_entry_code)` UNIQUE | UPSERT sync metadata |

### By action

| Action | Repeated `--execute` | Expected result |
|--------|-------------------|-----------------|
| **create** | Same `MAN-…` + same beds | 0 new beds; booking upsert idempotent; exit **0** |
| **create** | Same `MAN-…` + different beds | **Do not** silently add beds if MVP forbids; exit **2** or require explicit `--append-beds` (proposal: **reject** — staff must use update+reassign future) |
| **update** | Same field values | 0 column changes; exit **0** |
| **delete** | Second run | 0 beds deleted; status already `cancelled`; exit **0** |

### Duplicate manual entry

| Signal | Policy |
|--------|--------|
| `manual_entry_id` in `bookings.metadata` | If create targets new provisional code but metadata links existing booking → fail |
| `manual_entries.booking_id` | Optional table enforces one MAN → one booking |
| Sheet already `Synced` | Out of scope for 3b.4b (no sheet read); operator discipline |

### Transaction boundary

- Single `BEGIN` … `COMMIT` per `--execute`.
- Partial failure → full rollback (no half-inserted beds without booking).

---

## 6. Rollback

| Scenario | Action |
|----------|--------|
| **Restore PG from CSV baseline** | `npm run db:sync` (Airtable/CSV remain source for inventory export) |
| **Remove beds for one test booking** | `npm run db:cancel:booking-beds -- --booking-code=WH-rec… --execute` (does not set `cancelled`; use after mistaken create) |
| **Full manual delete mirror undo** | Re-run not possible; use `db:sync` or manual DELETE beds + UPDATE status via documented SQL in runbook |
| **Provisional booking code cleanup** | DELETE beds + DELETE booking row only if **no** `payments` rows FK (verify `SELECT` first); prefer `db:sync` |
| **Deactivate mistake** | No n8n fork in 3b.4b |
| **Payment rollback** | **Never** via 3b.4b tooling |

**Targeted SQL (local dev only, documented in `PHASE-3b-4b.md` when implemented):**

```sql
-- Example: remove provisional booking created for MAN-test (only if no payments)
-- DELETE FROM booking_beds WHERE booking_id = $id;
-- DELETE FROM bookings WHERE id = $id AND booking_code LIKE 'WH-pending-%';
```

---

## 7. Test plan

**Environment:** Local Postgres via Docker tools; **no** Airtable/Sheets. Pause **Assign Beds When Unassigned** only if running parallel AT automations (not required for PG-only 3b.4b).

| # | Scenario | Command sketch | Pass |
|---|----------|----------------|------|
| T1 | Baseline | `npm run db:sync` | exit 0 |
| T2 | Impact before execute | `db:report:manual-entry-impact` same flags | matches execute plan |
| T3 | **Clean create** | create, free beds, `--execute` | exit 0; PG booking + N beds |
| T4 | **Repeat create** | same `MAN-…` + `--execute` | exit 0; 0 duplicate natural keys |
| T5 | **Create overlap** | occupied bed/dates (e.g. R8-B1 2026-08-07–12) | exit 2; no mutation without `--allow-conflict` |
| T6 | **Unknown bed** | `R99-B1` | exit 2 |
| T7 | **Guest-count mismatch** | `--strict-guest-count` | exit 2 |
| T8 | **Update existing** | `recBtWzIvmjQ5mmo0` + new dates/name | exit 0; beds unchanged |
| T9 | **Delete existing** | `recBtWzIvmjQ5mmo0` | exit 0; 0 beds; `status=cancelled` |
| T10 | **Repeat delete** | second `--execute` | exit 0; idempotent |
| T11 | **Invalid dates** | `check-out <= check-in` | exit 2 |
| T12 | `db:report:bed-drift` | after T3–T9 on test data | exit 0 or documented exceptions |
| T13 | `planning:report:postgres` | | rows reflect manual beds |
| T14 | `test:phase2f-resolver` | | 10/10 |
| T15 | **Restore** | `db:sync` after test bookings | baseline restored |

**Suggested test booking:** `recBtWzIvmjQ5mmo0` / `WH-recBtWzIvmjQ5mmo0` (update/delete); overlap pair from 3b.3a (`R8-B1`, Aug 7–12).

---

## 8. Files if approved (implementation — not started)

| Action | Path |
|--------|------|
| **Create** | `scripts/manual-entry-postgres.js` |
| **Create** | `scripts/lib/manual-entry-pg-sql.js` (INSERT/UPDATE/DELETE statements) |
| **Create** | `docs/PHASE-3b-4b.md` (runbook: dry-run, execute, rollback, payment policy) |
| **Modify** | `scripts/lib/manual-entry-impact-plan.js` or **Create** `scripts/lib/manual-entry-plan.js` (shared plan for 3b.4a + 3b.4b) |
| **Modify** | `package.json` — `"db:manual-entry:postgres": "node scripts/manual-entry-postgres.js"` |
| **Modify** | `docs/regression-test-plan.md` — § Phase 3b.4b |

**Reuse (no fork):**

| Path | Use |
|------|-----|
| [`scripts/lib/manual-entry-impact-plan.js`](../scripts/lib/manual-entry-impact-plan.js) | Parse flags, validate, overlap, guest count |
| [`scripts/lib/assign-booking-beds-plan.js`](../scripts/lib/assign-booking-beds-plan.js) | Bed inventory, overlap query, natural key |
| [`scripts/lib/bed-drift-keys.js`](../scripts/lib/bed-drift-keys.js) | `assignmentNaturalKey`, date helpers |
| [`scripts/lib/pg-connect.js`](../scripts/lib/pg-connect.js) | `withPgClient` transactions |
| [`scripts/cancel-booking-beds-postgres.js`](../scripts/cancel-booking-beds-postgres.js) | Pattern for dry-run / `--execute` / exit codes |
| [`scripts/assign-booking-beds-postgres.js`](../scripts/assign-booking-beds-postgres.js) | Bed INSERT + assignment_status UPDATE pattern |

**Must not create/modify in 3b.4b:**

- `n8n/phase3b/*`, hosted `n8n/Wolfhouse - Manual Entries*.json`
- `apps-script/*`, Airtable scripts
- `database/migrations/*`
- Payment/Stripe/Main workflows

---

## Approval checklist (for user)

- [ ] PG-only scope acceptable (no AT/Sheets in 3b.4b)  
- [ ] Provisional `WH-pending-MAN-…` booking codes acceptable for PG-first tests  
- [ ] Update MVP: booking fields only; bed changes deferred to 3b.4+ / reassign  
- [ ] Delete sets `cancelled` + deletes all beds (hosted manual delete semantics)  
- [ ] `bookings.payment_status` mirror from CLI allowed; `payments` table never touched  
- [ ] Optional `manual_entries` UPSERT in scope or deferred  

**Next step after approval:** implement 3b.4b only; then propose 3b.4c n8n fork separately.
