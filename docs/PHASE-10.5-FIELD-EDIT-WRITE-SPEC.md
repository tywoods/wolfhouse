# Phase 10.5 — Gated Field Edit Writes Spec

**Status:** **PASS** (2026-06-04) — docs/spec only (**10.5a**); no code in this slice  
**Parent:** Phase 10 — Staff Operations Polish  
**Prior:** [Phase 10.4 field edit + running invoice](PHASE-10.4-FIELD-EDIT-RUNNING-INVOICE-SPEC.md) — preview UI + `POST /staff/bookings/edit-preview` hosted (`48b956b` / `b426b02` fixes → revision **`--0000074`**) · [Phase 10.3 move write](PHASE-10.3-MOVE-ROOM-BED-WRITE-SPEC.md) — move gate OFF  
**Next:** **10.5b** — contact write API (simplest first)

**Non-negotiables (preserved):** No n8n activation. No WhatsApp. No Stripe API calls from edit write. Stripe webhook remains **payment truth**. `booking_service_records` remains **add-on/service truth**. Live WhatsApp **NO_GO**. n8n **inactive** unless explicitly approved. `BOOKING_MOVE_WRITE_ENABLED=false` unchanged (separate gate). No automatic Stripe links, refunds, or guest messages on edit write.

**Context:** Phases **10.4d–10.4f** delivered read-only running invoice, field edit UI shell, and calculate-only edit preview. Phase **10.4f.2** (`b426b02`) fixed embedded UI parse (`bcFieldEditActivate`) and Today navigation. Staff can preview contact, dates, package, and guest-decrease edits; nothing is saved yet. This document defines the **gated write** path before any implementation.

---

## 1. Purpose

**Phase 10.5 — Gated field edit writes**

Allow staff to **apply one field-level edit at a time** after preview, with the same boundaries as preview:

| Action | Fields |
|--------|--------|
| **Contact** | `guest_name`, `email` |
| **Dates** | `check_in`, `check_out` (together) |
| **Package** | `package_code` |
| **Guests** | `guest_count` **decrease only** |

Requirements:

- **Gated** — `BOOKING_EDIT_WRITE_ENABLED=false` by default; staging proofs only when explicitly enabled.
- **Audited** — actor, optional reason, `idempotency_key`, `edit_type` in response + file audit log (MVP).
- **Idempotent** — same key + same payload → no duplicate mutation.
- **Safe** — reuse preview validation; if preview would fail, write fails with **no mutation**.

Writes must not broaden scope: no guest increase, no move bed, no add-on creation, no payment/Stripe mutation in MVP.

---

## 2. Gate

| Flag | Default | Scope |
|------|---------|--------|
| `BOOKING_EDIT_WRITE_ENABLED` | **`false`** | Staging/local until proof; production OFF until pilot GO |

When gate **OFF**:

| Surface | Behavior |
|---------|----------|
| `POST /staff/bookings/edit` | **403** — e.g. `booking_edit_write_disabled` |
| Staff UI Save buttons | **Disabled** (or hidden); Preview remains available |
| DB | **No mutation** |

When gate **ON** (staging proof only):

- Operator session auth required (same as move write / manual booking).
- `STAFF_ACTIONS_ENABLED=true` recommended pattern (align with `POST /staff/bookings/move`).
- Preview endpoint **unchanged** and always available.

**Separate from:** `BOOKING_MOVE_WRITE_ENABLED` — move write stays its own gate and proof track.

---

## 3. Proposed endpoint

**Route (proposed — not implemented in 10.5a):**

`POST /staff/bookings/edit`

**Request body:**

