# Phase 3b.3 — Local Reassign workflow fork (PG + Airtable) (proposal)

**Status:** Proposal only — **no implementation**, workflow JSON edits, hosted import, or production Airtable changes.  
**Prerequisites:** Phase **3b.1c** (`9556297`+), **3b.2c** (`1085e56`) — proven Cancel and Assign local forks + CLI mirrors.  
**Parents:** [`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md), [`PHASE-3b-2c-PROPOSAL.md`](PHASE-3b-2c-PROPOSAL.md), [`PHASE-3b-1c-PROPOSAL.md`](PHASE-3b-1c-PROPOSAL.md), [`PHASE-3b-2c.md`](PHASE-3b-2c.md)

**Explicitly out of scope for 3b.3:**

- Import or activation on **hosted** n8n Cloud (`tywoods.app.n8n.cloud`)  
- Editing **`n8n/Wolfhouse - Reassign Bed Assignments.json`** (hosted export — read-only input)  
- Editing **`n8n/Wolfhouse - Bed Assignment.json`** or hosted Assign on Cloud  
- **Production** Airtable base unless using a dedicated **test** base + PAT  
- **Google Sheets**  
- **`payments`**, **`payment_events`**, **`bookings.payment_status`**, Stripe / Main / Send Confirmation  
- **`bookings` row DELETE**  
- Pointing **production** Main or staff automations at local webhooks  
- **Manual Entries Queue** / **Operator Room Release** (3b.4 / 3b.5)  

---

## Executive summary

Hosted **Reassign** is a **reset** workflow: delete existing **Booking Beds** in Airtable, set the booking to **Unassigned** / **Not Checked**, then rely on a **separate Assign run** (Airtable automation or staff) to pick new beds via **Code - Choose Beds**. It does **not** embed Choose Beds or create new bed rows itself.

Phase **3b.3** adds a **local-only** n8n fork that:

1. Accepts the same webhook as hosted Reassign (`POST reassign-booking-beds`).  
2. **Mirrors the reset in Postgres** (delete all `booking_beds` for the booking; align booking assignment fields with the reassign-ready state).  
3. Runs the **hosted Airtable reset nodes** unchanged (delete old AT beds → mark booking ready).  
4. **Chains the local Assign fork** (3b.2c) in the **same execution** so one webhook completes cancel → reset → choose → PG insert → AT create (local test env only).  
5. Returns structured JSON (`pg_deleted_count`, `pg_inserted_count`, `partial_failure`, etc.).

**Order:** Postgres delete first → Airtable delete/update → Assign path (PG insert before AT create), reusing proven 3b.1b / 3b.2b SQL and 3b.2c workflow segments.

Generated artifacts: **`n8n/phase3b/Wolfhouse - Reassign Bed Assignments (local PG).json`** via **`npm run build:reassign-beds:local`**. Do not hand-edit the hosted export.

---

## 1. Current hosted Reassign flow

### 1.1 Workflow and trigger

| Attribute | Value |
|-----------|--------|
| **Workflow** | Wolfhouse - Reassign Bed Assignments |
| **Export (read-only)** | `n8n/Wolfhouse - Reassign Bed Assignments.json` |
| **Webhook path** | `POST /webhook/reassign-booking-beds` |
| **Webhook ID** | `53a8b6e4-f0ee-48dd-8a26-7ed58035ed99` |
| **n8n workflow id** | `b9ZrnbRNFDG0CRof` |

**Called by:**

| Caller | Payload |
|--------|---------|
| Airtable automation **“Update bed bookings when dates change”** ([`airtable-automations.md`](airtable-automations.md) §5) | `{ "record_id": "<Bookings rec…>" }` when Check In/Out change, Status not Cancelled, Assignment Status = Assigned, Booking Beds non-empty |
| **Main** (rooming preference update) | Rich body: `booking_record_id`, `reason`, `room_preference`, `guest_gender_group_type`, `stay_together`, `rooming_notes`, `preserve_booking_status`, `send_guest_reply` ([`webhook-map.md`](webhook-map.md)) |

Main typically **updates Bookings rooming fields** in a separate Airtable node **before** calling Reassign; the Reassign workflow itself only writes **Assignment Status** and **Availability Check Status** on success (see below).

### 1.2 Webhook inputs

| Field | Required | Used by hosted workflow |
|-------|----------|-------------------------|
| `record_id` or `booking_record_id` | **Yes** (one of) | `Get Booking To Reassign` |
| `guest_count` | No | `Code - Normalize Reassignment Booking` fallback if booking Guest Count is 0 |
| `room_preference`, `guest_gender_group_type`, `rooming_notes`, `stay_together`, `reason` | No | Normalized in Code for logging/future; **not** written by Reassign update node today |
| `preserve_booking_status`, `send_guest_reply` | No | Main-only; not read in Reassign export |

**Get Booking** id expression:

```text
$json.body.booking_record_id || $json.body.record_id
```

### 1.3 Node flow (hosted)

```
Reassign Booking Beds - Webhook
  → Get Booking To Reassign
  → Code - Normalize Reassignment Booking
  → IF - Can Reassign Booking
       ├─ true  → Code - Prepare Existing Booking Beds To Cancel
       │          → Cancel Old Booking Bed          (AT delete, per bed)
       │          → Mark Booking Ready For Reassignment
       └─ false → Update record1                    (Needs Review + conflict notes)
```

**No** HTTP call to `assign-beds-to-booking` inside this workflow. **No** **Code - Choose Beds** node.

### 1.4 Does it delete old Booking Beds first?

**Yes — in Airtable only.**

| Step | Behaviour |
|------|-----------|
| **Code - Prepare Existing Booking Beds To Cancel** | Expands `fields['Booking Beds']` linked record IDs into one item per bed |
| **Cancel Old Booking Bed** | `deleteRecord` on **Booking Beds** (`tblO1ByvTMXS4SalB`) for each id |
| If no linked beds | Single item with `no_booking_beds_found: true`; delete loop is empty |

**Postgres is not touched** in the hosted workflow.

### 1.5 Does it call Assign or Choose Beds?

| Question | Answer |
|----------|--------|
| Calls **Assign** workflow directly? | **No** |
| Runs **Choose Beds**? | **No** |
| How do new beds appear? | **Indirectly:** `Mark Booking Ready For Reassignment` sets **Assignment Status = Unassigned** and **Availability Check Status = Not Checked**, which satisfies the Airtable automation **“Assign Beds When Booking Is Unassigned”** ([`airtable-automations.md`](airtable-automations.md) §3) → POST `assign-beds-to-booking` → **Wolfhouse - Bed Assignment** → **Code - Choose Beds** → create rows |

**Implication for local dual-write:** A hosted-only reassign leaves **PG `booking_beds` stale** until Assign runs (or `db:cancel` / `db:sync`). The 3b.3 fork must **delete PG beds on reassign** and **run Assign** (local fork) in the same test flow.

### 1.6 `IF - Can Reassign Booking` gate

**True** when `Code - Normalize` sets `can_reassign`:

- Booking `rec…` exists  
- **Check In** and **Check Out** present  
- **Effective guest count** > 0 (from Guest Count, else count of existing Booking Beds, else webhook `guest_count`)

**False** → **Update record1**: **Assignment Status** = **Needs Review**, **Conflict Notes** = guest count / dates missing (does not delete beds).

### 1.7 Airtable tables and fields

| Table | Operations |
|-------|------------|
| **Bookings** (`tblYWm3zKFafe4qu7`) | **Read** (Get Booking); **Update** (Mark ready or failure) |
| **Booking Beds** (`tblO1ByvTMXS4SalB`) | **Delete** (all linked beds on success path) |

**Mark Booking Ready For Reassignment** (success path):

| Field | Value |
|-------|--------|
| **Assignment Status** | **Unassigned** |
| **Availability Check Status** | **Not Checked** |

**Update record1** (failure path):

| Field | Value |
|-------|--------|
| **Assignment Status** | **Needs Review** |
| **Conflict Notes** | e.g. guest count missing |

**Not updated by Reassign:** **Status**, **Payment Status**, deposit/paid amounts, **Check In/Out** (date automation fires *because* dates changed elsewhere), **Send Confirmation**.

### 1.8 What hosted Reassign does **not** touch

| System | Notes |
|--------|--------|
| **Postgres** | Not used |
| **payments** / Stripe / Main / Send Confirmation | Not used (Main may update rooming on Bookings before webhook) |
| **Google Sheets** | Not used |
| **Guests** (PG) | Not used |

---

## 2. Phase 3b.3 goal

| Goal | Detail |
|------|--------|
| **Local n8n fork only** | `n8n/phase3b/Wolfhouse - Reassign Bed Assignments (local PG).json` |
| **Postgres mirror** | DELETE all `booking_beds` for booking; mirror assignment fields through reassign-ready → assigned states |
| **Keep Airtable reset behaviour** | Hosted nodes: prepare → delete AT beds → mark Unassigned / Not Checked |
| **Reuse proven building blocks** | PG cancel SQL (3b.1b), PG assign SQL (3b.2b), Assign fork segment (3b.2c), parse/`__NULL__` patterns (3b.1c) |
| **Single-webhook local E2E** | Chain **local Assign (local PG)** after reset (HTTP to `assign-beds-to-booking` or embedded subgraph) — do not depend on hosted Cloud automation in local Docker |
| **Hosted export read-only** | Source: `n8n/Wolfhouse - Reassign Bed Assignments.json` |
| **No hosted import** | Local `http://localhost:5678` only |
| **Regenerate** | `npm run build:reassign-beds:local` |

### 2.1 Proposed local workflow order

```
1.  Webhook  reassign-booking-beds  (responseMode: responseNode)
      → Code - Parse Reassign Webhook
      → IF - Parse OK
2.  Get Booking To Reassign (hosted)
      → Code - Normalize Reassignment Booking (hosted)
      → IF - Can Reassign Booking (hosted)
      │
      ├─ FALSE → Code - Build Reassign Response (failure) → Respond
      │
      └─ TRUE
            → Postgres - Cancel Beds In Postgres (3b.1b SQL)
            → Code - Validate PG Cancel
            → IF - PG Cancel OK
            │
            ├─ FALSE → Build Response (partial: pg_failed) → Respond
            │
            └─ TRUE
                  → Code - Prepare Existing Booking Beds To Cancel (hosted)
                  → Cancel Old Booking Bed (hosted, continueOnFail)
                  → Mark Booking Ready For Reassignment (hosted, continueOnFail)
                  → Postgres - Mirror Reassign Ready Status (UPDATE unassigned / not_checked)
                  │
                  → [Assign segment — same as 3b.2c from Get Booking / Choose Beds onward]
                  │     Option A: Execute Workflow / sub-workflow import of Assign (local PG)
                  │     Option B: HTTP Request POST localhost assign-beds-to-booking { record_id }
                  │     Option C: Inline copy of Assign fork nodes after synthetic "Get Booking"
                  │
                  → Code - Build Reassign Response (aggregate cancel + assign metrics)
                  → Respond to Webhook
```

**Recommendation:** **Option B** for first implementation (HTTP to local Assign fork) — smallest build script, reuses active 3b.2c workflow; **Option C** if sub-workflow credentials/webhook routing are awkward.

**Deactivate** duplicate `reassign-booking-beds` on local n8n (hosted Reassign vs local fork).

---

## 3. Data behavior

### 3.1 Which old Postgres `booking_beds` are removed

| Rule | Detail |
|------|--------|
| **Scope** | **All** rows where `booking_beds.booking_id` = resolved booking and `client_id` = `wolfhouse-somo` |
| **Mechanism** | Same DELETE as [`cancel-booking-beds-postgres.js`](../scripts/cancel-booking-beds-postgres.js) `--execute` / 3b.1c PG node |
| **Not** | Per-bed selective delete by `bed_code` (reassign clears entire assignment set) |
| **Dates** | N/A — entire assignment set removed regardless of `assignment_start_date` / `assignment_end_date` |

### 3.2 Which new Postgres `booking_beds` are inserted

| Rule | Detail |
|------|--------|
| **Source of bed list** | **Code - Choose Beds** output (via chained Assign fork), not webhook body |
| **Mechanism** | Same INSERT rules as [`assign-booking-beds-postgres.js`](../scripts/assign-booking-beds-postgres.js) / [`assign-booking-beds-pg-sql.js`](../scripts/lib/assign-booking-beds-pg-sql.js) |
| **Natural key** | `(booking_code, bed_code, assignment_start_date, assignment_end_date)` — skip if already exists |
| **Dates** | Booking **check_in** / **check_out** from Airtable (or PG booking row) after date-change reassign |
| **Backfill** | `airtable_record_id` set after AT **Create Booking Bed Assignment** (3b.2c pattern) |

### 3.3 `assignment_status` and `availability_check_status`

| Phase | Postgres (proposed) | Airtable (hosted + assign) |
|-------|---------------------|----------------------------|
| After PG cancel (step 1) | Mirror 3b.1b: `needs_review` / `needs_review` **or** jump to `unassigned` / `not_checked` to match AT mark-ready | — |
| After Mark Booking Ready | **`unassigned`** / **`not_checked`** (explicit PG UPDATE) | **Unassigned** / **Not Checked** |
| After Assign success | **`assigned`** / **`available`** | **Assigned** / **Available** |
| Reassign gate failure | **`needs_review`** / **`conflict`** (align AT failure node) | **Needs Review** + conflict notes |
| Assign conflict branch | **`needs_review`** / **`conflict`** | **Needs Review** / **Conflict** |

**Proposal:** After PG DELETE, run **Mark Booking Ready** in AT, then PG UPDATE to **`unassigned` / `not_checked`** (not `needs_review`) so PG matches the reassign-ready state before Assign. Cancel-only scripts that set `needs_review` remain correct for **cancel**; reassign is a different terminal state before re-assign.

### 3.4 Hard limits (unchanged)

| Data | Rule |
|------|------|
| `payments`, `payment_events` | No INSERT/UPDATE/DELETE |
| `bookings.payment_status` | No UPDATE |
| `bookings.status` | No UPDATE in reassign fork (Main may set elsewhere; date automation does not change Status) |
| `bookings` DELETE | Never |
| `beds` / `rooms` inventory | Read-only in assign segment |

---

## 4. Safety and idempotency

### 4.1 Reassign runs twice (full success twice)

| Call | Expected behaviour |
|------|---------------------|
| **First** | PG delete N beds → AT delete → mark Unassigned → Assign inserts M beds → PG/AT **Assigned** |
| **Second** (same booking, no manual change) | PG delete M beds → AT delete M → Unassigned → Assign runs again → Choose Beds may pick same or different beds; PG insert skips natural keys only **within** same assign execution, not across delete cycle |

Second full reassign is **destructive then creative** — not a no-op. Idempotency metric: **`pg_deleted_count`** on second run equals current bed count; then new inserts.

For **“same reassign again”** tests, document expected: **delete count > 0**, then **insert count ≥ 0** (not `idempotent: true` for whole webhook unless assign returns 0 inserts and skip).

### 4.2 Cancel (PG/AT reset) succeeds but Assign fails

| Layer | State |
|-------|--------|
| **PG** | No `booking_beds`; booking likely `unassigned` / `not_checked` |
| **AT** | No Booking Beds; booking **Unassigned** |
| **Response** | `partial_failure: pg_ok_airtable_reset_ok_assign_failed` (name TBD) |

**Recovery:** Retry `assign-beds-to-booking` (local Assign fork) or `db:assign:booking-beds --execute` with beds from impact report; `db:sync` if test data corrupt.

### 4.3 Airtable reset succeeds but Postgres cancel fails

| Layer | State |
|-------|--------|
| **PG** | Stale `booking_beds` remain |
| **AT** | Beds deleted; booking Unassigned |

**Recovery:** `db:cancel:booking-beds --execute` or retry reassign webhook; `db:report:bed-drift`.

**Proposal:** If PG cancel fails, **skip** AT delete (same as 3b.1c PG-gate) to avoid AT-only release.

### 4.4 Assign PG succeeds but Airtable create fails

Same as 3b.2c: `partial_failure: pg_ok_airtable_failed`; PG has beds with `airtable_record_id` NULL; drift report shows PG-only keys.

### 4.5 Overlap conflicts

| Stage | Handling |
|-------|----------|
| **Choose Beds** | Uses AT Search Existing Bed Assignments (excludes old beds after delete) |
| **PG assign** | [`assign-booking-beds-plan.js`](../scripts/lib/assign-booking-beds-plan.js) overlap check on other bookings |
| **Conflict** | Assign branch sets **Needs Review** / **Conflict**; PG mirror conflict; reassign response reports `assignment_conflict` |

### 4.6 Duplicate avoidance

| Mechanism | Detail |
|-----------|--------|
| **Reassign** | Deletes **all** PG + AT beds for booking before re-insert |
| **Assign** | Natural-key skip for same booking/dates/bed |
| **PG unique** | `airtable_record_id` UNIQUE when set |
| **No double Assign in one execution** | Single chained Assign call per reassign webhook |

### 4.7 Proposed response JSON

| Field | Meaning |
|-------|---------|
| `ok` | Reset + assign both succeeded |
| `booking_code`, `record_id` | Identifiers |
| `pg_deleted_count` | Rows removed in PG cancel step |
| `pg_inserted_count` | Rows inserted in assign step |
| `pg_skipped_count` | Assign-step skips (usually 0 on fresh reassign) |
| `pg_conflict_count` | Overlap blocks in assign step |
| `airtable_delete_ok` | All AT bed deletes succeeded |
| `airtable_reset_ok` | Mark ready update succeeded |
| `airtable_create_ok`, `airtable_update_ok` | From assign segment |
| `assign_triggered` | `true` if local Assign fork ran |
| `partial_failure` | e.g. `assign_failed_after_reset` |
| `idempotent` | Reserved for “second assign-only call” patterns; **not** whole reassign |
| `errors[]` | Codes |

---

## 5. Rollback

| Action | Command / step |
|--------|----------------|
| **Restore PG from CSV** | `npm run db:sync` |
| **Clear PG beds only** | `npm run db:cancel:booking-beds -- --booking-code=WH-rec… --execute` |
| **CLI assign without n8n** | `npm run db:assign:booking-beds -- --booking-code=… --beds=… --execute` |
| **Deactivate local fork** | n8n UI: deactivate **Reassign (local PG)** |
| **Re-import hosted Reassign** | Import read-only `n8n/Wolfhouse - Reassign Bed Assignments.json` if needed |
| **Regenerate fork** | `npm run build:reassign-beds:local` |
| **Payment rollback** | **Never** — out of scope |

**Test Airtable:** Use `prep-assign-e2e-airtable.js` patterns or manual Unassigned reset; avoid production base.

---

## 6. Test plan

**Environment:** Local n8n + local Postgres + **test** Airtable PAT. **Assign (local PG)** and **Reassign (local PG)** active; hosted duplicates deactivated on same paths.

| Step | Action | Pass criteria |
|------|--------|---------------|
| T0 | `npm run db:sync` | Baseline |
| T1 | `db:report:reassign-impact` (3b.3a, if added) on booking with beds | Lists would-delete PG rows, payments untouched |
| T2 | Booking with **existing** PG + AT beds (e.g. after assign E2E) | — |
| T3 | `POST reassign-booking-beds` (local fork) with date or rooming change context | `pg_deleted_count` > 0; `pg_inserted_count` > 0; `airtable_reset_ok`; `airtable_create_ok`; `ok: true` |
| T4 | Verify PG: old natural keys gone, new keys present | SQL or drift report |
| T5 | **Same reassign again** (or reassign → expect delete then new assign) | `pg_deleted_count` matches prior insert count; no duplicate natural keys in PG |
| T6 | **Overlap/conflict** fixture (book busy bed dates) | `pg_conflict_count` or assign conflict branch; clear error |
| T7 | **Partial failure** (optional: break AT cred after PG cancel) | `partial_failure` set; documented recovery |
| T8 | `db:report:bed-drift` | Acceptable for test base |
| T9 | `planning:report:postgres` | New rows reflect reassigned beds |
| T10 | `test:phase2f-resolver` | 10/10 |
| T11 | `db:sync` | Restore |

**Chained Assign note:** Same as 3b.2c E2E — prep AT to **Unassigned** immediately before webhook if testing reset+assign separately; full reassign fork should handle both.

---

## 7. Files if approved (implementation)

| Action | Path |
|--------|------|
| **Create** | `scripts/build-reassign-beds-local.js` |
| **Create** | `n8n/phase3b/Wolfhouse - Reassign Bed Assignments (local PG).json` (generated) |
| **Create** | `n8n/phase3b/Wolfhouse - Reassign Bed Assignments (local PG).n8n-import.json` (generated) |
| **Create** | `docs/PHASE-3b-3.md` (runbook) |
| **Create** | `scripts/test-reassign-beds-webhook.ps1` (optional) |
| **Create** | `scripts/run-reassign-e2e-local.js` (optional orchestrator) |
| **Create** | `scripts/report-reassign-impact.js` (optional 3b.3a read-only, mirrors cancel-impact + assign-impact) |
| **Modify** | `package.json` — `build:reassign-beds:local`, optional `db:report:reassign-impact` |
| **Modify** | `n8n/phase3b/README.md` — Reassign section |
| **Modify** | `docs/regression-test-plan.md` — Phase 3b.3 |

**Reuse (no fork required):**

| Path | Use |
|------|-----|
| `scripts/lib/assign-booking-beds-pg-sql.js` | PG assign in assign segment |
| `scripts/cancel-booking-beds-postgres.js` | Reference for PG cancel SQL in build |
| `n8n/phase3b/Wolfhouse - Bed Assignment (local PG).json` | Chained assign target |

**Not modified:**

| Path | Reason |
|------|--------|
| `n8n/Wolfhouse - Reassign Bed Assignments.json` | Hosted export |
| `n8n/Wolfhouse - Bed Assignment.json` | Hosted export |
| `n8n/phase2/*` | Main / Stripe / Send Confirmation |
| `database/migrations/*` | No migration in 3b.3 |
| Production automations | Unchanged until cutover |

---

## 8. Approval checklist

- [ ] Owner approves **PG cancel → AT reset → chained local Assign** in one webhook  
- [ ] Owner accepts **HTTP to assign-beds-to-booking** vs inlined Assign nodes  
- [ ] PG booking fields after reset: **`unassigned` / `not_checked`** (not cancel’s `needs_review`)  
- [ ] Test Airtable base / PAT only for local webhooks  
- [ ] **No** hosted Cloud import of fork  
- [ ] **Deactivate duplicate** `reassign-booking-beds` on local n8n documented  
- [ ] `partial_failure` when assign fails after successful reset is acceptable  
- [ ] Main / Stripe / Send Confirmation / payments unchanged in 3b.3  

---

## 9. Sequence in Phase 3b

```
3b.0   bed drift audit                         ✅
3b.1   Cancel (impact → PG → local n8n)         ✅
3b.2   Assign (impact → PG → local n8n)         ✅ 1085e56
3b.3   Reassign (PG reset → AT reset → Assign)  ← this proposal
3b.4   Manual Entries                          not started
3b.5   Operator Room Release                   not started
```

---

## References

| Item | Location |
|------|----------|
| Hosted Reassign export | `n8n/Wolfhouse - Reassign Bed Assignments.json` |
| Hosted Assign export | `n8n/Wolfhouse - Bed Assignment.json` |
| Cancel local fork | `docs/PHASE-3b-1c.md`, `scripts/build-cancel-beds-local.js` |
| Assign local fork | `docs/PHASE-3b-2c.md`, `scripts/build-assign-beds-local.js` |
| Webhook map | `docs/webhook-map.md` |
| Airtable automations §3, §5 | `docs/airtable-automations.md` |
| Workflow dependencies | `docs/workflow-dependency-map.md` §7 |
| Phase 3b parent | `docs/PHASE-3b-PROPOSAL.md` |
