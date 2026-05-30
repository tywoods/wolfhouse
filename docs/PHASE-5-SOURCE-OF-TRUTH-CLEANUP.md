# Stage 5 — Targeted Source-of-Truth Cleanup (Planning)

**Status:** Planning only — **not started for implementation** (2026-05-30)  
**Prerequisite:** Stage 4 Autonomous Booking Dry-Run **CLOSE WITH DEFERRALS** (`beeb312`)  
**Next consumer:** Stage 6 staff/admin assistant (read-only queries first)

---

## 1. Objective (plain English)

Stage 5 makes **Postgres the reliable memory** for Wolfhouse pilot operations:

1. **Clean source of truth** — guest booking, payment, conversation, rooming, and add-on state live in queryable Postgres records, not scattered across Airtable mirrors and n8n session blobs.
2. **Reduce fragile Airtable dependency** — stop requiring Airtable reads/writes on core guest paths; keep Airtable only as an optional bridge until Stage 6 staff UI replaces it.
3. **Prepare structured data for pilot and staff ops** — when Ale asks *"Who paid for yoga today?"* or *"Who still owes money?"*, the answer comes from Postgres tables/views, not chat logs or exports.

**Scope boundary:** Wolfhouse beachhead only. No multi-client onboarding, no full PMS, no live autonomous operation, no real WhatsApp send — those stay behind separate gates.

---

## 2. Workstreams

| # | Workstream | Must-have before pilot | Should-have before pilot | Defer to multi-client / productization |
|---|------------|------------------------|--------------------------|----------------------------------------|
| 1 | **Conversation memory / session state** | Normalize `conversations.session_state` schema; PG-only conversation lookup (replace Airtable `Search Conversation` on Main path); document session keys (`route`, `missing_fields`, `payment_or_confirm_intent`, `current_hold_booking_id`) | Typed session-state contract + migration from legacy JSONB shapes | Cross-client session analytics; long-term customer memory productization |
| 2 | **Bookings / holds SoT** | Single PG write path for hold → payment_pending; `bookings` is authoritative for status, dates, guest_count, package_code, hold_expires_at | Stuck-hold detection query + runbook | Multi-property booking federation |
| 3 | **Payments / payment status** | Keep Stripe Webhook Handler as payment truth; `payments` + `payment_events` + `bookings.payment_status` aligned; **`payment_balances` view** (deposit paid, balance due, fully paid) | Automated duplicate-payment checks | Multi-currency / multi-Stripe-account |
| 4 | **Confirmation status** | Use existing `confirmation_sent_at` + `send_confirmation` flags; queryable "pending confirmation" list | Confirmation retry / idempotency audit trail | Branded confirmation templates per client |
| 5 | **Rooming / bed assignment** | `booking_beds` + `bookings.assignment_status` / rooming preference fields queryable; no Airtable required for read path | Needs-rooming-review queue view | Auto-assign optimization across properties |
| 6 | **Add-ons: lessons, yoga, rentals** | **Schema + write-path design** for structured add-on records (see §4); dry-run write stubs behind flag | Persist add-on intent when guest requests during stay; link to `payments` when paid | Full during-stay automation, voucher QR, inventory caps |
| 7 | **Staff handoffs / tasks** | **`staff_handoffs` / `staff_tasks`** table: conversation_id, reason, status, assigned_to, created_at | Handoff queue view; link to `conversations.needs_human` | Full task workflow engine |
| 8 | **Audit / logging** | Structured `workflow_events` for booking/payment/add-on mutations; fixture-scoped dry-run markers | Correlation IDs across Main → CPS → webhook → confirmation | Centralized observability platform (Stage 7) |
| 9 | **Pilot readiness gates** | Written gate checklist: PG-only core path, staff query smoke tests, protected-table invariants, explicit live-send approval | Shadow-mode pilot with staff approval per outbound message | Live autonomous operation |

---

## 3. Minimum data model for staff ops

Existing spine (`001_init.sql` + payment migrations): `bookings`, `booking_beds`, `payments`, `payment_events`, `conversations`, `messages`, `guests`. Stage 5 **adds** (migration plan only until approved):

### Core add-on order model

```text
add_on_orders
  id, client_id, booking_id, conversation_id (nullable)
  order_code, status (requested | quoted | awaiting_payment | paid | cancelled)
  payment_id (nullable), total_cents, currency
  source (whatsapp | staff), created_at, updated_at

add_on_items
  id, add_on_order_id
  item_type (lesson | yoga | rental | dinner | bundle)
  service_code (from service_addons.service_catalog)
  quantity, unit_price_cents, line_total_cents
  start_date, end_date (nullable), metadata JSONB
```

### Typed request tables (staff-query optimized)

```text
lesson_requests
  id, add_on_order_id, booking_id, guest_id
  requested_date, quantity, slot_group (nullable — staff assigns)
  payment_status, fulfillment_status (pending | scheduled | completed | refunded)
  staff_notes

yoga_requests
  id, add_on_order_id, booking_id
  class_date, quantity, payment_status
  fulfillment_status (pending | redeemed)
  booked_onsite (bool — per config: yoga often on-site)

rental_requests
  id, add_on_order_id, booking_id
  rental_type (wetsuit | softtop | hardboard | bundle)
  start_date, end_date, quantity
  payment_status, pickup_status (pending | active | returned)
```

### Staff ops + balances

