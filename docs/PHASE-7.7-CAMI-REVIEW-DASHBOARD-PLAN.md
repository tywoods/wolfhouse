# Stage 7.7 — Cami Review Dashboard + Editable Bed Calendar Plan

**Status:** IN PROGRESS — 7.7a–j DONE · 7.7k plan DONE · 7.7k1–k8 DONE · **7.7k8 staging gate DESIGN DONE (2026-06-01 — see §5a.10 and §7.7k8 section)**. Backend fully locally proven (k1–k7). Staging gate checklist defined: 17 required gates before reassignment UI is enabled in staging; UI gate conditions; 6-phase approval flow (Phase 0 = current local-only state); hard no-go conditions. No UI wiring. Calendar editing NOT approved. Cami/Ale written sign-off required before any staging/live editable reassignment. Prior: **7.7k7 rollback/undo proof DONE (2026-06-01)**: happy-path undo (move A→B, undo B→A, rows_updated=1, DB restored, rollback_payload proven); conflict-on-undo blocked (target_bed_overlap, rows_updated=0); 47/47 PASS; delta=0. **7.7m manual booking creation requirement added (2026-06-01 — see §5b). Design/planning only. No code. Not required for shadow pilot Phase 1. Required before replacing spreadsheet workflow.** No live operation approved.
**Parent plan:** [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md) — Workstream F (Cami dashboard) + hard gate before Phase 1 (shadow/co-pilot).
**Pilot gate:** [`PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md`](PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md) Section F (F1–F8).
**Builds on:** Stage 6 staff tools (read-only API/UI, query registry, reports/digest, token-gated `handoff.resolve`), Stage 7.2 auth (`staff_users`/`auth_sessions`), Stage 7.3 staging/TLS.
**Bed-calendar reference:** the existing Wolfhouse Excel planning calendar (`Wolfhouse_Planning_Calendar_Prototype`), mirrored in-repo by `scripts/lib/planning-row-format.js` (color/label model) and the Airtable grid-view CSV exports (`database/*-Grid view.csv`, `database/Booking Beds-Active Bed Assignments.csv`).

> **Design document only.** It builds nothing, deploys nothing, sends nothing, and approves no live operation. The dashboard is **read-only by default**; all write/edit/send capabilities are deferred behind explicit later gates. The bed calendar is a **hard requirement** before live Wolfhouse launch unless Cami/Ale sign a written deferral.

---

## 1. Objective

Give Cami a single, safe **control center** for shadow/co-pilot mode so she can run the Wolfhouse pilot without touching n8n, Postgres, or raw queries:

- **Review guest conversations** and the **Luna draft reply** before anything is guest-facing.
- **Reply inline from the dashboard** — Cami can open any conversation, read the full message thread, see Luna's draft, edit it or compose a fresh staff reply, and copy it for manual WhatsApp send (first version) or approve/send directly (later gate). **This is a hard requirement, not a nice-to-have.**
- **See booking / payment / rooming / add-on context** beside each conversation.
- **Manage handoffs** (open / stale / urgent queue; resolve later when the write gate is open).
- **See a spreadsheet-style bed calendar** modelled on the existing Wolfhouse Excel planning calendar — rooms/beds down the side, dates across the top, bookings as date-span blocks.
- **No autonomous live send** is approved in this stage. Cami reviews, edits inline, and sends manually; the dashboard is the review surface, not an auto-pilot.

Success for Stage 7.7 = Cami can do **shadow-mode review end-to-end** (see conversation → read full thread → see Luna draft → edit draft inline or compose reply → copy/send manually → see full booking context → see the bed calendar) with **zero autonomous action** and **zero protected-table mutation**.

---

## 2. Non-goals (do not overbuild the first version)

- No analytics / KPI dashboard.
- No full PMS / channel manager.
- No drag-and-drop calendar editing in v1.
- No owner revenue dashboard.
- No multi-client admin console.
- No autonomous send button.
- No live payment actions.

These are explicitly deferred. The first version optimizes for **Cami's daily review loop**, nothing more.

---

## 3. Minimum dashboard views

### A. Inbox / conversation list
The landing screen. One row per active conversation.

| Field | Source |
|---|---|
| Guest name / display name | `conversations.display_name` |
| Phone | `conversations.phone` |
| Latest message preview | `conversations.last_message_preview` |
| Language | `conversations.language` |
| Status | `conversations.status` (`open`/…) |
| Needs human | `conversations.needs_human` |
| Bot mode | `conversations.bot_mode` (`bot`/`human`/…) |
| Handoff reason (if any) | `staff_handoffs.reason_code` (latest open) |
| Booking code (if known) | `bookings.booking_code` via `current_hold_booking_id` |
| Last activity | `conversations.updated_at` |
| Priority | derived from open handoff priority (urgent→low) |

Sort: needs_human + urgent handoffs first, then most recent activity. Filters: needs_human, has open handoff, language, has booking.

### B. Conversation detail
Opened from an inbox row. This is the primary Cami work surface.

| Element | Source |
|---|---|
| Message history (threaded, in/out) | `messages` (`direction`, `message_text`, `created_at`, `route`) |
| Latest guest message | most recent inbound `messages` row |
| **Luna draft reply** | `conversations.staff_reply_draft` (clearly labelled **DRAFT — NOT SENT**) |
| Route / intent | `messages.route`, `conversations.conversation_stage`, `pending_action` |
| Confidence / debug summary (if safe) | `conversations.session_state` / `metadata` (sanitized; no secrets, no raw prompts) |
| Staff notes | `conversations.human_notes`, `internal_staff_notes` |
| Staff takeover status | `conversations.bot_mode`, `last_staff_reply_at` |
| **Inline staff reply composer** | editable text area — see §3.H |
| **Edit-draft area** | pre-populated with `staff_reply_draft`; Cami edits before copy or send |
| **Copy-to-clipboard button** | copies the composed reply for manual WhatsApp send (shadow/Phase 1) |
| **Approve / send button** | **disabled by default; gated** — appears only after live-send gate passes (later phase) |
| **Staff takeover controls** | "Take over conversation" / "Return to Luna" — see §3.H |
| **Reply audit trail** | list of staff replies / manual-reply marks with actor + timestamp |

### C. Booking context panel
Beside the conversation; resolved from the linked booking.

| Field | Source |
|---|---|
| Dates (check-in / check-out / nights) | `bookings.check_in`, `check_out` |
| Guest count | `bookings.guest_count` |
| Package | `bookings.package_code` |
| Room preference / requested type | `bookings.room_preference`, `requested_room_type`, `guest_gender_group_type` |
| Payment status | `bookings.payment_status` |
| Hold / payment-pending / confirmation status | `bookings.status`, `hold_expires_at`, `confirmation_sent_at` |
| Room / bed assignment | `booking_beds.room_code`, `bed_code`, `assignment_*` (from rooming roster) |
| Assignment status / rooming review flag | `bookings.assignment_status`, `needs_rooming_review`, `rooming_notes` |

### D. Add-ons context panel
From `add_on_orders` / add-on queries (Stage 5.6).

| Field | Source |
|---|---|
| Lessons (surf) | `staff-addon-queries` lessons-by-date / staff-required |
| Yoga | yoga-by-date |
| Rentals (wetsuit/board) | active-rentals-by-date |
| Dinners / meals | add-on order line items (`add_on_items`) |
| Airport transfers | add-on order line items / transfer type |
| Flight arrival/departure details (where relevant) | `add_on_orders.metadata` / booking metadata |
| Unpaid add-on balance | `getUnpaidAddOnsQuery` |

### E. Handoff queue
Dedicated view (and a badge on the inbox).

| Field | Source |
|---|---|
| Open / stale / urgent handoffs | `getOpenHandoffsQuery`, `getStaleHandoffsQuery`, `getHighPriorityHandoffsQuery` |
| Reason code | `staff_handoffs.reason_code` |
| Summary / guest message | `staff_handoffs.summary`, `guest_message` |
| Assigned staff | `staff_handoffs.assigned_staff` |
| Priority / opened / SLA due | `priority`, `opened_at`, `first_response_due_at` |
| Resolve action | **deferred** — button only appears after auth/TLS + Stage 6.9 write route enabled in staging (token-gated `handoff.resolve`) |

### F. Daily ops sidebar
A right-rail "today / tomorrow" summary.

| Block | Source |
|---|---|
| Arrivals / departures | bookings by `check_in` / `check_out` for today+tomorrow |
| Payment status summary | payment queries (deposit-paid, balance-due, waiting-payment) |
| Rooming review queue | `getRoomingReviewQuery`, `getArrivalsNeedingAssignmentQuery` |
| Housekeeping / high-turnover | **later** (derived from departures/arrivals same bed) |
| Lessons / dinners / transfers today/tomorrow | add-on queries by date |

### H. Inline conversation reply (HARD requirement)

Cami must be able to review and reply to any guest conversation directly from the dashboard. This is a **core shadow-pilot requirement**, not a nice-to-have.

**Required in the first shadow version (copy/manual-send):**
- Open any conversation from the inbox.
- Read the full guest message thread (all messages, in/out, timestamps).
- See Luna's latest draft reply pre-populated in an editable composer area (clearly labelled **DRAFT — NOT SENT**).
- **Edit Luna's draft inline** (free-text edit before copying).
- **Write a custom staff reply from scratch** (clear the draft and type freely).
- **Copy the reply to clipboard** for manual send via WhatsApp (the only send path in Phase 1).
- Optionally **mark the conversation as "replied manually"** so the audit trail is complete even when Cami sends outside the system.

**Deferred (require live-send gate + explicit approval):**
- Approve & send from the dashboard directly (the "approve/send" button is visible but disabled until the gate passes).
- The button must never fire silently; it must require a second confirmation step when eventually enabled.

