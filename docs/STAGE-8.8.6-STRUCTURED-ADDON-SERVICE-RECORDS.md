# Stage 8.8.6 — Structured add-on/service records for Staff Ask Luna

**Status:** PASS — design extended through **Stage 8.8.25** (2026-06-03).  
**Non-negotiables (8.8.25):** API code only. No Azure deploy.

**Context:** Stages 8.8.11–8.8.12 prove Staff Ask Luna reads **`booking_service_records`**. **8.8.16–8.8.17** prove manual booking create writes service rows tied to real bookings (`MB-WOLFHO-20260901-cb4799`). **8.8.18** defines when `payment_status` on service rows may change — Stripe webhook or audited staff action only.

**Related:** [STAGE-8.8.1-MVP-OPERATING-REQUIREMENTS.md](STAGE-8.8.1-MVP-OPERATING-REQUIREMENTS.md) · [ROADMAP.md](ROADMAP.md) · migration stub [`database/migrations/007_add_addon_orders.sql`](../database/migrations/007_add_addon_orders.sql) (not yet applied)

---

## 1. Staff questions to support

All answers must come from **Postgres service records** joined to `bookings` — never conversation/chat logs.

| # | Staff question (examples) | Query mode | Date resolution |
|---|---------------------------|------------|-----------------|
| 1 | Who paid for yoga tonight / tomorrow / June 15? | List guests (paid filter) | Same resolver as 8.8.2 (`tonight`→today, tomorrow, ISO, weekday, named month-day) |
| 2 | Who paid for meals tonight / tomorrow / June 15? | List guests (paid filter) | Same |
| 3 | Who has a lesson today? | List guests (scheduled/confirmed) | `service_date = today` (default) |
| 4 | Who needs a wetsuit today? | List guests (prep/fulfillment) | `service_date = today` |
| 5 | Who needs a surfboard today? | List guests (prep/fulfillment) | `service_date = today` |
| 6 | How many surfboards do we need ready today? | **Count** `SUM(quantity)` | `service_date = today` |
| 7 | How many wetsuits do we need ready today? | **Count** `SUM(quantity)` | `service_date = today` |

**“Paid” questions** filter `payment_status = 'paid'` (Stripe webhook or staff manual truth only).  
**“Needs / has / ready” questions** include `status IN ('requested','confirmed','paid')` and exclude `cancelled` unless staff explicitly asks for cancelled (future intent).

---

## 2. Required structured record shape

Proposed **Ask Luna-facing** table: `booking_service_records` (name fixed in 8.8.7 spec; not created in this slice).

| Field | Type (proposed) | Required | Notes |
|-------|-----------------|----------|-------|
| `id` | UUID | ✓ | Primary key |
| `client_id` | UUID | ✓ | FK → `clients` |
| `booking_id` | UUID | ✓ | FK → `bookings` |
| `guest_id` | UUID | — | FK → guest/contact if model exists; else null |
| `guest_name` | TEXT | ✓ | Denormalized from booking for staff-readable answers |
| `service_type` | TEXT | ✓ | `yoga` · `meal` · `surf_lesson` · `wetsuit` · `surfboard` |
| `service_date` | DATE | ✓ | Operational date staff cares about (class day, rental day, meal night) |
| `quantity` | INTEGER | ✓ | Default 1; used for board/wetsuit counts |
| `status` | TEXT | ✓ | `requested` · `confirmed` · `paid` · `cancelled` |
| `amount_due_cents` | INTEGER | ✓ | From quote/catalog at creation; never from chat |
| `amount_paid_cents` | INTEGER | ✓ | 0 until payment truth |
| `payment_status` | TEXT | ✓ | `not_requested` · `pending` · `paid` · `refunded` · `waived` |
| `source` | TEXT | ✓ | `staff_manual` · `luna_guest` · `import` · `stripe` |
| `payment_id` | UUID | — | FK → `payments` when linked to Stripe checkout |
| `notes` | TEXT | — | Staff free text |
| `created_at` / `updated_at` | TIMESTAMPTZ | ✓ | Audit |

