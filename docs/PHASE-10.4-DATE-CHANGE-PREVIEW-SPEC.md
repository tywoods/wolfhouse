# Phase 10.4 — Date-Change Preview Spec

**Status:** **10.4a PASS** — docs/spec only (2026-06-04). No implementation yet.  
**Parent:** Phase 10 — Staff Operations Polish  
**Prior:** [Phase 10.3 move write + UI closeout](PHASE-10.3-MOVE-ROOM-BED-WRITE-SPEC.md) — same-date bed move write + Staff Portal drawer move controls proven on staging (`7104815`, revision `--0000060`, gate OFF)  
**Next:** **10.4b** — SELECT-only `POST /staff/bookings/date-change-preview` API handler

**Non-negotiables (preserved):** No n8n activation. No WhatsApp. No Stripe calls. No payment or `booking_service_records` mutation. No booking/date mutation in 10.4. Live WhatsApp **NO_GO**. n8n **inactive** unless explicitly approved. Stripe webhook remains payment truth. `booking_service_records` remains service/add-on truth.

**Context:** Phase 10.2 move-preview and Phase 10.3 move write handle **bed/room change at fixed dates**. Phase 10.4 is the **preview-only** step for **date-span change** on an existing booking before any write exists. Date-change **write** is explicitly **Phase 10.5** (not in scope for 10.4).

---

## 1. Purpose

Phase 10.4 lets staff **preview** whether an existing booking can move to a new `check_in` / `check_out` date range **before** any write path exists.

Staff need answers to:

| Question | Preview must answer |
|----------|---------------------|
| Can this booking keep the same bed over the new dates? | `can_change_dates` + `conflicts[]` |
| What conflicts would block it? | `conflicts[]` with blocking booking details |
| What would the new nights count be? | `proposed.nights` vs `current.nights` |
| What payment/pricing impact might exist? | `pricing_impact` (informational only; **no payment mutation**) |

This phase is **SELECT-only**. No UPDATE, INSERT, or DELETE. No UI write button. No guest notification.

---

## 2. Proposed endpoint

**Route (proposed only — not implemented in 10.4a):**

`POST /staff/bookings/date-change-preview`

**Request body:**