**Staff takeover / return-to-Luna:**
- "Take over conversation" button — sets `bot_mode = 'human'`; Luna stops replying autonomously to this conversation.
- "Return to Luna" button — sets `bot_mode = 'bot'`; Luna resumes handling the conversation.
- Current takeover status visible at all times (`bot_mode`, `last_staff_reply_at`).
- Both actions must be audited (actor, timestamp, reason).

**Audit requirements for all reply actions:**
- Every staff-composed or staff-edited draft is recorded with `staff_user_id`, role, timestamp, and the text.
- Every "replied manually" mark is recorded.
- Every takeover/return-to-Luna toggle is recorded.
- No action is hidden or silent.

### G. Bed calendar grid (HARD requirement — see §4)
Spreadsheet-style planning view modelled on the Excel calendar.

- **Rooms / beds down the left side** (row per bed; grouped by room; `planning_row_label` from `booking_beds`).
- **Calendar dates across the top** (one column per night in the selected range).
- **Bookings shown as horizontal blocks** spanning their nights (`assignment_start_date` → `assignment_end_date`).
- **Guest name or booking code visible in each block** (`displayText()` from `planning-row-format.js`).
- **Room / bed assignment visible** (the row the block sits on).
- **Status visible by label or color** using the existing `colorTypeFromFields()` model: `hold`, `confirmed`, `needs_review`, `conflict`, `operator`, `cancelled`.
- **Arrivals / departures visually clear** (block start = arrival, block end = departure).
- **Gaps / overlaps visible** (empty cells = gap; two blocks on one bed/night = overlap → flagged).
- **Shared-room occupancy and turnover visible** enough for staff to understand each room (all beds of a room shown together; same-day turnover where one block ends and another starts).

---

## 4. Bed calendar is a hard requirement

This is **not optional**.

- Cami already runs Wolfhouse from the Excel-style planning calendar; the dashboard must **preserve that mental model**, not replace it with a list.
- The bed calendar grid is the operational heart of the staff workflow — availability, rooming, arrivals/departures, and turnover are all read from it.
- **Do not launch Wolfhouse live without either:**
  - **A.** the bed calendar grid available in the dashboard (read-only is acceptable for first launch), **or**
  - **B.** an explicit **written deferral approved by Cami/Ale** recorded in the Stage 7.6 checklist (gate F7-CAL).

The color/label model already exists in `scripts/lib/planning-row-format.js` and the data already exists in `booking_beds` — so the read-only grid is a rendering task on proven data, not new business logic.

---

## 5. Bed calendar editing requirements

The bed calendar **may be read-only in the first implementation**, but it must be **designed as the future main booking-operations screen**. The data model and API must not foreclose editing.

Eventually Cami must be able to:

- Click a booking block to open booking details (drawer).
- Change assigned room/bed.
- Move a booking to another available bed.
- Update check-in / check-out dates where safe.
- Update guest count / details where safe.
- Update room preference or rooming notes.
- Mark a booking as needs-review.
- Cancel or change **unpaid** bookings where allowed.
- Trigger staff handoff/review for risky booking changes.

### Safety requirements for editing (must hold before any write is enabled)
- First version is **read-only**.
- Write/edit mode is **explicitly gated** (feature flag + auth role `operator`/`admin` + HTTPS, same gate family as `STAFF_ACTIONS_ENABLED`).
- **All changes audited** (actor `staff_user_id` + role + before/after, per Stage 7.2 B8).
- **No silent overwrites** — optimistic concurrency / row-version check; reject stale edits.
- **No overlapping bed assignments** — server rejects an assignment that overlaps an existing one on the same bed (half-open overlap as in `getOccupiedBedsQuery`).
- **No moving staff/manual assignments without warning** — `operator`/`manual` color-type blocks require explicit confirm.
- **Paid-booking date changes / cancellations require human review** — route through `staff_handoffs` (`date_change_paid_booking`, `cancellation_request`, `refund_request`), never auto-applied.
- **Payment-impacting changes must not be automated** without explicit approval (deposit/refund implications go to handoff + owner gate).
- **Rollback / undo strategy defined before live editable use** — every edit writes an audit row sufficient to reverse it; a documented manual rollback (and/or `booking_beds` history) must exist before edit mode ships.

---

## 5a. Stage 7.7k — Safe bed reassignment plan (design only)

> **Status:** DESIGN DONE (2026-06-01). **No reassignment write is implemented or approved.** This section is the safety contract that every later reassignment slice (7.7k1–7.7k8) must satisfy before any `booking_beds` write from the calendar is enabled.
>
> **Naming note:** the slice table (§10) historically reserved "7.7n" for the bed-reassignment plan. This task supersedes that: the bed-reassignment design and all its sub-slices are tracked as **7.7k / 7.7k1–7.7k8**. The §10 row is reconciled accordingly.

### 5a.1 Objective

Allow Cami to **move one existing booking from bed A to bed B for the same date range**, directly from the bed calendar, **only after an explicit write gate is approved**. The design must:

- prevent overlaps (double-booking the same bed),
- prevent accidental room moves and payment-impacting changes,
- prevent silent corruption of operator/manual assignments,
- preserve a complete audit trail and a defined rollback path.

This is a **surgical single-assignment move**. It is deliberately distinct from the existing bot/n8n reset path (`scripts/lib/reassign-booking-beds-pg-sql.js`), which **deletes all `booking_beds` for a booking and re-runs auto-assignment**. The Cami calendar action must **never** call that reset path.

### 5a.2 Allowed v1 action (and only this)

- Move an existing `booking_beds` assignment from **bed A → bed B** for the **same `assignment_start_date`/`assignment_end_date`**.
- **No date change** in v1.
- **No guest-count change** in v1.
- **No payment change** in v1 (no deposit/refund/total recompute).
- **No cancellation** in v1.
- **No booking-status change** in v1 (`bookings.status` untouched).
- **No automated guest notification** in v1 (no WhatsApp, no Luna runtime).
- **Staff must explicitly confirm** before the write runs.

Anything beyond a same-range bed-to-bed move is **out of scope** and routes to a `staff_handoffs` review row (date change → `date_change_paid_booking`, cancellation → `cancellation_request`, etc.).

### 5a.3 Hard blockers (reject → no-op or convert to staff review)

The reassignment is **blocked** (no write) and either returns an actionable error or opens a `staff_handoffs` review row if any of the following hold:

1. **Target bed occupied** for overlapping dates (see §5a.5 overlap rule).
2. **Booking is paid** *and* the move changes room type / package implications (e.g. dorm→private).
3. **Manual/operator assignment lock** — current `booking_beds.assignment_type IN ('manual','operator')` (move requires elevated confirm; see §5a.4 — but a hard block if `STAFF_ACTIONS_ENABLED` is not set for operator-lock overrides).
4. **Booking is cancelled or expired** (`bookings.status IN ('cancelled','expired')`).
5. **`bookings.assignment_status = 'needs_review'`** (must be cleared by review first).
6. **Date range not fully verifiable** — booking spans dates outside the loaded calendar window and the full `[start,end)` cannot be re-fetched and overlap-checked server-side.
7. **Target room incompatible** — `rooms.gender_strategy` or `rooms.room_type` incompatible with the booking/guest.
8. **Breaks private/couple/matrimonial requirements** — move into/out of a `can_be_matrimonial` / private room that violates the booking's requirement.
9. **Protected/last-resort room constraints violated** — `rooms.avoid_until_needed = TRUE` or other R6/private/protected constraints not satisfied.
10. **Target bed does not exist, is inactive (`beds.active = FALSE`), or not sellable (`beds.sellable = FALSE`).**
11. **Client mismatch** — target bed/room `client_id` ≠ booking `client_id` (no cross-client moves).
12. **Staff role insufficient** — actor is not `operator` or `admin` (`viewer` is read-only).
13. **`STAFF_ACTIONS_ENABLED` is false** (feature flag off → all reassignment writes blocked).
14. **Auth/TLS gate not satisfied** in staging/production (`STAFF_AUTH_REQUIRED=true` + HTTPS; no anonymous writes).

### 5a.4 Allowed-with-warning (explicit confirm modal required)

The write may proceed **only after a second explicit confirmation** if:

- **Target room differs from current room** (not just a different bed in the same room).
- **Guest preference changes** from preferred room type / `room_preference`.
- **Shared room with gender/fill-strategy caveat** (e.g. `gender_strategy='Flexible'` mixing).
- **Booking is confirmed but unpaid.**
- **Booking has an open handoff** (`staff_handoffs` open row exists for this booking/phone).
- **Same-day or next-day arrival** (check-in is today/tomorrow — high operational sensitivity).
- **Move affects housekeeping / turnover** (e.g. into a bed that departs/arrives same day).

Each warning shown must be **recorded in the audit row** (`warnings_shown`).

### 5a.5 Overlap detection (authoritative rule)

Using `booking_beds` rows, the target bed is **occupied** for the proposed range if there exists a row where:

```
existing.bed_id              = target_bed_id
existing.id                 != current_booking_bed_id      -- exclude the row being moved
existing.assignment_start_date < proposed_end_date         -- half-open overlap
existing.assignment_end_date   > proposed_start_date
existing.booking_id IN (bookings WHERE status NOT IN ('cancelled','expired'))
```

Requirements:

- The overlap check **must run in the same transaction** as the `UPDATE`, after acquiring a row lock on the target bed's assignments (`SELECT ... FOR UPDATE` on `booking_beds` for that `bed_id`/date window) to prevent a read-then-write race.
- **No DB-level exclusion constraint exists today** (`booking_beds` only has `CHECK (assignment_end_date > assignment_start_date)` and `idx_booking_beds_availability`). Until a `btree_gist` `EXCLUDE` constraint is added (documented as a **future hardening item**), the transaction lock is the sole guard and **must not be bypassed**.
- Document for 7.7k-future: evaluate adding `EXCLUDE USING gist (bed_id WITH =, daterange(assignment_start_date, assignment_end_date) WITH &&)` (requires `btree_gist`) as defence-in-depth before high-volume multi-staff use.