**Indexes (8.8.7 spec):** `(client_id, service_type, service_date)`, `(booking_id)`, `(client_id, payment_status, service_date)`.

**Mapping from quote UI today:** Manual booking `buildAddOns()` produces quote line items (wetsuit days, lesson qty, yoga classes) but **does not persist** service rows — only `quote_snapshot` in booking metadata. Stage 8.8.8+ must backfill or create rows on booking create.

**Relation to migration 007:** Existing stub `add_on_orders` + `add_on_items` + typed tables (`yoga_requests`, `rental_requests`, …) is a **normalized** model. Options for 8.8.7:

- **A (MVP):** Single flat `booking_service_records` table (this doc) — fastest path to Ask Luna queries.
- **B (long-term):** Apply 007 + SQL **view** `staff_service_records_v` projecting the §2 shape from `add_on_items` joins.

Recommendation: **A for 8.8.7–8.8.9**, document view migration to B when write paths multiply.

---

## 3. Data ownership

```
┌─────────────────┐     read/write      ┌──────────────────────────┐
│  Staff API      │ ◄──────────────────►│  Postgres (source of     │
│  (Staff Portal, │                     │  truth for service rows) │
│   bot endpoints)│                     └────────────┬─────────────┘
└────────┬────────┘                                  │
         │                                           │ payment truth
         │ POST /staff/ask-luna (SELECT only)        ▼
         │                                  ┌─────────────────┐
         │                                  │ Stripe webhook  │
         │                                  │ (paid status)   │
         ▼                                  └─────────────────┘
┌─────────────────┐
│  n8n            │  pipe only — forwards WhatsApp text to Staff API;
│  (inactive)     │  does NOT own service record truth
└─────────────────┘
```

| System | Role |
|--------|------|
| **Staff API / Postgres** | Source of truth for who requested/paid which service on which date |
| **n8n** | Message pipe only (guest Luna, staff Ask Luna dry-run); no service SQL |
| **Stripe webhook** | Payment truth for online-paid service records (`payment_status` → `paid`, `amount_paid_cents`) |
| **Staff manual** | Future: create/update/cancel service rows from portal (after 8.8.10+) |
| **Chat / conversation logs** | **Never** used to answer operational add-on questions |

---

## 4. Query mapping (Ask Luna intents)

Smart understanding → **fixed intent keys** → parameterized SELECT (no LLM SQL).

| Natural language pattern | Registry / local intent (proposed) | SQL filter (conceptual) |
|--------------------------|-----------------------------------|-------------------------|
| yoga + paid + date | `services.yoga.paid_on_date` | `service_type='yoga' AND service_date=$date AND payment_status='paid'` |
| meal(s) + paid + date | `services.meal.paid_on_date` | `service_type='meal' AND service_date=$date AND payment_status='paid'` |
| lesson + today/date | `services.surf_lesson.on_date` | `service_type='surf_lesson' AND service_date=$date AND status!='cancelled'` |
| wetsuit + today/date | `services.wetsuit.on_date` | `service_type='wetsuit' AND service_date=$date AND status!='cancelled'` |
| surfboard + today/date | `services.surfboard.on_date` | `service_type='surfboard' AND service_date=$date AND status!='cancelled'` |
| how many + surfboards + today | `services.surfboard.count_on_date` | `SUM(quantity) WHERE service_type='surfboard' AND service_date=$date` |
| how many + wetsuits + today | `services.wetsuit.count_on_date` | `SUM(quantity) WHERE service_type='wetsuit' AND service_date=$date` |

**Date param:** Reuse `resolveAskLunaDatePhrase()` from 8.8.2/8.8.4 (`tonight`→today, `hoy`, `June 15`, etc.).

**Router change (8.8.9):** Remove `isBlockedAddOnServiceQuestion` → `unsupported_intent` for types that have registry intents; keep block only when table empty or question outside supported patterns.

**Empty result:** Safe message e.g. “No yoga payments recorded for tonight.” — not a chat-log guess.

---

## 5. MVP implementation phases

