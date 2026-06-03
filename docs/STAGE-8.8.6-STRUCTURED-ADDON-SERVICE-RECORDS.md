# Stage 8.8.6 — Structured add-on/service records for Staff Ask Luna

**Status:** PASS — docs only (2026-06-03).  
**Non-negotiables:** No code. No DB migration. No Azure. No n8n. No WhatsApp. No Stripe.

**Context:** Stages 8.8.2–8.8.5 prove Ask Luna on structured **bookings / payments / beds**. Add-on questions (`yoga`, `meals`, `lessons`, `wetsuits`, `surfboards`) still return `unsupported_intent` on staging `--0000034` — by design until persisted service rows exist.

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
| **Ask Luna** | **8.8.11+** | Read-only intents + router | Wire service queries against `booking_service_records` |
| **Portal display** | later | Read-only UI | Booking drawer section “Services & add-ons” from structured rows |
| **Staff writes** | later | Manual create/update/cancel | Gated behind `STAFF_ACTIONS_ENABLED`; persist from manual booking create |
| **Guest Luna** | later | In-stay add-on requests | Bot creates `booking_service_records` with `source=luna_guest`; payment link + webhook |

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

## 7. Staging state (after 8.8.10 apply, Staff API `--0000034`)

| Item | State |
|------|-------|
| `booking_service_records` table | **Applied on staging** — [`010_booking_service_records.sql`](../database/migrations/010_booking_service_records.sql) on `wh-staging-pg-app` / `wolfhouse_staging` (2026-06-03). **Not applied to production.** |
| Demo fixture | **Applied on staging** — 11 rows from [`booking-service-records-demo-up.sql`](../scripts/fixtures/booking-service-records-demo-up.sql); `client_slug=wolfhouse-somo`, `source=demo_fixture_stage888` |
| Today rental totals (demo) | Wetsuit qty **3**, surfboard qty **4** (CURRENT_DATE at apply time) |
| Payment mix (demo) | paid **6**, pending **3**, not_requested **2** |
| Manual booking create | Writes `quote_snapshot` add-ons in metadata only — does not yet write this table |
| Ask Luna add-on questions | Still `unsupported_intent` until service query intents wired (next slice) |
| Next slice | **8.8.11+** — Ask Luna read-only service query intents |

---

**Apply proof (8.8.10):** Ty-approved staging-only apply via `node scripts/run-sql.js` + Key Vault `wolfhouse-database-url`. Static verifiers PASS pre-apply. No Staff API deploy / n8n / WhatsApp / Stripe / live send.

**Next doc slice:** Ask Luna read-only service query intents against staging demo data.