### 5a.6 Write SQL strategy (future — not built here)

One explicit, single-purpose helper (mirrors the `handoff.resolve` write pattern and the existing `staff-handoff-write-sql.js` style):

- `reassignBookingBedSql()` — **one transaction**, parameterized, client-scoped, no string interpolation of identifiers, **no raw SQL from the UI**.

Transaction steps (all-or-nothing):

1. Lookup booking + `client_id` + the specific current `booking_beds` row (by `booking_bed_id` + `booking_code` + `client_id`); `SELECT ... FOR UPDATE`.
2. Validate target bed/room (exists, active, sellable, same `client_id`, compatible type/gender).
3. Re-check conflicts (§5a.5) under lock.
4. Write a **before/after audit row** (see §5a.7) — to a dedicated `booking_rooming_events` table (proposed; until it exists, use `workflow_events` with `workflow_name='staff_reassign'` + `payload` before/after) **and** the staff action audit log.
5. `UPDATE booking_beds SET bed_id, room_code, bed_code, assignment_type='manual', assignment_label, updated_at = NOW() WHERE id = $booking_bed_id AND client_id = $client_id`.
6. If room changed, update `bookings.primary_room_code` and, if needed, `bookings.assignment_status` (never auto-set to `needs_review` without surfacing it).
7. **Never** touch `payments`, `payment_events`, `payment_status`, `bookings.status`, or run any guest-notification path.

Forbidden in the write path: arbitrary booking edits, multi-row deletes, the bot reset path, date/guest/payment mutation.

### 5a.7 Audit requirements (every attempt, success or failure)

Each reassignment attempt logs:

- `staff_user_id` + `staff_role`
- `client_id`
- `booking_id` + `booking_code`
- `old_room_code` / `old_bed_code` / `old_bed_id`
- `new_room_code` / `new_bed_code` / `new_bed_id`
- `assignment_start_date` / `assignment_end_date` (dates affected — unchanged in v1)
- `reason` / staff note (required free text)
- `precheck_result` (passed / blocked + blocker code)
- `warnings_shown` (array from §5a.4)
- `confirm_timestamp`
- `success` / `failure` (+ error)
- `rollback_reference` (id of the before-state snapshot)

Audit is written **in the same transaction** as the mutation so a successful write can never lack its audit row. Proposed home: a dedicated `booking_rooming_events` table (future migration); interim sink is `workflow_events` + the existing staff audit log (`logs/staff-query-log.jsonl`, intent prefix `action:api:reassign_bed`, category `reassign_bed_api`).

### 5a.8 Rollback / undo

- The before/after snapshot (old `bed_id`/`room_code`/`bed_code`/`assignment_type` + dates) is stored **before** the update, sufficient to reverse it.
- **Undo path:**
  - **If the old bed is still free** for the range → reverse the move (apply the same gated write back to bed A).
  - **If the old bed is no longer free** → no destructive overwrite; open a `staff_handoffs` review row for manual resolution.
- **No destructive overwrite** ever (no blind re-assign that could double-book bed A).
- A **rollback proof** (move A→B then undo B→A, audited, with conflict-on-undo handled) is a **required gate (7.7k7)** before reassignment is enabled in staging or live.

### 5a.9 UI flow (future, gated)

1. Click a booking block → read-only context drawer (already shipped, 7.7i).
2. **"Move bed" button is shown only when edit mode is enabled** (feature flag + role + HTTPS). Hidden/disabled otherwise.
3. Choose a target bed.
4. System **previews** (read-only proposal, no write): old assignment, new assignment, dates, and all conflicts/warnings (§5a.3/§5a.4).
5. Staff enters a **reason** (required).
6. Staff **confirms** (second confirm for §5a.4 warnings).
7. System runs the **gated write** (§5a.6).
8. Result shown (success/blocked + reason).
9. Calendar **refreshes** from the read API.
10. Audit entry is visible (and undo offered where safe).

No drag/drop in v1. No inline editable cells. No write without the explicit confirm.

### 5a.10 Staged implementation slices (all gated; none implemented)

| Sub-slice | Name | Scope |
|---|---|---|
| **7.7k** | Safe bed reassignment plan (**this design**) | docs only — **DONE** |
| **7.7k1** | Reassign SQL helper (static only) | `reassignBookingBedSql()` + `REASSIGN_BLOCK_CODES`; 38-check verifier 38/38 PASS; **DONE** — not wired to any route |
| **7.7k2** | Conflict-checker verifier | `verify-staff-bed-reassignment-overlap.js` — 25 checks: half-open interval operands, current-row exclusion, target-bed scoping, cancelled/expired guard, blocker pipeline, UPDATE re-check, FOR UPDATE lock, date-range preservation, conflict_count returned; 25/25 PASS — **DONE** |
| **7.7k3** | Proposal-only API endpoint | `GET /staff/bed-calendar/reassign/preview` — confirm=false, BEGIN/ROLLBACK, rows_updated=0 proven; 32-check verifier 32/32 PASS; local proof 18/18 PASS; bug fix: `::text` casts on jsonb params — **DONE** |
| **7.7k4** | Confirmed local fixture write proof | `stage7.7k4-reassign-confirm-proof.js`: 35/35 PASS; rows_updated=1; old→new→old; booking_beds/payments/payment_events/staff_handoffs delta=0; workflow_events +1 audit row (cleaned up); NO API route; NO UI; fixture-only — **DONE** |
| **7.7k5** | Confirmed write API endpoint | `POST /staff/bed-calendar/reassign/confirm`: STAFF_ACTIONS_ENABLED+STAFF_AUTH_REQUIRED gated; session operator+; 42/42 proof PASS (GET→405, unauthenticated→401, viewer→403, missing confirm→400, valid→200 rows_updated=1, second→409 manual_operator_lock, delta=0); verifier 48/48; no UI wiring — **DONE** |
| **7.7k6** | Admin-only manual/operator lock override | `manual_operator_lock_override:true` in body; operator→403 `insufficient_override_role`; admin/owner bypasses `manual_operator_lock` only; all other blockers unchanged; $9 param in SQL helper; override fields in audit_payload; verifier 59/59 PASS; fixture proof 44/44 PASS (A–E matrix); no UI wiring — **DONE** |
| **7.7k7** | Rollback/undo proof | move A→B · undo B→A (rows_updated=1, DB restored, rollback_payload proven) · conflict-on-undo blocked (target_bed_overlap, rows_updated=0) · 47/47 PASS · delta=0 · no UI wiring — **DONE** |
| **7.7k8** | Staging gate for editable reassignment | 17-gate checklist; UI gate conditions; 6-phase approval flow; hard no-go conditions defined — **DESIGN DONE** (see §Stage 7.7k8 section) |

Each sub-slice must PASS (with proof) before the next is started. Editable reassignment is **not enabled** until 7.7k6 passes its gate and 7.7k7/7.7k8 are recorded.

---

---

## 5b. Stage 7.7m — Manual booking creation from dashboard (design requirement)

> **Status:** DESIGN / PLANNING (2026-06-01). **No manual booking write is implemented or approved.** This section is the requirement and safety contract that must be satisfied before any booking creation write from the dashboard is enabled.
>
> **Scope:** Cami must eventually be able to create a booking manually from the dashboard — replacing / extending the current spreadsheet / manual-entry workflow. This is **not required for shadow-pilot Phase 1** (conversation review, Luna draft, handoff queue). It is **required before the spreadsheet/manual-planning workflow is retired**.

### 5b.1 Purpose

- Cami can create a new booking directly from the staff dashboard without using the Wolfhouse Excel planning spreadsheet.
- This replaces and extends the existing `scripts/manual-entry-postgres.js` manual-entry workflow.
- Every manual booking creation must be **safe** (overlap-guarded, client-scoped, auth-gated), **audited** (actor + role + source + reason), and **conflict-checked** (no double-booking, no silent overwrite).
- No automatic guest message, no automatic Stripe payment link, and no automatic confirmation send on creation.

### 5b.2 Required fields for v1 manual booking

| Field | Required | Notes |
|---|---|---|
| Guest name | Yes | |
| Phone | Yes | WhatsApp-format preferred |
| Email | Optional | |
| Check-in date | Yes | ISO `YYYY-MM-DD` |
| Check-out date | Yes | ISO `YYYY-MM-DD` |
| Guest count | Yes | Number of guests |
| Package / stay type | Yes | Must match a valid `package_code` from client config |
| Room type or preference | Yes | `requested_room_type`, `room_preference` |
| Language | Yes | Defaults to `en` |
| Notes / staff note | Optional | Internal; not shared with guest |
| Payment status | Yes | `unpaid` / `deposit_paid` / `paid` — entered explicitly; no auto-charge |
| Deposit / full payment status if known | Optional | Manually recorded; no Stripe link unless explicitly requested |
| Source / channel | Yes | e.g. `walk_in`, `whatsapp_staff`, `email`, `phone`, `direct` |
| Assigned room / bed | Optional | If left blank → unassigned queue |
| Add-ons (optional) | Optional | Lessons, rentals (wetsuit/board), yoga, dinners/meals, airport transfers — recorded as notes or `add_on_orders` rows |

### 5b.3 Creation modes

**Mode A — Create unassigned booking**
- Booking record is created; no `booking_beds` row written.
- Booking appears in the **unassigned / needs assignment** queue.
- No bed conflict check needed (no bed assignment).
- Suitable for future-arrivals and pre-payment holds.

**Mode B — Create booking with bed assignment**
- Booking record + `booking_beds` row written in **one transaction**.
- Requires a full bed availability / overlap conflict check before the write (same half-open interval logic as reassignment, §5a.5).
- Must block overlaps; rejected with a conflict error if target bed is occupied.
- No orphaned `booking_beds` row without a valid `bookings` row.

