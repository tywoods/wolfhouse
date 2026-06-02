# Stage 8.4.1 — Wolfhouse Pricing / Payment Config Plan

**Status:** PLAN / CONFIG-SHAPE ONLY — **PASS** (2026-06-02). No code. No DB writes. No migrations. No API route. No Azure. No live Stripe/WhatsApp. `STAFF_ACTIONS_ENABLED=false`, `MANUAL_BOOKING_ENABLED=false`.

**HEAD at authoring:** `884453f`.
**Parent:** [`STAGE-8.4-MANUAL-BOOKING-CREATION.md`](STAGE-8.4-MANUAL-BOOKING-CREATION.md) (slice 1 of the 7-slice manual-booking ladder).
**Primary sources of truth:** [`package-pricing.md`](package-pricing.md) and the seeded `package_price_rules` table in [`../database/migrations/002_package_pricing.sql`](../database/migrations/002_package_pricing.sql). Schema references: `001_init.sql`, `003_rename_hostel_to_client.sql`, `004_payment_schema_phase2.sql`, `007_add_addon_orders.sql`, `008_add_staff_handoffs.sql`.

> **Scope guard.** This document defines the **config shape, contracts, and rules** that future slices (8.4.2–8.4.12) will implement. It builds nothing and enables nothing. Manual booking creation stays a disabled, UI-unwired stub.

---

## 1. Purpose — pricing must be deterministic, not guessed

Manual booking creation must **not** rely on arbitrary form-entered totals or AI guessing. A config-driven pricing/payment "brain" must produce **price, deposit, balance, and Stripe amount deterministically** before any create path can be trusted.

**Target end-to-end flow (future):**
1. Staff selects beds/dates on the Bed Calendar.
2. Availability preview passes (already exists: `POST /staff/manual-bookings/preview`).
3. Quote/pricing config calculates the price (deterministic, from config).
4. Staff reviews the quote.
5. Booking create uses the **quote snapshot** OR an explicit, audited staff override.
6. An internal **payment record** is created from the quote.
7. A **Stripe payment link / session** is created from the payment record (separate, later, gated slice).
8. A **Stripe webhook** confirms payment truth.
9. Booking/payment status updates safely.

**Vocabulary (must be used consistently everywhere downstream):**

| Term | Meaning |
|---|---|
| **Booking** | The guest stay (`bookings` row). |
| **Booking beds** | Room/bed assignment for that stay (`booking_beds` rows). |
| **Quote** | The calculated price + the formula/line items that produced it. Internal, deterministic. |
| **Payment record** | Internal amount owed (`payments` row). NOT money movement. |
| **Stripe payment link / session** | External payment collection (Stripe Checkout Session / Payment Link). |
| **Stripe webhook** | The single source of **payment truth**. |
| **Confirmation** | Guest-facing booking confirmation. Allowed **only** after payment truth OR an approved manual payment status set by staff. |

---

## 2. Known Wolfhouse pricing config (concrete)

All euro values are expressed in **cents**. Values below are either explicitly known business rules or already seeded in `package_price_rules` / documented in `package-pricing.md`.