| Phase | Stage | Scope | Deliverable |
|-------|-------|-------|-------------|
| **Spec** | **8.8.7** ✓ | Migration SQL spec only (no apply) | [`010_booking_service_records.sql`](../database/migrations/010_booking_service_records.sql) + `verify-booking-service-records-schema.js` |
| **Source CHECK** | **8.8.9** ✓ | `demo_fixture_stage888` allowed in 010 | Matches 8.8.8 demo fixture |
| **Fixture** | **8.8.8** ✓ | Read-only demo seed (no apply) | [`booking-service-records-demo-up.sql`](../scripts/fixtures/booking-service-records-demo-up.sql) + down + verifier |
| **Staging apply** | **8.8.10** ✓ | Migration 010 + demo fixture on staging DB | Applied 2026-06-03 to `wolfhouse_staging` only; 11 demo rows |
| **Ask Luna** | **8.8.11** ✓ | Read-only intents + router | 7 `services.*` intents on `booking_service_records` |
| **Hosted proof** | **8.8.12** ✓ | Deploy + Luna API proof | `--0000035`; 14/14 PASS |
| **Flows design** | **8.8.13** ✓ | Booking-time + guest Luna + drawer (docs) | §8–§11 below |
| **Portal display** | **8.8.14–8.8.15** ✓ | Read-only drawer UI + hosted proof | `--0000036`; golden empty state PASS; demo rows need real bookings (8.8.16) |
| **Booking create writes** | **8.8.16–8.8.17** ✓ | Manual create → `booking_service_records` + hosted proof | `--0000037`; `MB-WOLFHO-20260901-cb4799` |
| **Payment truth rules** | **8.8.18** ✓ | When service rows become paid (docs) | §12 below |
| **Payment linkage schema** | **8.8.19** ✓ spec | Migration 011 spec (`payment_id` FK + `addon_service`) | [`011_service_payment_linkage.sql`](../database/migrations/011_service_payment_linkage.sql) |
| **Staging apply 011** | **8.8.20** ✓ | Applied to `wolfhouse_staging` only (Ty-approved) | §7 below |
| **Webhook addon_service** | **8.8.21–8.8.22** ✓ | Code + hosted proof on `--0000038` | §12.2; yoga+wetsuit paid on `MB-WOLFHO-20260901-cb4799` |
| **Add-on checkout create** | **8.8.23–8.8.24** ✓ | API + hosted proof on `--0000039` | Staff API link + webhook; surf lesson paid via API path |
| **Bot add-on dry-run** | **8.8.25** ✓ | `POST /staff/bot/addon-request-preview` | Flow B preview; no deploy yet |

**Out of scope until explicit GO:** live WhatsApp send, n8n activation, applying migration to production.

---

## 6. Safety rules

| Rule | Enforcement |
|------|-------------|
| No answers from chat logs | Ask Luna SQL joins `booking_service_records` + `bookings` only |
| Unsupported until data exists | Router returns `unsupported_intent` until 8.8.9 **and** table populated (or empty-safe answer after 8.8.9) |
| No `paid` without truth | `payment_status='paid'` only via Stripe webhook handler or staff manual mark-paid (future write path with audit) |
| Ask Luna stays read-only | `read_only:true`, `no_write_performed:true`, `sends_whatsapp:false` |
| No live WhatsApp | Unchanged **NO_GO** per 8.6.8 / 8.8.1 |

---

## 7. Staging state (after 8.8.24 deploy, Staff API `--0000039`)

| Item | State |
|------|-------|
| `booking_service_records` table | **Applied on staging** — migrations **010** + **011** |
| `booking_service_records.payment_id` | **Live** — nullable UUID FK → `payments(id)` |
| `payments.payment_kind` enum | **Live** — includes **`addon_service`** |
| Demo fixture rows | **11** preserved |
| Stage8817 booking | **`MB-WOLFHO-20260901-cb4799`** — **all 3 services paid** (yoga/wetsuit 8.8.22; surf lesson 8.8.24) |
| Proof addon payments | **`3318b16c-…`** (yoga+wetsuit €30) · **`a01c735e-…`** (surf lesson €60) · disposable |
| Ask Luna service intents | **Live** — `--0000039` |
| Service row payment truth | **Live** — API link create + webhook marks linked rows by `payment_id` |
| Booking package payment truth | **Unchanged by add-on webhook** — 8.8.22/8.8.24 proof confirmed |
| Next slice | **8.8.26** — bot add-on create write path (service row + payment link) |

