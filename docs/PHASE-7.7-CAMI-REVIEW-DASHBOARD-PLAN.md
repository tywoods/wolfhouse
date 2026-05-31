# Stage 7.7 — Cami Review Dashboard + Editable Bed Calendar Plan

**Status:** PLANNING / DESIGN ONLY (2026-05-31). No implementation; no dashboard built; no bed calendar built; no live operation approved.
**Parent plan:** [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md) — Workstream F (Cami dashboard) + hard gate before Phase 1 (shadow/co-pilot).
**Pilot gate:** [`PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md`](PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md) Section F (F1–F7).
**Builds on:** Stage 6 staff tools (read-only API/UI, query registry, reports/digest, token-gated `handoff.resolve`), Stage 7.2 auth (`staff_users`/`auth_sessions`), Stage 7.3 staging/TLS.
**Bed-calendar reference:** the existing Wolfhouse Excel planning calendar (`Wolfhouse_Planning_Calendar_Prototype`), mirrored in-repo by `scripts/lib/planning-row-format.js` (color/label model) and the Airtable grid-view CSV exports (`database/*-Grid view.csv`, `database/Booking Beds-Active Bed Assignments.csv`).

> **Design document only.** It builds nothing, deploys nothing, sends nothing, and approves no live operation. The dashboard is **read-only by default**; all write/edit/send capabilities are deferred behind explicit later gates. The bed calendar is a **hard requirement** before live Wolfhouse launch unless Cami/Ale sign a written deferral.

---

## 1. Objective

Give Cami a single, safe **control center** for shadow/co-pilot mode so she can run the Wolfhouse pilot without touching n8n, Postgres, or raw queries:

- **Review guest conversations** and the **Luna draft reply** before anything is guest-facing.
- **See booking / payment / rooming / add-on context** beside each conversation.
- **Manage handoffs** (open / stale / urgent queue; resolve later when the write gate is open).
- **See a spreadsheet-style bed calendar** modelled on the existing Wolfhouse Excel planning calendar — rooms/beds down the side, dates across the top, bookings as date-span blocks.
- **No autonomous live send** is approved in this stage. Cami reviews and acts manually; the dashboard is the review surface, not an auto-pilot.

Success for Stage 7.7 = Cami can do **shadow-mode review end-to-end** (see conversation → see Luna draft → see full booking context → see the bed calendar → copy/handle manually) with **zero autonomous action** and **zero protected-table mutation**.

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
Opened from an inbox row.

| Element | Source |
|---|---|
| Message history (threaded, in/out) | `messages` (`direction`, `message_text`, `created_at`, `route`) |
| Latest guest message | most recent inbound `messages` row |
| **Luna draft reply** | `conversations.staff_reply_draft` (clearly labelled DRAFT — NOT SENT) |
| Route / intent | `messages.route`, `conversations.conversation_stage`, `pending_action` |
| Confidence / debug summary (if safe) | `conversations.session_state` / `metadata` (sanitized; no secrets, no raw prompts) |
| Staff notes | `conversations.human_notes`, `internal_staff_notes` |
| Staff takeover status | `conversations.bot_mode`, `last_staff_reply_at` |

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
| `GET /staff/conversations/:id/messages` | message thread (view B) | read — 7.7b |
| `GET /staff/conversations/:id/context` | booking/payment/rooming/add-on context (views C/D) | read — 7.7b |
| `GET /staff/conversations/:id/draft` | Luna draft (view B) | read — 7.7b |
| `GET /staff/bed-calendar?start=YYYY-MM-DD&end=YYYY-MM-DD` | calendar grid data (view G) | read — 7.7g |
| `GET /staff/bed-calendar/booking/:bookingCode` | booking detail for a calendar block | read — 7.7g |
| `POST /staff/conversations/:id/status` | mark needs-human / add note | **deferred** (write gate) |
| `POST /staff/replies/:id/approve/send` | approve + send draft | **deferred** (send gate / later phase) |
| `POST /staff/bed-calendar/reassign` | move booking to another bed | **deferred** (edit gate) |
| `POST /staff/bed-calendar/date-change` | change dates | **deferred** (edit gate + paid→handoff) |
| `POST /staff/bed-calendar/cancel-unpaid` | cancel an unpaid booking | **deferred** (edit gate) |

All new read endpoints follow the existing pattern: parameterised SQL from a helper module (no raw param SQL), `requireAuth` when `STAFF_AUTH_REQUIRED=true`, audit row per read, GET-only.

---

## 8. Dashboard safety model

