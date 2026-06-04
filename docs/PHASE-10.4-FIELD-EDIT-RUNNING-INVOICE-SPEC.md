# Phase 10.4 — Field-Level Booking Edits + Running Invoice Spec

**Status:** **PASS** (2026-06-04) — docs/spec only (**10.4c**); no code in this slice  
**Parent:** Phase 10 — Staff Operations Polish  
**Prior:** [Phase 10.3 move write + multi-bed UI closeout](PHASE-10.3-MOVE-ROOM-BED-WRITE-SPEC.md) — bed move proven; write gate OFF (`636aac2` / `--0000071`) · [Phase 10.4 date-change preview API](PHASE-10.4-DATE-CHANGE-PREVIEW-SPEC.md) — `POST /staff/bookings/date-change-preview` proven (`ac4c1d5` / `--0000061`); absorbed into broader edit model below  
**Next:** **10.4d** — Running invoice display (read-only Payment section line items)

**Non-negotiables (preserved):** No n8n activation. No WhatsApp. No Stripe calls from edit preview/write. Stripe webhook remains **payment truth**. `booking_service_records` remains **add-on/service truth**. Live WhatsApp **NO_GO**. n8n **inactive** unless explicitly approved. Move write gate remains **OFF** until separate proof. No automatic Stripe links or refunds in MVP.

**Context:** Phase 10.3 closed the bed-move vertical. The prior next step was a narrow **date-change preview UI** (**10.4e**). Product direction now broadens to **field-level booking edits** with a **running invoice** model in the Payment section — one controlled edit action at a time, preview first, gated writes later.

---

## 1. Purpose

Staff need to **safely edit one booking field or field-group at a time** from the booking drawer, without entering a giant “edit entire booking” mode.

Goals:

| Goal | Approach |
|------|----------|
| Reduce complexity | **One active edit action** at a time |
| Reduce risk | **Preview first**, then gated write (separate slices) |
| Clear money impact | **Running invoice** line items in Payment section |
| Preserve truth | Stripe webhook = paid amount; service records = add-ons |

This document (**10.4c**) is **spec only**. No routes, UI, migrations, or deploy in this slice.

---

## 2. Field-level edit model

### 2.1 One action at a time

Only **one** edit action may be active in the booking drawer at a time. Opening a new edit action closes or disables others.

Each action has its own:

- UI shell (inline edit controls)
- Validation rules
- Preview path (calculate-only)
- Write path (gated, later in **10.5**)

This avoids combined “edit everything” state and keeps conflict/availability logic scoped.

### 2.2 Editable actions (MVP scope)

| Action | Fields | Notes |
|--------|--------|-------|
| **Edit guest** | `guest_name`, `guest_email` (and phone if exposed) | Simple text fields; no availability |
| **Edit dates** | `check_in` + `check_out` together | Single combined action; calendar/date pickers |
| **Edit package** | accommodation package | Dropdown from pricing config |
| **Reduce guests** | `guest_count` down only | Dropdown; see §3–§4 |
| **Add add-ons** | — | **Later** — **10.6** staff add-ons UI |

**Not in this flow:** increase guest count (separate **Add guest** flow later), move bed (existing **10.3** Move bed panel), cancel booking (future phase).

### 2.3 UX pattern (each action)

1. Staff clicks inline **Edit** on a field/group.
2. Drawer shows controls for **that action only**.
3. Staff changes value(s).
4. **Preview** (when implemented in **10.4f**) shows validation, availability, bed release summary, running invoice delta.
5. **Save / Apply** (when implemented in **10.5**) — gated; disabled until preview passes and gate ON.
6. On success or cancel, drawer returns to read-only view.

**10.4e** UI shell may show **Preview** disabled or **Save** disabled until later slices.

---

## 3. Guest count rule

| Rule | Spec |
|------|------|
| Direction | **Decrease only** in this flow |
| Increase | **Not allowed** here — separate future **Add guest** flow (availability + bed assignment required) |
| Control | **Dropdown** |
| Options | Current guest count **down to 1**, inclusive |
| Example | Current = 4 → options: **4, 3, 2, 1** — **no 5** |

Selecting the same count as current = no-op / cancel preview.

---

## 4. Bed release rule when guests decrease

When guest count **decreases**, the system **automatically releases beds** from the booking. Staff do **not** pick which beds to release.

### 4.1 Assignment ordering

Order active `booking_beds` rows for the booking:

