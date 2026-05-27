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
- Changing Airtable automation scripts or staff UI layout on **production** (local may add **deprecated** compatibility only)  
- **Building a long-term Airtable-based Operator Room Release system** — see §1.2 non-goal  

---

## Executive summary

**Operator Room Release** is a **staff-driven split** of an existing **operator whole-room block** booking. When an operator frees part of a room’s blocked date range, the system **cancels the original block booking**, **cancels its bed assignments**, and optionally **creates one or two new operator block bookings** (Block A before the release window, Block B after) so the room stays blocked outside the released dates.

Today the hosted workflow is **Airtable-triggered** (no Postgres nodes). Phase **3b.5** establishes **Postgres as the backend source of truth** for release logic and outcomes. **Airtable is temporary scaffolding only** — used to mirror today’s hosted behavior during local validation, not as the desired long-term operator input or system of record.

**Recommended substeps:** **3b.5a** impact report + **input-surface decision** → **3b.5b** Postgres CLI mirror (payload-driven, not AT-record-dependent) → **3b.5c** local n8n fork preferring **direct webhook payload** over `record_id` lookup.

The **3b.4a → 3b.4b → 3b.4c** ladder fits with the above constraints; this workflow is smaller than Manual Entries (no Sheets queue).

---

## 1. Airtable temporary scaffolding only

### 1.1 Current reality (reference only)

| Item | Today (hosted) | Long-term intent |
|------|----------------|------------------|
| **Staff input** | Airtable **Operator Room Release Request** form/table + automation on record create | **Replace** — not extend |
| **Webhook payload** | `{ "record_id": "<airtable_rec_id>" }` then **Get Release Request** | **Replace** with direct fields in body (or form POST) |
| **Booking writes** | Airtable Bookings + Booking Beds nodes | **Postgres first**; AT mirror only while dual-write window lasts, then **remove** |
| **Audit trail** | Sparse in AT (export does not write back to request row) | **`operator_room_release_requests`** in Postgres |

The existing hosted workflow ([`n8n/Wolfhouse - Operator Room Release.json`](../n8n/Wolfhouse%20-%20Operator%20Room%20Release.json)) documents **how production works today**. 3b.5 treats that export as **read-only reference**, not as the architecture to preserve.

### 1.2 Explicit non-goal

**Do not build a long-term Airtable-based Operator Room Release system.**

3b.5 must **not**:

- Add new Airtable tables, forms, views, or automations intended as permanent staff UX  
- Deepen dependency on `record_id` → Get Release Request as the only entry path  
- Require staff to maintain release state in Airtable after Postgres + a proper operator input exist  

Temporary Airtable use in 3b.5 is limited to **compatibility testing** (hosted parity, test base) and **optional dual-write** during the migration window — same spirit as other 3b forks, but with a **documented exit**: remove AT from this path once PG + replacement input are signed off.

### 1.3 Avoid deepening Airtable dependency

| Do | Do not |
|----|--------|
| Implement release **business logic** in PG/SQL and shared JS (`operator-room-release-impact-plan.js`) | Add new AT-only branches or staff-facing AT formulas for release |
| Accept **direct payload** (`operator`, `room_code`, `release_start`, `release_end`) in 3b.5b/3b.5c | Require creating an AT request row for every local test |
| Mirror AT booking/bed writes only where dual-write still required | Design 3b.5c so PG steps are optional sidecars to AT |
| Document AT paths as **deprecated / compatibility** | Position AT form as the “real” operator product |

---

## 2. Preferred long-term direction

### 2.1 Source of truth

| Layer | Target |
|-------|--------|
| **Release requests** | Postgres `operator_room_release_requests` (status, errors, links to bookings) |
| **Inventory effect** | Postgres `bookings` + `booking_beds` (cancel original, create Block A/B) |
| **Staff input** | **Not** Airtable long-term |

Airtable may remain a **temporary write mirror** for Bookings/Beds only until planning and staff tools read Postgres — then **remove** those nodes from the local fork and retire hosted Operator Room Release on Cloud.

