# Phase 10.3 — Move Room/Bed Write Spec

**Status:** COMPLETE ENOUGH / PASS — Phase 10.3 + **10.3e** (2026-06-04). Implementation + hosted proof complete.  
**Parent:** Phase 10 — Staff Operations Polish  
**Prior:** [Phase 10.2 move preview closeout](ROADMAP.md) — `POST /staff/bookings/move-preview` hosted and proven SELECT-only (commit `6d339e3`, revision `--0000054`)  
**Next:** **Phase 10.4 — Date-change preview** (preview-only; same bed/room MVP; half-open overlap; no mutation)

**Implementation commits:** `d9b5c36` (10.3a spec) · `b5c76fe` (10.3b API) · `0a1acbf` (10.3b.1 verifier alignment) · **`7104815`** (10.3e Staff Portal drawer move controls). **Hosted:** `7104815-stage103e-move-ui-gate-off` → revisions **`--0000058`** (gate OFF UI proof) · **`--0000059`** (gate ON move proof) · **`--0000060`** (gate OFF cleanup, current, **100% traffic**). **Staging gate:** `BOOKING_MOVE_WRITE_ENABLED=false` (default OFF).

**Non-negotiables (preserved):** No n8n activation. No WhatsApp. No Stripe calls from move write. No payment or `booking_service_records` mutation. Staff Portal drawer move UI (**10.3e**) — preview always available; write gated. Write gate OFF on staging after proof.

**Context:** Live WhatsApp **NO_GO**. n8n **inactive** unless explicitly approved. Stripe webhook remains payment truth. `booking_service_records` remains service/add-on truth. Preview path reuses Phase 10.2 half-open overlap + same-day turnover rules.

---

## 1. Purpose

Phase 10.3 is the **gated write step** after Phase 10.2 preview.

Staff need to move an existing booking from one bed/room/date span to another **only after**:

1. Preview logic would allow the move (conflicts empty, target bed active/sellable).
2. Conflicts are **rechecked inside the write transaction** (no trust-the-client preview).
3. The write is **audited** (response + file audit log at minimum).
4. **No side effects** on payments, service records, chat, confirmations, n8n, WhatsApp, or Stripe.

Preview (`POST /staff/bookings/move-preview`) remains available and unchanged. Write is a separate route.

---

## 2. Proposed endpoint

**Route (proposed only — not implemented in 10.3a):**

`POST /staff/bookings/move`

**Request body:**

```json
{
  "client_slug": "wolfhouse-somo",
  "booking_id": "<optional uuid>",
  "booking_code": "<optional code>",
  "target_bed_id": "<uuid>",
  "target_room_id": "<optional uuid>",
  "check_in": "YYYY-MM-DD",
  "check_out": "YYYY-MM-DD",
  "idempotency_key": "<required>",
  "reason": "<optional staff reason>"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `client_slug` | Yes | Tenant scope |
| `booking_id` or `booking_code` | One required | Same as move-preview |
| `target_bed_id` | Yes | UUID of destination bed |
| `target_room_id` | No | If present, must match target bed's room |
| `check_in` / `check_out` | Yes | Half-open stay `[check_in, check_out)` |
| `idempotency_key` | **Required** | Prevents double-click duplicate writes |
| `reason` | No | Stored in audit response / audit log |

**Auth / gates (implementation slice 10.3b):**

- Session auth: **operator** role minimum (`requireAuth('operator')`).
- `STAFF_ACTIONS_ENABLED=true` (same pattern as manual booking writes).
- Proposed additional flag: `BOOKING_MOVE_WRITE_ENABLED=true` (default **false**; staging-only until proof; **currently OFF on staging after 10.3c cleanup**).
- **Not** bot-token auth in MVP.

---

## 3. Write rules

Reuse Phase 10.2 validation and conflict semantics:

| Rule | Spec |
|------|------|
| Auth | Operator+ session; gated flags as above |
| Input | `client_slug`, `booking_id` or `booking_code`, `target_bed_id`, `check_in`, `check_out`, `idempotency_key` |
| Dates | `check_out > check_in`; `YYYY-MM-DD`; half-open stay semantics |
| Target bed | Must exist, belong to client, be `active` and `sellable` |
| Target room | Optional `target_room_id` must match bed's room when provided |
| Overlap | **Strict half-open:** `existing.start < target.check_out && existing.end > target.check_in` |
| Same-day turnover | **Allowed:** `existing.check_out === target.check_in` and `existing.check_in === target.check_out` do **not** conflict (proven hosted in 10.2) |
| Self exclusion | Source booking's own assignment excluded from conflict check |
| Non-blocking | `cancelled` / `expired` booking or assignment status excluded (same as preview) |
| Conflict recheck | **Inside write transaction** before UPDATE; if any blocker → **no mutation** |
| Identity | Preserve `booking_id`, `booking_code`, guest, payment rows, service rows |
| Payments | **No** `payments` INSERT/UPDATE/DELETE |
| Service records | **No** `booking_service_records` mutation |
| Stripe | **No** `api.stripe.com`; webhook truth unchanged |
| Messages | **No** WhatsApp / graph.facebook.com; no confirmation send |
| n8n | **No** workflow activation or HTTP to n8n |
| Ask Luna | **No** intent/router changes |

**MVP date-scope rule (recommended):** Request `check_in`/`check_out` must match the booking's current `bookings.check_in`/`bookings.check_out` **and** the single assignment row's dates. Bed/room change only in 10.3; **date-span changes deferred to Phase 10.4.**

---

## 4. Mutation strategy — Option A (preferred)

**Minimal safe first implementation:** update the **single existing** `booking_beds` row when the booking has exactly **one** active assigned bed row.

### 4.1 Schema reference (`booking_beds`)

From `database/migrations/001_init.sql` (renamed `hostel_id` → `client_id` in 003):

| Column | Role in move |
|--------|----------------|
| `bed_id` | Update to target bed UUID |
| `room_code` | Update from target bed's room |
| `bed_code` | Update from target bed |
| `assignment_start_date` | MVP: unchanged (must equal request dates) |
| `assignment_end_date` | MVP: unchanged |
| `updated_at` | Set via `set_updated_at` trigger on UPDATE |

`bookings` row: **no UPDATE in MVP** except optionally `primary_room_code` sync if product requires drawer consistency — **defer** unless proven necessary; prefer assignment-only mutation first.

### 4.2 Single-row UPDATE (happy path)

When `COUNT(booking_beds WHERE booking_id = ?) = 1`:

```sql
UPDATE booking_beds
SET bed_id = $target_bed_id,
    bed_code = $target_bed_code,
    room_code = $target_room_code,
    updated_at = NOW()