- **Read-only by default.**
- **No live send button** at first.
- **Copy-to-clipboard allowed** (manual send only).
- **Approve / send deferred** until a later gate + an actual send action exists.
- **Bed calendar read-only first.**
- **Bed calendar edits deferred** behind explicit write gates (§5).
- **Resolve-handoff button** only after auth/TLS + Stage 6.9 write route enabled in staging.
- **Every staff action audited** (read and write) with `staff_user_id` + role.
- **No raw SQL** from the client; all queries via helper modules.
- **No arbitrary prompt execution** from the dashboard.
- **No hidden auto-send.**
- **No hidden booking movement.**

These map directly to Stage 7.6 hard no-go conditions (no autonomous send, no `STAFF_ACTIONS_ENABLED` without auth+TLS, audit durable).

---

## 9. UX priority for Cami (v1 order)

First version should prioritize, in order:
1. Simple inbox.
2. Conversation detail (message thread).
3. Luna draft (clearly labelled).
4. Booking / payment / add-on context.
5. Handoff status.
6. Bed calendar read-only view.
7. Copy reply.
8. Daily ops visibility.

Everything in §2 (analytics, PMS, drag/drop, owner dashboard, multi-client admin) is **out of scope for v1**.

---

## 10. Implementation slices

| Slice | Name | Scope | Gate |
|---|---|---|---|
| **7.7a** | Dashboard plan | this document | — |
| **7.7b** | Conversation API read endpoints | `GET /staff/conversations*` (+ context, draft) read-only | read |
| **7.7c** | Conversation inbox UI | view A | read |
| **7.7d** | Conversation detail + message thread | view B | read |
| **7.7e** | Luna draft + context panel | views B/C/D | read |
| **7.7f** | Handoff queue integration | view E (read; resolve deferred) | read |
| **7.7g** | Bed calendar query / API | `GET /staff/bed-calendar*` (built on `getOccupiedBedsQuery`) | read |
| **7.7h** | Bed calendar read-only render | view G grid | read |
| **7.7i** | Booking detail drawer from calendar block | drawer from a block → context | read |
| **7.7j** | Copy / review workflow proof | shadow-mode loop (§6) proven on fixtures | read |
| **7.7k** | Safe bed reassignment plan | design the reassign write path + overlap guard | **plan only** |
| **7.7l** | Audited booking edit / write gates plan | design edit-mode gating + audit + rollback | **plan only** |
| **7.7m** | Shadow-mode checklist update | wire results into Stage 7.6 F-gates | — |

Slices 7.7b–7.7j are read-only build slices. 7.7k/7.7l are **planning** slices that must pass before any calendar write is implemented.

---

## 11. Proof criteria (per read slice / fixtures)

A successful read-only dashboard proof must show:
- Seeded fixture conversation appears in the inbox.
- Conversation detail loads (message thread renders).
- Booking / payment / rooming / add-on context loads beside it.
- Luna draft visible (or an explicit "no draft yet" placeholder state).
- Handoff state visible.
- Bed calendar renders:
  - dates across the top,
  - beds/rooms down the side,
  - `booking_beds` rows as date-span blocks with the correct color/label.
- **No send action available.**
- **No calendar edit action available** in the first read-only proof.
- **No protected tables mutated** (bookings/payments/payment_events/booking_beds Δ=0).
- **Auth required** when `STAFF_AUTH_REQUIRED=true` (anonymous → 401).
- **Audit entries** written for staff reads/actions.

These are proven with seed/cleanup fixtures + a static verifier, mirroring the Stage 6 / 7.2 proof style. No runtime is part of this planning slice.

---

## 12. Dependencies and ordering

- **Auth + TLS (7.2 / 7.3)** must be in place before the dashboard is exposed in staging (no cookies without HTTPS).
- **Read endpoints (7.7b/7.7g)** depend only on existing tables — buildable locally now.
- **Handoff resolve (view E action)** depends on the Stage 6.9 / token-gated write route + auth.
- **Calendar edit (7.7k/7.7l)** depends on the edit-mode write gate, overlap guard, audit, and rollback being designed and approved first.
- **Shadow-mode (Stage 7.6 Section G)** depends on staging webhook + `WHATSAPP_DRY_RUN=true` — the dashboard is the review surface for it.

---

## 13. What this plan does NOT do

- Does not implement any dashboard, endpoint, UI, or calendar.
- Does not create or migrate any table.
- Does not enable any send, edit, or resolve action.
- Does not approve live operation, real WhatsApp, or live Stripe.
- Does not mark the bed calendar or dashboard as implemented.
