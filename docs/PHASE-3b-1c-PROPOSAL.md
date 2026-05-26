# Phase 3b.1c — Local Cancel workflow fork (PG + Airtable) (proposal)

**Status:** Proposal only — **no implementation**, workflow JSON edits, hosted import, or production Airtable changes.  
**Prerequisites:** Phase **3b.1a** (`2c710fb`), **3b.1b** (`0788f06`) — cancel impact report + Postgres cancel script.  
**Parents:** [`PHASE-3b-1-PROPOSAL.md`](PHASE-3b-1-PROPOSAL.md), [`PHASE-3b-1b-PROPOSAL.md`](PHASE-3b-1b-PROPOSAL.md), [`PHASE-3b-1b.md`](PHASE-3b-1b.md)

**Explicitly out of scope for 3b.1c:**

- Import or activation on **hosted** n8n Cloud (`tywoods.app.n8n.cloud`)  
- Editing **`n8n/Wolfhouse - Cancel Bed Assignments.json`** (hosted export — read-only input)  
- **Production** Airtable base changes unless using a dedicated **test** base + PAT (documented below)  
- **Google Sheets**  
- **`payments`**, **`payment_events`**, **`bookings.payment_status`**, Stripe workflows  
- **`bookings` row DELETE**  
- **3b.2+** Assign / Reassign  
- Pointing **Main** or staff automations at local webhook in production  

---

## Executive summary

3b.1c adds a **local-only** n8n workflow fork that:

1. Accepts the same webhook as hosted Cancel (`POST cancel-booking-beds`, `{ record_id }`).  
2. Runs the **Postgres cancel path** (same mutations as `cancel-booking-beds-postgres.js --execute`).  
3. Runs the **existing Airtable** delete/update nodes from the hosted export (unchanged behavior).  

**Order:** Postgres first, then Airtable — so local PG availability matches AT after a successful run.

Generated artifacts live under **`n8n/phase3b/`** (bed-ops fork folder; aligns with Phase 3b naming). Regenerate via **`scripts/build-cancel-beds-local.js`** — do not hand-edit the hosted export.

---

## 1. Current hosted Cancel workflow

### 1.1 Trigger and entry

| Attribute | Value |
|-----------|--------|
| **Workflow** | Wolfhouse - Cancel Bed Assignments |
| **Export (read-only)** | `n8n/Wolfhouse - Cancel Bed Assignments.json` |
| **Webhook path** | `POST /webhook/cancel-booking-beds` |
| **Webhook ID** | `8ab9d454-04d3-48c1-9cf4-8b0f305e26e7` |
| **Body** | `{ "record_id": "<Airtable Bookings rec…>" }` |
| **Called by** | Airtable automation **“Cancel Booking Beds When Booking Cancelled”** ([`airtable-automations.md`](airtable-automations.md) §4) |

**Automation precondition (Airtable):** **Bookings.Status** = **Cancelled** AND **Booking Beds** is not empty. The workflow does **not** set Status to Cancelled.

### 1.2 Node flow (hosted)

```
Webhook
  → Get Cancelled Booking          (Airtable READ: Bookings by record_id)
  → Code - Prepare Booking Beds    (READ: fields['Booking Beds'] linked IDs)
  → Delete Booking Beds Assignments (Airtable DELETE: Booking Beds table)
  → Update Cancelled Booking Assignment Status (Airtable UPDATE: Bookings)
```

### 1.3 Airtable reads/writes

| Table | Operation | Fields / behaviour |
|-------|-----------|-------------------|
| **Bookings** (`tblYWm3zKFafe4qu7`) | **Read** | `id`, **Booking ID**, **Booking Beds** (linked record IDs) |
| **Booking Beds** (`tblO1ByvTMXS4SalB`) | **Delete** | One `deleteRecord` per linked bed id |
| **Bookings** | **Update** | **Assignment Status** = `Needs Review`; **Availability Check Status** = `Needs Review` |

### 1.4 Booking Beds delete behaviour

- **Hard delete** of each linked Booking Bed row (not soft-delete).  
- If **Booking Beds** is empty, Code emits `no_booking_beds_found`; delete loop is effectively empty; Bookings update still runs.  
- Beds are “released” for Airtable-side availability/planning by removing assignment rows.