```text
staff_handoffs  (or staff_tasks)
  id, conversation_id, booking_id (nullable)
  reason_code, summary, status (open | assigned | resolved)
  assigned_staff, opened_at, resolved_at

payment_balances  (VIEW, not new truth)
  booking_id, booking_code, guest_name, check_in, check_out
  total_amount_cents, deposit_paid_cents, amount_paid_cents, balance_due_cents
  payment_status, last_payment_at
```

### Staff query mapping

| Staff question | Primary source |
|----------------|----------------|
| "Who paid for yoga today?" | `yoga_requests` WHERE `class_date = today` AND `payment_status = paid` |
| "Who has lessons tomorrow?" | `lesson_requests` WHERE `requested_date = tomorrow` |
| "Who still owes money?" | `payment_balances` WHERE `balance_due_cents > 0` |
| "Who requested a board?" | `rental_requests` WHERE `rental_type IN (...board...)` AND active dates |
| "Which bookings need a human reply?" | `staff_handoffs` open OR `conversations.needs_human = true` |
| "Today's arrivals / departures?" | `bookings` WHERE `check_in = today` OR `check_out = today` |
| "Deposit paid but not full balance?" | `payment_balances` WHERE `payment_status = deposit_paid` |

**Design rule:** Config (`wolfhouse-somo.baseline.json` → `service_addons.service_catalog`) defines **prices and fulfillment**; Postgres records define **who requested what, when, and whether paid**. Stage 6 assistant maps NL → fixed parameterized queries over these tables — never arbitrary SQL.

---

## 4. What NOT to do in Stage 5

| Out of scope | Reason |
|--------------|--------|
| Full staff dashboard / admin UI | Stage 6 |
| Full PMS (housekeeping, channel manager, etc.) | Not product scope |
| Multi-client onboarding system | Stage 7 |
| Live autonomous guest operation | Separate gate after pilot readiness |
| Real WhatsApp send | Separate gate; dry-run / staff-approved send only until proven |
| Broad n8n refactor "for cleanliness" | Only paths tied to SoT cleanup |
| Airtable removal before staff UI | Bridge until Stage 6 cutover |
| Full decision-engine extraction in one step | Incremental; golden tests per module |

---

## 5. Recommended implementation order

One workstream at a time. Each step: **design doc → migration SQL → workflow/script wiring → dry-run proof → PROJECT-STATE update**.

| Phase | Workstream | Deliverable | Live writes? |
|-------|------------|-------------|--------------|
| **5.0** | Planning | This doc + schema RFC | No |
| **5.1** | Conversation PG path | Replace Airtable conversation search on Main; session_state contract | Dry-run first |
| **5.2** | Bookings/holds SoT | Document single write authority; remove Airtable hold mirror from critical path | Stubs until gate |
| **5.3** | Payments + balances | `payment_balances` view; align booking payment fields with webhook truth | Protected-table rules unchanged |
| **5.4** | Confirmation status | Query views for pending/sent; no new send logic | Dry-run only |
| **5.5** | Add-on schema | Migration `007_add_on_orders.sql` (proposed); no runtime writes until 5.6 | Schema only in 5.5 |
| **5.6** | Add-on write path | Persist `add_on_intent` from bot (A9-style quotes → structured record) | Fixture-scoped dry-run |
| **5.7** | Staff handoffs | `staff_handoffs` populated from handoff routes (A6/A7 patterns) | Dry-run |
| **5.8** | Rooming queryability | Views for preferences + assignment status; no new auto-assign | Read-only |
| **5.9** | Pilot readiness gates | Checklist run: staff query smoke tests against PG | Shadow mode only |
| **5.10** | Decision engine (partial) | Extract highest-churn modules (`routeMessage`, `requiredFields`) — only after SoT stable | Tests only |

**Parallel (non-blocking):** 3x.2 price confirmation (provisional → confirmed for live charge); audit logging improvements.

---

## 6. Pilot readiness gates (Stage 5 exit)

Before any **live WhatsApp** or **live autonomous** gate:

- [ ] Core guest path reads/writes Postgres without Airtable on Main hold/conversation/search
- [ ] All eight staff sample questions answerable from PG (§3 table) with fixture data
- [ ] Protected tables invariant documented and enforced (Main must not write `payments` / `payment_events`)
- [ ] Add-on request → structured record → payment link → webhook → paid status traceable in PG (dry-run proven)
- [ ] Handoff queue queryable without reading raw WhatsApp exports
- [ ] Real WhatsApp send explicitly **not approved** until separate owner gate
- [ ] Pricing `global_pricing_status` reviewed before live autonomous charge

**Stage 5 success ≠ live pilot.** Stage 5 success = **data and paths ready** so Stage 6 staff assistant and a controlled shadow pilot can operate safely.

---

## 7. Related docs

| Doc | Role |
|-----|------|
| [ROADMAP.md § Stage 5](ROADMAP.md#stage-5--clean) | Roadmap placement + staff-queryable data requirement |
| [ARCHITECTURE-NORTH-STAR.md](ARCHITECTURE-NORTH-STAR.md) | Postgres remembers; Airtable temporary |
| [PROJECT-STATE.md](PROJECT-STATE.md) | Execution tracker |
| [test-payloads/stage4/autonomous-dry-run/README.md](../test-payloads/stage4/autonomous-dry-run/README.md) | Stage 4 evidence + deferrals |
| `config/clients/wolfhouse-somo.baseline.json` | Add-on catalog, payment, confirmation rules |
| [STAFF-QUERY-ASSISTANT-PLAN.md](STAFF-QUERY-ASSISTANT-PLAN.md) | Stage 6 query assistant (blocked on Stage 5 tables) |
