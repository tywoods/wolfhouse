# Wolfhouse Booking Assistant — Product Roadmap

**Product:** AI booking operations for WhatsApp-first experience businesses — **beachhead:** Wolfhouse (surf house / surf camp). Simpler label: *AI front desk for WhatsApp-heavy experience operators.*

**Engineering snapshot:** [`PROJECT-STATE.md`](PROJECT-STATE.md) · **Architecture:** [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) · **Stripe isolated gates:** [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

---

## Evolution order (do not skip)

```text
1. Correct and safe     ← Stage 3d engineering gates complete; Stage 3x specs in progress
2. Reliable             ← Stage 4
3. Clean                ← Stage 5
4. Beautiful            ← Stage 6
5. Scalable             ← Stage 7
```

Stage 3 is **not** about making the bot beautiful or fully productized. It is about proving the bot does **not** make dangerous mistakes.

---

## Architecture direction (long-term)

**Do not keep expanding n8n with more and more business logic forever.**

| Layer | Role |
|-------|------|
| **n8n** | Orchestrates — webhooks, WhatsApp, Stripe callbacks, notifications, simple integration steps |
| **Backend / code** | Decides — routing, required fields, package logic, safety guards, handoff rules |
| **Postgres** | Remembers — bookings, payments, conversations, beds, audit trail |
| **Client config** | Controls — packages, pricing, room rules, policies per property (Wolfhouse = client #1) |
| **Staff UI** | Manages — holds, payments, assignments, takeover (Stage 6+) |

The current **n8n-heavy** implementation is acceptable for **proving behavior** in Stage 3. Future stages migrate decision logic into code/config modules; n8n calls the decision engine instead of owning the business brain.

**Target module layout (Stage 5):**

```text
src/booking-assistant/
  routeMessage.ts
  extractBookingDetails.ts
  requiredFields.ts
  packageDecision.ts
  safetyGuards.ts
  handoffRules.ts
  duplicateProtection.ts
  bookingContext.ts
  clientConfig.ts
```

**Example future config shape (not implemented yet):**

```text
client_config.packages
client_config.room_rules
client_config.payment_rules
client_config.handoff_rules
client_config.required_fields
```

Build **Wolfhouse as client #1**, not as the only client the system can ever serve.

---

## Client category / market positioning

### Product category

**Primary:** AI booking operations for WhatsApp-first experience businesses.

**Simpler language:** AI front desk for WhatsApp-heavy experience operators.

This is **not** framed as a generic chatbot. It is an operations layer that handles guest questions, package/rental/lesson explanation, availability and detail collection, payment links, payment truth, confirmations, customer memory, staff handoff, and operational status.

### Beachhead

**Wolfhouse** — surf houses / surf camps (client #1, `wolfhouse-somo`).

Hard first use case: combines accommodation, packages, rooming, payments, confirmations, WhatsApp, and staff operations in one property.

### Adjacent categories (same core pattern)

Guests ask on WhatsApp → business explains options → checks availability → collects details → sends payment/deposit link → confirms → staff handle changes and handoffs.

| Adjacent vertical | Typical scope (often simpler than surf house) |
|------------------|-----------------------------------------------|
| Surf schools | Lessons, levels, schedules |
| Surf shops | Rentals, retail-adjacent booking |
| Kite schools · dive shops | Lessons, certifications, slots |
| Yoga retreats · small retreat operators | Packages, dates, capacity |
| Hostels with activities | Beds + activity add-ons |
| Tour operators | Departures, group size, deposits |
| Rental businesses | Lessons, rentals, inventory, time slots, sizes — surf shop / bike / e-bike / kayak / SUP / campervan patterns |

A **surf shop or lesson-rental** operator is likely a simpler config profile than Wolfhouse: fewer rooming rules, more slot/inventory semantics, still the same payment + confirmation + handoff spine.

### Competitive note

AI/WhatsApp tools already exist for hotels, hospitality, and tour operators. The opportunity is a **focused, configurable, operations-heavy** assistant for **small experience businesses** that live in WhatsApp and run **messy** packages, rentals, lessons, and deposits — not clean hotel-only PMS flows.

### Roadmap implication

| Build now | Defer |
|-----------|--------|
| Wolfhouse as client #1 with full safety proofs | Multi-client SaaS platform |
| `client_config` specs that generalize | Client onboarding UI, billing, settings editor |
| Engine shaped for lessons/rentals/rooming via config | Hardcoding “surf house only” in shared workflows |

**Config dimensions per client** (see §3x.11 in [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)): packages · lesson types · rental inventory · rooming rules (if applicable) · pricing · deposit rules · cancellation policy · handoff rules · staff notifications · customer memory policy.

---

## Legacy phase map (reference)

Older docs use **Phase 0–3d** for engineering milestones. They map to stages as follows:

| Legacy | Stage |
|--------|--------|
| Phase 0–2 local (frozen) | Foundation + Stripe/Main/Send Confirmation contracts |
| Phase 3b (frozen) | Stage 3 — bed-ops / manual / operator paths |
| Phase 3c–3g | Stage 3 — Main + Postgres + stub E2E |
| Phase 3d.x | Stage 3 — isolated real Stripe payment / webhook / confirmation gates |
| (planned) Stage 3x | Bot knowledge + safety guardrails (specs, not n8n sprawl) |
| Azure / multi-client | Stage 7 (Scalable), not before Reliability + Clean |

---

## Stage 3 — Correct and safe

### Purpose

Prove dangerous core workflows safely before cleanup, staff UI, or multi-client productization.

### What Stage 3 is not

- Not optimizing for guest-facing polish or marketing copy quality
- Not building the full staff product UI
- Not Azure/production cutover
- Not adding dozens of new n8n IF branches for business rules (that belongs in Stage 3x **specs** and Stage 5 **code**)

### Dangerous mistakes Stage 3 must prevent

| Risk | Guard |
|------|--------|
| Wrong booking selected | Conversation `current_hold_booking_id`, resolver, terminal-status blocks |
| Wrong payment link | Real CPS on correct hold; stub vs real env separation |
| Wrong confirmation | Send Confirmation gates; dry-run first; schedule disabled in tests |
| Wrong room assignment | Bed-ops forks; **hosted reassign URL** in Main fork (`3e.2` remap) — see [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) |
| Duplicate payment / session / event | Idempotency checks; single webhook per event id |
| Accidental live Stripe / WhatsApp | Test keys; `WHATSAPP_DRY_RUN`; activation boundaries |
| Background workflow firing | Inactive workflows + schedule `disabled` in test windows |

### Complete or in progress (engineering)

| Area | Status | Notes |
|------|--------|--------|
| `booking_flow` hold creation | **Proven** | PG hold + Airtable backfill in Main fork (3c.e) |
| `payment_details_provided` route | **Proven** | Resolver + Ensure (3c.g stub E2E) |
| Real Stripe checkout link (Main-integrated) | **Proven** | 3d.7b — `WH-260528-5369`, stop at checkout URL |
| Isolated Create Payment Session | **Proven** | 3d.4 |
| Stripe Webhook Handler payment truth | **Proven** (isolated) | 3d.5b on `WH-260528-1493` |
| Send Confirmation (dry-run) | **Proven** (isolated) | 3d.6e |
| Pay + webhook on Main-created session | **Proven** | 3d.8b organic Stripe on `WH-260528-5369` |
| Integrated Send Confirmation (dry-run) | **Proven** | 3d.9b exec **1077** on same booking |
| Rooming / reassign E2E | **Pending** | **3e.2** Main hosted URL remapped — [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md); next **3e.3** static contract |

**Not proven in Stage 3:** real WhatsApp send; Send Confirmation schedule-poll; single-window E2E; full package intelligence.

**Detail:** [`PROJECT-STATE.md`](PROJECT-STATE.md) · [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

---

## Stage 3x — Bot knowledge + safety guardrails

**Mini-phase before fully entering Stage 4 (Reliable).**

**Master spec:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)  
**Owner questionnaire:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### Purpose

Define the business knowledge and decision rules the bot needs to act safely, ask smart follow-up questions, and avoid dangerous guesses.

**Important:** Stage 3x delivers **specs, fixtures, and configurable rules** — not a huge expansion of n8n IF nodes. Implementation belongs in code modules (Stage 5) fed by client config.

| Sub-phase | Status |
|-----------|--------|
| **3x.1** Full roadmap §3x.1–3x.11 + exit criteria + 35 golden rows | **Done** (2026-05-28 retry) |
| **3x.1b** Customer memory layered model (§3x.5) | **Done** (2026-05-28) |
| **3x.2** Owner answers + draft client config | Planned |
| **3x.3** WhatsApp mining + golden fixtures + customer extract | Planned |
| **3x.4** Golden runner + Stage 4 reliability hooks | Planned |

**Stage 3x includes:** required-field map · package decision flow · Wolfhouse knowledge collection · **WhatsApp history mining** · **customer memory migration** · golden message tests · dangerous-action gates · human handoff · wrong-booking protection · duplicate protection · client-config architecture · **exit criteria** ([`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)).

### Summary index (detail in master spec)

### 3x.1 — Required field map

Define required fields **before** each action:

| Action | Required before proceed |
|--------|-------------------------|
| Create booking hold | Dates, guest count, contact phone, package or accommodation intent, availability OK |
| Send payment link | Hold exists, guest name + email, promoted payment state, deposit rule known |
| Confirm booking | Payment truth (`deposit_paid` / paid), `send_confirmation` gate, not terminal |
| Cancel booking | Booking id/code, policy window, staff approval if ambiguous |
| Room / bed assignment | Confirmed or approved hold, guest count, gender/couple/friend rules |
| Package quote | Package code, dates, guest count, season |
| Package booking | Quote inputs + package-specific required fields |
| Date change | Booking id, new dates, availability, policy |

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` §3x.1](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x1--required-field-map) + fixture tables keyed by `resolved_route`.

### 3x.2 — Package explanation + package decision flow

The bot must explain package differences clearly.

**Define per package:**

- Name, inclusions, exclusions
- Price or price logic (season, nights, per person)
- Deposit rules, minimum nights
- Lesson schedule, rental rules, meals, transfers
- Cancellation/refund policy
- Who the package is best for

**Bot behavior rules:**

| Guest signal | Bot behavior |
|--------------|--------------|
| “What packages do you have?” | Briefly explain all packages |
| Wants to book, package missing | Ask: accommodation only vs surf package |
| Unsure | Recommend by goal: cheapest → shared accommodation; beginner → lesson package; full arrange → full surf; already surfs → accommodation + rentals |
| Price question | Do **not** quote exact price unless dates, guest count, package, and price source are known |
| Still uncertain | Follow-up question or staff handoff |

### 3x.3 — Wolfhouse knowledge collection

Operational gaps only (not public website facts). Questionnaire for Ale/Cami:

**Deliverable:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### 3x.4 — WhatsApp history mining plan

Redacted Cami/Ale guest threads → **dual outputs:** (A) anonymized bot knowledge + (B) structured customer memory (see §3x.5).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` §3x.4](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x4--whatsapp-history-mining-plan); redacted samples under `docs/knowledge/whatsapp-samples/` (not in git until anonymized).

### 3x.5 — Customer memory + WhatsApp history migration

Layered model: temporary raw import → structured customer facts (PG, `client_id`-scoped) → anonymized fixtures. Proposed tables: `customers`, `customer_booking_history`, `conversation_summaries`, `customer_preferences`, `customer_notes`, `privacy_requests` (future).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` §3x.5](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x5--customer-memory--whatsapp-history-migration). Owner questions: [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) § Customer memory.

### Stage 3x exit criteria

Documented in master spec — planning complete when §3x.1–3x.11 + exit checklist exist; full golden fixture set may complete in 3x.3.

### 3x.6 — Golden message tests

**30–50** realistic guest messages with expected:

- `resolved_route`
- Missing fields
- Safe action (or explicit no-op)
- Clarification question text (pattern, not exact LLM wording)
- Handoff behavior

**Categories to include:**

- Booking request · package questions · payment-link request · “I paid”
- Cancellation · room preference · couple/friends/gender rooming · date changes
- Surfboard/wetsuit rental · breakfast/transfer · unclear / low-confidence messages

**Deliverable:** `docs/fixtures/golden-messages/` + runner stub (Stage 4+). Schema + samples in master spec §3x.6.

### 3x.7 — Dangerous action gates

Strict proof required before:

| Action | Proof |
|--------|--------|
| Send payment link | Hold + Ensure + CPS contract; no terminal booking |
| Confirm booking | Webhook payment truth + Send Confirmation eligibility |
| Cancel booking | Booking status + policy |
| Change room/bed | Assignment rules + capacity |
| Change dates | Availability + policy |
| Mark payment-related states | Webhook or authorized staff only |

### 3x.8 — Human handoff rules

Bot must stop guessing and alert staff when:

- Low route confidence
- Conflicting dates or guest count
- Multiple active holds for same conversation
- Guest says they paid but no payment record
- Refund / dispute / cancellation ambiguity
- Angry guest / complaint
- Medical / emergency / legal issues
- Rooming / reassign uncertainty

**Deliverable:** `handoffRules` spec → later `client_config.handoff_rules`.

### 3x.9 — Wrong-booking protection

Formalize (align with existing resolver + PG):

- `conversation.current_hold_booking_id` wins over phone-only fallback
- Terminal bookings (`confirmed`, `cancelled`, etc.) cannot be modified by guest path
- Old holds must not be selected because phone matches alone
- Active booking must match conversation context and latest intent

### 3x.10 — Duplicate protection

Verify and document:

| Scenario | Expected |
|----------|----------|
| Same WhatsApp message id | No duplicate booking |
| Repeated payment-link request | No duplicate checkout session without idempotency |
| Same Stripe event id | No duplicate `payment_events` row |
| Confirmation | Cannot send twice (`confirmation_sent_at`, flags) |

### 3x.11 — Client-config architecture plan

Same assistant engine, different **client config** per property.

| Config category | Examples |
|-----------------|----------|
| `packages` | Codes, seasons, inclusions |
| `room_types` | Shared, private, gender rules |
| `bed/room_rules` | Couples, friends, operator blocks |
| `pricing` | Rules, deposits, rounding |
| `deposit/payment_rules` | Deposit cents, deadlines |
| `cancellation_policy` | Windows, refund tiers |
| `hold_expiry` | TTL, reminders |
| `language/tone` | Default language, formality |
| `handoff_rules` | Triggers, staff notify |
| `integrations` | Stripe, WhatsApp, webhooks |
| `staff_notification_rules` | Channels, severity |
| `customer_memory_policy` | Retention, allowed fields, returning-guest rules |

Wolfhouse = `client_slug: wolfhouse-somo`. Future surf houses add new config rows, not forked workflows.

---

## Stage 4 — Reliable

### Purpose

Make the working system **dependable and observable** after Stage 3 behavior is proven and Stage 3x rules are specified.

### Includes

- Better error handling and safe retries (where idempotent)
- Stuck booking detection
- Monitoring, alerts, execution dashboards
- Clearer structured logs
- Health checks (n8n, Postgres, Redis, webhooks)
- Rollback tools and fixture cleanup
- Duplicate protection checks (automated)
- Active workflow safety checks; schedule safety checks
- Runbooks for common failures (payment stuck, webhook miss, confirmation not sent)

### Staff visibility (minimum for safety)

May begin here if needed before full Stage 6 UI:

- Stuck bookings queue
- Payment status view
- Human handoff queue
- Pending confirmations
- Failed workflow executions

---

## Stage 5 — Clean

### Purpose

Simplify implementation after behavior is proven and reliability checks exist.

### Includes

- Move decision logic **out of n8n** into `src/booking-assistant/` modules
- Reduce duplicated route logic in Main JSON
- Clean workflow naming; simplify n8n branches to orchestration only
- Reduce Airtable dependency on critical paths
- Consolidate scripts; organize docs
- Reusable service boundaries (booking, payment, conversation, assignment)

**Target:** n8n calls backend decision engine; Postgres writes go through shared SQL/modules; n8n performs WhatsApp/Stripe/Airtable I/O.

---

## Stage 6 — Beautiful

### Purpose

Excellent staff and owner experience.

### Includes

- Staff UI: calendar / bed grid, guest list, booking detail
- Payment status, pending holds, confirmation queue
- Conversation history, human takeover
- Manual booking / edit / cancel tools
- Room/bed assignment UI
- Alerts for stuck workflows
- Owner dashboard

Airtable may remain a **bridge** during transition; long-term goal is a proper staff UI, not Airtable as daily ops surface.

---

## Stage 7 — Scalable

### Purpose

Repeatable platform for multiple clients.

### Includes

- Multi-client config onboarding
- Client-specific room/package rules (config-driven)
- Isolated data per `client_id`
- Reusable deployment process (see [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md) when approved)
- Billing/subscription model (product)
- Support tools, backup/restore, per-client monitoring
- Migration path away from Airtable
- Templates for surf houses, retreats, hostels, camps

**Guiding principle:** Build Wolfhouse first; structure everything as **client #1**, not the only client.

---

## What to read next

| Role | Doc |
|------|-----|
| Engineer (today) | [`PROJECT-STATE.md`](PROJECT-STATE.md) |
| Stage 3x spec | [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) |
| Owner / non-engineer | [`PROJECT-ROADMAP.md`](PROJECT-ROADMAP.md) |
| Agent rules | [`../CURSOR.md`](../CURSOR.md) |
| Stripe test gates | [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) |