```json
{
  "client_slug": "wolfhouse-somo",
  "booking_id": "<optional uuid>",
  "booking_code": "<optional code>",
  "edit_type": "contact",
  "guest_name": "<optional>",
  "email": "<optional>",
  "check_in": "YYYY-MM-DD",
  "check_out": "YYYY-MM-DD",
  "package_code": "<optional>",
  "guest_count": 1,
  "idempotency_key": "<required>",
  "reason": "<optional staff reason>"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `client_slug` | Yes | Tenant scope |
| `booking_id` or `booking_code` | One required | Same as edit-preview |
| `edit_type` | Yes | `contact` \| `dates` \| `package` \| `guests` |
| Type-specific fields | Per `edit_type` | Same shapes as edit-preview |
| `idempotency_key` | **Required** | Non-empty string; prevents double-click duplicates |
| `reason` | No | Trimmed; max ~500 chars; audit only |

**Auth / gates (implementation):**

- Session auth: **operator** minimum (`requireAuth('operator')`).
- `STAFF_ACTIONS_ENABLED=true` (recommended; match move write).
- `BOOKING_EDIT_WRITE_ENABLED=true` (required for write).
- **Not** bot-token auth in MVP.

**Write pipeline (recommended):**

1. Validate gate, auth, JSON, `edit_type`, `idempotency_key`.
2. Load booking + assignments + service records (read).
3. **Reuse** `handleBookingEditPreview` logic internally (shared helpers) — same validation, conflicts, guest release plan, invoice impact calculation.
4. If preview outcome is `can_apply: false` (or equivalent blocked state) → **409/400** with preview reason; **no transaction**.
5. If idempotency store matches prior successful write for same key → **200** `idempotent: true`, return stored before/after; **no second mutation**.
6. Else `BEGIN` → apply single edit-type mutation → `COMMIT`.
7. Return before/after, `invoice_impact`, audit block, `would_mutate: true` on success path (contrast preview).

**Response (success shape — illustrative):**

```json
{
  "success": true,
  "idempotent": false,
  "edit_type": "contact",
  "booking": { "booking_id": "...", "booking_code": "..." },
  "before": { "guest_name": "...", "email": "..." },
  "after": { "guest_name": "...", "email": "..." },
  "invoice_impact": {
    "payment_mutation": false,
    "stripe_mutation": false,
    "total_amount_cents": null,
    "balance_due_cents": null,
    "needs_refund": false
  },
  "audit": {
    "staff_user_id": "...",
    "staff_role": "operator",
    "reason": "...",
    "idempotency_key": "...",
    "edit_type": "contact",
    "ts": "ISO-8601"
  },
  "message": "Booking updated.",
  "elapsed_ms": 42
}
```

Preview route `POST /staff/bookings/edit-preview` remains separate and always calculate-only.

---

## 4. Contact write

| Rule | Spec |
|------|------|
| Fields | `guest_name`, `email` only |
| Validation | Same as preview: name length, email format |
| DB | `UPDATE bookings` SET `guest_name`, `email` (and `updated_at`) |
| Beds | **No** `booking_beds` mutation |
| Payments | **No** `payments` INSERT/UPDATE/DELETE |
| Service records | **No** `booking_service_records` mutation |
| Invoice | Typically `no_pricing_change`; return `invoice_impact` with `payment_mutation: false` |
| Stripe / n8n / WhatsApp | **None** |
| Audit | actor, `reason`, `idempotency_key`, `edit_type: contact` |

**Recommendation:** Implement **10.5b** first — smallest blast radius, no repricing, no bed logic.

---

## 5. Date write

| Rule | Spec |
|------|------|
| Fields | `check_in` + `check_out` edited **together** |
| Validation | `check_out > check_in`; `YYYY-MM-DD`; half-open stay `[check_in, check_out)` |
| Pre-write | **Recheck availability** for all **current active** `booking_beds` rows (same as preview) |
| Overlap | Strict half-open; same-day turnover allowed; exclude source booking’s own rows |
| Conflict | Any blocker → **no mutation**; return conflicts like preview |
| On success | `UPDATE bookings.check_in`, `bookings.check_out` |
| Assignments | `UPDATE booking_beds` SET `assignment_start_date` = new `check_in`, `assignment_end_date` = new `check_out` for **all remaining active** rows (not rows already slated for release in a chained guest preview — write is one `edit_type` per request) |
| Repricing | Recalculate accommodation expected total via quote engine / `quote_snapshot` pattern where supported; update `bookings.total_amount_cents` / `balance_due_cents` per §8 |
| Stripe / n8n / WhatsApp | **None** |

**Paid / confirmed bookings:** Allow write with preview + extra UI warning in **10.5f**; spec does not block, but hosted proof should include a paid booking case before production GO.

---

## 6. Package write

| Rule | Spec |
|------|------|
| Validation | `package_code` against pricing config + fallback list (same as `editPreviewIsValidPackage`) |
| DB | `UPDATE bookings.package_code` (and related quote fields if model stores them) |
| Repricing | Recalculate accommodation line; update expected `total_amount_cents` / `balance_due_cents` per §8 |
| Beds | **No** bed assignment change |
| Stripe | **No** API call |
| Paid vs new total | If `total < amount_paid` → set internal **needs_refund** / review flag only; **no** automatic refund |

---

## 7. Guest decrease write

| Rule | Spec |
|------|------|
| Direction | **Decrease only** |
| Increase | `guest_count > current` → reject `guest_increase_not_supported` (same as preview); **no mutation** |
| Release count | `current_guest_count - new_guest_count` |
| Selection | Release beds from **end** of ordered assignment list (assignment order → else `created_at ASC`, `id ASC`) — same as preview |
| UI | **No** staff bed picker |
| Insufficient rows | `requires_manual_review: true` → **no mutation** |

**Write behavior (on success):**

1. `UPDATE bookings.guest_count` = new count.
2. For each `release_booking_bed_id` from preview plan:
   - **Preferred (if schema supports):** mark row `released` / `cancelled` / inactive — **TODO: confirm column before 10.5e implementation**.
   - **Current schema note:** `booking_beds` has **no** independent lifecycle status column in `001_init.sql`; `database/schema-proposal.md` says status derives from `bookings.status`. Existing cancel flows use **`DELETE FROM booking_beds`** (e.g. `cancel-booking-beds-postgres.js`, manual-entry rollback).
   - **MVP recommendation for 10.5e:** Use **`DELETE`** for released assignment rows only when verifier + impact plan prove no downstream FK breakage; **do not** hard-delete booking or payments. Document choice in 10.5e implementation notes. **Defer** new `released` status column to a later migration unless product requires retained history.
3. Recalculate accommodation expected charge / invoice impact per §8.
4. **No** Stripe refund.

**Remaining beds:** Unchanged assignments stay on their beds/dates.

---

## 8. Running invoice / payment write rules

| Principle | Spec |
|-----------|------|
| Payment truth | **Stripe webhook** + `payments` rows — **never** overwritten by edit write |
| Running invoice | **Expected charges** for staff display — may be derived on read |
| Stripe | **No** `api.stripe.com` from edit write |
| Checkout / link | **No** create payment link on edit |
| Refund | **No** automatic refund |

**Internal booking fields (when repricing applies):**

| Scenario | Booking fields (if they exist today) |
|----------|--------------------------------------|
| New total > paid | Increase `balance_due_cents`; `payment_status` may remain; staff collects via existing flows |
| New total < paid | Set `needs_refund` / `refund_review_needed` in response + optional booking metadata flag — **no** auto refund |
| New total = paid | `balance_due_cents` → 0; paid-in-full display |

**Known columns (staging schema baseline):**

- `bookings.guest_count`, `bookings.package_code`, `bookings.check_in`, `bookings.check_out`
- `bookings.total_amount_cents`, `bookings.amount_paid_cents`, `bookings.balance_due_cents`, `bookings.deposit_*`
- `bookings.metadata` (JSONB) — may hold `quote_snapshot`; confirmation draft separate

**Persistence caution:**

- There is **no** dedicated invoice/payment-draft table in MVP beyond `bookings` + `payments` + `booking_service_records`.
- If exact invoice line-item persistence is unclear, write should update **booking core fields** + return **`invoice_impact`** JSON; **do not invent** new payment rows or Stripe state.
- **TODO (10.5c–10.5e):** Document which repricing helper updates `total_amount_cents` / `balance_due_cents` vs compute-on-read only.

**Service records:** **No** mutation on accommodation/date/package/guest writes.

---

## 9. Audit / idempotency

| Item | MVP spec |
|------|----------|
| `idempotency_key` | Required on every write request |
| Idempotent retry | Same key + same normalized payload → **200**, `idempotent: true`, same `before`/`after`, no duplicate UPDATE |
| Audit in response | `staff_user_id`, `staff_role`, `reason`, `idempotency_key`, `edit_type`, `ts` |
| File log | Reuse `appendAuditLog` with `intent: api:booking_edit_write`, `category: booking_edit_write` |
| DB audit table | **Deferred** — optional later migration |

**Idempotency storage (implementation options — pick one in 10.5b):**

- In-memory / file-backed MVP **not** recommended for multi-replica Container Apps.
- **Recommended:** store last successful write per `(client_slug, booking_id, idempotency_key)` in `bookings.metadata` sub-key or small dedicated table in a later slice — **10.5a does not add migration**; 10.5b may use metadata JSONB sub-object `edit_write_idempotency[key]` for staging MVP if acceptable.

---

## 10. Suggested implementation split

| Slice | Scope | Deliverable |
|-------|--------|-------------|
| **10.5a** | Docs/spec | **PASS** — this document |
| **10.5b** | Contact write API | `POST /staff/bookings/edit` for `edit_type: contact` only; gated; no invoice mutation |
| **10.5c** | Package write API | Gated package change + repricing / `invoice_impact` |
| **10.5d** | Date write API | Gated dates + availability recheck + booking + `booking_beds` date columns |
| **10.5e** | Guest decrease write API | Gated guest count down + release last assignments + refund review flags |
| **10.5f** | UI Save wiring | Save buttons call write when gate ON; preview before save or internal preview reuse; gate OFF disables Save |

**Order rationale:** Contact → package → dates → guests (increasing complexity and bed/payment touch).

**Verifier slices (suggested):** `verify-staff-booking-edit-write.js` per slice or one growing verifier; must assert gate OFF → 403, no Stripe/WhatsApp/n8n, no service-record mutation.

---

## 11. Open questions (with recommendations)

| # | Question | Recommendation |
|---|----------|----------------|
| 1 | Which booking fields store package and guest count today? | `bookings.package_code`, `bookings.guest_count` (confirmed in `001_init.sql`). Package id optional via `package_id` FK. |
| 2 | Which `booking_beds` status/release fields exist? | **No** per-row status in baseline schema; derive from `bookings.status` per schema-proposal. Release likely **`DELETE`** row for MVP unless migration adds `released_at` / status. **Confirm in 10.5e** before coding. |
| 3 | Should released beds be status-marked or deleted? | **Prefer status/history column in long term**; **MVP: DELETE last N rows** only if impact reports + cancel-flow precedent accept it; document in 10.5e commit. |
| 4 | Which fields store expected total/balance? | `bookings.total_amount_cents`, `amount_paid_cents`, `balance_due_cents`; paid truth from `payments` / webhook. |
| 5 | Is there an invoice/payment draft table suitable for running invoice persistence? | **No** dedicated table in MVP; use booking columns + API `invoice_impact` response; **TODO** if persistent line items needed later. |
| 6 | Should paid/confirmed date changes be allowed immediately? | **Allow** with preview + prominent UI warning in 10.5f; extra hosted proof on paid booking before GO. |
| 7 | Should contact write be allowed without preview? | **Allow** write without prior client preview call if server reruns same validation internally; UI should still encourage Preview for staff confidence. |
| 8 | Should write update drawer immediately or reload context? | **Reload context** via existing `loadBlockDetail` after success — simplest, avoids stale invoice shell. |

**Cross-cutting recommendations:**

- Start with **contact write (10.5b)**.
- Keep package/date/guest behind **preview + gate**.
- For guest decrease, **prefer non-destructive marking when schema supports it**; until then, **DELETE with care** and staging proof counts.
- If invoice persistence is unclear, return **`invoice_impact`** and mark **TODO** in implementation — do not write uncertain payment fields.

---

## 12. Safety checklist (10.5a slice)

| Check | Status |
|-------|--------|
| Docs only | ✓ |
| No code | ✓ |
| No migrations | ✓ |
| No DB writes | ✓ |
| No deploy | ✓ |
| No n8n activation | ✓ |
| No WhatsApp | ✓ |
| No Stripe | ✓ |
| Move write gate unchanged | OFF (`BOOKING_MOVE_WRITE_ENABLED=false`) |
| Edit preview unchanged | Calculate-only |
| Live WhatsApp | **NO_GO** |

---

## 13. Relation to Phase 10.4 hosted state

| Item | Value |
|------|--------|
| Edit preview | `POST /staff/bookings/edit-preview` — `preview_only: true`, `would_mutate: false` |
| Running invoice UI | Hosted **10.4d** (`6466f1f` / `--0000072` baseline) |
| Field edit UI + preview | Hosted **10.4e–10.4f** on **`--0000074`** (`b426b02` parse fix) |
| Today navigation | **PASS** after `bcFieldEditActivate` fix |
| Write route | **Not implemented** — this spec defines **10.5b–10.5f** |

Prior preview proofs (DEMO-2603 guest decrease, Manual Polish contact/dates/package) remain valid; write proofs must re-run with gate ON and count before/after checks.