```jsonc
// Wolfhouse pricing/payment config — illustrative shape (NOT executed)
{
  "client_slug": "wolfhouse-somo",
  "currency": "EUR",
  "config_version": "2026-06-02.1",

  "deposits": {
    // KNOWN amounts; per_scope needs owner confirmation (see §3).
    "weekly_package_deposit_cents": 20000,   // €200
    "custom_or_short_stay_deposit_cents": 10000, // €100
    "deposit_scope": "REQUIRED_FROM_STAFF",  // per_booking | per_person
    "deposit_varies_by_package": "REQUIRED_FROM_STAFF",
    "deposit_varies_by_room_type": "REQUIRED_FROM_STAFF"
  },

  "hold": {
    "expiry_minutes": 60                     // 1 hour hold expiry (bookings.hold_expires_at)
  },

  "rounding": {
    "nightly_round_up_to_cents": 500,        // round UP to nearest €5 per night, per person
    "method": "ceil_to_nearest_5_eur"        // Math.ceil(eur/5)*5
  },

  "payment_options": ["deposit", "full", "pay_on_arrival"],
  "remaining_balance_methods": ["cash", "bank_transfer", "stripe_on_arrival"],

  "packages": [
    {
      "code": "malibu",
      "name": "Malibu",
      "price_scope": "per_person",           // KNOWN: per person per week, shared base
      "base_room_type": "shared",
      "allowed_nights": "any",               // weekly = 7; custom = prorate
      "custom_night_formula": "ceil5(weekly_per_person/7) * nights",
      "deposit_rule": "weekly_if_7_nights_else_custom",
      "seasonal_weekly_price_cents": {        // from package_price_rules seed
        "spring_autumn": { "months": [4,5,6,10], "weekly_per_person_cents": 24900 },
        "summer":        { "months": [7,9],      "weekly_per_person_cents": 29900 },
        "august":        { "months": [8],        "weekly_per_person_cents": 34900, "priority": 10 }
      },
      "room_type_supplements": {
        "double_or_private_per_person_per_night_cents": 1000  // +€10 pppn
      },
      "staff_review_required_if_missing": true
    },
    {
      "code": "uluwatu",
      "name": "Uluwatu",
      "price_scope": "per_person",
      "base_room_type": "shared",
      "allowed_nights": "any",
      "custom_night_formula": "ceil5(weekly_per_person/7) * nights",
      "deposit_rule": "weekly_if_7_nights_else_custom",
      "seasonal_weekly_price_cents": {
        "spring_autumn": { "months": [4,5,6,10], "weekly_per_person_cents": 34900 },
        "summer":        { "months": [7,9],      "weekly_per_person_cents": 39900 },
        "august":        { "months": [8],        "weekly_per_person_cents": 44900, "priority": 10 }
      },
      "room_type_supplements": {
        "double_or_private_per_person_per_night_cents": 1000
      },
      "staff_review_required_if_missing": true
    },
    {
      "code": "waimea",
      "name": "Waimea",
      "price_scope": "per_person",
      "base_room_type": "shared",
      "allowed_nights": "any",
      "custom_night_formula": "ceil5(weekly_per_person/7) * nights",
      "deposit_rule": "weekly_if_7_nights_else_custom",
      "seasonal_weekly_price_cents": {
        "spring_autumn": { "months": [4,5,6,10], "weekly_per_person_cents": 49900 },
        "summer":        { "months": [7,9],      "weekly_per_person_cents": 54900 },
        "august":        { "months": [8],        "weekly_per_person_cents": 59900, "priority": 10 }
      },
      "room_type_supplements": {
        "double_or_private_per_person_per_night_cents": 1000
      },
      "staff_review_required_if_missing": true
    }
  ],

  "add_ons": [
    { "code": "wetsuit",            "name": "Wetsuit rental",        "unit": "per_day",   "price_cents": 500,  "charge_timing": "REQUIRED_FROM_STAFF" },
    { "code": "soft_top",           "name": "Soft-top board",        "unit": "per_day",   "price_cents": 1500, "charge_timing": "REQUIRED_FROM_STAFF" },
    { "code": "wetsuit_soft_top",   "name": "Wetsuit + soft-top promo", "unit": "per_day", "price_cents": 1500, "replaces": ["wetsuit","soft_top"] },
    { "code": "hard_board",         "name": "Hard board",            "unit": "per_day",   "price_cents": 2000, "charge_timing": "REQUIRED_FROM_STAFF" },
    { "code": "wetsuit_hard_board", "name": "Wetsuit + hard board promo", "unit": "per_day", "price_cents": 2000, "replaces": ["wetsuit","hard_board"] },
    { "code": "lesson_single",      "name": "Single surf lesson",    "unit": "per_lesson", "price_cents": 3500 },
    { "code": "lesson_multi",       "name": "Surf lesson (2+)",      "unit": "per_lesson", "price_cents": 3000, "applies_when": "lesson_count >= 2" },
    { "code": "yoga",               "name": "Yoga class",            "unit": "per_class", "price_cents": 1500, "charge_timing": "on_site_default" }
  ],

  "refund_rules": {
    "paid_cancellation": "staff_handoff",
    "paid_refund": "staff_handoff",
    "paid_date_change": "staff_handoff",
    "unpaid_cancellation": "may_automate_if_safe",
    "unpaid_date_change": "may_automate_if_safe",
    "bad_weather_or_no_wave_lesson_refund": "staff_handoff_manual_day_by_day"
  },

  "handoff_rules": {
    "reason_codes": ["pricing_uncertain", "refund_required", "paid_change_requested"]
  },

  "automation_rules": {
    "auto_payment_link_after_required_details_and_deterministic_quote": true,
    "auto_confirmation_after_payment_truth": true,
    "never_auto_refund_paid_bookings": true
  },

  "missing_required_values": [ /* see §3 */ ]
}
```

