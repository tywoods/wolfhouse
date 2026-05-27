# Phase 3b.5 — Operator Room Release (local PG mirror) (proposal)

**Status:** Proposal only — **no implementation**, workflow JSON edits, hosted import, production Airtable writes, or production cutover.  
**Prerequisites:** Phase **3b.0**–**3b.4c** complete and frozen ([`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md); 3b.4c sign-off commit **`8aa74b9`**).  
**Parents:** [`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md), [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md), [`PHASE-3b-4c.md`](PHASE-3b-4c.md), [`workflow-dependency-map.md`](workflow-dependency-map.md)

**Explicitly out of scope for 3b.5 (this proposal and any substeps until approved):**

- **Phase 3c** / Main Postgres integration, Send Confirmation, Staff Reply / Return To Bot  
- Editing **hosted** n8n exports ([`n8n/Wolfhouse - Operator Room Release.json`](../n8n/Wolfhouse%20-%20Operator%20Room%20Release.json) — read-only input)  
- Import or activation on **hosted** n8n Cloud  
- **Production** Airtable base `appOCWIN47Bui9CSS` (test base / PAT only for local E2E, same pattern as 3b.4c)  
- **Google Sheets** — this workflow does **not** read or write Sheets  
- **`payments`**, **`payment_events`**, Stripe Create Session / Webhook, Main, Send Confirmation  
- **`conversations`**, **`messages`** (WhatsApp path)  
- **`database/migrations/*`** (schema for `operator_room_release_requests` already exists in `001_init.sql`)  
- Changing Airtable automation scripts or staff UI layout  

---

## Executive summary

**Operator Room Release** is a **staff-driven split** of an existing **operator whole-room block** booking. When an operator frees part of a room’s blocked date range, the system **cancels the original block booking**, **cancels its bed assignments**, and optionally **creates one or two new operator block bookings** (Block A before the release window, Block B after) so the room stays blocked outside the released dates.

Today the hosted workflow is **Airtable-only** (no Postgres nodes). Phase **3b.5** adds the same **local dual-write pattern** as 3b.1c–3b.4c: **Postgres first**, then existing Airtable nodes, with read-only impact reporting and a CLI mirror before the n8n fork.

**Recommended substeps:** **3b.5a** impact report → **3b.5b** Postgres CLI mirror → **3b.5c** local n8n fork (`build-operator-room-release-local.js`).

The **3b.4a → 3b.4b → 3b.4c** ladder fits; this workflow is smaller than Manual Entries (no Sheets queue, single webhook per release request).

---

## 1. Current hosted Operator Room Release workflow

### 1.1 Workflow identity

| Attribute | Value |
|-----------|--------|
| **Workflow name** | Wolfhouse - Operator Room Release |
| **Export (read-only)** | [`n8n/Wolfhouse - Operator Room Release.json`](../n8n/Wolfhouse%20-%20Operator%20Room%20Release.json) |
| **Hosted workflow id** | `CJV5wqk5yp29ZK1c` (export metadata) |
| **Webhook node** | `Free Up Operator Room - Webhook` |
| **Webhook path** | `POST /webhook/operator-room-release` |
| **Webhook id** | `57ad4c53-f371-4d6f-a632-b8133abdd315` |
| **Production URL (today)** | `https://tywoods.app.n8n.cloud/webhook/operator-room-release` ([`webhook-map.md`](webhook-map.md)) |

### 1.2 Trigger source and payload

| Item | Detail |
|------|--------|
| **Caller** | **Airtable automation** when a record is **created** in **Operator Room Release Request** ([`airtable-automations.md`](airtable-automations.md) §2) |
| **Expected body** | `{ "record_id": "<release_request_airtable_rec_id>" }` — n8n reads `$json.body.record_id \|\| $json.record_id` on **Get Release Request** |
| **Not called from** | Main, Manual Entries, Google Sheets, or Assign/Cancel/Reassign webhooks directly |

### 1.3 Google Sheets

**None.** Staff use **Airtable** “Operator Room Release Request” only for this path.

### 1.4 Postgres (hosted)

**None.** The export contains **no** `postgres` nodes. Postgres table **`operator_room_release_requests`** exists in [`database/migrations/001_init.sql`](../database/migrations/001_init.sql) but is **not written** by the hosted workflow today.

### 1.5 Airtable tables used

| Table | Table ID (export) | Operations |
|-------|-------------------|------------|
| **Operator Room Release Request** | `tblWslWOfwbgoQGZy` | **Get** by `record_id` from webhook |
| **Bookings** | `tblYWm3zKFafe4qu7` | **Search** (broad filter), **Update** (cancel original), **Create** (Block A / Block B) |
| **Booking Beds** | `tblO1ByvTMXS4SalB` | **Update** — set **Status = Cancelled** on each bed linked to original booking |

**Production base in export:** `appOCWIN47Bui9CSS` (“Wolfhouse Ops”). Local fork must remap to a **test base** (pattern: 3b.4c uses `appiyO4FmkKsyHZdK` + `--verify-targets`).

**Release request fields read** (from **Code - Pick Matching Operator Booking** + **Get Release Request**):

- `Operator`, `Room to Release`, `Release Start Date`, `Release End Date`  
- (Field usage also documented in [`airtable-field-usage.md`](airtable-field-usage.md) § Operator Room Release Request)

### 1.6 Node graph (hosted)

```
Free Up Operator Room - Webhook
  → Get Release Request                    (AT: Operator Room Release Request by record_id)
  → Search Matching Operator Booking       (AT: Bookings search — Operator + Whole Room + not Cancelled/Expired)
  → Code - Pick Matching Operator Booking  (exactly one match required)
  → Code - Prepare Split Operator Blocks   (compute Block A/B date ranges + WH-… booking ids)
  → Cancel Original Operator Booking       (AT: Bookings update — Status Cancelled, Assignment Needs Review)
  → Code - Prepare Original Booking Beds To Cancel
  → Cancel Original Booking Bed            (AT: Booking Beds update — Status Cancelled, loop)
  → IF - Should Create Operator Block A    → Create Operator Block A   (AT: Bookings create)
  → IF - Should Create Operator Block B    → Create Operator Block B   (AT: Bookings create)
```

**Operational node count:** 11 (webhook + 4 code/if + 6 Airtable).

### 1.7 Matching logic (hosted)

**Search** (Airtable formula, up to **10** rows):

`Booking Source = Operator` AND `Block Type = Whole Room` AND `Status` not Cancelled/Expired.

**Pick** (Code node) requires **exactly one** booking where:

- `Operator Name` === release `Operator`  
- `Room to Block` === release `Room to Release`  
- Date ranges **overlap** (`originalStart < releaseEnd && releaseStart < originalEnd`)

If `match_count !== 1`:

- Sets `found_match: false`, `error_notes` (`No matching…` / `Multiple matching…`)  
- Sets `should_create_a/b: false`  
- **Still proceeds** to **Cancel Original Operator Booking** (no `IF found_match` gate in connections — **unverified** whether n8n fails safely when `original_booking_record_id` is missing; treat as **implementation risk** for 3b.5c).

### 1.8 Split / block behavior (hosted)

When `found_match: true`:

| Step | Behavior |
|------|----------|
| **Cancel original** | Booking **Status → Cancelled**, **Assignment Status → Needs Review**, **Staff Notes** = split note |
| **Cancel beds** | Each linked **Booking Beds** record → **Status Cancelled** (not DELETE) |
| **Block A** | Created if `original_check_in < release_start` — dates `[original_check_in, release_start)` |
| **Block B** | Created if `release_end < original_check_out` — dates `[release_end, original_check_out)` |
| **New booking fields** | `Booking Source = Operator`, `Block Type = Whole Room`, `Operator Name`, `Room to Block`, `Guest Name`/`Email` = operator name, `Payment Status = not_requested`, amounts **0**, **Assignment Status = Unassigned**, **Status = Confirmed** |
| **Booking ID** | Generated in code as `WH-YYMMDD-{A\|B}-{4-digit random}` (not `WH-rec…`; AT automation “Create Booking ID” may still run separately — **unverified**) |

**Does not** create **Booking Beds** in this workflow. New blocks are **Unassigned**; [`airtable-automations.md`](airtable-automations.md) §3 **Assign Beds When Booking Is Unassigned** likely runs **after** Block A/B create (**downstream**, not in this JSON).

### 1.9 What it does **not** touch

| System | Touched? |
|--------|----------|
| **Google Sheets** | No |
| **`payments` / `payment_events`** | No nodes; new bookings set **Payment Status = not_requested** and money fields **0** only on **Bookings** |
| **Stripe / Main / Send Confirmation** | No |
| **`conversations` / `messages`** | No |
| **Manual Entries queue** | No |
| **Cancel / Assign / Reassign webhooks** | No HTTP calls to those paths in export |
| **Operator Room Release Request table (write-back)** | **No update node** in export — `error_notes` / `Original Booking` / `New Booking A/B` links may be **manual or AT-side** — **unverified** |
| **Postgres** | No (hosted) |

### 1.10 Relation to PHASE-3b-PROPOSAL table

[`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md) says Operator Release “Assign all beds in room”. The **hosted export does not assign beds**; it creates **Unassigned** operator blocks. **Bed assignment is expected via separate Assign automation** (regression §2.5). 3b.5 should document both layers and not reimplement **Choose Beds** in the release fork unless explicitly approved.

---

## 2. Purpose of Phase 3b.5

### 2.1 Plain English

Surf camp operators sometimes **block a whole room** for their own use (operator block). If they **no longer need the room for part of that period**, staff file an **Operator Room Release Request** in Airtable. The workflow **shortens the block** by cancelling the old whole-room booking and **recreating one or two smaller block bookings** around the released dates so inventory stays correct for guests and planning.

This is **not** a generic “release room to sell to guests” UI in Main/WhatsApp — it is **operator inventory management** tied to `booking_source = operator` and `block_type = whole_room`.

### 2.2 Why after Manual Entries (3b.4)

| Reason | Detail |
|--------|--------|
| **Roadmap order** | [`PROJECT-ROADMAP.md`](PROJECT-ROADMAP.md) and [`recommended-migration-order.md`](recommended-migration-order.md): Manual Entries (3e) → Operator Room Release (3f) |
| **3b dependency chain** | [`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md): cancel → assign → reassign → manual entries → **operator release** |
| **Shared primitives** | Release **reuses cancel + create booking patterns** already proven in 3b.1–3b.4c; Manual Entries added **create/update/delete + overlap gates** needed for multi-booking staff paths |
| **Lower volume** | Low-traffic staff path; safer after core bed ops and manual queue are frozen locally |

### 2.3 Local Postgres behavior to add or verify

| Layer | Proposed PG behavior |
|-------|----------------------|
| **`operator_room_release_requests`** | UPSERT row from release request (`operator_name`, `room_code`, dates, `airtable_record_id`, `status`, `error_notes`, links to `original_booking_id`, `new_booking_a_id`, `new_booking_b_id`) |
| **Original booking** | `bookings.status = cancelled`, `assignment_status` mirror, `staff_notes` / split note |
| **Original beds** | Align with 3b.1: **DELETE** `booking_beds` in PG (hosted AT uses **Cancelled** status on bed rows — dual-write must define **PG vs AT semantics** in 3b.5b) |
| **Block A / B** | INSERT new `bookings` (`booking_source = operator`, block metadata, date ranges); **no beds** until Assign runs (PG assign may be **out of scope** for 3b.5 MVP — mirror hosted) |
| **Overlap / match** | Read-only checks in 3b.5a: exactly one PG operator whole-room booking matching release window |
| **Payments** | **No** `payments` / `payment_events` writes; optional `bookings.payment_status = not_requested` mirror only |

### 2.4 Relation to other 3b workflows

| Workflow | Relationship |
|----------|----------------|
| **3b.1 Cancel** | Same “remove beds + cancel booking” outcome on original; release uses **bed Status Cancelled** in AT vs cancel webhook **delete** — document mapping |
| **3b.2 Assign** | **Downstream** for new Block A/B (`Assignment Status = Unassigned`) — do not duplicate Choose Beds in 3b.5 unless scoped |
| **3b.3 Reassign** | Not used by hosted release |
| **3b.4 Manual Entries** | Different staff path (`manual_staff`); may share overlap SQL patterns but not queue/Sheet |

---

## 3. Proposed implementation ladder

The **3b.4a / 3b.4b / 3b.4c** pattern **fits** this workflow.

| Step | Deliverable | Writes? |
|------|-------------|---------|
| **3b.5a** | `db:report:operator-room-release-impact` — given `--release-record-id=rec…` or CLI snapshot: match count, would-cancel booking + beds, would-create Block A/B, overlaps, payments untouched | **Read-only** |
| **3b.5b** | `db:operator-room-release:postgres` — execute same plan in PG only (`--execute`) | **PG only** |
| **3b.5c** | `build-operator-room-release-local.js` → `n8n/phase3b/Wolfhouse - Operator Room Release (local PG).json` | PG + AT (test base) |

### 3.1 Why not skip straight to 3b.5c

| Concern | Mitigation |
|---------|------------|
| **Ambiguous match** (0 or N bookings) | 3b.5a must surface before any execute |
| **PG/AT bed cancel semantics** | Decide DELETE vs status in 3b.5b before n8n injection |
| **No write-back to release request in hosted JSON** | 3b.5a/5b define whether PG tracks outcome even if AT request row stale |
| **Missing `found_match` gate** | 3b.5c should add **IF found_match** before cancel (local improvement; do not edit hosted export) |

### 3.2 Proposed local workflow order (3b.5c sketch)

```
Webhook operator-room-release
  → Get Release Request (test base)
  → [optional] Postgres - Upsert operator_room_release_requests
  → Search + Code - Pick Matching (hosted logic)
  → IF - found_match === true
       ├─ false → Postgres - Set error_notes; Respond (no AT cancel)
       └─ true
            → Code - Prepare Split Operator Blocks
            → Postgres - Cancel original booking + delete/cancel beds
            → Cancel Original Operator Booking (AT)
            → Cancel Original Booking Beds (AT)
            → IF Block A → Postgres INSERT booking A → Create Operator Block A (AT) → backfill ids
            → IF Block B → Postgres INSERT booking B → Create Operator Block B (AT) → backfill ids
            → Postgres - Link release request → original / A / B
  → Code - Build Response (partial_failure flags)
```

**Stable local id (proposed):** `B3b5OperatorRoomLocal01`  
**Stable local webhook id (proposed):** `b3b5c001-0005-4000-8000-000000000005` (new UUID; not hosted `57ad4c53-…`)

---

## 4. Data safety

| Rule | Detail |
|------|--------|
| **Local / test only** | Test Airtable base + PAT; `docker compose` local stack |
| **No hosted workflow edits** | `n8n/Wolfhouse - Operator Room Release.json` remains read-only source |
| **No production cutover** | Hosted Cloud URL and `appOCWIN47Bui9CSS` unchanged |
| **No payment mutation** | No `payments` / `payment_events`; booking money fields zeroed on create mirror AT only |
| **No Phase 3c / Main** | No WhatsApp, hold creation, or inline Main assignment |
| **Inactive until tests** | Local fork **inactive** after E2E; `docker restart n8n-main` for webhook register/unregister (3b.4c lesson) |
| **Generated JSON only** | `n8n/phase3b/*.json` produced by build script, not hand-edited |
| **Never DELETE `bookings`** | Cancel updates status (same as 3b.4 delete path) |
| **Rollback** | `db:cancel:booking-beds` / manual PG delete for test bookings; re-import hosted JSON if needed ([`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md) §7) |

---

## 5. Dependencies

| Dependency | Status / notes |
|------------|----------------|
| **3b.0–3b.4c frozen** | Required — bed ops + manual entries MVP signed off |
| **Local Postgres** | `wolfhouse-somo` client, seeded `rooms`/`beds`, `operator_room_release_requests` table exists |
| **3.0b airtable id backfill** | Block A/B and release row need `airtable_record_id` backfill pattern (3b.4c style) |
| **Hosted behavior reference** | [`n8n/Wolfhouse - Operator Room Release.json`](../n8n/Wolfhouse%20-%20Operator%20Room%20Release.json) |
| **Airtable automation contract** | `{ record_id }` on create — [`airtable-automations.md`](airtable-automations.md) |
| **Assign automation (downstream)** | Unassigned operator blocks may trigger **Assign Beds** — local Assign fork (3b.2c) should be active only if testing full room block |
| **Test data** | Pre-seed **one** operator whole-room booking + linked beds in **test** AT/PG matching a release request — IDs TBD in 3b.5a runbook |

---

## 6. Test plan (MVP — mark **unverified** until 3b.5c E2E)

| # | Scenario | Expected (proposed) | Verified |
|---|----------|---------------------|----------|
| T1 | **Happy path** — release window in middle of operator block | Original cancelled; beds cleared/cancelled; Block A + Block B created in AT+PG; release row linked | ☐ unverified |
| T2 | **Release at start** — only Block B | No Block A; Block B only | ☐ unverified |
| T3 | **Release at end** — only Block A | Block A only; no Block B | ☐ unverified |
| T4 | **Full release equals block** — no A/B | Original cancelled; no new blocks | ☐ unverified |
| T5 | **No match** (`match_count = 0`) | **No** AT cancel; `error_notes` set; PG request `status = failed` | ☐ unverified |
| T6 | **Ambiguous match** (`match_count > 1`) | Same as T5 | ☐ unverified |
| T7 | **Repeat webhook** (same `record_id`) | Idempotency rules TBD — likely fail or no-op second cancel | ☐ unverified |
| T8 | **Invalid / missing `record_id`** | Webhook/AT get fails; no PG mutation | ☐ unverified |
| T9 | **Overlap with guest beds** | 3b.5a report flags conflict; execute blocked or `partial_failure` | ☐ unverified |
| T10 | **No payment mutation** | `payments` / `payment_events` row count unchanged | ☐ unverified |
| T11 | **Post-run drift** | `db:report:bed-drift`, `planning:report:postgres` (recommended, not blocking MVP) | ☐ unverified |
| T12 | **Assign follow-on** (optional) | New blocks get beds via local Assign fork — regression §2.5 | ☐ unverified |

**Regression doc:** [`regression-test-plan.md`](regression-test-plan.md) §9 (generic); extend with **Phase 3b.5** section when runbook exists.

**Rollback / cleanup:** Document test `booking_code` / AT rec ids in `PHASE-3b-5.md`; use `db:cancel:booking-beds --execute` for PG test blocks; AT cleanup manual or test-base only.

---

## 7. Files if approved (likely — not created by this proposal)

| File | Purpose |
|------|---------|
| [`docs/PHASE-3b-5.md`](PHASE-3b-5.md) | Runbook + sign-off evidence (after 3b.5c) |
| `scripts/report-operator-room-release-impact.js` | 3b.5a read-only impact |
| `scripts/lib/operator-room-release-impact-plan.js` | Shared match/split plan |
| `scripts/operator-room-release-postgres.js` | 3b.5b PG execute (`--execute`) |
| `scripts/lib/operator-room-release-pg-n8n-sql.js` | SQL for n8n postgres nodes |
| `scripts/build-operator-room-release-local.js` | Generate/neutralize/inject PG nodes |
| `n8n/phase3b/Wolfhouse - Operator Room Release (local PG).json` | Generated fork |
| `n8n/phase3b/Wolfhouse - Operator Room Release (local PG).n8n-import.json` | CLI re-import |
| `n8n/phase3b/README.md` | Section for Operator Room Release |
| `package.json` | `db:report:operator-room-release-impact`, `db:operator-room-release:postgres`, `build:operator-room-release:local` (optional) |
| `scripts/test-operator-room-release-webhook.ps1` | Optional local POST helper |
| [`docs/regression-test-plan.md`](regression-test-plan.md) | Phase 3b.5 pass table |
| [`docs/PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md) | Update when signed off |

---

## 8. Unknowns and risks

| Unknown | Risk | Proposal handling |
|---------|------|-------------------|
| **No `IF found_match` before cancel in hosted graph** | No-match path may hit **Cancel Original** with empty `id` | Add gate in **local fork only**; document in 3b.5a |
| **Release request table never updated in n8n** | Staff may not see `error_notes` / booking links on request row | 3b.5a inspect AT automations; optional PG-only audit trail |
| **Booking Beds: AT Cancelled vs PG DELETE** | Drift between layers | Explicit mapping in 3b.5b |
| **Block A/B bed assignment** | Planning shows unassigned blocks until Assign runs | MVP mirrors hosted (bookings only); optional T12 |
| **`WH-YYMMDD-A-####` vs `WH-rec…` booking codes** | PG `booking_code` uniqueness / sync | 3b.5a define mapping; backfill after AT create |
| **Exactly-one match relies on AT search limit 10** | Missed match if >10 operator blocks | Rare; 3b.5a may query PG without limit |
| **Repeat webhook idempotency** | Double cancel / duplicate blocks | Not defined in hosted export — design in 3b.5b |
| **Payments** | Appears **not** touched | Confirm in 3b.5a static analysis |
| **“Operator UI release” vs room state** | Name sounds like UI; behavior is **booking split** | This proposal treats it as **operator block split**, not Main rooming |
| **Test base IDs** | Prod base baked in export | `--verify-targets` on build script (3b.4c pattern) |
| **Whether 3b.5b CLI alone is sufficient for sign-off** | Could skip n8n if staff only use AT automation locally | Recommend **3b.5c** for parity with 3b.1c–3b.4c; owner decision at 3b.5a review |

---

## 9. Owner approval checklist (before 3b.5a implementation)

- [ ] Accept **PG-first cancel + create** for operator block splits with **test Airtable base** only.  
- [ ] Accept **no Booking Beds** on new blocks in MVP (Assign automation or manual follow-up).  
- [ ] Accept **local `IF found_match` gate** even if hosted export lacks it.  
- [ ] Confirm **test operator block + release request** fixtures in test base (not production `appOCWIN47Bui9CSS`).  
- [ ] Confirm **no** `payments` / Main / Manual Entries changes in 3b.5.  

---

## 10. References

| Item | Location |
|------|----------|
| Hosted export | `n8n/Wolfhouse - Operator Room Release.json` |
| Webhook map | `docs/webhook-map.md` |
| AT automation | `docs/airtable-automations.md` §2 |
| Workflow map | `docs/workflow-dependency-map.md` §8 |
| PG schema | `database/migrations/001_init.sql` (`operator_room_release_requests`) |
| Field map | `docs/airtable-field-usage.md` |
| Prior art (build) | `scripts/build-manual-entries-local.js`, `scripts/build-cancel-beds-local.js` |
| Regression §9 | `docs/regression-test-plan.md` |

---

## Sign-off (proposal only)

| Role | Date | Notes |
|------|------|--------|
| Proposal author | 2026-05-27 | From hosted export inspection; no E2E |

**Next stage after approval:** implement **3b.5a** read-only impact report only.