### 2.2 Replacement input surfaces (preferred order)

Decide in **3b.5a**; implement the chosen path in **3b.5c** (or defer AT compatibility to a single deprecated branch).

| Priority | Option | When to use |
|----------|--------|-------------|
| **A** | **n8n Form** → webhook with JSON body (`operator`, `room_code`, `release_start`, `release_end`) | **MVP** if fast enough — no new app repo; staff bookmark form URL on local/Azure n8n |
| **B** | **Simple internal web form** (static HTML + POST to webhook, or minimal route in future operator app) | If n8n Form UX is insufficient but full board is too heavy |
| **C** | **Future operator UI / planning board** | Long-term; shares PG APIs with 3b.5b |

**Deprecated (compatibility only):** Airtable record create → `{ record_id }` — retain only if needed to regression-match hosted behavior on test base; mark for removal in `PHASE-3b-5.md` exit criteria.

### 2.3 Exit criteria (remove Airtable from this path)

- 3b.5b can run end-to-end from **CLI or direct payload** with no AT request record  
- 3b.5c E2E passes with **preferred input** (Form or web POST)  
- Postgres `operator_room_release_requests` holds outcome + errors staff need  
- Dual-write AT booking nodes **neutralized or removed** from local fork; hosted workflow **not** updated in place (retire on cutover)

---

## 3. Current hosted Operator Room Release workflow (reference)

### 3.1 Workflow identity

| Attribute | Value |
|-----------|--------|
| **Workflow name** | Wolfhouse - Operator Room Release |
| **Export (read-only)** | [`n8n/Wolfhouse - Operator Room Release.json`](../n8n/Wolfhouse%20-%20Operator%20Room%20Release.json) |
| **Hosted workflow id** | `CJV5wqk5yp29ZK1c` (export metadata) |
| **Webhook node** | `Free Up Operator Room - Webhook` |
| **Webhook path** | `POST /webhook/operator-room-release` |
| **Webhook id** | `57ad4c53-f371-4d6f-a632-b8133abdd315` |
| **Production URL (today)** | `https://tywoods.app.n8n.cloud/webhook/operator-room-release` ([`webhook-map.md`](webhook-map.md)) |

### 3.2 Trigger source and payload (**temporary**)

| Item | Detail |
|------|--------|
| **Caller (hosted today)** | **Airtable automation** when a record is **created** in **Operator Room Release Request** ([`airtable-automations.md`](airtable-automations.md) §2) — **not** the desired long-term input |
| **Expected body (hosted)** | `{ "record_id": "<release_request_airtable_rec_id>" }` — n8n reads `$json.body.record_id \|\| $json.record_id` on **Get Release Request** |
| **Target body (3b.5c preferred)** | Direct fields, e.g. `{ "operator", "room_code", "release_start", "release_end", "client_slug" }` — no AT lookup required |
| **Not called from** | Main, Manual Entries, Google Sheets, or Assign/Cancel/Reassign webhooks directly |

### 3.3 Google Sheets

**None** in hosted export. Long-term input is **not** Sheets; see §2.2.

### 3.4 Postgres (hosted)

**None.** The export contains **no** `postgres` nodes. Postgres table **`operator_room_release_requests`** exists in [`database/migrations/001_init.sql`](../database/migrations/001_init.sql) but is **not written** by the hosted workflow today.

### 3.5 Airtable tables used (hosted — **temporary mirror target**)

| Table | Table ID (export) | Operations |
|-------|-------------------|------------|
| **Operator Room Release Request** | `tblWslWOfwbgoQGZy` | **Get** by `record_id` from webhook |
| **Bookings** | `tblYWm3zKFafe4qu7` | **Search** (broad filter), **Update** (cancel original), **Create** (Block A / Block B) |
| **Booking Beds** | `tblO1ByvTMXS4SalB` | **Update** — set **Status = Cancelled** on each bed linked to original booking |