1. **Primary:** explicit assignment order if the model exposes it (e.g. sort key on assignment).
2. **Fallback:** `created_at ASC`, then `id ASC`.

**Released beds** = last N assignments in that ordered list, where N = `current_guest_count - new_guest_count`.

**Kept beds** = first `new_guest_count` assignments in that ordered list.

### 4.2 Example

| | Value |
|---|-------|
| Current guests | 3 |
| Beds (ordered) | R1-B1, R1-B2, R1-B3 |
| New guests | 1 |
| **Release** | R1-B3, R1-B2 |
| **Keep** | R1-B1 |

### 4.3 Preview before save (required UI)

Before any write, UI must show:

```
Guests: 3 → 1
Will release: R1-B3, R1-B2
Remaining: R1-B1
```

If staff wants a **different** remaining bed, they must **Move bed** first (Phase 10.3), then reduce guests.

### 4.4 Date availability interaction

If guest count was reduced first (or in same preview chain), **released beds are not checked** for date availability on subsequent date edits — only **remaining** assignments are checked.

---

## 5. Date edit rule

| Rule | Spec |
|------|------|
| Fields | `check_in` and `check_out` edited **together** as one action |
| Inputs | Calendar / date picker controls (not free-text long-term) |
| Validation | `check_out` must be **after** `check_in` (half-open `[check_in, check_out)`) |
| Availability | Must pass availability check **before save** |
| Multi-bed | Check availability for **all remaining** bed assignments on proposed dates |
| After guest reduction | Do **not** check beds already marked for release |
| Turnover | Same-day checkout/checkin allowed — **half-open** overlap rules (same as move-preview / date-change-preview) |

Existing `POST /staff/bookings/date-change-preview` is a building block; broader field-edit preview (**10.4f**) should unify dates + invoice + multi-bed remaining assignments.

---

## 6. Package edit rule

| Rule | Spec |
|------|------|
| Control | **Dropdown** |
| Options source | **Pricing/package config** (e.g. `wolfhouse-somo.pricing.json`) — not hard-coded long-term |
| Staging | Temporary hard-coded fallback acceptable for staging-only proofs |
| Repricing | Package change **reprices accommodation line item** only |
| Beds | **No** bed assignment change implied by package change unless explicitly designed later |
| Preview | Show old vs new package, nights, accommodation subtotal delta |

---

## 7. Running invoice model

The booking drawer **Payment** section should evolve from a flat summary into a **running invoice** — line-item based, always reflecting **expected charges** vs **payment truth**.

### 7.1 Required line item groups

| Group | Source | Example |
|-------|--------|---------|
| **Accommodation / package** | Quote calculator + booking package + nights × rate | Malibu package — 7 nights × €40 = **€280** |
| **Add-ons / services** | `booking_service_records` | Wetsuit — 3 days × €5 = **€15**; Surf lesson — 1 × €35 = **€35** |
| **Total** | Sum of line items | **€330** |
| **Paid** | Payment truth (Stripe webhook / `payments`) | **€100** |
| **Balance due** | `total - paid` (when total ≥ paid) | **€230** |
| **Refund / credit needed** | When `total < paid` | Show **needs refund** or **credit needed** — manual review |

### 7.2 Example display

```
Accommodation:
  Malibu package — 7 nights × €40 = €280

Add-ons:
  Wetsuit — 3 days × €5 = €15
  Surf lesson — 1 × €35 = €35

Total:     €330
Paid:      €100
Balance due: €230
```

### 7.3 When booking changes

| Scenario | Behavior |
|----------|----------|
| **Total increases** | Increase **balance due**; **do not** auto-send Stripe link |
| **Total decreases below paid** | Mark **`needs_refund: true`** / **refund review needed**; **no** automatic refund; refund UI refined later |
| **Preview** | Running invoice preview shows proposed line items before write |
| **Paid amount** | **Never** overwritten by edit preview — paid comes from payment truth only |

---

## 8. Payment truth rules

| Rule | Spec |
|------|------|
| Payment truth | **Stripe webhook** (and persisted `payments` rows) |
| Running invoice | **Internal expected charges** — not payment truth |
| Paid amount | From payments / webhook; **not** recalculated by edit preview |
| Total increases | **Balance due** increases; staff initiates payment link separately (existing flows) |
| Total decreases below paid | **`needs_refund: true`** / **`refund_review_needed`** — manual refund/credit review |
| Stripe refund | **No** automatic refund in MVP |
| Stripe link | **No** automatic send on edit |
| WhatsApp | **No** automatic message on edit |
| Service records | **`booking_service_records`** unchanged by accommodation/date/package edits unless add-on action (**10.6**) |

