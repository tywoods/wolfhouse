# Phase 3b.2c — Local Bed Assignment workflow fork (PG + Airtable) (proposal)

**Status:** Proposal only — **no implementation**, workflow JSON edits, hosted import, or production Airtable changes.  
**Prerequisites:** Phase **3b.2a** (`aa278c3`), **3b.2b** (`15e53bb`) — assign impact report + Postgres assign script.  
**Parents:** [`PHASE-3b-2-PROPOSAL.md`](PHASE-3b-2-PROPOSAL.md), [`PHASE-3b-2a.md`](PHASE-3b-2a.md), [`PHASE-3b-2b.md`](PHASE-3b-2b.md), [`PHASE-3b-1c-PROPOSAL.md`](PHASE-3b-1c-PROPOSAL.md)

**Explicitly out of scope for 3b.2c:**

- Import or activation on **hosted** n8n Cloud (`tywoods.app.n8n.cloud`)  
- Editing **`n8n/Wolfhouse - Bed Assignment.json`** (hosted export — read-only input)  
- **Production** Airtable base unless using a dedicated **test** base + PAT (documented below)  
- **Google Sheets**  
- **`payments`**, **`payment_events`**, **`bookings.payment_status`**, Stripe / Main / Send Confirmation  
- **`bookings` row DELETE**  
- **3b.3** Reassign  
- Pointing **Main** or staff automations at local webhook in **production**  
- Replacing **Code - Choose Beds** with a Postgres-only scorer (deferred)  

---

## Executive summary

3b.2c adds a **local-only** n8n workflow fork that:

1. Accepts the same webhook as hosted Assign (`POST assign-beds-to-booking`, `{ record_id }`).  
2. Runs the **full hosted assignment path** unchanged through **Code - Choose Beds** (Airtable searches + scorer).  
3. **Mirrors chosen beds into Postgres** (same rules as [`assign-booking-beds-postgres.js`](../scripts/assign-booking-beds-postgres.js) `--execute`) **before** Airtable **Create Booking Bed Assignment** nodes.  
4. **Backfills** `booking_beds.airtable_record_id` after AT create.  
5. Returns structured JSON (`pg_inserted_count`, `partial_failure`, `idempotent`, etc.).

**Order:** Postgres reserve beds first, then Airtable create — aligned with 3b.1c (PG before AT). Local inventory and planning reports see assignments even when AT is slow or fails mid-run.

Generated artifacts: **`n8n/phase3b/Wolfhouse - Bed Assignment (local PG).json`** via **`npm run build:assign-beds:local`**. Do not hand-edit the hosted export.

---

## 1. Current hosted Assign workflow

### 1.1 Trigger and entry

| Attribute | Value |
|-----------|--------|
| **Workflow** | Wolfhouse - Bed Assignment |
| **Export (read-only)** | `n8n/Wolfhouse - Bed Assignment.json` |
| **Webhook path** | `POST /webhook/assign-beds-to-booking` |
| **Webhook ID** | `76de4db6-f820-41db-b47c-65bd056a04d6` |
| **Body** | `{ "record_id": "<Airtable Bookings rec…>" }` |
| **Called by** | Airtable automation **“Assign Beds When Booking Is Unassigned”** ([`airtable-automations.md`](airtable-automations.md) §3) |

**Important:** The webhook does **not** pass bed codes. **Bed selection is internal** — performed by **Code - Choose Beds** after reading Beds, Booking Beds, Rooms, and the Bookings record from Airtable.

**Automation preconditions (Airtable):** Assignment Status = **Unassigned**, dates filled, Status not Cancelled/Expired, Availability Check Status = **Not Checked**, Guest Count > 0.

**n8n gate (`IF - Needs Bed Assignment`):** Skips when Assignment Status is **Assigned**, **Assigning**, or **Needs Review**, or Status is **Cancelled** / **Expired**.

### 1.2 How beds are chosen (hosted)

| Step | Behaviour |
|------|-----------|
| **Search Active Beds** | Airtable: Beds where Active + Sellable |
| **Search Existing Bed Assignments** | Overlap formula vs booking Check In/Out (active statuses) |
| **Search Rooms** | Room metadata (fill priority, gender strategy, capacity) |
| **Code - Choose Beds** | ~23k LOC scorer: guest count, preferences, operator whole-room block, multi-room Tetris; outputs **one item per chosen bed** with `bed_record_id`, `bed_id`, dates, `assignment_type`, etc. |
| **IF - Bed Assignment Conflict** | True branch if conflict object (no bed list); false branch → create rows |