**Production base in export:** `appOCWIN47Bui9CSS` (“Wolfhouse Ops”). Local fork must remap to a **test base** (pattern: 3b.4c uses `appiyO4FmkKsyHZdK` + `--verify-targets`).

**Release request fields read** (from **Code - Pick Matching Operator Booking** + **Get Release Request**):

- `Operator`, `Room to Release`, `Release Start Date`, `Release End Date`  
- (Field usage also documented in [`airtable-field-usage.md`](airtable-field-usage.md) § Operator Room Release Request)

### 3.6 Node graph (hosted)

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

### 3.7 Matching logic (hosted)

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

### 3.8 Split / block behavior (hosted)

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

### 3.9 What it does **not** touch

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

### 3.10 Relation to PHASE-3b-PROPOSAL table

[`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md) says Operator Release “Assign all beds in room”. The **hosted export does not assign beds**; it creates **Unassigned** operator blocks. **Bed assignment is expected via separate Assign automation** (regression §2.5). 3b.5 should document both layers and not reimplement **Choose Beds** in the release fork unless explicitly approved.

---

## 4. Purpose of Phase 3b.5

### 4.1 Plain English

Surf camp operators sometimes **block a whole room** for their own use (operator block). If they **no longer need the room for part of that period**, staff submit a **room release request** (today via a **temporary** Airtable form; target: n8n Form, simple web form, or future operator UI). The workflow **shortens the block** by cancelling the old whole-room booking and **recreating one or two smaller block bookings** around the released dates so inventory stays correct for guests and planning.

This is **not** a generic “release room to sell to guests” UI in Main/WhatsApp — it is **operator inventory management** tied to `booking_source = operator` and `block_type = whole_room`.

### 4.2 Why after Manual Entries (3b.4)

| Reason | Detail |
|--------|--------|
| **Roadmap order** | [`PROJECT-ROADMAP.md`](PROJECT-ROADMAP.md) and [`recommended-migration-order.md`](recommended-migration-order.md): Manual Entries (3e) → Operator Room Release (3f) |
| **3b dependency chain** | [`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md): cancel → assign → reassign → manual entries → **operator release** |
| **Shared primitives** | Release **reuses cancel + create booking patterns** already proven in 3b.1–3b.4c; Manual Entries added **create/update/delete + overlap gates** needed for multi-booking staff paths |
| **Lower volume** | Low-traffic staff path; safer after core bed ops and manual queue are frozen locally |

### 4.3 Local Postgres behavior to add or verify

| Layer | Proposed PG behavior |
|-------|----------------------|
| **`operator_room_release_requests`** | UPSERT from **payload** (`operator_name`, `room_code`, dates, `status`, `error_notes`, links to bookings). `airtable_record_id` **optional** — compatibility only, not required for execute |
| **Original booking** | `bookings.status = cancelled`, `assignment_status` mirror, `staff_notes` / split note |
| **Original beds** | Align with 3b.1: **DELETE** `booking_beds` in PG (hosted AT uses **Cancelled** status on bed rows — dual-write must define **PG vs AT semantics** in 3b.5b) |
| **Block A / B** | INSERT new `bookings` (`booking_source = operator`, block metadata, date ranges); **no beds** until Assign runs (PG assign may be **out of scope** for 3b.5 MVP — mirror hosted) |
| **Overlap / match** | Read-only checks in 3b.5a: exactly one PG operator whole-room booking matching release window (**query PG**, not AT search limit 10) |
| **Payments** | **No** `payments` / `payment_events` writes; optional `bookings.payment_status = not_requested` mirror only |
| **Match source of truth** | **Postgres** for 3b.5b execute; AT search in hosted export is **reference** for parity tests only |

### 4.4 Relation to other 3b workflows

| Workflow | Relationship |
|----------|----------------|
| **3b.1 Cancel** | Same “remove beds + cancel booking” outcome on original; release uses **bed Status Cancelled** in AT vs cancel webhook **delete** — document mapping |
| **3b.2 Assign** | **Downstream** for new Block A/B (`Assignment Status = Unassigned`) — do not duplicate Choose Beds in 3b.5 unless scoped |
| **3b.3 Reassign** | Not used by hosted release |
| **3b.4 Manual Entries** | Different staff path (`manual_staff`); may share overlap SQL patterns but not queue/Sheet |