WHERE id = $booking_bed_id
  AND booking_id = $booking_id
  AND client_id = $client_id;
```

Run inside `BEGIN … COMMIT` after conflict recheck SELECT.

### 4.3 Multi-bed / grouped assignment

If booking has **zero** or **more than one** `booking_beds` row:

- Return **200** or **409** with `success: false`, `can_move: false`, `requires_manual_review: true`
- **No mutation** in MVP
- Message: e.g. *Multi-bed assignments cannot be moved automatically. Manual review required.*

### 4.4 What must NOT happen

- No INSERT of new `booking_beds` rows (avoid duplicates)
- No DELETE of old row + INSERT replacement in MVP (prefer in-place UPDATE)
- No touch of `payments`, `booking_service_records`, `conversations`, `messages`

---

## 5. Success response shape

```json
{
  "success": true,
  "moved": true,
  "preview_only": false,
  "would_mutate": true,
  "idempotent": false,
  "booking": {
    "booking_id": "...",
    "booking_code": "MB-WOLFHO-20260920-4f62e2",
    "guest_name": "Manual Polish Test",
    "check_in": "2026-09-20",
    "check_out": "2026-09-23"
  },
  "previous_assignment": {
    "booking_bed_id": "...",
    "bed_id": "...",
    "bed_code": "DEMO-R1-B1",
    "room_code": "DEMO-R1",
    "check_in": "2026-09-20",
    "check_out": "2026-09-23"
  },
  "new_assignment": {
    "booking_bed_id": "...",
    "bed_id": "...",
    "bed_code": "DEMO-R1-B2",
    "room_code": "DEMO-R1",
    "room_name": "Demo Dorm Room 1",
    "check_in": "2026-09-20",
    "check_out": "2026-09-23"
  },
  "audit": {
    "actor": "operator.stage72c@example.test",
    "staff_user_id": "...",
    "staff_role": "operator",
    "reason": null,
    "idempotency_key": "move-20260920-4f62e2-b2-001",
    "intent": "api:booking_move"
  },
  "message": "Booking moved. No payment, service, or message changes were made."
}
```

**Blocked / no-op response (example):**

```json
{
  "success": true,
  "moved": false,
  "can_move": false,
  "preview_only": false,
  "would_mutate": false,
  "conflicts": [ { "booking_code": "...", "check_in": "...", "check_out": "..." } ],
  "message": "Target bed is not available for this date range. No changes were made."
}
```

File audit: reuse `appendAuditLog()` pattern from `staff-query-api.js` with `intent: 'api:booking_move'`, `category: 'booking_move'`, actor, idempotency_key, before/after assignment snapshot.

---

## 6. Idempotency

| Case | Behavior |
|------|----------|
| First write with key | Perform move; return `moved: true`, `idempotent: false` |
| Retry same key + same target | Return **200** `idempotent: true`, same assignment ids, no second UPDATE |
| Booking already at target bed/dates | Return **200** `success: true`, `moved: false`, `idempotent: true` |
| Same key, different target | Return **409** conflict on idempotency misuse |
| Missing key | **400** `idempotency_key is required` |

**Storage (MVP recommendation):** Store move idempotency in `bookings.metadata` JSONB under `metadata->>'move_idempotency_key'` + snapshot of resulting `booking_bed_id` / target bed (mirrors manual-create interim pattern). Dedicated table/column deferred.

**Hard rule:** No duplicate `booking_beds` rows on retry.

---

## 7. Safety gates

| Gate | Rule |
|------|------|
| GATED write | Default OFF; `BOOKING_MOVE_ENABLED=false` until staging proof |
| Staging first | Hosted proof **10.3d** on staging/test only |
| Production | **No production use** until explicit approval after proof |
| WhatsApp | **NO_GO** — no sends |
| n8n | **Inactive** — no activation |
| Stripe | No API calls; webhook truth untouched |
| Payments | No mutation |
| Service records | No mutation |
| Ask Luna | No changes |
| Live guest automation | **NO_GO** |
| Proof booking | `MB-WOLFHO-20260920-4f62e2` (Manual Polish Test) — 10.3c moved B1→B2; 10.3e gate-ON moved B2→B1; remains on **DEMO-R1-B1** after cleanup (`--0000060`) |

---

## 8. Implementation split

| Slice | Scope | Deliverable |
|-------|-------|-------------|
| **10.3a** | Docs/spec | **PASS** (`d9b5c36`) — this document |
| **10.3b** | API handler | **PASS** (`b5c76fe`) — `POST /staff/bookings/move`; operator auth + `BOOKING_MOVE_WRITE_ENABLED`; transaction + conflict recheck; Option A UPDATE; no UI |
| **10.3b.1** | Verifier alignment | **PASS** (`0a1acbf`) — preview verifier distinguishes gated write route |
| **10.3c** | Hosted proof + safety cleanup | **PASS** — move B1→B2 on `MB-WOLFHO-20260920-4f62e2`; gate OFF/ON/OFF; idempotency; revision `--0000057` gate OFF |
| **10.3e** | Staff Portal drawer move UI | **PASS** (`7104815`) — Move bed panel; Preview move + Move booking; gate-OFF UI proof `--0000058`; gate-ON move B2→B1 `--0000059`; cleanup `--0000060` gate OFF |
| **10.4** | Date-change preview/write | **Next** — preview-only; same bed/room MVP; half-open overlap; no mutation yet |

Preview route and verifier (`verify:staff-booking-move-preview`) remain unchanged.

---

## 9. Open questions

| # | Question | Current answer / recommendation |
|---|----------|----------------------------------|
| 1 | What columns represent assignment start/end? | **`booking_beds.assignment_start_date`** and **`assignment_end_date`** (DATE, half-open `[start, end)`). Mirror **`bookings.check_in` / `bookings.check_out`**. Phase 10.2 SQL uses these for overlap. |
| 2 | Do manual bookings have exactly one `booking_beds` row? | **Staging proof booking yes** (`MB-WOLFHO-20260920-4f62e2` → 1 row). Multi-bed manual create exists in UI (`selected_bed_codes[]`) — those bookings may have **N rows**. MVP must reject N≠1. |
| 3 | Dedicated audit table? | **No move-specific table today.** MVP: `appendAuditLog()` file log + full audit object in JSON response. DB audit table deferred (e.g. future `staff_action_audit` migration). |
| 4 | Allow date changes in 10.3? | **Recommend NO for MVP.** 10.3 = bed/room move at **same** check_in/check_out. **Phase 10.4** = date-span change write (requires booking + assignment date sync). |
| 5 | Paid/confirmed bookings — extra gate? | **Recommend soft gate for MVP:** allow move with audit if conflict recheck passes; return `payment_status` in response for staff awareness. **Hard gate** (block when `deposit_paid`/`paid`) optional in 10.3b if owner prefers — document in 10.3b if added. No payment recalculation. |

---

## 10. Recommended MVP write scope

**In scope for 10.3b–10.3d:**

- Single-bed bookings only (exactly one `booking_beds` row)
- Bed/room change only; **same** `check_in`/`check_out` as booking and assignment
- Conflict recheck identical to move-preview logic
- Idempotent POST with required `idempotency_key`
- UPDATE one `booking_beds` row (`bed_id`, `bed_code`, `room_code`)
- Audit in response + file log
- Staging proof on `MB-WOLFHO-20260920-4f62e2`

**Out of scope (defer):**

- Multi-bed moves
- Date-span changes (→ 10.4 preview first)
- `bookings.primary_room_code` sync (unless drawer proof requires it)
- Payment/service/message side effects
- n8n / WhatsApp / Stripe

---

## 11. Relation to move-preview

| Concern | move-preview (10.2) | move write (10.3) |
|---------|---------------------|-------------------|
| Route | `POST /staff/bookings/move-preview` | `POST /staff/bookings/move` |
| SQL | SELECT only | SELECT + single UPDATE |
| `preview_only` | `true` | `false` |
| `would_mutate` | `false` | `true` when move executes |
| Conflict logic | Shared helpers | **Same helpers, re-run in transaction** |
| Idempotency | Not required | **Required** |

Implement 10.3b by extracting shared validation/conflict functions from `handleBookingMovePreview` where possible — **without changing preview behavior**.