### 1.5 Bookings status / assignment updates

| Field | Changed by Cancel workflow? |
|-------|----------------------------|
| **Status** | **No** (already Cancelled before automation) |
| **Assignment Status** | **Yes** → `Needs Review` |
| **Availability Check Status** | **Yes** → `Needs Review` |
| **Payment Status** / money fields | **No** |

### 1.6 What hosted Cancel does **not** touch

| System | Notes |
|--------|--------|
| **Postgres** | Not used today |
| **payments** / Stripe | Not touched |
| **Conversations / Messages** | Not touched |
| **Google Sheets** | Not touched (Planning sync is separate scheduled workflow) |
| **Rooms / Beds** inventory tables | Not touched |
| **Guests** | Not touched |

---

## 2. Local fork goal

| Goal | Detail |
|------|--------|
| **Build local-only fork** | Output: `n8n/phase3b/Wolfhouse - Cancel Bed Assignments (local PG).json` |
| **Postgres mirror step** | Same effect as [`cancel-booking-beds-postgres.js`](../scripts/cancel-booking-beds-postgres.js) `--execute` |
| **Preserve Airtable steps** | Reuse hosted nodes (via build script copy) for AT delete + Bookings update |
| **No hosted import** | Import **only** into `http://localhost:5678` ([`n8n/phase2/README.md`](../n8n/phase2/README.md) pattern) |
| **Regenerate, don’t hand-edit hosted** | `npm run build:cancel-beds:local` from export + injected PG nodes |

### Why `n8n/phase3b/` (not `phase2`)

Phase **2** forks cover payment/Main/Send Confirmation. Phase **3b** forks cover bed inventory ops. Keeps import order and docs separate.

### Postgres execution options (implementation choice)

| Option | Pros | Cons |
|--------|------|------|
| **A. Postgres nodes in n8n** | Native; uses `WOLFHOUSE_DATABASE_URL` on local `n8n` container (already in `docker-compose.local.yml`) | Duplicate SQL vs script — must stay in sync with 3b.1b |
| **B. Execute Command → `npm run db:cancel:booking-beds --execute`** | Single source of truth (script) | Harder in n8n Cloud; OK locally via tools container or mounted repo |
| **C. Sub-workflow HTTP to local script server** | Overkill for 3b.1c | Not recommended |

**Proposal:** Prefer **A (Postgres nodes)** for in-workflow atomicity with AT steps, with SQL copied from 3b.1b and a comment in build script to keep in sync. **Alternative:** **B** if we want zero SQL duplication — run script from **Execute Command** only when `n8n` container has repo mount (document in runbook).

---

## 3. Proposed workflow order (local fork)

```
1. Webhook  cancel-booking-beds
      │  body.record_id = Airtable Bookings rec id
      ▼
2. Identify booking (Postgres)
      │  SELECT bookings by airtable_record_id = record_id
      │  (fail workflow if 0 or >1 rows; surface booking_code in items)
      ▼
3. [Optional] Impact snapshot (read-only branch)
      │  IF $env.CANCEL_IMPACT_LOG=true → Code node logs bed count / keys
      │  OR document: run npm run db:report:cancel-impact before manual test
      ▼
4. Postgres cancel (mutate) — same transaction as 3b.1b
      │  DELETE booking_beds WHERE booking_id + client_id
      │  UPDATE bookings assignment_status, availability_check_status → needs_review
      │  Assert: payment_status unchanged; payments COUNT unchanged
      ▼
5. Get Cancelled Booking (Airtable) — hosted node (unchanged)
      ▼
6. Code - Prepare Booking Beds To Cancel — hosted node (unchanged)
      ▼
7. Delete Booking Beds Assignments — hosted node (unchanged)
      ▼
8. Update Cancelled Booking Assignment Status — hosted node (unchanged)
      ▼
9. Respond to Webhook (optional)
      │  JSON: { ok, booking_code, pg_beds_deleted, at_beds_deleted, idempotent }
```

### Webhook collision rule

On **local** n8n: **deactivate** or **do not import** the hosted Cancel workflow. Only one active workflow may own `cancel-booking-beds`.

### Mapping `record_id` → Postgres