> **Note on `priority`:** August (`month=8`) rules carry `priority: 10` and override the July/September summer rule when the check-in month is August — matching `package_price_rules.priority` in migration 002.

---

## 3. Missing config — REQUIRED_FROM_STAFF / TODO

The package **prices, scope, seasons, and double-room supplement are already known** (seeded). The remaining unknowns below must be confirmed by Ale/Cami before automatic pricing can be fully trusted. **Do not invent these values.**

| Key | Status | Notes |
|---|---|---|
| `deposits.deposit_scope` | **REQUIRED_FROM_STAFF** | Is €200 / €100 deposit **per booking** or **per person**? Critical for group bookings. |
| `deposits.deposit_varies_by_package` | **REQUIRED_FROM_STAFF** | Does deposit change between Malibu/Uluwatu/Waimea? |
| `deposits.deposit_varies_by_room_type` | **REQUIRED_FROM_STAFF** | Does deposit change for double/private? |
| `deposits.custom_stay_deposit_by_package` | **REQUIRED_FROM_STAFF** | Does the €100 short-stay deposit vary by package or room type? |
| `add_ons[*].charge_timing` (wetsuit, soft_top, hard_board) | **REQUIRED_FROM_STAFF** | Charged with the booking payment, or tracked/paid **on site**? Default assumption: on site. |
| `group_pricing` / `discounts` | **REQUIRED_FROM_STAFF** | Any group discount tiers? Promo codes? Discount mechanics? |
| `retreat_camp_special_pricing` | **REQUIRED_FROM_STAFF** | Retreats / special camps / events — exact rates and rules. |
| `operator_pricing_rules` | **REQUIRED_FROM_STAFF** | How operator/tour-operator blocks are priced (often €0 / negotiated). |
| `multi_week_stays` | **REQUIRED_FROM_STAFF** | Confirm prorate formula is correct for stays **> 7 nights** (e.g. 10 or 14 nights) and whether multi-week is just `weekly × weeks`. |
| `longer_stay_discount` | **REQUIRED_FROM_STAFF** | Any discount for long stays? |
| `seasonal_edge_months` | confirm | Months Jan–Mar, Nov–Dec are **not** in any seeded rule. Confirm closed season vs missing rates. |
| `package_price_per_booking_vs_per_person_for_private` | confirm | For a fully-private room booked by 1 guest, confirm pricing intent. |

**Packages are known, not missing:** `malibu`, `uluwatu`, `waimea` with the seeded weekly prices above. They are recorded as KNOWN. (Were prices unknown, they would read `"weekly_price_cents": "REQUIRED_FROM_STAFF"` while still listing code/name.)

---

## 4. Concrete config object shape

```jsonc
{
  "client_slug": "string",
  "currency": "EUR",
  "config_version": "string",
  "deposits": { /* amounts in cents + scope flags */ },
  "hold": { "expiry_minutes": 60 },
  "rounding": { "nightly_round_up_to_cents": 500, "method": "ceil_to_nearest_5_eur" },
  "payment_options": ["deposit", "full", "pay_on_arrival"],
  "remaining_balance_methods": ["cash", "bank_transfer", "stripe_on_arrival"],
  "packages": [
    {
      "code": "string",
      "name": "string",
      "weekly_price_cents": "int | { season: cents } | REQUIRED_FROM_STAFF",
      "price_scope": "per_person | per_booking | REQUIRED_FROM_STAFF",
      "allowed_nights": "any | [int] | '7-only'",
      "custom_night_formula": "ceil5(weekly_per_person/7) * nights",
      "deposit_rule": "weekly_if_7_nights_else_custom | custom | REQUIRED_FROM_STAFF",
      "room_type_supplements": { "double_or_private_per_person_per_night_cents": 1000 },
      "room_type_pricing_notes": "string",
      "staff_review_required_if_missing": true
    }
  ],
  "add_ons": [ /* code, name, unit, price_cents, replaces?, applies_when?, charge_timing */ ],
  "refund_rules": { /* see §2 */ },
  "handoff_rules": { "reason_codes": ["pricing_uncertain","refund_required","paid_change_requested"] },
  "automation_rules": { /* see §2 */ },
  "missing_required_values": ["deposit_scope", "..."]
}
```

---

## 5. Quote input contract (future quote function)

