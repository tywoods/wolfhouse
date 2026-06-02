# Stage 8.3 — Staff Portal Bed Calendar Operations Plan (Luna Front Desk)

**Status:** 8.3 PLANNING DONE (2026-06-02). **8.3a IMPLEMENTATION DONE (2026-06-02).** See §8.3a proof below.
**Parent:** [`STAGE-8-CLIENT-READY-STAGING-ROADMAP.md`](STAGE-8-CLIENT-READY-STAGING-ROADMAP.md) — slice 8.3 (expanded into 8.3a–8.3o).
**Builds on:** [`STAGE-8.1-DASHBOARD-UX-CLEANUP-PLAN.md`](STAGE-8.1-DASHBOARD-UX-CLEANUP-PLAN.md) (IA + tokens), [`PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md`](PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md) (§5a reassignment gates 7.7k1–k8 proven; §5b manual booking creation design), Stage 8.6 demo data seeded.
**Pilot decision:** Remains **NO_GO**. This plan describes the *operations workspace* the Staff Portal should become; it enables no live action.

> **Safety scope.** Planning/docs only. No code, no DB commands, no Azure changes, no workflow activation, no webhook POST, no live WhatsApp, no live Stripe, no staff writes. `STAFF_ACTIONS_ENABLED` stays `false`; `WHATSAPP_DRY_RUN` stays `true`; n8n workflows stay inactive. Every write surface described here is a **future, gated** capability — none is built or enabled by this task.

---

## 0. Current state entering Stage 8.3 (reference — do not edit code)

- **HEAD:** `e288ae2` (Stage 8.6 demo data seeded).
- **Hosted:** `https://staff-staging.lunafrontdesk.com` (Stage 7.3f, Azure managed TLS).
- **Login / logout:** working (7.3e + 7.3e-fix).
- **Dashboard (Stage 8.2):** default **Today / Needs Attention** view, **Inbox** tab, **Bed Calendar** tab, **Developer Tools** (admin-only). Natural room sort + `switchToTab` utility shipped.
- **Demo data (Stage 8.6):** 3 conversations, 3 bookings (Sofia/hold, Marco/payment_pending, Lena/confirmed Jul 16–22), 1 handoff, 2 payments, 2 booking_beds, 2 demo rooms + 4 demo beds. The bed calendar shows Lena's confirmed block.
- **Backend operations already proven locally (not wired to UI):**
  - Manual entry create/update/cancel — `scripts/manual-entry-postgres.js`, `scripts/lib/manual-entry-pg-sql.js` (upsert booking, insert `booking_beds`, update fields, delete-beds+cancel; payments untouched).
  - Safe bed reassignment — `scripts/lib/staff-bed-reassignment-sql.js`; gates 7.7k1–k8 (single-assignment move, overlap guard, role/flag gating, admin override, rollback proof).
  - Operator room release / split — `scripts/operator-room-release-postgres.js`, `scripts/lib/operator-room-release-pg-sql.js` (cancel original + create `-A`/`-B` block bookings, `booking_source='operator'`, `block_type='whole_room'`, payments-unchanged assertions). n8n variant: `scripts/lib/operator-room-release-pg-n8n-sql.js`, `n8n/Wolfhouse - Operator Room Release.json`.
  - Operator blocks live in `bookings` already (`booking_source='operator'`, `block_type`, `operator_name`, `room_to_block_id`).
- **Existing n8n workflows (inactive; inspect only):** Manual Entries Queue Processor, Bed Assignment, Reassign Bed Assignments, Cancel Bed Assignments, Operator Room Release, Sync Planning Sheet.

**Gap:** the bed calendar is a useful *read-only* grid but is not yet the **operations workspace** the business needs (manual bookings, moves, date/cancel changes, operator blocking, operator release) — and the old spreadsheet-era modals (manual booking, Book Tour Operator, Operator Room Release) are not part of the Staff Portal yet.

---

## 1. Product language cleanup

**Decision: the product is the "Staff Portal" (a.k.a. "Luna Front Desk"). Stop calling it the "Cami dashboard" in any user-facing surface.**