---

## 5. Proposed implementation ladder

The **3b.4a / 3b.4b / 3b.4c** shape **fits**, with **input-surface and AT-deprecation constraints** below (not a clone of Manual Entries’ AT+Sheet coupling).

| Step | Deliverable | Writes? |
|------|-------------|---------|
| **3b.5a** | `db:report:operator-room-release-impact` — payload-driven plan (see §5.1); match count, would-cancel/create, overlaps; **input-surface decision** documented | **Read-only** |
| **3b.5b** | `db:operator-room-release:postgres` — execute plan from **CLI flags / JSON file** (`--operator`, `--room-code`, `--release-start`, `--release-end`); **no dependency** on AT request record | **PG only** |
| **3b.5c** | `build-operator-room-release-local.js` → local fork; **preferred:** webhook parses **direct payload** → PG → optional **deprecated** AT mirror branch | PG required; AT optional |

### 5.1 3b.5a — impact report + input-surface decision

**Required outputs:**

| Output | Detail |
|--------|--------|
| **Impact JSON** | Same as other 3b impact reports: `found_match`, booking/bed actions, Block A/B preview, `payments` untouched |
| **Input-surface decision** | Record chosen path: **(A) n8n Form**, **(B) simple web form**, **(C) defer to future UI**, plus whether **deprecated AT `record_id`** branch is needed for one parity test |
| **PG match query** | Document SQL for operator whole-room match (replaces reliance on AT search `limit: 10`) |
| **Deprecation note** | List AT nodes to omit or gate behind `DATA_SOURCE=airtable` / `COMPAT_AT_MIRROR=true` in 3b.5c |

**CLI examples (proposed):**

```bash
# Preferred — no Airtable
npm run db:report:operator-room-release-impact -- \
  --operator="Surf Week Co" --room-code=R7 --release-start=2027-06-01 --release-end=2027-06-08

# Deprecated compatibility only
npm run db:report:operator-room-release-impact -- --release-record-id=recXXXXXXXX
```

### 5.2 3b.5b — PG-only mirror (AT-independent)

| Principle | Detail |
|-----------|--------|
| **Inputs** | Operator name, room code, release date range, `client_slug` — from argv or `--plan=file.json` |
| **No AT request row** | Do not require `operator_room_release_requests.airtable_record_id` to exist before execute |
| **Match in PG** | Find exactly one `bookings` row: `booking_source = operator`, whole-room block semantics, overlapping dates, matching `room_to_block` / room link |
| **Effects** | Cancel original + beds in PG; INSERT Block A/B bookings; UPDATE `operator_room_release_requests` by **PG id** or `request_code` |
| **AT** | **Not called** in 3b.5b |

### 5.3 3b.5c — local n8n fork (prefer direct payload)

| Path | Priority |
|------|----------|
| **Primary** | `Code - Parse Release Payload` → validate → **Postgres** (3b.5b SQL) → respond with PG + booking ids |
| **Optional mirror** | If `COMPAT_AT_MIRROR` / build flag: run hosted AT cancel/create nodes on **test base** for regression parity — **document as temporary** |
| **Deprecated** | `Get Release Request` by `record_id` — only if parity test required; single branch, clearly labeled in build script inventory |

**Do not** make 3b.5c require staff to create an Airtable request row for normal local operation.

### 5.4 Why not skip straight to 3b.5c

| Concern | Mitigation |
|---------|------------|
| **Ambiguous match** (0 or N bookings) | 3b.5a must surface before any execute |
| **PG/AT bed cancel semantics** | Decide DELETE vs status in 3b.5b before n8n injection |
| **No write-back to release request in hosted JSON** | **PG `operator_room_release_requests`** is the audit trail; do not invest in AT request write-back |
| **Missing `found_match` gate** | 3b.5c must add **IF found_match** before any cancel (local improvement; do not edit hosted export) |
| **Airtable entrenchment** | 3b.5a must pick non-AT input before 3b.5c build |