```jsonc
// Required
{
  "client_slug": "wolfhouse-somo",
  "check_in": "YYYY-MM-DD",
  "check_out": "YYYY-MM-DD",     // exclusive (half-open)
  "nights": "int",
  "guest_count": "int >= 1",
  "package_code": "string | null",   // or package_id
  "room_type": "shared | double | private | REQUIRED",
  "booking_type": "weekly_package | custom_stay | manual_booking | operator_block | add_on_only",
  "payment_choice": "deposit | full | pay_on_arrival",
  "currency": "EUR",
  "add_ons": [ { "code": "string", "qty": "int", "days": "int|null", "lesson_count": "int|null" } ]
}
// Optional
{
  "season": "string|null",          // normally derived from check_in month
  "promo_code": "string|null",
  "discount_cents": "int|null",
  "source": "string|null",          // walk_in | phone | email | whatsapp | staff_manual
  "language": "string|null",
  "staff_manual_override": { /* see §11 */ } ,
  "amount_paid_cents": "int|null",   // already paid (manual record)
  "booking_status": "string|null",
  "payment_status": "string|null",
  "notes": "string|null"
}
```

---

## 6. Quote output contract

```jsonc
{
  "success": true,
  "quote_id": "string",                 // ephemeral or persisted snapshot id
  "client_slug": "wolfhouse-somo",
  "currency": "EUR",
  "nights": 3,
  "guest_count": 2,
  "line_items": [
    { "type": "accommodation", "label": "Malibu shared · 3 nights · 2 guests", "unit_cents": 11000, "qty": 2, "amount_cents": 22000 },
    { "type": "add_on", "code": "wetsuit", "label": "Wetsuit rental · 3 days · 2", "unit_cents": 500, "qty": 6, "amount_cents": 3000 },
    { "type": "discount", "label": "Promo", "amount_cents": -0 },
    { "type": "manual_adjustment", "label": "Staff override", "amount_cents": 0 },
    { "type": "deposit_request", "label": "Deposit due now", "amount_cents": 10000 },
    { "type": "balance_due", "label": "Balance on arrival", "amount_cents": 15000 }
  ],
  "subtotal_cents": 25000,
  "discount_cents": 0,
  "total_cents": 25000,
  "deposit_required_cents": 10000,
  "payment_link_amount_cents": 10000,   // = deposit OR total per payment_choice
  "amount_paid_cents": 0,
  "balance_due_cents": 15000,
  "payment_options": ["deposit", "full", "pay_on_arrival"],
  "confidence": "high | medium | low",
  "blockers": [],
  "warnings": [],
  "formula_summary": "ceil5(24900/7)=4000/night ×3 ×2 guests = 24000? see note",
  "staff_review_required": false,
  "source": "automatic_quote | manual_override | staff_entered",
  "missing_config": []
}
```

**Line item types:** `accommodation` (package), `add_on`, `discount`, `manual_adjustment`, `deposit_request`, `balance_due`.

---

## 7. Wolfhouse package calculation rules

All math in cents; convert to EUR only for the `ceil5` step, then back to cents.

**A. Weekly package (nights = 7, weekly price + scope known):**
- `per_person_cents = seasonal_weekly_per_person_cents` (no proration).
- `accommodation_cents = per_person_cents × guest_count` (scope = per_person).
- `+ double_or_private_supplement = 1000 × guest_count × nights` if room_type ∈ {double, private}.
- `deposit_required_cents = 20000` (€200), pending `deposit_scope` confirmation.
- payment options: deposit now / full now / remainder on arrival.

**B. Custom / shorter / longer stay (nights ≠ 7):**
- `nightly_per_person_eur = ceil_to_nearest_5(weekly_per_person_eur / 7)`
- `per_person_cents = nightly_per_person_eur × 100 × nights`
- `accommodation_cents = per_person_cents × guest_count` (scope = per_person)
- `+ double/private supplement` as in A.
- `deposit_required_cents = 10000` (€100), pending `deposit_scope` confirmation.
- payment options: deposit / full / remainder on arrival.

**C. Missing weekly price or scope:** `staff_review_required = true`; `missing_config` includes the package price/scope; **no auto payment link**.

**D. Unknown / special package:** `staff_review_required = true`; **no auto payment link**.

**E. Retreat / camp / special event:** `staff_review_required = true` unless exact config exists.

> **Worked example (matches `package-pricing.md`):** Malibu spring (€249/wk pp), 3 nights, 2 guests, shared: `ceil5(249/7)=ceil5(35.57)=40 → €40/night pp`? **No** — the documented total uses `ceil5(249×3/7)=ceil5(106.71)=110 → €110 pp`, then `×2 = €220` shared = `22000 cents`. The per-night display rate (`ceil5(249/7)=40`) is for WhatsApp quotes only; the **billed** total uses prorate-then-round on the whole stay.