Hosted payload uses **Airtable `rec…` id**. Postgres lookup:

```sql
SELECT id, booking_code, status, payment_status, assignment_status
  FROM bookings
 WHERE client_id = $client_id
   AND airtable_record_id = $record_id
 LIMIT 2;
```

Requires **3.0b** backfill (`airtable_record_id` populated for `WH-rec*` bookings). If missing, PG step errors with clear message — do not guess by phone.

---

## 4. Data safety

### 4.1 Invariants (must hold)

| Rule | Enforcement |
|------|-------------|
| No **payments** / **payment_events** writes | No nodes on those tables |
| No **payment_status** change | PG UPDATE column whitelist; post-check in Code node |
| No **bookings** DELETE | No DELETE on bookings |
| No **status** change in cancel-bed path | PG UPDATE excludes `status` (same as 3b.1b script) |
| Scoped bed delete | `booking_id` + `client_id` only |

### 4.2 Idempotency (call webhook twice)

| Layer | Second call |
|-------|-------------|
| **Postgres** | DELETE 0 rows; UPDATE sets same enums → safe |
| **Airtable** | Delete on missing records may no-op; update idempotent |
| **Workflow** | Should return **200** with `idempotent: true` when both sides already clean |

### 4.3 Failure matrix

| Scenario | System state | Detection | Recovery |
|----------|--------------|-----------|----------|
| **PG ok, AT delete fails** | PG: 0 beds; AT: beds remain | `db:report:bed-drift` → keys **only in CSV** for booking | Retry webhook (AT delete only effective); or manual AT delete; PG already idempotent |
| **PG fails, AT ok** | PG: beds remain; AT: 0 beds | Drift → keys **only in PG** | Run `npm run db:cancel:booking-beds --execute`; or retry fork after fixing PG error |
| **PG ok, AT update fails** | Beds gone both sides possible; assignment fields diverge | Drift / spot-check AT assignment columns | Retry AT update node; PG assignment already `needs_review` |
| **Webhook timeout mid-flow** | Unknown | Re-run impact + bed-drift | Retry idempotent webhook; inspect n8n execution log |

**Proposal:** After PG step, set execution metadata (`pg_cancel_done: true`). If AT branch fails, n8n execution shows error; operator runs bed-drift before retry.

**No automatic payment rollback** in any failure mode.

### 4.4 Airtable credentials (local testing)

| Environment | Rule |
|-------------|------|
| **Local n8n** | Map Airtable credential to **test PAT** + optional **test base** copy |
| **Production base** | **Do not** run 3b.1c fork against production until explicit cutover plan |
| **Automation** | Point test automation to `http://localhost:5678/webhook/cancel-booking-beds` only in dev |

---

## 5. Rollback

| Action | Effect |
|--------|--------|
| **Deactivate** local fork in n8n UI | Webhook stops; hosted Cloud unchanged |
| **Delete** local fork import | Same |
| **Re-import hosted export** | Only if you replaced Cancel on local n8n — re-import from `n8n/Wolfhouse - Cancel Bed Assignments.json` (read-only git copy) |
| **`npm run db:sync`** | Rebuild local PG `booking_beds` from CSV (**local only**) |
| **Payments** | **Never** rolled back by this phase |

### Git tags (suggested)

| Tag | When |
|-----|------|
| `phase3b-1b-pass` | Before 3b.1c implementation (already have `0788f06`) |
| `phase3b-1c-pass` | After local fork tests pass |

---

## 6. Test plan

### 6.1 Fixture

- Booking with **≥1** `booking_beds` in Postgres and AT (e.g. `WH-rechKjCcySkfLzxUD` after `db:sync`).  
- `airtable_record_id` backfilled.  
- **Test** Airtable base or isolated records — not production staff workflow.

### 6.2 Steps