**Mode C — Create hold / payment-pending booking**
- Booking created with `status='hold'` and `payment_status='unpaid'` (or `deposit_paid` if confirmed).
- **No Stripe payment link is generated automatically.** Staff can request a payment link as a separate explicit step (deferred, requires Stage 7.9 / payment-send gate).
- Hold expiry (`hold_expires_at`) set manually or left null for staff-managed holds.

**Mode D — Create confirmed manual booking**
- `status='confirmed'`, `payment_status='paid'` — allowed only for staff with `operator` or `admin` role.
- Requires a mandatory **reason / source** field in the audit row.
- No confirmation email / WhatsApp is sent automatically.
- Staff must manually send any guest confirmation.

### 5b.4 Safety requirements

- **No overlapping bed assignments.** Mode B must run the same in-transaction overlap guard as bed reassignment (§5a.5), with a `SELECT ... FOR UPDATE` lock on the target bed before the write.
- **No silent overwrite.** A second create for the same phone + overlapping dates must warn or be rejected; no silent merge.
- **No automatic WhatsApp message.** No `send_message` call, no n8n workflow activation on booking create.
- **No automatic Stripe payment link.** No `create-payment-session` call. Payment collection is a separate explicit step.
- **No automatic confirmation send.** `confirmation_sent_at` must not be set by the create action.
- **All creates audited.** Every create attempt (success or failure) must log: `staff_user_id`, `staff_role`, `client_id`, `source`, `reason`, `mode` (A/B/C/D), booking fields used, conflict check result, `success` / `failure` + error.
- **Staff must enter reason and source.** Both fields required in the form; not optional.
- **Payment-impacting fields clearly marked manual.** Any `payment_status` value entered via this form is tagged `payment_record_status = 'manual_staff'` or equivalent to distinguish from Stripe-confirmed payments.
- **Rollback / delete strategy required before live use.** Before any create write is enabled in staging/live, a documented delete/undo path must exist. This is gate **7.7m6** (rollback/delete fixture proof).
- **Create is client-scoped.** `client_id` resolved from authenticated session / `client` param; no cross-client writes.
- **Auth required.** Anonymous → 401.
- **Operator or admin role required** for all create write paths. Viewer role → 403.
- **`STAFF_ACTIONS_ENABLED=true` required** for all create write actions. If false → 403 / feature-flagged off.

### 5b.5 UI flow

1. **"Create Booking" button** appears in the Bed Calendar tab (and optionally the main dashboard header).
   - Button is **visible but disabled** (greyed out) unless `STAFF_ACTIONS_ENABLED=true` and role is `operator`/`admin`.
2. **Opens a form / drawer** with the fields from §5b.2.
3. Cami completes the form. Required fields are validated client-side and server-side.
4. **Preview step** before any write:
   - System shows: proposed dates, guest count, package, room/bed assignment (if Mode B), detected conflicts (if any), payment status as entered.
   - Conflicts are highlighted (overlapping bed, existing booking for same phone+dates, etc.).
   - No write occurs at the preview stage.
5. **Cami confirms** (second confirm button, not the same as "preview").
6. System runs the **gated write** (mode A/B/C/D per selection).
7. Booking appears in:
   - Booking list / bed calendar (if assigned).
   - Unassigned queue (if Mode A / no bed assigned).
8. **No guest message is sent.** Dashboard shows a notice: "Booking created — no guest notification was sent."

### 5b.6 Implementation slices

| Sub-slice | Name | Scope |
|---|---|---|
| **7.7m** | Manual booking creation plan (**this design**) | docs only — **DONE** |
| **7.7m1** | Manual booking SQL helper (static only) | `createManualBookingSql()` — parameterized, client-scoped, no raw SQL, modes A–D; verifier only; not wired to any route |
| **7.7m2** | Create booking preview / proposal endpoint | `POST /staff/bookings/create/preview` (or `GET` with body) — BEGIN/ROLLBACK, no write, returns conflict check + proposed summary |
| **7.7m3** | Fixture create booking write proof | `stage7.7m3-create-booking-proof.js` — modes A+B proven locally; `booking_beds` delta=0 after cleanup; audit row verified; NO API route |
| **7.7m4** | Manual booking UI form (read + proposal mode) | Form / drawer in `/staff/ui` — client-side only in first pass; connected to preview endpoint; no confirmed-write button active |
| **7.7m5** | Confirmed create behind auth / action gate | `POST /staff/bookings/create` — STAFF_ACTIONS_ENABLED + operator/admin + STAFF_AUTH_REQUIRED; reason+source required; all 4 modes |
| **7.7m6** | Rollback / delete fixture proof | Move A: create booking → delete/cancel; move B: create with bed → remove bed assignment → cancel booking; audited; delta=0 proven |
| **7.7m7** | Cami / Ale sign-off | Written approval to enable manual booking creation in staging; confirms it is safe to retire spreadsheet for this workflow |

Each sub-slice must PASS (with proof) before the next is started. Manual booking creation is **not enabled** until 7.7m5 passes its gate and 7.7m6/7.7m7 are recorded.

### 5b.7 Relationship to existing manual-entry workflow

The existing `scripts/manual-entry-postgres.js` CLI tool is the current path for staff-created bookings. The dashboard manual booking form (7.7m) is the **UI successor** to this workflow. Until 7.7m5 passes its gate and Cami/Ale sign off (7.7m7), the CLI tool remains the primary path for manual booking creation. Do not retire the CLI tool or the spreadsheet workflow until 7.7m7 is recorded.

### 5b.8 Pilot phase placement

| Phase | Manual booking status |
|---|---|
| Phase 1 — Shadow / co-pilot | **Not required.** Cami uses existing spreadsheet / CLI tool for new bookings. Dashboard is conversation-review only. |
| Phase 2 / Phase 3 | Still not required; existing tools remain the primary path. |
| **Pre-spreadsheet retirement** | **Required.** 7.7m1–7.7m7 must all PASS before the spreadsheet / CLI manual-entry workflow is retired. |

---

## 6. Shadow-mode workflow (Phase 1 — zero autonomous send)

```
1. Guest WhatsApp message received (staging webhook; WHATSAPP_DRY_RUN=true)
2. Luna parses / classifies / drafts → draft stored in conversations.staff_reply_draft
3. Dashboard shows the draft (labelled DRAFT — NOT SENT) in conversation detail
4. Cami reviews the draft + booking/payment/rooming/add-on context
5. Cami chooses one of:
     • copy reply manually (copy-to-clipboard) and send via WhatsApp herself
     • edit the reply text before copying
     • mark conversation as needs human / add a staff note
     • resolve a handoff  → DEFERRED until write gate enabled (auth/TLS + 6.9 route)
     • approve & send       → DEFERRED until a send action exists (later phase/gate)
6. No autonomous send occurs during the first shadow pilot.
```

The dashboard never sends to the guest in Phase 1. The only "send" is Cami pasting into WhatsApp manually.

---

## 7. Required data / API endpoints (exists vs missing)

### Exists today (Stage 6 + 7.2)
- `GET /staff/query` (registry-driven read queries; rooming/payment/addon/handoff)
- `GET /staff/intents` (registry list)
- `GET /staff/ui` (read-only query/report UI)
- `POST /staff/auth/login`, `POST /staff/auth/logout` (session auth)
- `POST /staff/handoff/:id/resolve` (token-gated; `STAFF_ACTIONS_ENABLED` + operator/admin)
- Query helpers: handoff (`staff-handoff-queries`), payment (`staff-payment-queries`), rooming (`staff-rooming-queries` incl. `getOccupiedBedsQuery` for a date range), add-on (`staff-addon-queries`)
- `staff_users` / `auth_sessions` (migration 009); audit log to `logs/staff-query-log.jsonl`

### Missing — needed for the dashboard (new read endpoints first)
| Endpoint | Purpose | Phase |
|---|---|---|
| `GET /staff/conversations` | inbox list (view A) | read — 7.7b |
| `GET /staff/conversations/:id` | conversation header/state | read — 7.7b |
| `GET /staff/conversations/:id/messages` | message thread (view B/H) | read — 7.7b |
| `GET /staff/conversations/:id/context` | booking/payment/rooming/add-on context (views C/D) | read — 7.7b |
| `GET /staff/conversations/:id/draft` | Luna draft pre-populated into reply composer (view H) | read — 7.7b |
| `GET /staff/conversations/:id/staff-state` | bot_mode, last_staff_reply_at, takeover status (view H) | read — 7.7b |
| `GET /staff/bed-calendar?start=YYYY-MM-DD&end=YYYY-MM-DD` | calendar grid data (view G) | read — 7.7g |
| `GET /staff/bed-calendar/booking/:bookingCode` | booking detail for a calendar block | read — 7.7g |

**Deferred write endpoints (require write gate + auth/TLS):**
| Endpoint | Purpose | Phase |
|---|---|---|
| `POST /staff/conversations/:id/staff-reply/draft` | save Cami's edited/composed draft (audit; no send) | deferred (write gate) |
| `POST /staff/conversations/:id/mark-replied-manually` | record that Cami sent reply outside the system | deferred (write gate) |
| `POST /staff/conversations/:id/takeover` | set bot_mode='human'; Luna stops replying (audited) | deferred (write gate) |
| `POST /staff/conversations/:id/return-to-luna` | set bot_mode='bot'; Luna resumes (audited) | deferred (write gate) |
| `POST /staff/conversations/:id/status` | mark needs-human / add staff note | deferred (write gate) |
| `POST /staff/replies/:id/approve-send` | approve + send draft to guest via WhatsApp — **live-send gate required; button disabled until gate passes** | deferred (send gate / later phase) |
| `POST /staff/bed-calendar/reassign` | move booking to another bed | deferred (edit gate) |
| `POST /staff/bed-calendar/date-change` | change dates | deferred (edit gate + paid→handoff) |
| `POST /staff/bed-calendar/cancel-unpaid` | cancel an unpaid booking | deferred (edit gate) |

