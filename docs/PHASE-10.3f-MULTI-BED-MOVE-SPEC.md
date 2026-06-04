# Phase 10.3f — Multi-Bed Move Selection Spec

**Status:** SPEC ONLY / PASS (2026-06-04) — docs-only design; **no code in this slice**  
**Parent:** Phase 10.3 — Move Room/Bed Write  
**Prior:** [Phase 10.3 move write + UI](PHASE-10.3-MOVE-ROOM-BED-WRITE-SPEC.md) — single-bed same-date move proven on staging; drawer layout cleaned in **10.3e.1** (`efc199a`)  
**Next:** **10.3g** — API: `booking_bed_id` in move-preview + move write → **10.3h** UI source-bed pills → **10.3i** hosted multi-bed proof → close Phase 10.3 fully

**Non-negotiables (preserved):** No n8n activation. No WhatsApp. No Stripe calls. No payment or `booking_service_records` mutation. No booking date mutation. No Ask Luna changes. Live WhatsApp **NO_GO**. n8n **inactive**. Stripe webhook remains payment truth. Write remains gated (`BOOKING_MOVE_WRITE_ENABLED`).

**Context:** Phase 10.3 MVP intentionally restricts move to **exactly one** active `booking_beds` row. Multi-bed or zero-bed bookings return `requires_manual_review: true` / `single_bed_booking_required`. That is **safe** but **too limiting** for real operations where a group booking spans multiple beds and staff need to relocate **one** assignment without touching siblings.

---

## 1. Problem

| State | Behavior today | Gap |
|-------|----------------|-----|
| **Single-bed booking** | Move preview + gated write work end-to-end (Staff Portal drawer, staging proof PASS) | None for MVP single-bed path |
| **Multi-bed booking** | Preview/write return **200** `success: true`, `can_move: false`, `requires_manual_review: true`, `reason: single_bed_booking_required` | Staff cannot move **one** bed inside the booking |
| **Zero-bed booking** | Same manual-review block | Correct — not in scope for automated move |

**Staff need:** In the booking drawer **Move bed** panel, when a booking has **multiple** current bed assignments, select **which assignment** to move, pick a **target bed**, **Preview move**, then **Move booking** (when gate ON and preview passes).

**Scope of mutation:** Move **one** `booking_beds` row (identified by `booking_bed_id`), not the whole booking. Sibling assignments on the same booking must remain unchanged.

---

## 2. Recommended model — assignment-level move via `booking_bed_id`

Extend existing `POST /staff/bookings/move-preview` and `POST /staff/bookings/move` with optional **`booking_bed_id`** — the primary key of the `booking_beds` row to relocate.

### 2.1 Request shape (preview + write)