---

## 8. Three connected flows (Stage 8.8.13)

### Flow A — Booking-time add-ons

Applies when staff (portal) or Luna (bot) creates a booking and the guest selects chargeable add-ons in the quote step.

```
Quote UI / bot payload
    → calculateWolfhouseQuote() line items (chargeable add-ons only)
    → booking create (bookings + booking_beds + quote_snapshot)
    → payments draft row (package deposit/full + optional bundled add-on amount)
    → booking_service_records (one row per operational service line)
    → Stripe checkout (optional) → webhook → payment truth
```

| Step | Owner | Rule |
|------|-------|------|
| **A1. Quote line items** | Staff API | Chargeable add-ons from [`wolfhouse-somo.pricing.json`](../config/clients/wolfhouse-somo.pricing.json) become quote line items (wetsuit days, lesson qty, yoga qty, combos). **Meals excluded** — visual-only in portal; not in `buildAddOns()`. |
| **A2. Payment draft** | Staff API | Primary `payments` row covers **package payment choice** (deposit/full). When add-ons are chargeable at booking time, **either** roll their cents into the same checkout session total **or** (preferred for clarity) create **separate `payments` rows** per add-on batch — see §9 decision 4. Original booking deposit/full payment **stays separate** from later add-ons. |
| **A3. Service records** | Staff API | On successful booking create, insert `booking_service_records` for each selected operational service: map quote codes → `service_type` (`yoga_class`→`yoga`, `surf_lesson`/`surf_lesson_multi`→`surf_lesson`, rentals→`wetsuit`/`surfboard`). Set `service_date` (see §9). Set `source='staff_manual'` (portal) or `source='luna_guest'` (bot). Link `booking_id`, denormalize `guest_name`/`booking_code`. Initial `payment_status`: `pending` if checkout created, `not_requested` if on-site-only (yoga), `paid` only after webhook. |
| **A4. Payment truth** | Stripe webhook | Existing `POST /staff/stripe/webhook` marks `payments.status=paid` and updates booking balances. **Extend** webhook handler to set linked `booking_service_records.payment_status='paid'`, `amount_paid_cents`, and `status='paid'` when `metadata` includes `service_record_id`(s) or payment is tagged `payment_kind=addon_service`. Never infer paid from chat. |

**Today vs target:** Quote calculator + manual form support rentals/lessons/yoga; meals UI-only. **8.8.16** implements Flow A step A3 for staff manual create (`source=staff_manual`). Bot create + Stripe webhook service-row payment truth still pending.

---

### Flow B — Later guest add-ons via Luna

Guest already has a booking (or is in-stay) and asks for an add-on **after** initial booking/payment.

**Example guest messages (WhatsApp / dry-run):**

- “Can I add yoga tomorrow?”
- “I need a wetsuit today”
- “Can I book 2 surf lessons?”
- “Can we add dinner tonight?”

```
Guest WhatsApp → n8n (pipe) → Staff API bot/add-on endpoint
    → resolve active booking (phone / session)
    → parse add-on intent + service_date (+ quantity)
    → if date missing → Luna follow-up question (no payable row yet)
    → if meal / on-site-only → record request, no Stripe link
    → else create booking_service_records (source=luna_guest)
    → create separate payments row (payment_kind=addon_service)
    → POST /staff/bot/payments/:id/create-stripe-link (or staff equivalent)
    → reply draft with checkout_url (dry-run: whatsapp_sent:false)
    → [live GO only] send link via WhatsApp
    → Stripe webhook → payment truth → service record paid
```