Manual-send workflow (Phase 1, no write gate needed — read-only actions):
- Copy-to-clipboard: client-side only; no server round-trip; no audit needed (optional: client fires a lightweight log call).
- The draft text is read from the already-loaded `GET /staff/conversations/:id/draft` response.

All new read endpoints follow the existing pattern: parameterised SQL from a helper module (no raw param SQL), `requireAuth` when `STAFF_AUTH_REQUIRED=true`, audit row per read, GET-only.

---

## 8. Dashboard safety model

- **Read-only data layer by default.**
- **Inline reply composer is read+copy-only in Phase 1** — Cami can read, edit, and copy the draft; no server write until the write gate passes.
- **No live send button active** in Phase 1 — the approve/send button is visible but disabled; it requires a second confirmation when eventually enabled.
- **Copy-to-clipboard allowed** (manual WhatsApp send only in Phase 1).
- **Mark-replied-manually deferred** (write gate) but planned — the reply audit trail must be completable even when Cami sends outside the system.
- **Staff takeover / return-to-Luna deferred** (write gate) — UI shows current state; toggle write requires auth/TLS + write route.
- **Approve / send deferred** until live-send gate passes — not just a write gate but an explicit owner-approval gate (Stage 7.8 / Phase 2+).
- **Bed calendar read-only first.**
- **Bed calendar edits deferred** behind explicit write gates (§5).
- **Resolve-handoff button** only after auth/TLS + Stage 6.9 write route enabled in staging.
- **Every staff action audited** (read-triggered actions, draft saves, takeover, mark-replied, send) with `staff_user_id` + role + timestamp.
- **No raw SQL** from the client; all queries via helper modules.
- **No arbitrary prompt execution** from the dashboard.
- **No hidden auto-send** — every send path requires an explicit staff action.
- **No hidden booking movement.**

These map directly to Stage 7.6 hard no-go conditions (no autonomous send, no `STAFF_ACTIONS_ENABLED` without auth+TLS, audit durable).

---

## 9. UX priority for Cami (v1 order)

First version should prioritize, in order:
1. Simple inbox.
2. Conversation detail (full message thread).
3. Luna draft (clearly labelled DRAFT — NOT SENT).
4. **Inline staff reply composer** (edit draft / compose custom reply / copy-to-clipboard).
5. Booking / payment / add-on context.
6. Handoff status.
7. Bed calendar read-only view.
8. Daily ops visibility.

Everything in §2 (analytics, PMS, drag/drop, owner dashboard, multi-client admin) is **out of scope for v1**.

---

## 10. Implementation slices

| Slice | Name | Scope | Gate |
|---|---|---|---|
| **7.7a** | Dashboard plan (+ amendment) | this document | — | **DONE** |
| **7.7b** | Conversation API read endpoints | `GET /staff/conversations*` (inbox, detail, messages, context, draft, staff-state) read-only | read | **DONE** |
| **7.7c** | Conversation inbox UI | view A | read | **DONE** |
| **7.7d** | Conversation detail + full message thread | view B — thread renders; Luna draft pre-populated in composer; copy-to-clipboard works | read | **DONE** |
| **7.7e** | Luna draft + context panel | views B/C/D — draft labelled DRAFT — NOT SENT; booking/add-on context visible | read |
| **7.7f** | Handoff queue integration | view E (read; resolve deferred) | read | **DONE** |
| **7.7g** | Bed calendar query / API | `GET /staff/bed-calendar*` (built on `getOccupiedBedsQuery`) | read | **DONE** |
| **7.7h** | Bed calendar read-only render | view G grid | read | **DONE** |
| **7.7i** | Booking detail drawer from calendar block | drawer from a block → context | read | **DONE** |
| **7.7j** | Inline reply composer + copy/manual-send proof | view H — composer visible; Luna draft editable; copy works; no send button active; fixture conversation proves end-to-end shadow loop | read | **DONE** |
| **7.7k** | Staff takeover / return-to-Luna controls | view H — UI shows bot_mode status; toggle controls designed; write path deferred; plan for write endpoint + audit | **plan + read UI** |
| **7.7l** | Approve-send gate plan | design the live-send write path (Phase 2+ gate), double-confirm UI, audit, and rollback; button disabled until gate passes | **plan only** |
| **7.7m** | Shadow-mode checklist update | wire results into Stage 7.6 F-gates | — |
| **7.7k** | **Safe bed reassignment plan** (supersedes old "7.7n") — design reassign write path, overlap guard, audit, rollback; sub-slices 7.7k1–7.7k8 in §5a.10 | **plan only** | **DONE** |
| **7.7m (booking)** | **Manual booking creation plan** — design, required fields, modes A–D (unassigned / with-bed / hold / confirmed), safety requirements, UI flow; sub-slices 7.7m1–7.7m7 in §5b; **not required for shadow pilot Phase 1; required before spreadsheet retirement** | **plan only** | **DONE (2026-06-01)** |
| **7.7o** | Audited booking edit / write gates plan | design edit-mode gating + audit + rollback for calendar edits | **plan only** |

> Note: §5a defines the bed-reassignment design as **7.7k / 7.7k1–7.7k8**. The earlier "7.7n" label for this work is retired; the separate "staff takeover / return-to-Luna" plan row above retains the 7.7k row id for historical continuity but is functionally tracked as a takeover-controls slice — see §5a.1 naming note. §5b defines the manual booking creation design as **7.7m (booking) / 7.7m1–7.7m7** — not required for shadow pilot Phase 1; required before spreadsheet retirement.

Slices 7.7b–7.7j are read-only build slices. 7.7l/7.7k(reassignment)/7.7m(booking)/7.7o are **planning-only** slices that must pass before any corresponding write is implemented.

---

## 11. Proof criteria (per read slice / fixtures)

A successful read-only dashboard proof must show:
- Seeded fixture conversation appears in the inbox.
- Conversation detail loads (full message thread renders, in/out, timestamps).
- Luna draft visible in an editable composer area (labelled **DRAFT — NOT SENT**), or explicit "no draft yet" placeholder.
- **Inline reply composer present** — Cami can edit the draft text and compose a custom reply.
- **Copy-to-clipboard button works** — the composed/edited reply is copied cleanly.
- **Approve/send button visible but disabled** — it must not trigger any send action.
- **Staff takeover status visible** — `bot_mode` and `last_staff_reply_at` shown.
- **Takeover / return-to-Luna toggle visible** — UI shows current state; write action disabled until write gate.
- Booking / payment / rooming / add-on context loads beside it.
- Handoff state visible.
- Bed calendar renders:
  - dates across the top,
  - beds/rooms down the side,
  - `booking_beds` rows as date-span blocks with the correct color/label.
- **No live send fires** at any point in the proof.
- **No calendar edit action available** in the first read-only proof.
- **No protected tables mutated** (bookings/payments/payment_events/booking_beds/conversations Δ=0 — all writes are deferred).
- **Auth required** when `STAFF_AUTH_REQUIRED=true` (anonymous → 401).
- **Audit entries** written for staff reads/actions.

These are proven with seed/cleanup fixtures + a static verifier, mirroring the Stage 6 / 7.2 proof style. No runtime is part of this planning slice.

---

## 12. Dependencies and ordering

- **Auth + TLS (7.2 / 7.3)** must be in place before the dashboard is exposed in staging (no cookies without HTTPS).
- **Read endpoints (7.7b/7.7g)** depend only on existing tables — buildable locally now.
- **Inline reply composer (view H, read+copy)** is buildable locally now — only the write actions (draft save, takeover, mark-replied, send) are deferred.
- **Draft-save / takeover / mark-replied-manually writes (7.7k)** depend on the staff write gate (auth/TLS + `STAFF_ACTIONS_ENABLED` + `operator`/`admin` role).
- **Approve/send (7.7l)** depends on the Stage 7.8 live-send gate — an explicit owner-approval decision, not just a write gate.
- **Handoff resolve (view E action)** depends on the Stage 6.9 / token-gated write route + auth.
- **Calendar edit (7.7n/7.7o)** depends on the edit-mode write gate, overlap guard, audit, and rollback being designed and approved first.
- **Shadow-mode (Stage 7.6 Section G)** depends on staging webhook + `WHATSAPP_DRY_RUN=true` — the dashboard (conversation detail + inline reply composer + copy) is the review surface for it.

---

## 13. What this plan does NOT do

- Does not enable any send, edit, or resolve action.
- Does not approve live operation, real WhatsApp, or live Stripe.
- Does not mark the bed calendar or dashboard as fully implemented.

---

## 14. Implementation log

### 7.7a — Dashboard plan (design)
- **Status:** DONE (commit `11b09ce`)
- Created this document. Defined inbox, conversation detail, booking/payment/rooming/add-on context, handoff queue, daily ops sidebar, and bed calendar grid. Inline staff reply composer added as a hard requirement.

### 7.7b — Conversation API read endpoints
- **Status:** DONE (commit: this change)
- **Date:** 2026-06-01
- **Files added:**
  - `scripts/lib/staff-conversation-queries.js` — 6 SELECT-only SQL helpers (inbox, detail, messages, context, draft, staff-state)
  - `scripts/verify-staff-conversation-queries.js` — 29 static checks
  - `scripts/verify-staff-conversation-api.js` — 33 static checks
  - `scripts/fixtures/stage7.7b-conversation-api-seed.sql` — fixture conversation for +34600000191
  - `scripts/fixtures/stage7.7b-conversation-api-cleanup.sql` — cleanup SQL
- **Files updated:** `scripts/staff-query-api.js`, `package.json`, `docs/*`
- **Endpoints added:**
  - `GET /staff/conversations` — inbox (200+ active conversations, urgency-ordered)
  - `GET /staff/conversations/:id` — full conversation detail + booking/handoff overview
  - `GET /staff/conversations/:id/messages` — message thread (inbound/outbound, chronological)
  - `GET /staff/conversations/:id/context` — booking/payment/rooming context (partial if no booking linked)
  - `GET /staff/conversations/:id/draft` — Luna draft with `draft_available` flag
  - `GET /staff/conversations/:id/staff-state` — `bot_mode`, `needs_human`, open handoff state