### 5.5 Proposed local workflow order (3b.5c sketch — **preferred**)

```
Webhook operator-room-release
  → Code - Parse Release Payload (operator, room_code, release_start, release_end)
  → Postgres - Upsert operator_room_release_requests
  → Postgres - Match operator whole-room booking (or Code using PG query result)
  → IF - found_match === true
       ├─ false → Postgres - Set error_notes + status failed; Respond (no cancel)
       └─ true
            → Code - Prepare Split Operator Blocks
            → Postgres - Cancel original booking + delete/cancel beds
            → Postgres - INSERT Block A / B as needed
            → Postgres - Link release request → original / A / B
            → [DEPRECATED optional] AT mirror branch (test base only, build flag)
  → Code - Build Response (partial_failure flags)
```

**Deprecated compatibility branch** (omit from MVP if owner accepts PG-only sign-off for 3b.5):

```
  → Get Release Request (test base)   ← temporary; remove when AT path retired
  → … hosted AT nodes …
```

**Stable local id (proposed):** `B3b5OperatorRoomLocal01`  
**Stable local webhook id (proposed):** `b3b5c001-0005-4000-8000-000000000005` (new UUID; not hosted `57ad4c53-…`)

---

## 6. Data safety

| Rule | Detail |
|------|--------|
| **Local / test only** | `docker compose` local stack; test Airtable base **only** if deprecated mirror branch enabled |
| **No long-term AT UX** | Do not add production AT forms/automations for release; see §1.2 |
| **No hosted workflow edits** | `n8n/Wolfhouse - Operator Room Release.json` remains read-only source |
| **No production cutover** | Hosted Cloud URL and `appOCWIN47Bui9CSS` unchanged |
| **No payment mutation** | No `payments` / `payment_events`; booking money fields zeroed on create mirror AT only |
| **No Phase 3c / Main** | No WhatsApp, hold creation, or inline Main assignment |
| **Inactive until tests** | Local fork **inactive** after E2E; `docker restart n8n-main` for webhook register/unregister (3b.4c lesson) |
| **Generated JSON only** | `n8n/phase3b/*.json` produced by build script, not hand-edited |
| **Never DELETE `bookings`** | Cancel updates status (same as 3b.4 delete path) |
| **Rollback** | `db:cancel:booking-beds` / manual PG delete for test bookings; re-import hosted JSON if needed ([`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md) §7) |

---

## 7. Dependencies

| Dependency | Status / notes |
|------------|----------------|
| **3b.0–3b.4c frozen** | Required — bed ops + manual entries MVP signed off |
| **Local Postgres** | `wolfhouse-somo` client, seeded `rooms`/`beds`, `operator_room_release_requests` table exists |
| **3.0b airtable id backfill** | **Optional** — only if deprecated AT mirror branch runs; PG-first path uses PG booking ids |
| **Hosted behavior reference** | [`n8n/Wolfhouse - Operator Room Release.json`](../n8n/Wolfhouse%20-%20Operator%20Room%20Release.json) — parity reference, not target architecture |
| **Airtable automation contract** | `{ record_id }` — **deprecated**; documented in [`airtable-automations.md`](airtable-automations.md) §2 for hosted-only |
| **Input surface (3b.5a)** | n8n Form URL or web POST contract before 3b.5c |
| **Assign automation (downstream)** | Unassigned operator blocks may trigger **Assign Beds** in AT today — PG Assign fork (3b.2c) when testing full block locally |
| **Test data** | Pre-seed **one** operator whole-room booking + beds in **PG** (and test AT only if mirror branch) — fixtures in 3b.5a runbook |

---

## 8. Test plan (MVP — mark **unverified** until 3b.5c E2E)

| # | Scenario | Expected (proposed) | Verified |
|---|----------|---------------------|----------|
| T0 | **Direct payload** (no AT request record) | PG release request + split completes; response JSON from PG | ☐ unverified |
| T1 | **Happy path** — release window in middle of operator block | Original cancelled; beds cleared in PG; Block A + Block B in PG; optional AT mirror if enabled | ☐ unverified |
| T2 | **Release at start** — only Block B | No Block A; Block B only | ☐ unverified |
| T3 | **Release at end** — only Block A | Block A only; no Block B | ☐ unverified |
| T4 | **Full release equals block** — no A/B | Original cancelled; no new blocks | ☐ unverified |
| T5 | **No match** (`match_count = 0`) | **No** AT cancel; `error_notes` set; PG request `status = failed` | ☐ unverified |
| T6 | **Ambiguous match** (`match_count > 1`) | Same as T5 | ☐ unverified |
| T7 | **Repeat webhook** (same payload / request id) | Idempotency rules TBD — likely fail or no-op second cancel | ☐ unverified |
| T8 | **Invalid / missing payload fields** | Validation error; no PG cancel | ☐ unverified |
| T8b | **Deprecated: `record_id` only** (if branch kept) | Parity with hosted get-request path on test base | ☐ unverified |
| T9 | **Overlap with guest beds** | 3b.5a report flags conflict; execute blocked or `partial_failure` | ☐ unverified |
| T10 | **No payment mutation** | `payments` / `payment_events` row count unchanged | ☐ unverified |
| T11 | **Post-run drift** | `db:report:bed-drift`, `planning:report:postgres` (recommended, not blocking MVP) | ☐ unverified |
| T12 | **Assign follow-on** (optional) | New blocks get beds via local Assign fork — regression §2.5 | ☐ unverified |

**Regression doc:** [`regression-test-plan.md`](regression-test-plan.md) §9 (generic); extend with **Phase 3b.5** section when runbook exists.

**Rollback / cleanup:** Document test `booking_code` / AT rec ids in `PHASE-3b-5.md`; use `db:cancel:booking-beds --execute` for PG test blocks; AT cleanup manual or test-base only.

---

## 9. Files if approved (likely — not created by this proposal)

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
| `scripts/test-operator-room-release-webhook.ps1` | Optional local POST helper (**direct payload**, not `record_id`-only) |
| n8n Form or minimal `operator-release-form.html` | If 3b.5a selects input surface A or B |
| [`docs/regression-test-plan.md`](regression-test-plan.md) | Phase 3b.5 pass table |
| [`docs/PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md) | Update when signed off |

---

## 10. Unknowns and risks

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
| **Whether 3b.5b CLI alone is sufficient for sign-off** | Could skip n8n if webhook/Form not ready | **PG-only sign-off acceptable** for 3b.5 MVP if direct payload + 3b.5b pass; 3b.5c adds Form/webhook |
| **n8n Form vs custom web form** | UX and auth | **Decide in 3b.5a** (§2.2) |
| **Removing AT without PG Assign** | New blocks unassigned in planning | Accept for MVP or chain local Assign explicitly |

---

## 11. Owner approval checklist (before 3b.5a implementation)

- [ ] Accept **Postgres as source of truth** for release requests and booking split effects.  
- [ ] Accept **Airtable input as temporary only** — agree to **non-goal** in §1.2 (no long-term AT release system).  
- [ ] Choose **input surface** for 3b.5c: n8n Form (A), simple web form (B), or PG/CLI-only MVP with Form deferred.  
- [ ] Accept **PG-first cancel + create**; AT mirror **optional** and **deprecated**, test base only.  
- [ ] Accept **no Booking Beds** on new blocks in MVP (Assign automation or manual follow-up).  
- [ ] Accept **local `IF found_match` gate** even if hosted export lacks it.  
- [ ] Confirm **test operator block** fixtures in **PG** (AT test base only if mirror branch).  
- [ ] Confirm **no** `payments` / Main / Manual Entries changes in 3b.5.  

---

## 12. References

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

**Next stage after approval:** implement **3b.5a** read-only impact report + **input-surface decision** (§5.1) only.