| Context | Use | Avoid |
|---|---|---|
| App / product name (banner, login, titles) | **Luna Front Desk** · **Staff Portal** | "Cami Dashboard", "Cami's dashboard" |
| The daily-operations view | **Staff Portal** / "the dashboard" | naming it after one person |
| Specific people in **docs** | "Cami" (daily operator at Wolfhouse), "Ale" (owner) | using their names as UI labels |
| Internal repo/code identifiers | unchanged (`client_slug`, `staff_user_id`, etc.) | renaming DB/code for cosmetics |

**Role vocabulary (display + future gating):**

| Role | Meaning | Portal capability (current → future) |
|---|---|---|
| **Staff** (viewer) | Front-desk read | Read everything in shadow mode; no writes. |
| **Operator** | Booking ops (Cami's working role) | Future: gated manual booking / move / operator block / release. |
| **Admin** | Manager (Ale) | Operator powers + manual/operator-lock override + settings. |
| **Owner** | Account owner | All of the above + company config. |
| **Developer / Admin tools** | Ty / engineering | Query Tools, raw intents, JSON, audit internals (already admin-only, Stage 8.2). |

> Cami and Ale remain **named example users in docs only**. The UI shows the **role**, never "Cami" as a product label. Keep wording **client-generic** so Sunset (client #2) can reuse the same shell — see §8 Sunset notes and STAGE-8.1 §14.

---

## 2. Bed calendar read-only UX cleanup (slice 8.3a)

Goal: the calendar reads at a glance — **all rooms/beds always visible**, free space obvious, bookings prominent, no raw IDs.

**Date controls**
- Replace raw text date fields with **calendar date-picker dropdowns** (native `<input type="date">` first; styled picker later).
- **Date shortcut chips:** `Today` · `This week` · `Next 30 days` · `Season (Jul–Aug)`. Each sets start/end and reloads read-only.
- Default range = **next 30 days** (so demo data and near arrivals show without scrolling).

**Grid / rows**
- **Always display every room and bed**, not only beds with bookings. Free beds must be visible.
- **Natural room sort** `R1, R2, R3 … R10` (already shipped Stage 8.2 — keep; verify across demo + real data).
- **Clean labels:** room shows **room code + name** (`R2 · Dorm 2`), bed shows **bed code** (`R2-B3`). Never show raw UUIDs in the staff view.
- **Group beds under their room** with a subtle room header/separator; **sticky side labels** while scrolling dates.
- **Booking blocks visually prominent** (strong fill, guest label, readable across the span, larger click target).
- **Empty beds recede** (quiet background) but remain visible so occupancy stands out.

**A/D markers**
- **Remove the inline A/D (arrival/departure) letter markers** from the default grid — they add clutter.
- Surface arrival/departure instead via a **hover/detail state** on the block (and on the Today view's Arrivals/Departures tiles). Keep the data; drop the noisy glyph.

**Color legend (always visible, semantic — STAGE-8.1 §10.2 tokens):**

| Legend item | Source field | Token direction |
|---|---|---|
| Confirmed | `bookings.status='confirmed'` | sage/green |
| Hold | `status='hold'` | amber/sand |
| Payment pending | `status='payment_pending'` / `payment_status='waiting_payment'` | amber |
| Needs review | `assignment_status='needs_review'` | soft-red accent |
| Operator block | `booking_source='operator'` (+ `block_type`) | dusty-blue (distinct, non-guest) |
| Cancelled | `status='cancelled'` | muted grey (faded) |
| Manual / staff-created | `booking_source='manual_staff'` | teal accent |

> Reuse the existing `colorTypeFromFields()` / `planning-row-format` color model (PHASE-7.7 §3) so the legend matches the Wolfhouse Excel mental model.

**Read-only guarantee:** **no drag/drop, no editable cells, no live buttons.** A calm "View only — shadow mode" affordance stays visible. Write affordances appear only behind later gates (§4–§7).

---

## 3. Booking detail drawer cleanup (slice 8.3b)

Goal: clicking a block opens a **clean, de-duplicated** drawer grouped into cards (STAGE-8.1 §8 order).

**Cards, in order:**
1. **Guest** — name, phone, email, language. (Company shown, not raw slug.)
2. **Stay** — check-in → check-out, nights, status pill.
3. **Room / Beds** — `Room: R2` · `Beds: R2-B3, R2-B4` (clean codes, no UUIDs).
4. **Payment** — **Deposit paid**, **Remaining balance**, **Total paid**, **Payment status**. Read-only; amounts from `bookings` cents fields + `payments`.
5. **Add-ons / Activities** — lessons / rentals / yoga / dinners / transfers, or a friendly empty state.
6. **Conversation / Handoff** — link back to the thread + handoff status.
7. **Admin / Audit** — **collapsed expander**, admin/dev only (IDs, raw fields, audit rows).

**De-dup:** remove repeated fields (e.g. dates shown twice, status shown twice). One source per fact.

**Disabled / planned actions (visible, clearly not-live):** render as **disabled buttons with plain labels** — never dead buttons that look live (STAGE-8.1 §5):
- `Move room/bed` (→ 8.3i preview)
- `Change dates` (→ 8.3j)
- `Cancel booking` (→ 8.3j)
- `Create handoff`
- `View conversation`
- `Copy guest summary`

Keep a calm inline note: **"Booking edits are disabled in staging (shadow mode)"** — quiet, not alarming.

---

## 4. Manual booking creation from the bed calendar (slices 8.3c–8.3h)

Goal: staff create a booking **directly from calendar cells**. This replaces the old spreadsheet manual-entry modal and extends `scripts/manual-entry-postgres.js` (PHASE-7.7 §5b).

**Desired UX**
1. Staff **select bed/date cells** in the calendar (selection model = slice 8.3c, **no writes**).
2. Staff click **"Create Manual Booking"**.
3. Modal opens with a **selection summary:** date range · nights · selected rooms/beds · guest count.

**Form fields**

| Field | Required | Notes |
|---|---|---|
| Guest name | Yes | |
| Phone | Yes | WhatsApp format preferred |
| Email | Optional | |
| Package / stay type | Yes | must match a valid `package_code` |
| Guest count | Yes | |
| Booking status | Yes | `hold` / `payment_pending` / `confirmed` |
| Payment status | Yes | `unpaid` / `deposit_paid` / `paid` — **manual, no auto-charge** |
| Deposit amount paid | Optional | staff-entered if a deposit was taken; supports **paid vs unpaid** |
| Total / remaining | Optional | if supported |
| Source / channel | Yes | `walk_in` / `whatsapp_staff` / `email` / `phone` / `direct` |
| Notes | Optional | internal staff note |
| Language | Yes | default `en` |
| Add-ons | Optional | lessons · rentals · yoga · dinners · airport transfers |

**Deposit field rules**
- Staff may enter the deposit amount **if it was paid** (recorded manually, tagged as `manual_staff`).
- Support **deposit paid vs unpaid** explicitly.
- **Do NOT create a Stripe charge or payment link.** Payment collection is a separate, later, explicitly-gated step.

**Safety (all required before any write)**
- **Preview before create** (read-only proposal; shows exactly what will be written).
- **Conflict check** the selected beds/dates with the same **half-open overlap** logic as reassignment (PHASE-7.7 §5a.5), `SELECT … FOR UPDATE` on target beds.
- **No overlap · no silent overwrite.**
- **No guest message · no payment link · no confirmation sent** (`confirmation_sent_at` untouched).
- **Audited:** `staff_user_id`, role, `client_id`, source, reason, mode, fields, conflict result, success/failure.
- **Rollback/delete proof required** before live use.
- **Modes A–D** carried from PHASE-7.7 §5b.3 (unassigned / assigned / hold / confirmed).

**Staged build (each PASS before the next):**

| Slice | Scope |
|---|---|
| **8.3c** | Calendar cell **selection model** (highlight bed×date ranges) — **no writes**. |
| **8.3d** | Manual booking **modal UI — proposal-only** (form + selection summary; submit disabled / shows "would create"). |
| **8.3e** | Manual booking **SQL helper static proof** (reuse/extend `manual-entry-pg-sql.js`; overlap guard; payments-untouched assertions). |
| **8.3f** | Manual booking **fixture write proof** (create in test DB, verify rows + audit + delta=0 on payments; rollback/delete proven). |
| **8.3g** | Manual booking **gated API** (`POST …/bookings/manual` behind `STAFF_ACTIONS_ENABLED` + role + auth; preview endpoint first). |
| **8.3h** | Manual booking **UI confirm behind the gate** (button live only when flag+role+HTTPS; reason+source required). |

---

## 5. Operations from a clicked booking (slices 8.3i–8.3j)

### A. Move room/bed (slice 8.3i — preview only)
- Backend gates **already proven** (7.7k1–k8). UI **still not wired**.
- **Preview modal** (read-only proposal): old → new assignment, dates, conflicts/warnings.
- **No drag/drop in v1.**
- **Confirm requires a reason.** Admin override applies **only** to the manual/operator lock (7.7k6).
- **Undo/rollback proof exists** (7.7k7).
- 8.3i delivers the **preview UI only**; the confirmed write stays behind the 7.7k8 staging gate + Cami/Ale sign-off.

### B. Cancel booking (slice 8.3j design)
- v1 limited to **unpaid / manual / staging-safe** bookings.
- **Paid cancellations / manual refunds → `staff_handoffs`** (`cancellation_request`, `refund_request`); never auto-applied.
- Cancel **frees beds only after preview**.
- **No guest message auto-send.** Audit required. (Backend basis: `deleteBedsAndCancelBooking()` in `manual-entry-pg-sql.js` — frees beds, sets `cancelled` + `needs_review`, asserts payments unchanged.)

### C. Change dates (slice 8.3j design)
- **Preview new dates**; check bed availability for the new span.
- **Same-nights vs different-nights** rules (re-price implications flagged, not auto-charged).
- **Payment-impacting changes → handoff / manual review.**
- **No automatic refund/charge.** Audit required.

### D. Change guest count / beds (slice 8.3j design)
- **Preview capacity and availability.**
- Gender / private / couple constraints deferred (later).
- Audit required.

> All of §5 is **preview-first**; no confirmed write ships until its fixture proof + gate + sign-off are recorded.

---

## 6. Tour operator booking interface (slices 8.3k–8.3l)

Goal: a Staff Portal replacement for the old **"Book Tour Operator"** form — block a room or set of beds for an operator over a date range.

**Purpose:** reserve whole rooms / selected beds for a tour operator (no individual guest), visible distinctly on the calendar.

**Fields**

| Field | Default (locked where noted) |
|---|---|
| Manager name | — |
| Operator name | — |
| Check-in | — |
| Check-out | — |
| Room(s) to block | — |
| Block type | **whole room** \| selected beds |
| Booking source | **Operator** (locked) |
| Payment status | **not_requested** (locked) |
| Assignment status | **Unassigned / Operator Block** (locked) |
| Booking status | **Confirmed / Operator Blocked** (locked) |
| Availability check status | **Not Checked / Blocked by Operator** (locked) |
| Guest count | optional / N-A |

**Behaviour**
- Creates **operator block records safely** (basis: existing `bookings` operator fields — `booking_source='operator'`, `block_type`, `operator_name`, `room_to_block_id` — and `insertBlockBooking()` in `operator-room-release-pg-sql.js`).
- Operator blocks appear on the bed calendar with a **unique color** (dusty-blue, §2 legend).
- **No guest message. No Stripe payment. Audited.**

**Staged build:** **8.3k** = plan (this section + field/lock spec + safety contract); **8.3l** = implementation/gates (SQL helper static → fixture create proof → gated API → proposal-only UI → gated confirm → rollback proof). Mirror the manual-booking ladder (§4).

---

## 7. Operator room release / split interface (slices 8.3m–8.3n)

Goal: a Staff Portal replacement for the old **"Operator Room Release"** form — operator holds a long block but has no guests for certain days, so staff release selected dates/rooms/beds back to availability.

**UX**
1. **Select the operator block** on the calendar.
2. Click **"Release days"**.
3. Modal shows: operator · original block dates · release start/end · rooms/beds to release · **remaining block before/after**.
4. **Preview the split result** (read-only proposal).
5. **Confirm only after a staff reason.**

**Existing logic (inspect only)**
- `scripts/lib/operator-room-release-pg-sql.js` already implements a safe split: loads original, asserts **payments == 0** (else `payments_exist` block), cancels original, creates deterministic `-A` / `-B` block bookings, tracks an `operator_room_release_requests` row (processing → completed/failed), all in one transaction with payments-unchanged assertions.
- n8n variant exists (`scripts/lib/operator-room-release-pg-n8n-sql.js`, `n8n/Wolfhouse - Operator Room Release.json`) that can split a booking and free beds.

**Recommendation (v1)**
- **Migrate the logic into the backend module path** (the Node helper already exists and is testable) rather than calling n8n live from the portal.
- **Keep any n8n call disabled / staging-only** until a fixture proof passes.
- **Proposal/preview endpoint first**, no direct live action until fixture proof.

**Safety**
- **Never free dates that have actual assigned guests** (only operator blocks, payments==0).
- **No overlap corruption** (deterministic `-A`/`-B` codes; block-code conflict guard already present).
- **Audit before/after.** **Rollback/undo plan** required before live.
- **No guest message.**
- Calendar shows a **visible "released" / available gap**.

**Staged build:** **8.3m** = plan (this section); **8.3n** = implementation/gates (preview endpoint → fixture split proof → gated confirm → rollback proof; n8n stays inactive).

---

## 8. Additional Staff Portal suggestions (slice 8.3o roadmap)

Beyond the user's list — surfaces that fit a hospitality front desk, all **read-only first**, composed from existing data where possible.

**Today**
- Arrivals today · Departures today · Unpaid / remaining balance · Needs Human · **Holds expiring soon** · Activities today (lessons / rentals / yoga / dinners / transfers).

**Calendar**
- **Occupancy %** (per day / range) · **Free beds by room** · **Conflict warnings** · Operator blocks · **Housekeeping-needed** markers (post-departure beds).

**Inbox**
- Unanswered guest messages · Stale handoffs · "Draft ready to copy".

**Payments**
- Who paid deposit · Who owes balance · **Payment claimed but unverified** (e.g. Marco-style bank-transfer pending).

**Housekeeping**
- Rooms/beds needing cleaning after departures · High-turnover shared-room warning.

**Add-ons**
- Lessons tomorrow · Rentals active / due back · Dinners / transfers list.

**Admin**
- Staff users · Client/Company config · Feature flags (read-only display of `STAFF_ACTIONS_ENABLED` etc.) · **Audit-log viewer**.

**Demo**
- **Reset demo data** (admin/dev only; wraps the Stage 8.6 cleanup+seed scripts) · **Hide demo data toggle** (filter `metadata.source='stage8_demo'` from views for a "clean" look).

> 8.3o is a **roadmap entry**, not a build list; individual surfaces graduate into their own slices as data and gates allow.

---

## 9. Stage breakdown (8.3 expansion)

| Slice | Name | Type | Gate |
|---|---|---|---|
| **8.3** | Staff Portal bed calendar operations **plan** (this doc) | docs | — |
| **8.3a** | Bed calendar read-only cleanup | code (read-only) | none (no writes) |
| **8.3b** | Booking drawer cleanup | code (read-only) | none |
| **8.3c** | Calendar cell **selection model** (no writes) | code (read-only) | none |
| **8.3d** | Manual booking **modal UI — proposal-only** | code (read-only) | none |
| **8.3e** | Manual booking **SQL helper static proof** | code (test) | static verifier |
| **8.3f** | Manual booking **fixture write proof** | code (test) | fixture proof + rollback |
| **8.3g** | Manual booking **gated API** | code | `STAFF_ACTIONS_ENABLED`+role+auth |
| **8.3h** | Manual booking **UI confirm behind gate** | code | flag+role+HTTPS+sign-off |
| **8.3i** | Move room/bed **UI preview only** | code (read-only) | none (preview); confirm = 7.7k8 |
| **8.3j** | Cancel / date-change / count-change **design** | docs | — |
| **8.3k** | Tour operator booking **plan** | docs | — |
| **8.3l** | Tour operator booking **implementation/gates** | code | flag+role+auth+proof |
| **8.3m** | Operator room release **plan** | docs | — |
| **8.3n** | Operator room release **implementation/gates** | code | flag+role+auth+proof |
| **8.3o** | Staff dashboard extra operations **roadmap** | docs | — |

> Ordering is a recommendation. **8.3a/8.3b** (read-only polish) are the only slices needed before the Ale/Cami demo (§10). Everything from **8.3e onward** is gated write work toward spreadsheet replacement and is **not** required for the first demo. Read-only previews (8.3c/8.3d/8.3i) may ship as "coming soon" affordances without enabling any write.

---

## 10. What is needed before the Ale/Cami demo

**Required before showing Ale/Cami:**
- Bed calendar **readability cleanup** (8.3a).
- Booking **drawer cleanup** (8.3b).
- **Demo data** (8.6 — DONE).
- **Real login / signout** (7.3e / 7.3e-fix — DONE).
- **No scary Query Tools** on default view (8.2 — DONE).
- **Clear read-only / shadow-mode** messaging (DONE; keep).
- Manual booking may appear as **"coming soon" (disabled)** — not active.

**Not required before the first demo:**
- Actual manual booking **writes**.
- Cancel / date-change **writes**.
- Operator release **writes**.
- Live WhatsApp.
- Live Stripe.

**Required before replacing the spreadsheet:**
- Manual booking creation (8.3c–8.3h).
- Tour operator booking (8.3k–8.3l).
- Operator room release (8.3m–8.3n).
- Safe move / cancel / date-change (8.3i–8.3j + 7.7k8).
- Audit / rollback for every write.
- Backup / restore drill (Stage 8.9).

---

## 11. Sunset (client #2) readiness notes — captured, not built

- Keep wording **client-generic**: "Staff Portal" / "Luna Front Desk", roles not names.
- The grid model is **resource rows × date columns**; "beds/rooms" is the lodging instance. Sunset (board/wetsuit rentals) would map to **inventory items × time windows** ("out today / due back / stock") — same shell, different vocabulary and tiles.
- Operator-block and manual-booking concepts generalize to **inventory holds** and **manual rental records**; do not abstract the engine now — record as Sunset-readiness debt (STAGE-8.1 §14).

---

## 12. Safety recap (unchanged by this plan)

- `STAFF_ACTIONS_ENABLED = false` · `WHATSAPP_DRY_RUN = true` · `STRIPE_WEBHOOK_SKIP_VERIFY = false`.
- n8n workflows **inactive** (incl. Operator Room Release, Manual Entries, Sync Planning Sheet).
- No webhook POST, no live WhatsApp, no live Stripe, no staff writes enabled.
- Every write surface above is **future + gated**; nothing here is implemented or turned on.
- Pilot decision: **NO_GO**.

---

## 13. Stage 8.3a — IMPLEMENTATION PROOF (2026-06-02)

**Status: PASS**

Changes shipped in `scripts/staff-query-api.js`:

| Feature | Result |
|---|---|
| Date inputs → `type="date"` with `.bc-date-input` styling | ✓ |
| Shortcut chips: Today, This week, Next 30 days, Jul–Aug, Demo range (Jul 16–22) | ✓ |
| `bcSetRange(start,end,chipKey)` helper + active chip highlight | ✓ |
| Default range: next 30 days (computed dynamically in JS) | ✓ |
| Always-visible color legend (confirmed/hold/payment/review/operator/manual/cancelled) | ✓ |
| Operator block CSS class (`bc-block-operator`, dusty-blue) | ✓ |
| Manual/staff block CSS class (`bc-block-manual`, pale teal) | ✓ |
| Inline A/D markers removed from blocks; arrival/departure in tooltip | ✓ |
| Room header: cleaner labels (code — name · type · capacity) | ✓ |
| Bed cell: `bed_code` primary label; `bed_label` as subtitle if different | ✓ |
| Free beds count in summary strip | ✓ |
| Booking blocks 28px tall (was 24px), stronger colors, bigger click target | ✓ |
| Detail panel: cleaner header, no raw `color_type` field, lock icon note | ✓ |
| `bedCalendarColorType()`: operator + manual_staff source detection | ✓ |
| `buildCalendarBlocks()`: `booking_source` included in block payload | ✓ |
| Verifier: 56 checks (13 new Stage 8.3a checks added) — all PASS | ✓ |
| All other verifiers (conversation/login/auth/query/write): all PASS | ✓ |
| No POST/PATCH/DELETE, no drag/drop, no write controls | ✓ |
| Local proof: `http://127.0.0.1:3036/staff/ui` → 200, all elements confirmed | ✓ |

**Safety flags:** `STAFF_ACTIONS_ENABLED=false` · `WHATSAPP_DRY_RUN=true` · n8n inactive · no writes.

**Azure proof:** DONE — image `whstagingacr.azurecr.io/wh-staff-api:bcb3ff5-8x3a` built via `az acr build` (run ID: cb4), deployed to revision `wh-staging-staff-api--0000005`. Login page at `https://staff-staging.lunafrontdesk.com/staff/login` → 200, safety badges confirmed (STAFF_ACTIONS_ENABLED=false, staging/shadow mode). Full UI with date inputs / chips / legend requires authenticated login at `https://staff-staging.lunafrontdesk.com`.

**Files changed:** `scripts/staff-query-api.js`, `scripts/verify-staff-bed-calendar-ui.js`

**Commit:** see `ui(stage8.3a)` commit hash.

## 14. Stage 8.3b — IMPLEMENTATION PROOF (2026-06-02)

**Status: PASS**

Changes shipped in `scripts/staff-query-api.js`:

| Feature | Result |
|---|---|
| Drawer refactored into 6 named sections: Guest / Stay / Room-Beds / Payment / Add-ons / Conversation-Handoff | ✓ |
| Stay: status pill + nights badge + check-in/out/guests/package | ✓ |
| Payment: Total / Paid / Remaining balance rows in €; .owing/.paid color classes | ✓ |
| Room/Beds: clean codes (no UUIDs), per-bed rows with date range | ✓ |
| Planned operations area (disabled): Move / Change dates / Cancel — cursor:not-allowed | ✓ |
| `showBlockDetail` skeleton: status pill in header, cleaner quick-info grid | ✓ |
| No raw `color_type` field in drawer | ✓ |
| CSS: ctx-nights-badge, ctx-pay-row/label/amount, ctx-addon-row, ctx-bed-row, ctx-planned, ctx-planned-action | ✓ |
| Verifier: 72 checks (14 new Stage 8.3b additions) — all PASS | ✓ |
| All other verifiers: all PASS | ✓ |
| Embedded browser JS: node --check PASS | ✓ |
| No POST/PATCH/DELETE, no drag/drop, no write controls | ✓ |

**Safety flags:** `STAFF_ACTIONS_ENABLED=false` · `WHATSAPP_DRY_RUN=true` · n8n inactive.

**Azure proof:** DONE — image `whstagingacr.azurecr.io/wh-staff-api:404ee9a-8x3b` built (ACR run cb6), deployed to revision `wh-staging-staff-api--0000007`. Login page at `https://staff-staging.lunafrontdesk.com/staff/login` returns 200 with Luna Front Desk branding. Full drawer UI requires authenticated login. STAFF_ACTIONS_ENABLED=false, WHATSAPP_DRY_RUN=true, n8n inactive.

## 15. Next slice

**Stage 8.3c — calendar cell selection model:** click empty date cell to highlight a range; no writes; prerequisite for future manual booking modal.