```json
{
  "client_slug": "wolfhouse-somo",
  "booking_id": "<optional uuid>",
  "booking_code": "<optional code>",
  "booking_bed_id": "<specific assignment row to move>",
  "target_bed_id": "<uuid>",
  "check_in": "YYYY-MM-DD",
  "check_out": "YYYY-MM-DD",
  "idempotency_key": "<write only>",
  "reason": "<optional>"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `client_slug` | Yes | Tenant scope |
| `booking_id` or `booking_code` | One required | Same lookup as today |
| `booking_bed_id` | **Conditional** | See rules below |
| `target_bed_id` | Yes (for full preview) | Destination bed UUID |
| `check_in` / `check_out` | Yes | Same-date MVP: must match booking + selected assignment |
| `idempotency_key` | Write only | Required on `POST /staff/bookings/move` |
| `reason` | No | Audit / response echo |

### 2.2 Selection rules

| Case | `booking_bed_id` | API behavior |
|------|------------------|--------------|
| **Single assignment** | Optional | If omitted, infer the sole active `booking_beds` row (backward compatible) |
| **Multiple assignments** | **Required** | If omitted → `requires_selection: true` (not `requires_manual_review`) |
| **Zero assignments** | N/A | Keep `requires_manual_review: true` / `single_bed_booking_required` or equivalent |
| **Invalid / foreign** | Provided | **Reject** — `booking_bed_id` must belong to resolved booking + client |
| **Wrong booking** | Provided but row belongs to another booking | **400** or **404** with clear error |

### 2.3 Mutation rules

- Move **only** the selected `booking_beds` row (`UPDATE` by `booking_bed_id`).
- **Do not** INSERT or DELETE sibling rows.
- **Do not** change `bookings.check_in` / `check_out`.
- **Do not** mutate payments, service records, messages, n8n, WhatsApp, or Stripe.
- Assignment dates (`assignment_start_date` / `assignment_end_date`) unchanged in MVP (same-date bed move only).

---

## 3. UI behavior — Move bed panel

Applies to Staff Portal booking drawer **Move bed** section (Phase 10.3e base + **10.3h** implementation).

### 3.1 Single current bed

- Auto-select the sole assignment (implicit `booking_bed_id`).
- Current single-bed UX unchanged: target bed dropdown/input → **Preview move** → **Move booking**.

### 3.2 Multiple current beds

| Element | Spec |
|---------|------|
| Source selection | **Selectable pills or radio buttons**, one per current assignment |
| Pill label | Bed code, e.g. `DEMO-R1-B1`, `DEMO-R1-B2` (optionally append room code if ambiguous) |
| Selected pill | Sets `booking_bed_id` sent to preview/write APIs |
| Target bed | Dropdown/input as today; **exclude or disable** the bed currently selected as source |
| Preview button | Disabled until **source bed selected** and **target bed selected** (and not same bed) |
| Move booking | Disabled until preview returns `can_move: true` and gate ON (unchanged gating) |
| Safety copy | Keep: preview does not change anything; same-date only; no date changes in this panel |

### 3.3 Zero or ambiguous assignments

- Keep error state: manual review message; no pills; preview/move disabled.

**Data source:** `rooming.assignments[]` from booking context API (see §8 open questions for field gaps).

---

## 4. API response behavior

### 4.1 Multi-bed, no `booking_bed_id` (selection required)

Replace today's `requires_manual_review` for this case with **`requires_selection: true`**.

```json
{
  "success": true,
  "can_move": false,
  "preview_only": true,
  "would_mutate": false,
  "requires_selection": true,
  "reason": "booking_bed_selection_required",
  "assignments": [
    {
      "booking_bed_id": "...",
      "bed_id": "...",
      "bed_code": "DEMO-R1-B1",
      "room_code": "DEMO-R1",
      "check_in": "2026-09-20",
      "check_out": "2026-09-23"
    }
  ],
  "message": "Select which bed assignment to move."
}
```

| Flag | Value | Meaning |
|------|-------|---------|
| `requires_selection` | `true` | Client must pick `booking_bed_id` and retry |
| `requires_manual_review` | `false` | Not a hard block — staff can proceed after selection |
| `preview_only` | `true` on preview route | No mutation |
| `assignments` | Array | Drives UI pills; same shape as write preview success path |

**Backward compatibility:** Single-bed callers omitting `booking_bed_id` continue to work. Existing UI that never sends `booking_bed_id` on single-bed bookings unchanged.

### 4.2 Multi-bed, valid `booking_bed_id` + target

Same success shape as current single-bed preview/write, but `previous_assignment` / `new_assignment` refer to the **selected** row only. Response should include `booking_bed_id` explicitly in assignment objects.

### 4.3 Deprecation note

For multi-bed + missing `booking_bed_id`, **stop returning** `requires_manual_review: true` / `single_bed_booking_required`. Reserve `requires_manual_review` for true edge cases (zero beds, date mismatch, policy blocks).

---

## 5. Conflict behavior

Conflict check uses the **selected** `booking_beds` row as the self-excluded assignment:

| Rule | Spec |
|------|------|
| Self exclusion | Exclude conflicts from the **selected** `booking_bed_id` / its booking on the **target bed** over the stay dates |
| Sibling rows | **Do not** treat other assignments on the **same booking** as conflicts unless the **target bed + date range** would overlap that sibling's assignment on a **different** bed incorrectly — siblings on **other beds** are irrelevant to target-bed overlap |
| Same booking, two beds | Moving B1 → B2 while booking also holds B2: target overlap logic applies to **destination bed only**; exclude only the row being moved from source-bed conflicts, not sibling occupancy on other beds |
| Same-day turnover | Unchanged — checkout/checkin same day allowed |
| Half-open overlap | Unchanged — `existing.start < target.check_out && existing.end > target.check_in` |
| Non-blocking statuses | Unchanged — cancelled/expired excluded |

**Implementation note (10.3g):** Today conflict SQL excludes by `sourceBookingId`. For multi-bed, exclusion must be at **`booking_bed_id`** granularity (or equivalent: exclude the one row being updated, not all rows for the booking on the target bed query).

---

## 6. Write behavior

When `BOOKING_MOVE_WRITE_ENABLED=true` and preview returns `can_move: true`:

```sql
-- Conceptual: UPDATE exactly one row by primary key
UPDATE booking_beds
SET bed_id = :target_bed_id, bed_code = :..., room_code = :..., updated_at = NOW()
WHERE id = :booking_bed_id
  AND booking_id = :booking_id
  AND client_id = :client_id;