Operator whole-room and gender/preference logic remain **Airtable-data-driven** in 3b.2c — not reimplemented in Postgres.

### 1.3 Node flow (hosted, simplified)

```
Webhook (record_id)
  → Get Booking
  → IF - Needs Bed Assignment
  → Update Booking - Mark Assigning          (Assignment Status = Assigning)
  → Search Active Beds
  → Search Existing Bed Assignments
  → Search Rooms
  → Code - Choose Beds
  → IF - Bed Assignment Conflict
       ├─ true  → Update Booking Assignment Status - Conflict
       └─ false → Create Booking Bed Assignment (per item)
                  → Update Booking Assignment Status (Assigned / Available)
```

Hosted export does **not** use `responseMode: responseNode` today (legacy response code on webhook). The local fork should add **Respond to Webhook** for testability (same pattern as 3b.1c).

### 1.4 Airtable tables read/written

| Table | Operations |
|-------|------------|
| **Bookings** (`tblYWm3zKFafe4qu7`) | **Read** (Get Booking); **Update** (Assigning → Assigned or Needs Review / Conflict) |
| **Beds** (`tblEkF4SG4TLaNmW4`) | **Search** (inventory) |
| **Booking Beds** (`tblO1ByvTMXS4SalB`) | **Search** (occupancy); **Create** (one row per chosen bed) |
| **Rooms** | **Search** (scoring metadata) |

### 1.5 Booking Beds rows created (success path)

**Create Booking Bed Assignment** fields (from Code output):

| Airtable field | Source |
|----------------|--------|
| **Booking** | `booking_record_id` |
| **Bed** | `bed_record_id` |
| **Assignment Type** | e.g. Auto Assigned, Auto Assigned - Multi Room, Manual Staff Assignment |
| **Assignment Start / End Date** | booking Check In / Check Out |
| **Assignment Notes**, **Rooming Notes**, **Guest Gender / Group Type**, **Room Preference** | From scorer |

### 1.6 Bookings fields updated

| Node | Assignment Status | Availability Check Status |
|------|-------------------|---------------------------|
| **Update Booking - Mark Assigning** | **Assigning** | (unchanged) |
| **Update Booking Assignment Status** | **Assigned** | **Available** |
| **Update Booking Assignment Status - Conflict** | **Needs Review** | **Conflict** (+ Conflict Notes) |

**Not updated:** **Status**, **Payment Status**, deposit/paid amounts, **Send Confirmation**.

### 1.7 What hosted Assign does **not** touch

| System | Notes |
|--------|--------|
| **Postgres** | Not used today |
| **payments** / Stripe / Main | Not touched |
| **Conversations / Messages** | Not touched |
| **Google Sheets** | Not touched |
| **Guests** table (PG) | Not touched |

---

## 2. Local fork goal

| Goal | Detail |
|------|--------|
| **Generate local-only fork** | `n8n/phase3b/Wolfhouse - Bed Assignment (local PG).json` |
| **Postgres mirror** | INSERT `booking_beds` + UPDATE assignment fields; logic aligned with 3b.2b + [`assign-booking-beds-plan.js`](../scripts/lib/assign-booking-beds-plan.js) |
| **Keep Airtable behaviour** | All hosted AT nodes through Create/Update preserved (copied by build script) |
| **Hosted export read-only** | Source: `n8n/Wolfhouse - Bed Assignment.json` only |
| **No hosted import** | Local `http://localhost:5678` only |
| **Regenerate** | `npm run build:assign-beds:local` — do not hand-edit generated JSON |
| **Stable workflow id** | `.n8n-import.json` with fixed id for CLI re-import (pattern from 3b.1c `KchhRC9b3MIdkzPT`) |

### Relationship to 3b.2a / 3b.2b

| Tool | Role |
|------|------|
| `db:report:assign-impact` | **Before** manual/webhook test when beds are known explicitly (CLI `--beds`) |
| `db:assign:booking-beds` | **CLI-only** assign without AT; validates PG path in isolation |
| **3b.2c webhook** | **Full path:** Choose Beds (AT) → PG mirror → AT create → backfill |

For webhook testing without running full scorer, use 3b.2b with beds taken from a prior impact report. The fork always uses **Choose Beds output** at runtime.

### Postgres execution options (implementation choice)