---

## 8. Add-on pricing rules

- **Rentals are per day.** `amount = price_cents × days × qty`.
- **Promo combos replace separate line items** when both are selected together:
  - `wetsuit + soft_top` → single `wetsuit_soft_top` line at €15/day (replaces the two).
  - `wetsuit + hard_board` → single `wetsuit_hard_board` line at €20/day (replaces the two).
- **Lessons:** 1 lesson = €35; **2+ lessons = €30 each** (applies to all lessons in that booking when count ≥ 2).
- **Yoga = €15/class, normally booked & paid on site** (`charge_timing: on_site_default`).
- **Add-ons may be tracked separately** from the accommodation balance (existing `add_on_orders` / `add_on_items` / `lesson_requests` / `yoga_requests` / `rental_requests` tables from migration 007).
- **Weather / no-wave lesson refunds require a staff handoff** (manual, day-by-day).
- Add-ons should become **staff-queryable operational records** (already stubbed in migration 007).
- `charge_timing` for rentals is **REQUIRED_FROM_STAFF** (with-booking vs on-site).

---

## 9. Payment record / invoice model

**For v1, "invoice" means an internal payment record / amount due — NOT a formal invoice PDF.** A Stripe Checkout Session / Payment Link is created **from** that payment record in a later, gated slice. (Formal invoice PDFs are out of scope unless explicitly required later.)

**Map quote output → existing schema (confirmed column names):**

`bookings` (001 + 004):
- `total_amount_cents` ← `quote.total_cents`
- `amount_paid_cents` ← starts 0 (webhook-maintained for Stripe; staff-set for manual paid)
- `balance_due_cents` ← `quote.balance_due_cents` (app-maintained: total − paid)
- `deposit_required_cents` ← `quote.deposit_required_cents`
- `deposit_paid_cents` ← webhook/staff
- `payment_option` ← `quote.input.payment_choice`
- `payment_status` (enum: `not_requested`,`waiting_payment`,`payment_link_sent`,`deposit_paid`,`paid`,`refunded`,`failed`,`expired`)
- `metadata.quote_snapshot` (v1) or `metadata.quote_snapshot_id` (v2)

`payments` (after 004):
- `payment_kind` (enum: `deposit_only` | `full_amount`)
- `amount_due_cents` ← `quote.payment_link_amount_cents`
- `amount_paid_cents` ← webhook-only
- `status` (`payment_record_status` enum: `draft`,`checkout_created`,`pending`,`paid`,`expired`,`cancelled`,`failed`)
- `currency` = `EUR`
- `stripe_checkout_session_id` / `stripe_payment_intent_id` / `checkout_url` — **NULL until the explicit payment-link slice (8.4.9)**

`workflow_events` (after 003: `workflow_name`, `node_name`, `event_level`, `message`, `booking_id`, `payload`) — event names recorded via `message`/`payload`:
- `quote_created`, `quote_manual_override`, `payment_record_created`, `payment_link_created`, `payment_confirmed`.

`staff_handoffs` (008: `reason_code` TEXT, config-driven):
- reason_codes `pricing_uncertain`, `refund_required`, `paid_change_requested`.

---

## 10. Quote snapshot storage

A quote snapshot must **freeze** everything needed to reproduce/justify the price:
- input fields (dates, nights, guests, package, room_type, payment_choice, add_ons)
- `config_version`
- package/rate used (which seasonal rule)
- formula text
- line items
- total, deposit, payment-link amount
- staff override (if any)
- warnings / blockers
- `staff_review_required`
- `created_by` (staff_user_id) + `created_at`

**Storage plan:**
- **v1 (interim):** `bookings.metadata.quote_snapshot` (JSONB) when no dedicated table exists.
- **v2:** a `quote_snapshots` table (`id`, `client_id`, `booking_id`, `config_version`, `input`, `output`, `created_by`, `created_at`) referenced via `bookings.metadata.quote_snapshot_id`.

---

## 11. Staff override rules

Staff may override: **total price, deposit amount, discount, remaining balance, add-on price.**

Every override must require and record:
- `staff_user_id`
- `role` (operator/admin/owner gate)
- `reason` (non-empty)
- before/after snapshot
- audit event (`quote_manual_override` in `workflow_events`)
- a visible **"manual override"** label in the Staff Portal