```

| Concern | Behavior |
|---------|----------|
| Rows touched | **1** — selected `booking_bed_id` only |
| Sibling `booking_beds` | **Unchanged** |
| `bookings` row | **No UPDATE** in MVP (including `primary_room_code`) |
| Payments | **No** mutation |
| `booking_service_records` | **No** mutation |
| Messages / WhatsApp / n8n | **No** side effects |
| Idempotency | Required `idempotency_key`; same semantics as 10.3 |
| Transaction | Conflict recheck inside transaction before UPDATE |

---

## 7. Suggested implementation split

| Slice | Scope | Deliverable |
|-------|--------|-------------|
| **10.3f** | Docs/spec | This document — **current step** |
| **10.3g** | API | `booking_bed_id` on move-preview + move write; `requires_selection` response; assignment-scoped conflict exclusion; verifiers updated |
| **10.3h** | UI | Source-bed pills/radios in drawer; send `booking_bed_id`; target dropdown excludes selected source; handle `requires_selection` |
| **10.3i** | Hosted proof | Gate OFF + ON with **multi-bed fixture booking**; move one assignment; verify sibling unchanged; counts audit |
| **10.3 closeout** | Docs | Update [PHASE-10.3-MOVE-ROOM-BED-WRITE-SPEC.md](PHASE-10.3-MOVE-ROOM-BED-WRITE-SPEC.md) § MVP out-of-scope; PROJECT-STATE / ROADMAP |

**Parallel work:** Phase **10.4e** (date-change preview UI) and **10.5** (date-change write) remain independent tracks. Multi-bed move completes Phase **10.3** bed-move vertical without blocking date-change work.

---

## 8. Open questions

| # | Question | Current evidence | Recommendation (MVP) |
|---|----------|------------------|----------------------|
| 1 | Does booking drawer context expose `booking_bed_id` per assignment? | **Yes** — `GET /staff/bookings/:code/context` → `rooming.assignments[]` includes `booking_bed_id` via `getBookingRoomingAssignmentsQuery()` | Use `assignment.booking_bed_id` for pills; no context API change required for IDs |
| 2 | Are `booking_beds` rows stable enough as selection ID? | **Yes** — primary key UUID; move write already updates by `bb.id` in `MOVE_WRITE_UPDATE_BED_SQL` | Use `booking_bed_id` as SoT for selection |
| 3 | Does context expose `bed_id` per assignment for target dropdown filtering? | **Partial gap** — rooming query returns `booking_bed_id`, `bed_code`, `room_code`, dates; **`bed_id` not currently selected** in context query | **10.3h:** add `bed_id` to context assignments **or** map `bed_code` → bed list from calendar cache; prefer adding `bb.bed_id::text AS bed_id` to context query in **10.3g/10.3h** |
| 4 | Target dropdown: exclude all beds already on booking, or only selected source? | Product ambiguity | **MVP: exclude only selected source bed** — moving B1→B2 while booking holds B2 is valid if B2 is empty on those dates; exclude all assigned beds only if conflict UX proves confusing |
| 5 | Should moving one bed update `bookings.primary_room_code` or drawer room summary? | 10.3 spec deferred booking-level sync | **MVP: no booking-level room summary update** — drawer already lists all assignments in stay details; only mutated row changes |
| 6 | Multi-bed moves on paid/confirmed bookings — extra warning? | Not proven in staging | **MVP: allow preview for all statuses**; write gated + audited as today; optional non-blocking UI warning in **10.3h** if `payment_status` is `paid` / `deposit_paid` (copy only, no new gates) |

---

## 9. MVP recommendation (summary)

| Decision | Choice |
|----------|--------|
| Selection key | `booking_bed_id` |
| Rows mutated | **One** `booking_beds` row per move |
| Siblings | Unchanged |
| Booking-level fields | Unchanged |
| Multi-bed, no selection | `requires_selection: true` + `assignments[]` |
| Zero-bed | Keep manual review block |
| Preview | Available for all statuses |
| Write | Gated, idempotent, audited |
| Date change | Still **not** in move panel → Phase 10.4/10.5 |

---

## 10. Relation to Phase 10.3 MVP

| Concern | Single-bed (shipped) | Multi-bed (10.3f–10.3i) |
|---------|----------------------|-------------------------|
| `booking_bed_id` | Inferred when one row | Required when >1 row |
| Block reason | N/A | `booking_bed_selection_required` vs `single_bed_booking_required` |
| Conflict exclusion | Whole booking on target bed | **Selected row only** |
| UI | Target + preview + move | **+ source pills** |
| Write SQL | Same `UPDATE booking_beds WHERE id = $booking_bed_id` | Same — already row-keyed |

Implement **10.3g** by extending existing handlers; do **not** fork new routes.

---

## 11. Safety checklist (10.3f slice)

| Check | Status |
|-------|--------|
| Docs only | ✓ |
| No code | ✓ |
| No migrations | ✓ |
| No DB writes | ✓ |
| No deploy | ✓ |
| No n8n | ✓ |
| No WhatsApp | ✓ |
| No Stripe | ✓ |