| Option | Pros | Cons |
|--------|------|------|
| **A. Injected Postgres + Code nodes** | Atomic with AT steps in one workflow; matches 3b.1c | SQL/loop must stay in sync with 3b.2b |
| **B. Execute Command → `db:assign:booking-beds --execute`** | Single source of truth | Must pass dynamic `--beds` from Choose Beds items; harder in queue worker |
| **C. HTTP to local script** | Overkill | Not recommended |

**Proposal:** **A** — Code node builds bed list from `$('Code - Choose Beds').all()`, then **Postgres** INSERT loop (or batched SQL) + overlap checks mirroring `loadAssignPlan`. Document sync requirement in build script header (same as cancel build).

---

## 3. Proposed workflow order (local fork)

```
1.  Webhook  assign-beds-to-booking
      │  Parse: record_id, RecordId, optional booking_code; __NULL__ on PG params if needed
      ▼
2.  Get Booking (AT, hosted)
      ▼
3.  IF - Needs Bed Assignment (hosted)
      │  false → early Respond (skipped: already_assigned_or_ineligible)
      ▼
4.  Update Booking - Mark Assigning (AT, hosted)
      ▼
5.  Search Active Beds → Search Existing Bed Assignments → Search Rooms (AT, hosted)
      ▼
6.  Code - Choose Beds (hosted, UNCHANGED)
      ▼
7.  IF - Bed Assignment Conflict (hosted)
      │
      ├─ TRUE (conflict)
      │     → Code - PG Mirror Assignment Status (conflict only: needs_review / conflict)
      │     → Update Booking Assignment Status - Conflict (AT, hosted)
      │     → Build Assign Response → Respond to Webhook
      │     (no booking_beds INSERT on conflict path)
      │
      └─ FALSE (success path)
            ▼
8.  Code - Build PG Assign Plan
      │  Map Choose Beds items → bed_code, dates, assignment_type
      │  Run overlap / natural-key logic (same as assign-booking-beds-plan.js)
      │  Optional: log diff vs npm run db:report:assign-impact if env flag set
            ▼
9.  Postgres - Insert Booking Beds (new)
      │  Per would_insert row; skip existing natural keys
      │  airtable_record_id = NULL until step 11
      │  continueOnFail + structured errors
            ▼
10. Create Booking Bed Assignment (AT, hosted, continueOnFail)
            ▼
11. Code - Backfill PG airtable_record_id (new)
      │  Match AT create output id to PG row by bed_code + dates
            ▼
12. Update Booking Assignment Status (AT, hosted, continueOnFail)
            ▼
13. Postgres - Mirror Booking Assignment Status (new)
      │  assigned / available (success) — idempotent UPDATE
            ▼
14. Code - Build Assign Response → Respond to Webhook (new)
      │  responseMode: responseNode on webhook
```

**Webhook path:** Keep **`assign-beds-to-booking`** but use a **new webhookId** in generated JSON (only one active workflow per path on local n8n). **Deactivate** hosted Bed Assignment import on local instance if both exist.

---

## 4. Data safety

### 4.1 Never touch (same as 3b.2b)

| Data | Rule |
|------|------|
| `payments`, `payment_events` | SELECT count before/after; abort transaction if changed |
| `bookings.payment_status` | No UPDATE |
| `bookings.status` | No UPDATE |
| `bookings` DELETE | Never |

### 4.2 Idempotency and duplicates

| Scenario | Behaviour |
|----------|-----------|
| **Second webhook** (booking already Assigned) | `IF - Needs Bed Assignment` may skip AT path; PG early exit if no new items |
| **Same beds/dates already in PG** | INSERT skipped (natural key); `pg_inserted_count=0` |
| **AT creates duplicate** | AT IF reduces risk; drift report catches duplicates |
| **Choose Beds runs again** | PG skips existing keys; AT may create duplicate AT rows if gate passes — document test base only |

### 4.3 Overlap conflicts

| Layer | Behaviour |
|-------|-----------|
| **Choose Beds** | Uses AT Search Existing Bed Assignments |
| **PG mirror (new)** | Re-check overlap on `booking_beds` for other bookings ([`assign-booking-beds-plan.js`](../scripts/lib/assign-booking-beds-plan.js)); **block INSERT** on conflict unless build adds `--allow-conflict` equivalent via Code flag |
| **Conflict branch** | No PG bed INSERT; AT sets Needs Review / Conflict; PG mirrors assignment fields only |