| Step | Owner | Rule |
|------|-------|------|
| **B1. Intent** | Staff API | Map utterance to `service_type` + `quantity` + optional `service_date` (reuse date resolver patterns from Ask Luna where applicable). |
| **B2. Booking match** | Staff API | Identify booking by guest phone + active stay window (`check_in ≤ today ≤ check_out` or nearest upcoming). Fail closed → staff handoff if ambiguous. |
| **B3. Date gate** | Luna | **Required** for yoga, meals, lessons, wetsuit rental, surfboard rental. If missing, Luna asks: “Which day — today, tomorrow, or a date?” before creating a payable row. |
| **B4. Service row** | Staff API | `INSERT booking_service_records` with `source='luna_guest'`, amounts from pricing catalog (never from chat text). |
| **B5. Add-on payment** | Staff API | **New** `payments` row tied to same `booking_id`, **not** mutating original deposit payment. Amount = catalog × quantity/days. |
| **B6. Stripe link** | Staff API | Same isolated path as 8.4.9/8.5.5 — Staff API creates Checkout Session; n8n never calls Stripe directly. |
| **B7. Guest message** | n8n | Payment link in reply **only when live send GO** (8.6.8 / 8.8.1 §5). Until then: dry-run draft only. |
| **B8. Payment truth** | Stripe webhook | Marks `payments` paid + linked service record(s) `payment_status='paid'`. |
| **B9. Manual override** | Staff API (future) | Staff may mark `payment_status='paid'` or `waived` with audit (`source` stays `luna_guest`; payment truth fields set by staff action). |

**Meals (dinner):** Record `service_type='meal'` with `payment_status='not_requested'` and **no** Stripe link — on-site settlement per Wolfhouse ops (pricing config has no meal SKU). Luna confirms request to guest; staff fulfill operationally.

---

### Flow C — Staff Portal booking drawer

When staff click a booking on Bed Calendar, the context drawer shows operational services without leaving the calendar.

| Step | Rule |
|------|------|
| **C1. Data source** | `SELECT` from `booking_service_records WHERE booking_id = $id ORDER BY service_date, service_type` — **never** conversation/chat logs. |
| **C2. Fields shown** | `service_type`, `service_date`, `quantity`, `status`, `payment_status`, `amount_due_cents`, `amount_paid_cents`, `source`, `notes` (+ `booking_code` in API if useful). |
| **C3. Layout** | Section title **“Services & add-ons”** below payment block; group by `service_date` then sort by `service_type`. Empty state: “No service records for this booking.” |
| **C4. Payment visibility** | Per-row payment status + amounts; optional link to related `payments.checkout_url` if `payment_id` FK added later. Booking-level deposit banner **unchanged** — add-ons are additive. |
| **C5. No send** | **No** WhatsApp send, confirmation send, or “charge guest” button in read-only slice. |
| **C6. API shape** | Extend `GET /staff/bookings/:id/context` (or nested query) to include `service_records: []` array; drawer renders from JSON only. |

**Today vs target:** Drawer shows payment truth + Luna confirmation draft + **Services & Add-ons** panel (8.8.14, read-only). Demo rows visible when `booking_code` matches fixture codes; golden booking may show empty state until linked.

---

## 9. Key decisions (8.8.13)