- **Fixture proof:** PASS — login as operator, all 6 endpoints returned 200, audit log confirmed 12 `api:conversation.*` entries, protected table delta = 0, cleanup confirmed.
- **Known gaps:** draft history not implemented (single `staff_reply_draft` field only); add-ons context not included in `/context` (served by `staff-addon-queries.js` separately); `lunafrontdesk.com` domain purchased but DNS not yet configured.
- **Next:** 7.7c — conversation inbox UI (render the inbox as a browser view using the new API).

### 7.7c — Conversation inbox UI
- **Status:** DONE (commit: this change)
- **Date:** 2026-06-01
- **Files added:**
  - `scripts/verify-staff-conversation-ui.js` — 34 static checks
- **Files updated:** `scripts/staff-query-api.js` (`buildUiHtml` → two-tab Cami dashboard), `package.json`
- **UI features added:**
  - Tab 1: Conversations (default) — Cami inbox table populated from `GET /staff/conversations`; columns: guest name, phone, language, status/mode, handoff, booking code, latest message preview, last activity; priority pills (URGENT / NEEDS HUMAN / HANDOFF / BOT); loading / empty / error / 401 states; refresh button.
  - Tab 2: Query Tools — existing registry-based staff query interface (unchanged).
  - Conversation detail pane (opens on row click): guest name/phone/language, Luna draft (labelled DRAFT — NOT SENT, read-only), linked booking summary, open handoff summary, staff notes, pending action, read-only reminder.
  - No reply composer, no send button, no approve-send, no handoff.resolve action — all deferred to Stage 7.7d/7.7j.
  - Banner: "Luna Front Desk — Cami Dashboard" + "READ-ONLY • SHADOW MODE".
  - Auth: 401 surfaced with "Authentication required — POST /staff/auth/login first."
- **Verifier:** `scripts/verify-staff-conversation-ui.js` — 34/34 PASS
- **Fixture proof:** PASS — `GET /staff/ui` 200 HTML; fixture conversation (+34600000191) visible in inbox; detail pane renders draft_length=119; audit log shows 9 `api:conversation.*` entries; protected table delta = 0; cleanup confirmed.
- **Known gaps:** inline reply composer (7.7d/7.7j); conversation message thread view (7.7d); bed calendar (7.7g/7.7h); `lunafrontdesk.com` domain purchased but DNS not yet configured.
- **Next:** 7.7d — conversation detail + full message thread render.

### 7.7d — Conversation detail + full message thread + copyable Luna draft
- **Status:** DONE (commit: this change)
- **Date:** 2026-06-01
- **Files updated:** `scripts/staff-query-api.js` (`loadConvDetail` upgraded to fetch 5 sub-endpoints, render thread + draft panel + context sidebar), `scripts/verify-staff-conversation-ui.js` (44 checks, up from 34)
- **UI features added:**
  - Parallel fetch of all 5 sub-endpoints: `/conversations/:id`, `/messages`, `/context`, `/draft`, `/staff-state`
  - Two-column layout: left (message thread + Luna draft panel), right (context sidebar)
  - Message thread: chronological, visual distinction inbound (guest, blue) vs outbound (Luna, green), empty state, scroll-to-bottom
  - Luna draft panel: editable `<textarea>` pre-filled with draft; "NOT SENT" label; copy-to-clipboard button; "shadow mode: copy and send manually in WhatsApp"; disabled approve/send button with clear "disabled (live-send gate required)" label
  - Context sidebar: Bot state card (mode, needs_human, pending action, handoff), Booking card (code, dates, guests, package, room/bed, payment due/paid), Notes card
  - READ-ONLY VIEW + "No live sends from this dashboard" footer
- **Verifier:** `scripts/verify-staff-conversation-ui.js` — 44/44 PASS
- **Fixture proof:** all 5 endpoints 200; draft_available=true, text_len=119; messages count=1; 18 `api:conversation.*` audit entries (all 6 intents); protected table delta=0; cleanup confirmed.
- **Known gaps:** inline reply save (POST to save edited draft — deferred to Stage 7.7j); staff takeover write (7.7k); mark-replied-manually (7.7j); bed calendar (7.7g/7.7h); `lunafrontdesk.com` DNS not configured.
- **Next:** 7.7e — Luna draft context panel (conversation summary, last bot reply, routing intent, confidence info) or 7.7f handoff queue integration.

### 7.7f — Handoff queue integration in Cami dashboard
- **Status:** DONE (commit: this change)
- **Date:** 2026-06-01
- **Files updated:** `scripts/staff-query-api.js` (new `handleHandoffQueue` + `GET /staff/handoffs`; Conversations tab now has Inbox / Needs Human sub-tabs), `scripts/verify-staff-conversation-ui.js` (52 checks, up from 44), `scripts/fixtures/stage7.7f-handoff-seed.sql`, `scripts/fixtures/stage7.7f-handoff-cleanup.sql`
- **UI features added:**
  - Conversations tab now has two sub-tabs: **Inbox** and **Needs Human** (badge count)
  - Needs Human panel fetches `GET /staff/handoffs?client=...`
  - Handoff queue table: Priority (pill: URGENT/HIGH/NORMAL/LOW), Guest, Phone, Reason, Status, Assigned staff, Booking code, Opened timestamp, Time since opened
  - Time since opened: relative (Xh Ym) with "stale" red highlighting for > 4 hours
  - Empty state: "No open handoffs right now."
  - Row click → navigates to linked conversation detail in Inbox sub-tab (or shows "No conversation linked yet" placeholder)
  - Badge count on Needs Human tab updates after load
  - READ-ONLY HANDOFF QUEUE label; resolve-disabled notice
  - No resolve button. No write actions of any kind.
- **API endpoint added:**
  - `GET /staff/handoffs?client=<slug>` — auth-gated (viewer minimum), returns `handoffs[]` (open/assigned/waiting_guest rows) + `needs_human_without_handoff[]` (conversations needing reconciliation), audited with intent `api:handoffs.open`
- **Verifier:** `scripts/verify-staff-conversation-ui.js` — 52/52 PASS (8 new handoff queue checks)
- **Fixture proof:** open handoffs in DB=1; `/staff/handoffs` 200 count=1 conv_id=present; `/staff/conversations` 200 count=1; audit log shows `api:handoffs.open OK hq=1`; protected table delta=0; cleanup confirmed.
- **Known gaps:** handoff resolve UI (deferred — requires production auth/TLS + Stage 6.9 write gate approval); inline reply composer (7.7j); bed calendar (7.7g/7.7h).
- **Next:** 7.7g — bed calendar query/API (`GET /staff/bed-calendar`), or 7.7e — Luna draft context panel enhancements.

### 7.7g — Bed calendar query/API
- **Status:** DONE (commit: this change)
- **Date:** 2026-06-01
- **Files created:** `scripts/lib/staff-bed-calendar-queries.js` (3 SELECT-only helpers), `scripts/verify-staff-bed-calendar-queries.js` (25 checks), `scripts/verify-staff-bed-calendar-api.js` (28 checks), fixture seed/cleanup SQL
- **Files updated:** `scripts/staff-query-api.js` (`handleBedCalendar`, `GET /staff/bed-calendar`, date helpers), `package.json` (2 new verifier scripts)
- **API endpoint added:**
  - `GET /staff/bed-calendar?client=<slug>&start=YYYY-MM-DD&end=YYYY-MM-DD` — auth-gated (viewer minimum), audited `api:bed_calendar`
  - Validates: date format, end > start, max 90-day range (returns 400 otherwise)
  - Returns: `{ days[], rooms[], blocks[], summary[], warnings[] }`
  - `blocks[]` fields: `start_offset`, `span_days`, `color_type`, `is_arrival`, `is_departure`, `label`, `needs_review`
  - `color_type`: confirmed / payment_pending / hold / needs_review / cancelled
- **Verifier output:** queries 25/25 PASS · API 28/28 PASS · all prior verifiers PASS
- **Fixture proof:** baseline booking_beds=15; after seed=16; GET 200 success=true; days=7; rooms=10; blocks=1; block `start_offset=0 span_days=7 is_arrival=true color_type=confirmed`; validation 400 (bad date / end<start / >90d); audit `api:bed_calendar OK blocks=1 days=7`; after cleanup=15; delta=0.
- **Known gaps:** bed calendar UI render (7.7h — HTML grid in `/staff/ui`); booking detail drawer (7.7i); calendar editing deferred behind gates.
- **Next:** 7.7h — bed calendar read-only render in Cami dashboard.

### 7.7h — Bed calendar read-only render
- **Status:** DONE (commit: this change)
- **Date:** 2026-06-01
- **Files updated:** `scripts/staff-query-api.js` (new Bed Calendar tab, CSS, HTML, JS: `renderBedCalendar`, `renderBookingBlock`, `loadBedCalendar`, `showBlockDetail`), `scripts/verify-staff-bed-calendar-ui.js` (new, 30 checks), `package.json` (1 new verifier script)
- **UI added to `/staff/ui`:**
  - New "Bed Calendar" tab between Conversations and Query Tools
  - Date range inputs (start/end) + client input + Load Calendar button
  - READ-ONLY BED CALENDAR label (edits disabled notice)
  - Scrollable grid: rooms/beds left, dates top, booking blocks as colored colspan cells
  - Color classes: confirmed (green), hold (yellow), payment_pending (red), needs_review (orange), cancelled (grey)
  - A/D arrival/departure markers on blocks
  - Clicking a block opens a read-only detail panel with all block fields + "Booking edits are disabled" note
  - Close button on detail panel
  - Summary strip: room/bed/block counts
  - Empty/error/loading states