### 4.4 Partial failure matrix

| PG | AT | Outcome | `partial_failure` |
|----|----|---------|-------------------|
| OK | OK | Full success | `null` |
| OK | Fail | PG beds exist; AT empty or partial | `pg_ok_airtable_failed` |
| Fail | OK | AT beds exist; PG missing/partial | `pg_failed_airtable_ok` |
| OK (0 insert) | OK | Idempotent | `null`, `idempotent: true` |
| Conflict | AT conflict update | No beds | `assignment_conflict` |

**PG succeeds, AT fails:** Local PG has beds with `airtable_record_id` NULL; staff sees beds in planning/drift “keys only in PG”. Recovery: retry webhook, manual AT create, or `db:sync` after export. Log `partial_failure` in response; do not auto-rollback PG (same policy as 3b.1c).

**AT succeeds, PG fails:** AT has Booking Beds; PG empty or behind. Recovery: `db:assign:booking-beds --execute` with beds from AT export, or `db:sync`. Response `pg_failed_airtable_ok`.

**Transaction scope:** PG INSERTs can be one DB transaction in Code/Postgres subflow; AT steps are **not** in the same DB transaction. Treat as **best-effort dual-write** with explicit `partial_failure` (3b.1c pattern).

### 4.5 Response JSON (proposed)

| Field | Meaning |
|-------|---------|
| `ok` | PG and AT success paths completed without `partial_failure` |
| `booking_code` | `WH-rec…` |
| `record_id` | Airtable `rec…` |
| `pg_inserted_count` | New `booking_beds` rows |
| `pg_skipped_count` | Natural key already existed |
| `pg_updated` | Booking assignment fields mirrored in PG |
| `airtable_create_ok` | All Create nodes succeeded |
| `airtable_update_ok` | Bookings update succeeded |
| `beds_chosen_count` | Items from Choose Beds |
| `idempotent` | `pg_inserted_count === 0` and no new AT requirement |
| `partial_failure` | e.g. `pg_ok_airtable_failed` |
| `errors[]` | AT/PG messages |
| `skipped_reason` | e.g. `already_assigned` when IF false |

---

## 5. Rollback

### 5.1 Deactivate local fork

1. In local n8n UI: deactivate **Wolfhouse - Bed Assignment (local PG)**.  
2. Activate hosted **Wolfhouse - Bed Assignment** only if needed for AT-only tests — **never both** on same webhook path.

### 5.2 Re-import hosted workflow from Git

If local fork replaced hosted copy in n8n DB:

- Import read-only export `n8n/Wolfhouse - Bed Assignment.json` from repo (not the `(local PG)` file).  
- Map Airtable credentials in UI.

### 5.3 Local Postgres recovery

| Action | Command |
|--------|---------|
| Remove PG beds for one booking | `npm run db:cancel:booking-beds -- --booking-code=WH-rec… --execute` |
| Rebuild all beds from CSV | `npm run db:sync` |
| CLI assign without AT | `db:assign:booking-beds` (3b.2b) |

### 5.4 No payment rollback

Assign and rollback paths never modify payments. No Stripe or payment_status reversal.

---

## 6. Test plan

**Environment:** Local n8n + local Postgres + **test Airtable** base/PAT only unless explicitly approved.

| Step | Action | Pass criteria |
|------|--------|---------------|
| T0 | `npm run db:sync` | Clean baseline; bed-drift 0 actionable |
| T1 | `db:report:assign-impact` with beds from expected Choose Beds outcome (optional) | Matches dry-run intent |
| T2 | `db:assign:booking-beds` dry-run (same booking, 0 PG beds) | Lists would_insert |
| T3 | Build + import fork; map Postgres + Airtable creds; deactivate duplicate webhook | Workflow active |
| T4 | `test-assign-beds-webhook.ps1 -RecordId rec…` **first call** | HTTP 200 JSON; `pg_inserted_count` = guest_count; AT creates rows (test base) |
| T5 | **Second call** | `idempotent`; `pg_inserted_count=0` |
| T6 | **Partial** booking (1 PG bed, re-run assign) | Only missing beds inserted |
| T7 | **Overlap** fixture | PG blocks or conflict branch; no silent double-book |
| T8 | `db:report:bed-drift` | Acceptable drift for test base; document PG-only keys if AT skipped |
| T9 | `planning:report:postgres` | New rows visible |
| T10 | `test:phase2f-resolver` | 10/10 |
| T11 | Payments | Unchanged count and `payment_status` |
| T12 | `db:sync` | Restore after destructive tests |