| Step | Action | Pass criteria |
|------|--------|---------------|
| T0 | `npm run db:report:cancel-impact -- --booking-code=WH-rec…` | Lists beds to remove |
| T0b | `npm run db:report:bed-drift` | Baseline mirror clean (optional) |
| T1 | Set booking **Cancelled** in AT (or use already-cancelled test row) | Automation can fire |
| T2 | `POST http://localhost:5678/webhook/cancel-booking-beds` `{ "record_id": "rec…" }` | n8n execution success |
| T3 | Verify PG | `SELECT COUNT(*) FROM booking_beds WHERE booking_id = …` → **0** |
| T4 | Verify AT (test base only) | Booking Beds empty; Assignment / Availability → Needs Review |
| T5 | Repeat POST (idempotency) | 200; no duplicate errors |
| T6 | `npm run db:report:bed-drift` | **0** actionable key mismatch for fixture |
| T7 | `npm run planning:report:postgres` | Fixture bed rows absent |
| T8 | `npm run test:phase2f-resolver` | 10/10 |
| T9 | `npm run db:report:drift` | `missing_airtable_record_id=0` (unchanged) |

### 6.3 Manual webhook example

```powershell
$body = @{ record_id = "recXXXXXXXXXXXXXX" } | ConvertTo-Json
Invoke-RestMethod -Method POST -Uri "http://localhost:5678/webhook/cancel-booking-beds" -Body $body -ContentType "application/json"
```

Use the **Airtable record id** from `bookings.airtable_record_id`, not `WH-rec…` booking code.

### 6.4 Expected bed-drift

After successful **PG + AT** run: per-booking bed counts match export → bed-drift exit **0** for that booking.

After **PG-only** (3b.1b) without AT: exit **1** with keys only in CSV — **not** the 3b.1c pass state.

---

## 7. Files if approved (implementation)

| Action | Path |
|--------|------|
| **Create** | `scripts/build-cancel-beds-local.js` |
| **Create** | `n8n/phase3b/Wolfhouse - Cancel Bed Assignments (local PG).json` (generated) |
| **Create** | `n8n/phase3b/README.md` |
| **Create** | `docs/PHASE-3b-1c.md` (runbook after implementation) |
| **Modify** | `package.json` — `"build:cancel-beds:local": "node scripts/build-cancel-beds-local.js"` |
| **Modify** | `docs/regression-test-plan.md` — Phase 3b.1c section |
| **Optional** | `scripts/test-cancel-beds-webhook.ps1` — local POST helper (like Phase 2 test scripts) |

**Not modified:**

- `n8n/Wolfhouse - Cancel Bed Assignments.json` (hosted export)  
- `scripts/cancel-booking-beds-postgres.js` (keep CLI; fork SQL must match)  
- Assign / Reassign exports  

### Build script responsibilities

1. Read hosted Cancel JSON.  
2. Insert nodes: **Resolve booking in Postgres**, **Postgres cancel** (DELETE + UPDATE), optional **assert payments unchanged**.  
3. Rewire connections: Webhook → PG branch → existing Get Cancelled Booking → …  
4. Strip hosted credential IDs (map in n8n UI after import).  
5. Write `n8n/phase3b/... (local PG).json`.  
6. Fail build if hosted export node names change (guard list).

---

## 8. Approval checklist

- [ ] Owner approves **Postgres-before-Airtable** order in local fork  
- [ ] Test Airtable base / PAT confirmed for local n8n  
- [ ] Owner confirms **no** hosted Cloud import of fork  
- [ ] SQL duplication strategy: Postgres nodes **vs** Execute Command to 3b.1b script  
- [ ] Main / staff automations remain on Cloud until explicit cutover (separate phase)  

---

## 9. Sequence in Phase 3b

```
3b.0   bed drift audit (read-only)           ✅
3b.1a  cancel impact report (read-only)     ✅
3b.1b  cancel-booking-beds-postgres.js      ✅
3b.1c  local n8n fork PG → AT               ← this proposal
3b.2   Assign dual-write                    not started
3b.3   Reassign                             not started
```

---

## References

| Item | Location |
|------|----------|
| Hosted Cancel export | `n8n/Wolfhouse - Cancel Bed Assignments.json` |
| Postgres cancel CLI | `scripts/cancel-booking-beds-postgres.js` (`0788f06`) |
| Impact report | `scripts/report-cancel-impact.js` |
| Automation trigger | `docs/airtable-automations.md` §4 |
| Phase 2 fork pattern | `scripts/build-send-confirmation-local.js`, `n8n/phase2/` |
| Local DB URL on n8n | `infra/docker-compose.local.yml` → `WOLFHOUSE_DATABASE_URL` |