- **Verifier output:** 30/30 PASS
- **Local proof:** GET /staff/ui 200; all 15 HTML/JS checks PASS; GET /staff/bed-calendar 200 days=7 rooms=10 block confirmed; audit `api:bed_calendar OK days=7`; delta=0.
- **Known gaps:** booking detail drawer (7.7i done); inline reply from calendar block; calendar editing (7.7k/7.7l deferred behind write gates).
- **Next:** 7.7k — safe bed reassignment plan (design) or 7.7l — audited booking edit/write gates plan.

### Stage 7.7j — Copy/review shadow workflow (DONE 2026-06-01)

Implementation log:

**UI upgrades in `/staff/ui`:**
- Copy confirmation upgraded to "Copied — send manually in WhatsApp"
- Manual-send instructions added: "Review and edit the draft below, then copy it and send manually in WhatsApp during shadow mode."
- Shadow-mode workflow checklist added (`.shadow-checklist`):
  1. Read the guest message thread
  2. Review and edit the Luna draft
  3. Click Copy to clipboard
  4. Paste and send manually in WhatsApp
  5. Gate warning: "Do NOT use this dashboard for live sends yet — live-send gate required"
- Stage badge updated to `Stage 7.7j`
- Disabled Approve/Send button remains visible
- NOT SENT label retained
- READ-ONLY · SHADOW MODE banner retained

**Copy mechanism confirmed:**
- `copyBtn.addEventListener('click', ...)` reads `textaEl.value` at click time (captures edits)
- `navigator.clipboard.writeText` with `document.execCommand('copy')` fallback

**Verifier created:**
- `scripts/verify-stage77j-copy-review-workflow.js` — 28 checks (all PASS)

**Local proof:**
- Fixture conversation +34600000191 seeded (stage7.7b fixture)
- `GET /staff/conversations` → success=true, fixture row visible
- `GET /staff/conversations/:id/messages` → 1 inbound guest message
- `GET /staff/conversations/:id/draft` → draft_available=true, draft_text populated
- `GET /staff/conversations/:id/staff-state` → needs_human=true, bot_mode=bot
- `GET /staff/ui` → Stage 7.7j badge, shadow-checklist, draft-instructions, copied confirmation, disabled button all present
- Audit log: `api:conversation.messages/.draft/.staff-state` all success=true
- Cleanup: protected table delta = 0

**Shadow workflow proven (manual steps):**
1. Cami opens Conversations tab → fixture row appears
2. Click row → detail pane loads (thread + draft + context)
3. Thread shows guest message: "Do you have beds available for next week?"
4. Draft textarea shows Luna reply (editable)
5. Shadow-mode checklist guides through the copy flow
6. Copy button reads textarea value (after any edits)
7. Confirmation shows: "Copied — send manually in WhatsApp"
8. Approve/Send button remains disabled — no live send path exists

**No writes except audit log. No WhatsApp. No live sends.**

### Stage 7.7i — Booking detail drawer (DONE 2026-06-01)

Implementation log:

**Endpoint added:**
- `GET /staff/bookings/:bookingCode/context?client=<slug>` — returns full booking context card
  - `booking`, `payments`, `rooming`, `conversation`, `handoff`, `addons`, `warnings`
  - auth-gated, client-scoped, audited (`api:booking_context` / `booking_context_api`)
  - 404 on unknown booking; 400 on invalid code/client
  - Protected tables unchanged (SELECT-only queries)

**Query helpers created** (`scripts/lib/staff-booking-detail-queries.js`):
- `getBookingDetailQuery()` — full booking row with all finance fields
- `getBookingPaymentsQuery()` — payment rows newest-first
- `getBookingRoomingAssignmentsQuery()` — booking_beds with room detail
- `getBookingConversationQuery()` — conversation linked by phone, newest
- `getBookingHandoffQuery()` — open/latest staff handoff by phone/booking
- `getBookingAddOnSummaryQuery()` — add-on orders + items for booking

**UI drawer (Bed Calendar tab):**
- Clicking a block shows block summary immediately
- Fetches `/staff/bookings/:bookingCode/context`
- Renders enriched drawer with sections: Booking Details · Payments · Rooming/Beds · Conversation · Handoff · Add-ons · Warnings
- "Open conversation" button navigates to Conversations tab (read-only, no write)
- "Booking edits are disabled" warning retained

**Verifiers:**
- `scripts/verify-staff-booking-detail-queries.js` — 27 checks (all PASS)
- `scripts/verify-staff-booking-detail-api.js` — 26 checks (all PASS)
- `scripts/verify-staff-bed-calendar-ui.js` expanded to 40 checks (all PASS)

**Local proof:**
- Fixture `WH-77I-DETAIL-001` seeded: booking + bed + payment + handoff
- `GET /staff/bookings/WH-77I-DETAIL-001/context` → 200, full context including rooming R1/R1-B1, payment record, open handoff
- `GET /staff/bed-calendar?start=2026-08-01&end=2026-08-08` → 7 days, 10 rooms, 7+ blocks
- `GET /staff/ui` → HTML contains loadBlockDetail, Booking Details, Open conversation
- Audit log: `api:booking_context success=true`, `api:bed_calendar success=true`
- Cleanup: booking_count=0, bed_count=0, handoff_count=0 → protected table delta = 0

### Stage 7.7k7 — Bed reassignment rollback/undo proof (DONE 2026-06-01)

Implementation log:

**SQL helper enhancement:**
- `scripts/lib/staff-bed-reassignment-sql.js` — added `new_bed_code` to `rollback_payload_cte` JSONB so the payload carries the complete pre/post state for rollback consumers. All 38 verifier checks still pass.

**Files created:**
- `scripts/fixtures/stage7.7k7-reassign-rollback-seed.sql` — seeds `WH-77K7-UNDO-001` (2027-03-01→08) and `WH-77K7-CONFLICT-001` (2027-03-15→22), both with `assignment_type='automatic'`
- `scripts/fixtures/stage7.7k7-reassign-rollback-cleanup.sql` — idempotent cleanup for both fixtures + `WH-77K7-BLOCKER-001` safety catch
- `scripts/fixtures/stage7.7k7-reassign-rollback-proof.js` — local DB proof (no API server, no UI)

**Approach:** reuses existing `reassignBookingBedSql()` for undo by passing `target_bed_code = rollback_payload.old_bed_code` with `manual_operator_lock_override=true` + `staff_role='admin'`. No new rollback helper needed.

**Case A — Happy-path undo (PASS):**
- Move `WH-77K7-UNDO-001` R1-B1 → R1-B2 (admin, confirm=true) → `rows_updated=1`
- `rollback_payload`: `booking_bed_id` ✓ · `old_bed_code=R1-B1` ✓ · `new_bed_code=R1-B2` ✓ · `assignment_start_date=2027-03-01` ✓ · `assignment_end_date=2027-03-08` ✓
- Undo R1-B2 → R1-B1 using `rollback_payload.old_bed_code` (admin, override=true) → `rows_updated=1`
- DB: `bed_code` restored to R1-B1 ✓ · date range unchanged ✓ · `audit_event_id` present for both move and undo ✓
- `workflow_events +2` (move audit + undo audit)

**Case B — Conflict-on-undo (PASS):**
- Move `WH-77K7-CONFLICT-001` R1-B1 → R1-B2 (admin) → `rows_updated=1`
- Blocker `WH-77K7-BLOCKER-001` seeded on old bed R1-B1 with overlapping dates (2027-03-16→21)
- Undo attempt R1-B2 → R1-B1 (admin, override=true): `blocked=true` · `block_reason=target_bed_overlap` · `rows_updated=0` · `conflict_count=1`
- Booking remains on R1-B2 — no double-booking, no overwrite ✓
- Blocker removed after test
- `workflow_events +0` for blocked undo (blocked attempts write no audit row) ✓

**UI fix:**
- `scripts/staff-query-api.js` — title changed from "Luna Front Desk — Cami Dashboard" to "Luna Front Desk"; brand `<div>` replaced with `<a href="/staff/ui">` link to home

**Proof result:** 47/47 PASS
- All protected table deltas = 0 after cleanup
- `workflow_events`: +3 during proof (A:move+undo=2, B:move=1, B:blocked_undo=0) → cleaned up → delta=0
- No API server started. No UI wiring. No live data. No workflow activation.

**Known gaps:**
- UI calendar editing is still NOT wired and NOT approved
- 7.7k8 staging gate DESIGN DONE; all actual gate items NOT_STARTED (staging not deployed)
- Cami/Ale written sign-off required before editable calendar goes live

---

### Stage 7.7k8 — Staging gate for editable bed reassignment (DESIGN DONE 2026-06-01)

> **What this section is:** A complete staging gate checklist that must be satisfied before editable bed reassignment is exposed to Cami in staging or enabled in the Luna Front Desk UI. This section is **design/planning only**. No code, no routes, no UI, no DB commands, no runtime changes are made here. It records the approval contract.
>
> **Current state:** The reassignment backend is fully locally proven (7.7k1–7.7k7). The UI calendar is read-only. Reassignment controls are intentionally not wired. This gate prevents accidental booking corruption, hidden moves, overlap bugs, or unclear staff behaviour when reassignment is eventually enabled.

---

#### Purpose

The bed reassignment write path is locally proven across 7 sub-slices (SQL helper, overlap guard, preview API, write proof, confirmed API endpoint, admin override, rollback/undo). Before Cami can use it in staging or production, the following risks must be mitigated:

| Risk | Mitigation required |
|---|---|
| Accidental booking corruption in staging data | DB backup + restore drill before any write gate opens |
| Overlap introduced via UI action | overlap proof re-run in staging against real staging DB schema |
| Hidden or unauditable moves | Durable audit log (not file-only) confirmed before write enabled |
| Staff mis-click / no confirmation | Confirm modal required; reason required; preview-only path first |
| No rollback path | rollback/undo proof re-run in staging; undo option in Phase 4+ |
| Unauthorised access to confirm route | HTTPS + per-user auth + role check required |
| Feature flag accidentally enabled | `STAGING_BED_REASSIGNMENT_ENABLED` flag required; `false` by default |
| Cami/Ale not trained | Training gate (K4-CAL) required before edit controls shown |