---

## 9. Proposed data concepts (no migration in 10.4c)

Document likely concepts for later implementation — **do not create migration in this slice**.

| Concept | Description |
|---------|-------------|
| **`invoice_preview` / line items array** | Calculate-only object returned by edit preview API |
| **`accommodation_line_item`** | Package label, nights, unit rate, subtotal cents |
| **`service_line_items[]`** | From `booking_service_records` — type, qty, unit, subtotal |
| **`total_cents`** | Sum of accommodation + services |
| **`paid_cents`** | From payment truth (sum of recognized payments for booking) |
| **`balance_due_cents`** | `max(0, total_cents - paid_cents)` |
| **`needs_refund` / `refund_review_needed`** | Derived when `total_cents < paid_cents` |
| **`bed_release_preview[]`** | Beds to release on guest reduction — codes + `booking_bed_id` |
| **`pricing_impact`** | Delta summary for preview (reuse pattern from date-change-preview) |

These may live in API response JSON first; persistent invoice table is **out of scope** for MVP unless later justified.

---

## 10. Implementation split

| Slice | Scope | Deliverable |
|-------|--------|-------------|
| **10.4a–10.4b** | Date-change preview | **DONE** — spec + `POST /staff/bookings/date-change-preview` (`ac4c1d5`) |
| **10.4c** | Docs/spec | **PASS** — this document |
| **10.4d** | Running invoice display | Payment section **read-only** line items from existing data where possible; **no edit, no write** |
| **10.4e** | Field edit UI shell | Inline Edit buttons per field/group; name/email, dates, package, reduce-guests dropdown shells; **no save/write** |
| **10.4f** | Edit preview API | Calculate-only preview for dates / package / guest reduction; availability; running invoice preview; **no mutation** |
| **10.5** | Gated field edit writes | One action at a time; `BOOKING_EDIT_WRITE_ENABLED=false` default; staged proofs; **no Stripe / n8n / WhatsApp** |
| **10.6** | Staff add-ons UI | Add `booking_service_records` from drawer; update running invoice; payment draft/link later |

**Supersedes:** narrow **“10.4e date-change preview UI only”** as the immediate next step. Date-change remains **one action** inside the broader field-edit model; existing date-change-preview API is reused/extended in **10.4f**.

---

## 11. Open questions

| # | Question | Recommendation |
|---|----------|----------------|
| 1 | **Package source?** | Pricing/package config (`wolfhouse-somo.pricing.json`); temporary staging fallback OK |
| 2 | **Guest increase?** | Separate **Add guest** flow later — requires availability + bed assignment |
| 3 | **Released bed row behavior?** | Design in **10.5** write spec; prefer **status/released marker** if schema supports; avoid hard DELETE unless current model expects delete |
| 4 | **Paid booking total decreases?** | Allow **preview**; write marks `refund_review_needed` / `needs_refund`; **no** automatic refund |
| 5 | **Should Save exist now?** | **Not until preview/write phases.** UI shell (**10.4e**) may show disabled Save or preview-only |
| 6 | **Add-ons in edit flow now?** | **After** running invoice (**10.4d**) and core edit actions — **10.6** |
| 7 | **Relation to move bed?** | Move bed stays separate panel (**10.3**); use Move bed before Reduce guests if staff wants specific remaining bed |
| 8 | **Single vs multi-bed date preview?** | Extend date-change-preview logic to **all remaining assignments** in **10.4f** |

---

## 12. Safety checklist (10.4c slice)

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
| Live WhatsApp | **NO_GO** |

---

## 13. Relation to prior Phase 10.4 work

| Concern | Date-change preview (10.4a–b) | Field edit + running invoice (10.4c+) |
|---------|------------------------------|--------------------------------------|
| Scope | Dates only, single-bed MVP API | Guest, dates, package, guest reduction + invoice |
| Endpoint | `POST /staff/bookings/date-change-preview` | Broader preview in **10.4f** (may wrap/extend existing) |
| UI | Was planned as standalone **10.4e** | Dates become one **Edit dates** action among others |
| Payment display | Flat summary | **Running invoice** line items (**10.4d**) |
| Write | Deferred | **10.5** gated field writes |

Prior API proof and verifier remain valid; direction expands without discarding date-change logic.