| # | Decision |
|---|----------|
| **D1. service_date required** | Date-specific services (yoga, meal, surf_lesson, wetsuit, surfboard) **must** have `service_date` before a payable record + Stripe link. Missing date → Luna follow-up, no payment draft. |
| **D2. Separate payments** | Original booking payment (deposit/full) **remains separate** from later add-on payments. Each add-on checkout is its own `payments` row. |
| **D3. payment_kind extension** | Current enum: `deposit_only` \| `full_amount` ([`004_payment_schema_phase2.sql`](../database/migrations/004_payment_schema_phase2.sql)). **Add** `addon_service` (migration TBD) for Flow A/B add-on checkouts. Stripe metadata: `payment_kind=addon_service`, `booking_id`, `payment_id`, optional `service_record_ids[]`. |
| **D4. payments.source / metadata** | Tag add-on payments with `metadata.source` = `staff_portal_manual_booking` \| `luna_guest_addon` \| `staff_manual_addon` for webhook routing and drawer labels. |
| **D5. Meals pricing** | **On-site only for MVP.** No meal line item in quote engine; portal meals qty is visual-only. Luna may **record** meal requests in `booking_service_records` but **must not** generate a payment link until a priced meal SKU exists and Ty approves. |
| **D6. Yoga pricing** | Catalog marks `yoga_class.on_site: true`. At **booking time**, staff can include yoga in quote (line item exists). **Later guest requests** default to on-site unless staff/policy enables prepayment — if prepay enabled, use Flow B with Stripe link. |
| **D7. Ask Luna reads records only** | Staff Ask Luna service intents (8.8.11–8.8.12) query `booking_service_records` only — unchanged. |
| **D8. Payment truth** | `payment_status='paid'` on service rows only via Stripe webhook or staff manual mark-paid — never from chat inference. |
| **D9. Safety** | No live WhatsApp until explicit GO; no Stripe from UI or n8n; no production DB apply without approval; staging-only proofs continue. |

---

## 10. Open questions

| # | Question | Default / lean |
|---|----------|----------------|
| **Q1. Single vs split checkout at booking** | Roll add-ons into first deposit checkout vs separate add-on payment rows at booking create? | **Separate rows** (clearer webhook + drawer); optional “pay all now” bundles later. |
| **Q2. payment_id FK on service records** | Add `booking_service_records.payment_id` in migration 011? | **Yes** — links row to add-on `payments` checkout; nullable for on-site/waived. |
| **Q3. Rental service_date semantics** | Wetsuit/board: one row per day vs one row with `quantity=days` and `service_date=start`? | **One row per rental start date** with `quantity=days` for MVP (matches quote `days` field). |
| **Q4. Partial pay / deposit on add-ons** | Can add-ons use deposit-only or always full amount due? | **Full amount due** for add-on checkouts unless Ty defines deposit rules per service type. |
| **Q5. Cancelled booking** | Cascade service records when booking cancelled? | Set service `status='cancelled'`; do not delete; exclude from Ask Luna counts. |
| **Q6. Meal pricing future** | When meals become priced, which SKU? | New `meal` add-on in pricing JSON + `on_site: false`; until then Flow B records only. |
| **Q7. Full-payment add-on allocation** | When guest pays **full** at booking, how to split Stripe `amount_paid` across package vs add-on line items? | Store `service_record_ids[]` + per-row `amount_due_cents` on payment metadata at checkout create; webhook marks linked rows `paid` only when allocation explicit (§12.1). |
| **Q8. Deposit + add-ons in same checkout** | If deposit checkout total includes add-on cents, mark add-ons paid on deposit webhook? | **No** — deposit webhook marks **package deposit only**; add-on rows stay `pending` unless separate `addon_service` payment or full-payment allocation slice (§12.1). |

---

## 12. Service-record payment truth rules (Stage 8.8.18)

**Scope:** Docs only. Defines when `booking_service_records.payment_status`, `amount_paid_cents`, and `status` may change. **No code in this slice.**

**Invariant:** `payment_status='paid'` only via **Stripe webhook** (`POST /staff/stripe/webhook`) or **audited staff manual action**. Never from chat, n8n, or UI inference.

### 12.1 Booking-time add-ons (Flow A)

Applies to service rows created at manual/bot booking create (`source=staff_manual` or `luna_guest` at create time).