---

#### §k8.1 Required staging gates before enabling reassignment UI

All 17 gates must pass before edit controls are shown to any staff user in staging. No single gate may be waived without a written reason signed by Ty + Ale.

| # | Gate | Status | Owner | Evidence required | Blocks |
|---|---|---|---|---|---|
| K8-G1 | Azure staging environment deployed and reachable | NOT_STARTED | Ty | Container App running; health check 200 | All |
| K8-G2 | HTTPS / TLS active on `staff-staging.<domain>` | NOT_STARTED | Ty | Browser cert check; HTTP → HTTPS redirect | All |
| K8-G3 | `STAFF_AUTH_REQUIRED=true` in staging env | NOT_STARTED | Ty | Container App env verified | All |
| K8-G4 | `STAFF_ACTIONS_ENABLED=false` by default in staging | NOT_STARTED | Ty | Container App env verified; unauthenticated POST to confirm returns 403 | All |
| K8-G5 | Per-user staff auth working (email/password, session cookies) | NOT_STARTED | Ty | Login → session cookie → protected route 200 | All |
| K8-G6 | Cami staff account created in staging; role assigned | NOT_STARTED | Ty + Cami | Cami logs in; role = operator (or admin per decision) confirmed | All |
| K8-G7 | Ale staff account created in staging; role = admin/owner | NOT_STARTED | Ty + Ale | Ale logs in; role confirmed | All |
| K8-G8 | Durable audit log confirmed (not file-only) | NOT_STARTED | Ty | Write → row appears in Log Analytics or DB audit table within 60 s | All |
| K8-G9 | Database backup configured for staging (≥ 7-day retention) | NOT_STARTED | Ty | Azure portal backup policy screenshot | All |
| K8-G10 | Restore drill completed and documented | NOT_STARTED | Ty | Drill log: steps completed; time-to-restore recorded | All |
| K8-G11 | rollback/undo proof repeated in staging against staging DB | NOT_STARTED | Ty | `stage7.7k7-reassign-rollback-proof.js` run against staging DB; 47/47 PASS | All |
| K8-G12 | overlap/conflict proof repeated in staging | NOT_STARTED | Ty | `verify-staff-bed-reassignment-overlap.js` + fixture PASS against staging DB | All |
| K8-G13 | Reassignment API smoke test passed in staging (POST /staff/bed-calendar/reassign/confirm with fixture) | NOT_STARTED | Ty | 200 response + rows_updated=1 + audit row written in staging DB | All |
| K8-G14 | `STAGING_BED_REASSIGNMENT_ENABLED=false` by default; feature flag mechanism confirmed | NOT_STARTED | Ty | Staging env; confirm route rejects unless flag true | All |
| K8-G15 | UI edit controls hidden by default; no "Move Bed" button visible without flag | NOT_STARTED | Ty | `GET /staff/ui` in staging; no edit button in DOM unless flag explicitly set | All |
| K8-G16 | Cami/Ale sign-off recorded in writing (doc + dated acknowledgement) | NOT_STARTED | Cami + Ale | Written sign-off appended to this section | All |
| K8-G17 | Emergency toggle drill for reassignment: disable `STAFF_ACTIONS_ENABLED` and confirm confirm-route returns 403 | NOT_STARTED | Ty | Toggle drill record; flag flip → 403 within 1 s | All |

---

#### §k8.2 UI gate conditions (before showing move/reassign controls to any staff user)

Even after all K8-G gates pass, the "Move Bed" UI control must satisfy ALL of the following at the time of display:

1. Authenticated staff session exists (cookie valid).
2. Staff role is `operator`, `admin`, or `owner` — never `viewer`.
3. `STAFF_ACTIONS_ENABLED=true` on the server.
4. `STAGING_BED_REASSIGNMENT_ENABLED=true` (feature flag).
5. Bed calendar date range is fully loaded (no partial-load state).
6. Selected booking block has a valid `booking_bed_id` (UUID present).
7. Booking status is not `cancelled` or `expired`.
8. Preview endpoint (`GET /staff/bed-calendar/reassign/preview`) returns `rows_updated=0` (proposal-only) with no hard blockers.
9. Staff has selected a valid target bed (different from current bed).
10. Staff has entered a non-empty reason string.
11. Staff has confirmed in the modal (confirm=true sent in body).

If any condition fails, the confirm button remains disabled and the control shows the relevant blocker reason.

---

#### §k8.3 Approval phases for editable reassignment

| Phase | Name | What is allowed | Prerequisites | Approvals required |
|---|---|---|---|---|
| **Phase 0** | Local proof only | `reassignBookingBedSql()` direct in proof scripts only; no API route wired; no UI | Current state (7.7k1–7.7k7 PASS) | None (already done) |
| **Phase 1** | Staging hidden endpoint only | `POST /staff/bed-calendar/reassign/confirm` reachable in staging via `curl` only; no UI controls; fixture bookings only | K8-G1–G10, G13, G16 | Ty + Ale |
| **Phase 2** | Staging preview modal only | Preview modal visible in UI; `GET /staff/bed-calendar/reassign/preview` shown; confirm button absent | Phase 1 stable ≥ 3 days; K8-G11–G15 | Ty + Cami + Ale |
| **Phase 3** | Staging confirm for fixture bookings only | Confirm button enabled in staging for test/fixture bookings only (booking codes that match fixture pattern); real guest bookings blocked by additional guard | Phase 2 stable; K8-G16 written sign-off | Ty + Cami + Ale |
| **Phase 4** | Cami/Ale training with real staging data | Cami can move fixture and limited real staging beds; undo available; all moves audited | Phase 3 stable; K-training gates pass; rollback option available in UI | Ty + Cami + Ale |
| **Phase 5** | Limited real staging data (signed-off bookings) | Cami can move real bookings after written approval per booking; undo within 24h | Phase 4 stable ≥ 1 week; written per-booking approval | Ty + Cami + Ale |
| **Phase 6** | Production / live | NOT ENABLED — separate production gate required; production gate not defined or approved here | Phase 5 stable; separate production gate document; explicit production sign-off | Ty + Cami + Ale + separate production approval |

> **Phase 6 is explicitly not approved by this document.** Production editable reassignment requires a separate gate.

---

#### §k8.4 Required UI behaviour (for future implementation, not approved today)

When edit controls are eventually implemented, the following behaviour is required. **No drag-and-drop in v1.**

1. Calendar renders read-only by default (current state).
2. Staff clicks a booking block → detail drawer opens (current: read-only, 7.7i).
3. Staff clicks **"Move Bed"** button (hidden unless all UI gate conditions in §k8.2 pass).
4. A proposal modal opens (no write yet).
5. Modal shows: current bed, current dates, proposed target bed picker, any blockers from preview endpoint.
6. Staff selects a target bed; system calls `GET /staff/bed-calendar/reassign/preview` and shows result.
7. If preview returns any hard blocker → confirm button stays disabled; blocker reason shown prominently.
8. If preview is clean → staff enters reason (non-empty required); confirm button enables.
9. Admin/owner only: "Override manual lock" checkbox visible (hidden from operators).
10. Staff clicks Confirm → `POST /staff/bed-calendar/reassign/confirm` called.
11. On success: calendar refreshes; success toast with `audit_event_id`; "Undo" option offered (Phase 4+).
12. On failure: error message with `block_reason`; no calendar state change.
13. Audit event linkable from the drawer (future: link to `workflow_events` row).

---

#### §k8.5 Hard no-go conditions for editable reassignment

These block all phases of editable reassignment. No waiver is possible.

| No-go condition | Phase blocked |
|---|---|
| No HTTPS on staff UI/API | Phase 1+ |
| No per-user auth (session + role) | Phase 1+ |
| No durable audit log (file-only logging) | Phase 1+ |
| No database backup configured | Phase 1+ |
| No backup/restore drill completed | Phase 1+ |
| No staging fixture rollback proof (K8-G11) | Phase 1+ |
| `STAFF_ACTIONS_ENABLED=true` without HTTPS + auth + TLS | Phase 1+ |
| Edit controls visible to `viewer` role | Phase 1+ |
| Confirm route callable without valid session + role check | Phase 1+ |
| overlap verifier failing in staging | Phase 1+ |
| rollback proof failing in staging | Phase 1+ |
| `STAGING_BED_REASSIGNMENT_ENABLED` flag absent or defaulting to `true` | Phase 1+ |
| Cami not trained on move/undo flow before using edit controls | Phase 3+ |
| No written Cami + Ale sign-off (K8-G16) | Phase 3+ |
| Production gate not separately defined and approved | Phase 6 |

---

#### §k8.6 Current status (2026-06-01)

| Item | Status |
|---|---|
| Local backend proof (7.7k1–7.7k7) | **DONE** |
| Staging gate checklist (§k8.1) | **DESIGN DONE** — all 17 gates NOT_STARTED |
| UI gate conditions (§k8.2) | **DEFINED** — not evaluated (staging not deployed) |
| Approval phases (§k8.3) | **DEFINED** — Phase 0 = current state |
| UI behaviour spec (§k8.4) | **DEFINED** — not implemented |
| Hard no-go conditions (§k8.5) | **DEFINED** — all apply |
| Pilot checklist gate F8-CAL-EDIT | Updated to DESIGN_DONE; see PHASE-7.6 §F8-CAL-EDIT |
| Calendar edit controls | **NOT WIRED** |
| Staging reassignment | **NOT ENABLED** |
| Production reassignment | **NOT APPROVED** |

**Next action:** deploy Azure staging (Workstream C, Stage 7.3b) → auth in staging (Workstream B) → then work through K8-G1–K8-G17 in order.