**Fixture:** Booking with **Unassigned**, valid dates, **0** PG `booking_beds` (e.g. after cancel + sync, or dedicated test row). Example used in 3b.2b: `WH-rechKjCcySkfLzxUD` (restore via sync after tests).

---

## 7. Files if approved (implementation)

| Action | Path |
|--------|------|
| **Create** | `scripts/build-assign-beds-local.js` |
| **Create** | `n8n/phase3b/Wolfhouse - Bed Assignment (local PG).json` (generated) |
| **Create** | `n8n/phase3b/Wolfhouse - Bed Assignment (local PG).n8n-import.json` (generated) |
| **Create** | `docs/PHASE-3b-2c.md` (runbook) |
| **Create** | `scripts/test-assign-beds-webhook.ps1` (optional helper) |
| **Modify** | `package.json` — `"build:assign-beds:local": "node scripts/build-assign-beds-local.js"` |
| **Modify** | `n8n/phase3b/README.md` — Assign section + re-import commands |
| **Modify** | `docs/regression-test-plan.md` — Phase 3b.2c section |

**Not modified:**

| Path | Reason |
|------|--------|
| `n8n/Wolfhouse - Bed Assignment.json` | Hosted export (read-only input) |
| `n8n/Wolfhouse - Cancel Bed Assignments.json` | Separate fork |
| `n8n/Wolfhouse - Reassign Bed Assignments.json` | 3b.3 |
| `n8n/phase2/*` | Main / Stripe / Send Confirmation |
| `database/migrations/*` | No migration in 3b.2c |
| `scripts/assign-booking-beds-postgres.js` | Keep CLI; fork SQL/plan must stay in sync |
| Production Airtable automations | Unchanged until explicit cutover |

### Build script responsibilities (sketch)

1. Read hosted `Wolfhouse - Bed Assignment.json`.  
2. Inject nodes: Parse Webhook, Build PG Plan, Postgres Insert, Backfill, PG Mirror Status, Build Response, Respond to Webhook.  
3. Rewire connections after **Code - Choose Beds** / **IF - Bed Assignment Conflict**.  
4. Set `responseMode: responseNode`, new `webhookId`, strip hosted credential ids → map in UI / `.n8n-import.json`.  
5. `continueOnFail: true` on AT create/update nodes.  
6. Fail build if hosted node names change (guard list).  

---

## 8. Approval checklist

- [ ] Owner approves **PG-before-AT** insert order for bed rows  
- [ ] Owner accepts **Choose Beds unchanged** (AT-driven selection) for first cut  
- [ ] Test Airtable base / PAT for local webhook tests  
- [ ] Owner confirms **no** hosted Cloud import of fork  
- [ ] **Deactivate duplicate** `assign-beds-to-booking` workflow on local n8n documented  
- [ ] `partial_failure` behaviour acceptable when PG ahead of AT  
- [ ] **Reassign (3b.3)** remains out of scope  
- [ ] Main / Stripe / Send Confirmation / payments unchanged  

---

## 9. Sequence in Phase 3b

```
3b.0   bed drift audit                         ✅
3b.1   Cancel (impact → PG → local n8n)         ✅ through 9556297
3b.2a  assign impact report                    ✅ aa278c3
3b.2b  assign-booking-beds-postgres.js          ✅ 15e53bb
3b.2c  local n8n Assign fork (PG → AT)          ← this proposal
3b.3   Reassign                                 not started
```

---

## References

| Item | Location |
|------|----------|
| Hosted Assign export | `n8n/Wolfhouse - Bed Assignment.json` |
| Cancel local fork pattern | `scripts/build-cancel-beds-local.js`, `docs/PHASE-3b-1c.md` |
| Assign impact / plan | `scripts/report-assign-impact.js`, `scripts/lib/assign-booking-beds-plan.js` |
| Assign CLI | `scripts/assign-booking-beds-postgres.js`, `docs/PHASE-3b-2b.md` |
| Webhook / automation | `docs/webhook-map.md`, `docs/airtable-automations.md` §3 |
| Phase 3b.2 parent | `docs/PHASE-3b-2-PROPOSAL.md` |
| Local n8n Postgres | `infra/docker-compose.local.yml` → `WOLFHOUSE_DATABASE_URL` |