| Booking payment choice | Service row initial state (today: 8.8.16) | After Stripe webhook (future) |
|------------------------|-------------------------------------------|-------------------------------|
| **Full payment** (`payment_choice=full`) | `pending` if `amount_due_cents > 0`; `not_requested` if 0 | When checkout session total covers **package + allocated add-on cents**, webhook may mark **linked** service rows `paid` if metadata lists `service_record_ids[]` and per-row allocation. Set `amount_paid_cents` = allocated amount (≤ `amount_due_cents`). Set `status='paid'` when fully settled. |
| **Deposit only** (`payment_choice=deposit`) | `pending` if `amount_due_cents > 0` | **Do not** auto-mark service rows `paid` on deposit webhook. Deposit truth applies to **package payment row only**. Add-on rows stay `pending` until separate add-on checkout or staff manual truth. |
| **Pay on arrival** (`payment_choice=pay_on_arrival`) | `pending` or `not_requested` per row | Stay `pending`/`not_requested` until staff manual mark-paid/waived or guest pays separate add-on link later. |
| **Zero amount** (`amount_due_cents = 0`) | `not_requested` (e.g. combo unsplit rows, on-site yoga policy) | **Never** mark `paid`. Keep `not_requested` or operational `confirmed`; do not flip to `paid` without explicit payment truth. |

**Allocation rule (full payment):** At checkout session create, Staff API must persist on the `payments` row metadata:

```json
{
  "service_record_ids": ["uuid", "..."],
  "service_record_allocation_cents": { "uuid": 1500, "...": 6000 }
}
```

Webhook handler reads allocation; updates **only** listed rows. Rows not in metadata are unchanged.

**Deposit + add-ons in one checkout total:** If product rolls add-on cents into first checkout for UX, still treat deposit webhook as **non-allocating** to service rows unless Ty explicitly approves a combined allocation table (default: **no**).

### 12.2 Later guest add-ons via Luna (Flow B)

Mid-stay requests create **separate** payment + service rows.

| Rule | Detail |
|------|--------|
| **Separate payment row** | Each payable add-on batch gets its own `payments` row. Never mutate original booking deposit/full payment row. |
| **payment_kind** | Extend enum with **`addon_service`** (migration 011). Values today: `deposit_only` \| `full_amount` ([`004_payment_schema_phase2.sql`](../database/migrations/004_payment_schema_phase2.sql)). |
| **payments.metadata** | `source`: `luna_guest_addon` \| `staff_manual_addon`; `service_record_ids[]`; optional `service_record_allocation_cents`. |
| **Stripe Checkout metadata** | Required keys: `client_slug`, `booking_id`, `booking_code`, `payment_id`, `payment_kind=addon_service`, `service_record_ids` (JSON array string). Staff API creates session; n8n never calls Stripe. |
| **Amount** | `amount_due_cents` = **full add-on amount** (no deposit option for add-on checkouts). |
| **Webhook** | On `checkout.session.completed` for `payment_kind=addon_service`: mark `payments.status=paid`; update **only** linked service records → `payment_status='paid'`, `amount_paid_cents`, `status='paid'`; set `booking_service_records.payment_id` FK. |
| **Meals** | Record-only (`not_requested`); no Stripe link until priced SKU + explicit GO. |

### 12.3 Staff / manual payment truth

| Action | Allowed | Audit |
|--------|---------|-------|
| Mark service row **paid** | Future staff endpoint (operator+) | `workflow_events` + `updated_at`; optional `metadata.manual_paid_by`, `metadata.manual_paid_at` |
| Mark **waived** | Yes — on-site settlement, comp, ops exception | Same audit; `payment_status='waived'`, `amount_paid_cents` may stay 0 |
| Mark **refunded** | Future — tied to Stripe refund webhook or staff reversal | `payment_status='refunded'`; do not delete row |
| **Chat / Luna text** | **Never** sets payment truth | n8n pipe only |

### 12.4 Drawer behavior (Flow C — future slices)

| Rule | Detail |
|------|--------|
| **Display** | Per-row `payment_status` shown clearly: pending · paid · waived · refunded · not_requested |
| **Amounts** | Show `amount_due_cents` and `amount_paid_cents`; paid rows may show paid-at from linked payment if available |
| **Actions** | **No** send / charge / payment-link buttons in read-only slices. Future slice may add read-only link to `payments.checkout_url` when `payment_id` set. |
| **Booking banner** | Package deposit/paid banner **unchanged** — service rows are additive |

### 12.5 Ask Luna behavior