A manual override **may allow** manual booking creation even when pricing config is incomplete, but **only** with: explicit reason + audit + staff-role gate + **no automatic payment link** unless the amount is valid and explicitly confirmed.

---

## 12. Confidence / handoff rules

**Automatic quote (confidence = high) allowed only if ALL hold:**
- package exists, rate configured, price scope clear (per_person vs per_booking)
- dates/nights valid, guest count known
- no special-event ambiguity
- no manual-override conflict
- no paid change/refund/cancellation in play

**Staff handoff required if ANY hold:**
- package unknown · price missing · price scope missing
- custom discount requested · group pricing unclear · operator booking
- paid cancellation / refund / date-change
- bad weather / no-wave lesson refund
- manual price override unclear
- guest disputes price · booking changed after payment

---

## 13. Luna guest-facing behavior

**Confidence high:** give the total → ask deposit vs full payment → send payment link after required details + a frozen quote snapshot.
**Confidence low:** ask one clarifying question → if still unclear, hand off to staff.
**Never:** invent prices · promise refunds · confirm a paid booking without payment truth · change a paid booking's price without staff review.

---

## 14. Staff Portal behavior

Staff Portal must show:
- **price source:** automatic quote · manual override · staff-entered
- formula summary
- total · deposit required · deposit paid · total paid · remaining balance
- payment status · payment link amount
- confidence / warnings
- **staff-review-required** banner
- missing-config warning when relevant

The manual booking form must eventually:
- preview the quote before create
- show the formula before create
- allow manual override with a reason
- create a booking **only** from a quote snapshot or an explicit, audited manual override
- **never silently trust an arbitrary form total**

---

## 15. Hard gate before `MANUAL_BOOKING_ENABLED` may ever be true

All of the following must exist and be proven:
1. Concrete pricing config exists for Wolfhouse.
2. Required package prices/scope configured **OR** manual override is required for the gap.
3. Quote calculator exists and is tested.
4. Quote snapshot shape exists.
5. Payment-record creation consumes quote output (not arbitrary form totals).
6. The create helper uses the quote snapshot / payment record safely (one transaction, conflict re-check).
7. Audit includes the **pricing basis** (automatic vs override, config version).
8. Staff Portal clearly shows the price source.
9. Rollback behavior handles **draft** payment records and quote snapshots.
10. Stripe payment-link generation remains a **separate, gated** slice.

Until then: `MANUAL_BOOKING_ENABLED=false`, `STAFF_ACTIONS_ENABLED=false`, create route stays a disabled, UI-unwired stub.

---

## 16. Implementation ladder (8.4.x)

| Slice | Title | Type | Writes? |
|---|---|---|---|
| **8.4.1** | Wolfhouse pricing/payment config plan (**this**) | docs | no |
| 8.4.2 | Pricing config schema / design | docs/design | no |
| 8.4.3 | Pure Wolfhouse quote calculator helper | code (pure) | no |
| 8.4.4 | Quote calculator fixture/verifier for Wolfhouse rules | code (test) | no |
| 8.4.5 | Quote preview endpoint (read-only) | code (API) | no |
| 8.4.6 | Staff Portal quote preview UI | code (UI) | no |
| 8.4.7 | Integrate quote snapshot into manual booking create helper | code | gated |
| 8.4.8 | Internal payment-record creation from quote | code | gated |
| 8.4.9 | Stripe payment-link creation from payment record | code | gated |
| 8.4.10 | Stripe webhook truth / payment reconciliation | code | gated |
| 8.4.11 | Manual booking UI create enablement behind gates | code (UI) | gated |
| 8.4.12 | Staging E2E proof | proof | gated |

---

## 17. Status flags (unchanged)

- No pricing code implemented.
- No quote endpoint implemented.
- No payment automation enabled.
- Disabled create route remains disabled / unwired.
- `STAFF_ACTIONS_ENABLED=false`; `MANUAL_BOOKING_ENABLED=false`.
- No live pilot approved. Pilot decision: **NO_GO**.

---

## 18. Next recommended prompt

> Stage 8.4.2 — Pricing config schema/design (docs + optional config fixture, no live writes). Decide where the Wolfhouse pricing config lives (JSON config file vs `client_config`/DB-backed), reconcile it with the seeded `package_price_rules`, resolve the §3 REQUIRED_FROM_STAFF items into either confirmed values or explicit "override-required" markers, and define the `config_version` strategy the quote calculator (8.4.3) will load.
