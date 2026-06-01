# Stage 7.7 — Cami Review Dashboard + Editable Bed Calendar Plan

**Status:** IN PROGRESS — 7.7a–h DONE · **7.7i booking detail drawer DONE (2026-06-01)**. Calendar editing (7.7k/7.7l) pending; no live operation approved.
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
| **7.7j** | Inline reply composer + copy/manual-send proof | view H — composer visible; Luna draft editable; copy works; no send button active; fixture conversation proves end-to-end shadow loop | read |
| **7.7k** | Staff takeover / return-to-Luna controls | view H — UI shows bot_mode status; toggle controls designed; write path deferred; plan for write endpoint + audit | **plan + read UI** |
| **7.7l** | Approve-send gate plan | design the live-send write path (Phase 2+ gate), double-confirm UI, audit, and rollback; button disabled until gate passes | **plan only** |
| **7.7m** | Shadow-mode checklist update | wire results into Stage 7.6 F-gates | — |
| **7.7n** | Safe bed reassignment plan | design the reassign write path + overlap guard | **plan only** |
| **7.7o** | Audited booking edit / write gates plan | design edit-mode gating + audit + rollback for calendar edits | **plan only** |

Slices 7.7b–7.7j are read-only build slices. 7.7k has a read UI component (showing current state) plus a deferred write plan. 7.7l/7.7n/7.7o are **planning-only** slices that must pass before any corresponding write is implemented.

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
- **Next:** 7.7j — copy/review workflow proof, or 7.7k — safe bed reassignment plan.

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