| Question type | SQL filter | Notes |
|---------------|------------|-------|
| **Paid** (yoga/meal on date) | `payment_status = 'paid'` | e.g. `services.yoga.paid_on_date` — **only** paid rows |
| **Needs / has / ready** (wetsuit, board, lesson) | `status != 'cancelled'` | Includes `requested`, `confirmed`, `paid`; **includes `pending` and `not_requested`** unless question asks for paid |
| **Count readiness** | `SUM(quantity) WHERE status != 'cancelled'` | Exclude cancelled; pending/not_requested count toward prep totals |

**Examples (8.8.17 proof booking):**

- “Who needs a wetsuit on September 1 2026?” → **includes** Stage8817 Addon Test (`pending`) ✓
- “Who paid for yoga on September 1 2026?” → **excludes** Stage8817 Addon Test until webhook/staff marks paid

### 12.6 Required future migrations and code (8.8.19+)

| # | Deliverable | Purpose |
|---|-------------|---------|
| **M1** | Migration **011** ✓ applied staging: `booking_service_records.payment_id UUID REFERENCES payments(id)` nullable | 8.8.20 — `wolfhouse_staging` only |
| **M2** | Migration **011** ✓ applied staging: `payment_kind` enum → **`addon_service`** | `ALTER TYPE payment_kind ADD VALUE IF NOT EXISTS 'addon_service'` |
| **M3** | Webhook: `addon_service` branch ✓ code + hosted proof (8.8.21–8.8.22) | `--0000038`; payment `3318b16c-…` |
| **M4** | Webhook: **full-payment allocation** branch | Mark booking-time service rows paid when metadata allocation present (§12.1) |
| **M5** | Checkout create: embed `service_record_ids` in Stripe metadata | Required for webhook linkage |
| **M6** | Flow B: `POST /staff/bookings/:id/service-records/create-payment-link` ✓ code (8.8.23) | Staff addon Stripe link; replaces manual DB setup from 8.8.22 |
| **M7** | Staff manual mark-paid/waived endpoint (future) | On-site / ops override with audit |

**Recommended order:** M1+M2 → M3 → M5+M4 → M6 → M7.

### 12.7 Safety (unchanged)

| Rule | Enforcement |
|------|-------------|
| Stripe webhook = payment truth | HMAC-verified `POST /staff/stripe/webhook` only |
| No chat → paid | Luna/n8n never UPDATE service payment fields |
| No n8n → Stripe | Staff API creates Checkout Sessions |
| No live WhatsApp | **NO_GO** per 8.6.8 / 8.8.1 until explicit approval |
| Staging only until GO | No production migration without approval |

---

## 11. Next recommended code slices

| Order | Stage | Scope | Delivers |
|-------|-------|-------|----------|
| **1** | **8.8.26** | Bot add-on create write path | Service row + `addon_service` payment + Stripe link |
| **2** | **8.8.26+** | Live guest add-on send | Flow B7 — only after 8.6.8 GO |
| **3** | **8.8.27+** | Full-payment allocation | Booking-time add-ons on full checkout (§12.1 M4) |

---

**Code slice (8.8.25):** `POST /staff/bot/addon-request-preview` — Luna guest add-on dry-run. **No deploy.**

**Hosted proof (8.8.24):** `POST .../service-records/create-payment-link` on `--0000039` — surf lesson paid on `MB-WOLFHO-20260901-cb4799` via API + webhook; no manual DB setup.

**Code slice (8.8.23):** Staff API add-on checkout link endpoint. **Deployed in 8.8.24.**

**Code slice (8.8.21):** Webhook `addon_service` branch. **No deploy.**

**Doc slice (8.8.20):** Migration 011 applied to staging Postgres only. **No webhook. No deploy.**

**Doc slice (8.8.19):** Migration 011 service payment linkage spec. **No apply. No webhook.**

**Doc slice (8.8.18):** Service-record payment truth rules (§12). **No code.**

**Hosted proof (8.8.17):** Manual create → 3 service rows on `MB-WOLFHO-20260901-cb4799`; drawer + Ask Luna PASS. Rows `pending`; no Stripe paid truth yet.