```json
{
  "client_slug": "wolfhouse-somo",
  "booking_id": "<optional uuid>",
  "booking_code": "<optional code>",
  "new_check_in": "YYYY-MM-DD",
  "new_check_out": "YYYY-MM-DD",
  "target_bed_id": "<optional uuid, defaults to current assigned bed>",
  "reason": "<optional staff reason>"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `client_slug` | Yes | Tenant scope |
| `booking_id` or `booking_code` | One required | Same lookup pattern as move-preview |
| `new_check_in` / `new_check_out` | Yes | Proposed half-open stay `[new_check_in, new_check_out)` |
| `target_bed_id` | No | Defaults to current single assigned bed; optional override if cheap to reuse move-preview bed logic |
| `reason` | No | Echoed in response/audit context only; not persisted in 10.4 |

**Auth (implementation slice 10.4b):**

- Session auth: **operator** role minimum (`requireAuth('operator')`).
- **Not** bot-token auth in MVP.
- No additional write gate required for preview (read-only); same pattern as `POST /staff/bookings/move-preview`.

---

## 3. Preview rules

| Rule | Spec |
|------|------|
| Auth | Operator+ session |
| Input | `client_slug`, `booking_id` or `booking_code`, `new_check_in`, `new_check_out` |
| Dates | `new_check_out > new_check_in`; `YYYY-MM-DD`; half-open stay semantics |
| Bed scope | **MVP:** keep **same bed** as current single assignment unless `target_bed_id` explicitly provided |
| Single-bed | Exactly **one** active `booking_beds` row required |
| Multi-bed | Return **200** `success: true`, `can_change_dates: false`, `requires_manual_review: true`, **no mutation** |
| SQL | **SELECT only** — no UPDATE/INSERT/DELETE |
| Booking dates | **No** `bookings.check_in` / `check_out` mutation |
| Assignment dates | **No** `booking_beds.assignment_*` mutation |
| Payments | **No** `payments` mutation; **no** Stripe link creation |
| Service records | **No** `booking_service_records` mutation |
| Messages | **No** WhatsApp / graph.facebook.com; no confirmation send |
| n8n | **No** workflow activation |
| Ask Luna | **No** intent/router changes |
| Response flags | Always `preview_only: true`, `would_mutate: false` |

**Nights calculation:** `nights = days between new_check_in and new_check_out` using the same half-open convention as Bed Calendar / manual booking (`check_out − check_in` in calendar days; e.g. 2026-09-20 → 2026-09-23 = **3 nights**).

---

## 4. Conflict logic

Reuse Phase 10.2 / 10.3 half-open overlap semantics on the **target bed** over the **proposed date range**.

**Overlap test (strict half-open):**

```
existing.assignment_start_date < new_check_out
AND existing.assignment_end_date > new_check_in
```

| Rule | Spec |
|------|------|
| Scope | All other assignments on `target_bed_id` for the client |
| Self exclusion | **Exclude** the booking being previewed (its current assignment must not block itself) |
| Non-blocking statuses | Skip `cancelled` / `expired` booking or assignment status (same as move-preview) |
| Same-day turnover | **Allowed:** `existing.check_out === new_check_in` → **not** a conflict |
| Same-day turnover | **Allowed:** `existing.check_in === new_check_out` → **not** a conflict |
| Target bed | Must exist, belong to client, be `active` and `sellable` when `target_bed_id` is resolved |

If `target_bed_id` is omitted, resolve from the booking's single `booking_beds.bed_id`. If optional `target_bed_id` is provided and differs from current bed, reuse move-preview bed validation + conflict query with proposed dates (only if implementation cost is low in 10.4b).

---

## 5. Success response — allowed

```json
{
  "success": true,
  "can_change_dates": true,
  "preview_only": true,
  "would_mutate": false,
  "booking": {
    "booking_id": "...",
    "booking_code": "MB-WOLFHO-20260920-4f62e2",
    "guest_name": "Manual Polish Test"
  },
  "current": {
    "check_in": "2026-09-20",
    "check_out": "2026-09-23",
    "nights": 3,
    "bed_id": "...",
    "bed_code": "DEMO-R1-B1",
    "room_code": "DEMO-R1"
  },
  "proposed": {
    "check_in": "2026-09-21",
    "check_out": "2026-09-25",
    "nights": 4,
    "bed_id": "...",
    "bed_code": "DEMO-R1-B1",
    "room_code": "DEMO-R1"
  },
  "conflicts": [],
  "pricing_impact": {
    "requires_reprice": true,
    "nights_delta": 1,
    "payment_mutation": false,
    "note": "Preview only. No payment or Stripe changes were made."
  },
  "message": "Date-change preview passed. No changes were made."
}
```

When proposed nights equal current nights, set `pricing_impact.requires_reprice: false` and `nights_delta: 0`.

---

## 6. Success response — blocked

```json
{
  "success": true,
  "can_change_dates": false,
  "preview_only": true,
  "would_mutate": false,
  "requires_manual_review": false,
  "booking": {
    "booking_id": "...",
    "booking_code": "MB-WOLFHO-20260920-4f62e2",
    "guest_name": "Manual Polish Test"
  },
  "current": {
    "check_in": "2026-09-20",
    "check_out": "2026-09-23",
    "nights": 3,
    "bed_code": "DEMO-R1-B1"
  },
  "proposed": {
    "check_in": "2026-09-20",
    "check_out": "2026-09-23",
    "nights": 3,
    "bed_code": "DEMO-R1-B1"
  },
  "conflicts": [
    {
      "booking_id": "...",
      "booking_code": "MB-WOLFHO-20260801-4f10c3",
      "guest_name": "Luna Test 855",
      "check_in": "2026-07-28",
      "check_out": "2026-08-10",
      "bed_id": "..."
    }
  ],
  "pricing_impact": {
    "requires_reprice": false,
    "nights_delta": 0,
    "payment_mutation": false,
    "note": "Preview only. No payment or Stripe changes were made."
  },
  "message": "Current bed is not available for the proposed dates. No changes were made."
}
```

**Multi-bed booking (MVP reject):**

```json
{
  "success": true,
  "can_change_dates": false,
  "preview_only": true,
  "would_mutate": false,
  "requires_manual_review": true,
  "message": "Multi-bed assignments cannot be date-changed automatically. Manual review required."
}
```

---

## 7. Payment / pricing policy (preview only)

| Rule | Spec |
|------|------|
| Payment mutation | **Forbidden** — no INSERT/UPDATE/DELETE on `payments` |
| Stripe | **No** `api.stripe.com`; no checkout link creation |
| Balance / status | **No** update to `bookings.balance_due_cents`, `amount_paid_cents`, or `payment_status` |
| Nights delta | **Allowed** — report `current.nights`, `proposed.nights`, `pricing_impact.nights_delta` |
| Reprice hint | **Allowed** — `requires_reprice: true` when `proposed.nights !== current.nights` |
| Exact quote | **Deferred** — do **not** call `calculateWolfhouseQuote()` for exact new totals in 10.4 MVP unless explicitly approved later |
| Paid bookings | Preview **allowed**; show conflicts + pricing impact. Write phase (**10.5**) should probably require manual review when `deposit_paid` / `paid` |
| Service records | **No** mutation; **no** automatic `service_date` shift in 10.4 |

**Hard rule:** Preview responses must include `pricing_impact.payment_mutation: false` and a note that no payment or Stripe changes were made.

---

## 8. Write phase explicitly deferred

| Item | Phase |
|------|-------|
| Date-change preview (SELECT-only) | **10.4** |
| Date-change write (UPDATE bookings + booking_beds dates) | **10.5** (design/spec later) |
| Staff Portal date-change UI write button | **After 10.5** |
| Guest notification / confirmation resend | **Not in 10.4 or 10.5 MVP** |

**10.4 must not:**

- Add `POST /staff/bookings/date-change` or any write route
- Add a UI “Apply date change” button
- Trigger n8n, WhatsApp, Stripe, or confirmation send

---

## 9. Implementation split

| Slice | Scope | Deliverable |
|-------|-------|-------------|
| **10.4a** | Docs/spec | **PASS** — this document |
| **10.4b** | API handler | `POST /staff/bookings/date-change-preview`; operator auth; SELECT-only conflict check; response shapes above |
| **10.4c** | Static verifier | `verify:staff-booking-date-change-preview` — route exists, SELECT-only, no write routes, safety flags |
| **10.4d** | Hosted preview proof | Staging proof on `MB-WOLFHO-20260920-4f62e2` or golden booking; allowed + blocked cases; no DB mutation |
| **10.5** | Date-change write | **Later** — gated write spec + implementation after preview proof |

**Recommended proof booking:** `MB-WOLFHO-20260920-4f62e2` (Manual Polish Test, currently **DEMO-R1-B1**, 2026-09-20→2026-09-23).

---

## 10. Open questions

| # | Question | Recommendation (MVP 10.4) |
|---|----------|---------------------------|
| 1 | Should date-change preview allow `target_bed_id` or same-bed only? | **Same-bed default.** Allow optional `target_bed_id` only if it reuses move-preview conflict logic cheaply in 10.4b; otherwise defer cross-bed + date change combo to later. |
| 2 | Should paid/confirmed bookings be previewable but write-blocked? | **Yes.** Preview shows conflicts + `requires_reprice`; write gate in **10.5** blocks or flags manual review for `deposit_paid` / `paid`. |
| 3 | Should pricing impact calculate exact new quote or only nights delta? | **Nights delta + `requires_reprice` only.** Do not calculate exact new payment truth in 10.4. |
| 4 | Should service/add-on dates move with booking dates later? | **Defer.** Likely manual review or separate slice; preview may note `service_records_outside_stay: true` in 10.5+ if cheap to detect. |
| 5 | Should date-change write be blocked for bookings with paid add-ons or services? | **Recommend soft block in 10.5 write:** allow preview always; write returns `requires_manual_review: true` when paid `booking_service_records` exist until allocation policy is defined. |

---

## 11. Recommended MVP preview scope (10.4b–10.4d)

**In scope:**

- Single-bed bookings only (exactly one `booking_beds` row)
- Same-bed date change preview (default); optional `target_bed_id` if reuse is trivial
- Half-open conflict check identical to move-preview semantics
- `current` vs `proposed` dates + nights
- `pricing_impact`: `nights_delta`, `requires_reprice`, `payment_mutation: false`
- Operator session auth; SELECT-only SQL

**Out of scope (defer):**

- Date-change write (→ **10.5**)
- Exact quote / balance recalculation
- Payment / Stripe / service-record mutation
- Multi-bed date changes (return `requires_manual_review`)
- UI date-change panel (→ after preview proof, likely with 10.5 write)
- n8n / WhatsApp / guest automation

---

## 12. Relation to move-preview / move write

| Concern | move-preview (10.2) | move write (10.3) | date-change preview (10.4) |
|---------|---------------------|-------------------|----------------------------|
| Route | `POST /staff/bookings/move-preview` | `POST /staff/bookings/move` | `POST /staff/bookings/date-change-preview` |
| What changes | Target bed/room | Target bed/room | Proposed check_in/check_out |
| Dates | Fixed (same as booking) | Fixed (same as booking) | **New** proposed range |
| SQL | SELECT only | SELECT + UPDATE | SELECT only |
| `preview_only` | `true` | `false` on write | `true` |
| Conflict logic | Shared half-open | Re-run in transaction | Shared half-open on target bed |

Implement 10.4b by extracting shared conflict helpers from move-preview where possible — **without changing move-preview or move-write behavior**.
