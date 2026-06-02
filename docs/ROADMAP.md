# Wolfhouse Booking Assistant ï¿½ Product Roadmap

**Product:** AI booking operations for WhatsApp-first experience businesses ï¿½ **beachhead:** Wolfhouse (surf house / surf camp). Simpler label: *AI front desk for WhatsApp-heavy experience operators.*

**Product-level roadmap (15 pillars):** [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md) ï¿½ **Engineering snapshot:** [`PROJECT-STATE.md`](PROJECT-STATE.md) ï¿½ **Architecture:** [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) ï¿½ **Stripe isolated gates:** [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

> **This file is the stage-level / engineering roadmap.** For the **product-level view** ï¿½ the full 15-pillar product vision (Guest Assistant, SoT DB, Staff Brain, Dashboard, Rooming UI, Add-ons, Messaging Bridge, Multi-Client Config, Onboarding, PMS, AI Intent, Analytics, Production Hardening, Multi-Client Admin, Productization) mapped to these stages ï¿½ see [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md).

---

## Evolution order (do not skip)

```text
1. Correct and safe      ? Stage 3  (engineering gates + exit criteria)
   Safety rails          ? Stage 3.5 (seatbelts before live/shadow mode)
   Knowledge + guardrails ? Stage 3x (specs, client config, golden tests)
   Shadow / co-pilot     ? Stage 3y (staff-approved replies, real guest data)
2. Reliable              ? Stage 4
3. Clean                 ? Stage 5
4. Beautiful             ? Stage 6  (Staff / Admin Layer + Staff Operations Assistant)
5. Scalable              ? Stage 7
```

Stage 3 is **not** about making the bot beautiful or fully productized. It is about proving the bot does **not** make dangerous mistakes.

**Stage 3.5 is not full Stage 4 observability.** It is the minimum seatbelts required before serious runtime or live/shadow operation ï¿½ error capture, idempotency checks, overlap guards, basic execution logging.

**Stage 3y (Shadow/Co-pilot)** bridges dry-run proof and autonomous live operation. The bot reads real messages and drafts responses; staff approve and send manually. No autonomous payment/confirmation/cancellation/rooming without explicit staff approval. This reduces the dry-run ? real-guest cliff and generates real golden-message data.

---

## Architecture direction (long-term)

**Do not keep expanding n8n with more and more business logic forever.**

| Layer | Role |
|-------|------|
| **n8n** | Orchestrates ï¿½ webhooks, WhatsApp, Stripe callbacks, notifications, simple integration steps |
| **Backend / code** | Decides ï¿½ routing, required fields, package logic, safety guards, handoff rules |
| **Postgres** | Remembers ï¿½ bookings, payments, conversations, beds, audit trail |
| **Client config** | Controls ï¿½ packages, pricing, room rules, policies per property (Wolfhouse = client #1) |
| **Staff UI + Staff Assistant** | Manages ï¿½ holds, payments, assignments, takeover; answers operational queries; approves risky bot actions (Stage 6+) |

The current **n8n-heavy** implementation is acceptable for **proving behavior** in Stage 3. Future stages migrate decision logic into code/config modules; n8n calls the decision engine instead of owning the business brain.

**Target module layout (Stage 5):**

```text
src/booking-assistant/
  # --- shared spine (client- AND vertical-agnostic; never rebuilt per vertical) ---
  routeMessage.ts
  extractBookingDetails.ts
  requiredFields.ts
  safetyGuards.ts
  handoffRules.ts
  duplicateProtection.ts
  bookingContext.ts
  clientConfig.ts
  payments.ts              # Stripe link + webhook truth + confirmation (vertical-agnostic)
  # --- vertical plugin seam (the ONLY part that differs per business type) ---
  inventory/
    InventoryProvider.ts   # interface: findAvailability / hold / fulfill
    lodging.ts             # beds-in-rooms + rooming (Wolfhouse / hostels)
    slots.ts               # lesson/tour time-slot capacity (surf/kite schools, tours)
    rentals.ts             # item ï¿½ time-window ï¿½ quantity ï¿½ size (surf/bike/SUP shops)
  catalog/
    offerings.ts           # generic priced offering (packages | lessons | rental SKUs | departures)
    packageDecision.ts     # explain / recommend / quote ï¿½ driven by config, not hardcoded names
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

**Spine vs plugin (portability principle):** everything above the `inventory/` and `catalog/` folders is the **shared spine** and must contain **no surf-house-specific nouns** (no `bed`, `room`, `malibu`, `surfweek`). Anything vertical-specific lives behind the `InventoryProvider` interface or in `client_config`. A new vertical = new config + (at most) one new inventory provider ï¿½ see [ï¿½ Engine portability](#engine-portability--adding-a-new-vertical-surf-shop--lessons).

---

## Client category / market positioning

### Product category

**Primary:** AI booking operations for WhatsApp-first experience businesses.

**Simpler language:** AI front desk for WhatsApp-heavy experience operators.

This is **not** framed as a generic chatbot. It is an operations layer that handles guest questions, package/rental/lesson explanation, availability and detail collection, payment links, payment truth, confirmations, customer memory, staff handoff, and operational status.

### Beachhead

**Wolfhouse** ï¿½ surf houses / surf camps (client #1, `wolfhouse-somo`).

Hard first use case: combines accommodation, packages, rooming, payments, confirmations, WhatsApp, and staff operations in one property.

### Adjacent categories (same core pattern)

Guests ask on WhatsApp ? business explains options ? checks availability ? collects details ? sends payment/deposit link ? confirms ? staff handle changes and handoffs.

| Adjacent vertical | Typical scope (often simpler than surf house) |
|------------------|-----------------------------------------------|
| Surf schools | Lessons, levels, schedules |
| Surf shops | Rentals, retail-adjacent booking |
| Kite schools ï¿½ dive shops | Lessons, certifications, slots |
| Yoga retreats ï¿½ small retreat operators | Packages, dates, capacity |
| Hostels with activities | Beds + activity add-ons |
| Tour operators | Departures, group size, deposits |
| Rental businesses | Lessons, rentals, inventory, time slots, sizes ï¿½ surf shop / bike / e-bike / kayak / SUP / campervan patterns |

A **surf shop or lesson-rental** operator is likely a simpler config profile than Wolfhouse: fewer rooming rules, more slot/inventory semantics, still the same payment + confirmation + handoff spine.

### Competitive note

AI/WhatsApp tools already exist for hotels, hospitality, and tour operators. The opportunity is a **focused, configurable, operations-heavy** assistant for **small experience businesses** that live in WhatsApp and run **messy** packages, rentals, lessons, and deposits ï¿½ not clean hotel-only PMS flows.

### Roadmap implication

| Build now | Defer |
|-----------|--------|
| Wolfhouse as client #1 with full safety proofs | Multi-client SaaS platform |
| `client_config` specs that generalize | Client onboarding UI, billing, settings editor |
| Engine shaped for lessons/rentals/rooming via config | Hardcoding ï¿½surf house onlyï¿½ in shared workflows |

**Config dimensions per client** (see ï¿½3x.11 in [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)): packages ï¿½ lesson types ï¿½ rental inventory ï¿½ rooming rules (if applicable) ï¿½ pricing ï¿½ deposit rules ï¿½ cancellation policy ï¿½ handoff rules ï¿½ staff notifications ï¿½ customer memory policy.

---

## Engine portability ï¿½ adding a new vertical (surf shop / lessons)

**Goal:** when Wolfhouse is done, standing up a second vertical (surf-shop **rentals**, surf/kite-school **lessons**, tour **departures**) is a **config + inventory-plugin** exercise ï¿½ **not** a rewrite. This section defines the seam so that promise is real instead of aspirational.

### What is SHARED ï¿½ built once, reused by every vertical

| Shared spine capability | Where |
|-------------------------|-------|
| WhatsApp inbound/outbound I/O | n8n orchestration |
| Message routing / intent (`routeMessage`) | spine |
| Required-field gating per action (`requiredFields`) | spine + `client_config` |
| Payment link ? **Stripe webhook truth** ? confirmation (`payments`) | spine (proven 3d.x) |
| Handoff triggers (`handoffRules`) | spine + `client_config.handoff` |
| LLM safety (low-confidence ? handoff; never act on LLM alone) | spine + `client_config.llm_safety` |
| Duplicate / idempotency protection | spine (Stage 3.5) |
| Conversation / session state, customer memory + privacy | spine + Postgres |
| Error capture, golden-message runner | Stage 3.5 / 4 |

These **must not** be reimplemented per client. If a "new vertical" task touches these, the seam has leaked.

### What is VERTICAL-SPECIFIC ï¿½ plugged in, never forked

| Vertical concern | How it varies | Mechanism |
|------------------|---------------|-----------|
| The bookable resource + availability | bed-nights vs lesson slots vs rental items vs departure seats | `InventoryProvider` implementation |
| Catalog of offerings | packages vs lesson types vs rental SKUs vs departures | `catalog/offerings` + `client_config` |
| Fulfillment / assignment | rooming is **lodging-only**; most verticals skip it | capability flag, not core path |
| Required fields per booking type | dorm gender vs board size vs surf level | `client_config.required_fields` |
| Vocabulary / tone | surf-house terms vs shop terms | `client_config.language_tone` |

### The one abstraction that unlocks all of it: `InventoryProvider`

All verticals reduce to the same three-call contract ï¿½ `findAvailability(request)` ? `hold(unit, window)` ? `fulfill(booking)`:

| Vertical | Unit | Availability dimension | Special attribute | Rooming? |
|----------|------|------------------------|-------------------|----------|
| Surf house / hostel | bed | date-range overlap | gender / couple | **yes** (`lodging`) |
| Surf / kite / dive school | lesson slot | time + slot capacity | skill level | no (`slots`) |
| Surf / bike / SUP shop | rental item | time-window ï¿½ quantity | size / fit | no (`rentals`) |
| Tour operator | departure seat | departure-date capacity | group size | no (`slots`) |

The spine calls the interface and never knows which provider it is.

### Portability gate ï¿½ a vertical is "config-only ready" when:

- [ ] No surf-house nouns (`bed`, `room`, `matrimonial`, `surfweek`, `malibu`/`uluwatu`/`waimea`) appear in the shared spine ï¿½ only in `client_config` / providers.
- [ ] Rooming/assignment is behind a **capability flag**, not assumed.
- [ ] Catalog is generic `offerings`, not a hardcoded package enum.
- [ ] Inventory/availability is behind `InventoryProvider`; lodging is just one impl.
- [ ] `client_config` is split into **engine config** (spine) + **vertical config** (catalog/inventory/capabilities).
- [ ] Golden-message suite is parameterized by `client_id` (Wolfhouse fixtures don't hardcode the engine's behavior).

### Cheapest validation ï¿½ do this on paper during Stage 3x.3 (safe, docs-only)

Before any Stage 5 extraction, draft **sample configs for a second and third vertical** and run them against the schema to surface every leak:

- `config/clients/surf-shop-rental.sample.json` (rentals: items, sizes, time windows, deposits)
- `config/clients/surf-school.sample.json` (lessons: levels, slots, instructors)

Each gap found ("this field has no home," "this rule assumes beds") becomes a line item in the **Stage 5 extraction backlog**. If both samples fit the schema with only a new `InventoryProvider`, the backbone is portable; if not, you've found the surf-house assumptions cheaply, on paper, before writing engine code.

### Stage placement

| Work | Stage | Safe before runtime? |
|------|-------|----------------------|
| Spine/plugin seam **design** + sample vertical configs (paper test) | now / **3x.3** | yes (docs/config only) |
| Split `client_config` into engine vs vertical schema | 3x.3 ? Stage 5 | yes (config) |
| Extract spine modules; implement `InventoryProvider` (lodging first) | **Stage 5** | build stage |
| Second `InventoryProvider` (`slots` / `rentals`) + 2nd client live | **Stage 7** | scale stage |

**Do not** build multi-vertical infra early. **Do** lock the seam now so Stage 5 cleanup produces portable modules instead of a tidied-up surf-house monolith.

### Deploy config (the onboarding contract)

Every client-specific value (prices, seasons, gate code, phone numbers, packages, room map, policies) lives in **one per-client deploy config** + a gitignored secret file ï¿½ never hardcoded in code/workflows. A new client = fill the template, not rewrite logic. Template: [`config/clients/_deploy-config.template.json`](../config/clients/_deploy-config.template.json) ï¿½ Guide: [`DEPLOYMENT-CONFIG.md`](DEPLOYMENT-CONFIG.md). Wolfhouse's `wolfhouse-somo.baseline.json` is the worked example (`vertical: lodging_surf_house`).

---

## Legacy phase map (reference)

Older docs use **Phase 0ï¿½3d** for engineering milestones. They map to stages as follows:

| Legacy | Stage |
|--------|--------|
| Phase 0ï¿½2 local (frozen) | Foundation + Stripe/Main/Send Confirmation contracts |
| Phase 3b (frozen) | Stage 3 ï¿½ bed-ops / manual / operator paths |
| Phase 3cï¿½3g | Stage 3 ï¿½ Main + Postgres + stub E2E |
| Phase 3d.x | Stage 3 ï¿½ isolated real Stripe payment / webhook / confirmation gates |
| Phase 3e | Stage 3 ï¿½ rooming/reassign E2E ? |
| Stage 3.5 | Safety rails ï¿½ idempotency, error capture, overlap guards |
| Stage 3x | Bot knowledge + safety guardrails (specs, not n8n sprawl) |
| Stage 3y | Shadow / co-pilot ï¿½ staff-approved mode before autonomous |
| Azure / multi-client | Stage 7 (Scalable), not before Reliability + Clean |

---

## Stage 3 ï¿½ Correct and safe

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
| Wrong room assignment | Bed-ops forks; **hosted reassign URL** in Main fork (`3e.2` remap) ï¿½ see [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) |
| Duplicate payment / session / event | Idempotency checks; single webhook per event id |
| Accidental live Stripe / WhatsApp | Test keys; `WHATSAPP_DRY_RUN`; activation boundaries |
| Background workflow firing | Inactive workflows + schedule `disabled` in test windows |

### Complete or in progress (engineering)

| Area | Status | Notes |
|------|--------|--------|
| `booking_flow` hold creation | **Proven** | PG hold + Airtable backfill in Main fork (3c.e) |
| `payment_details_provided` route | **Proven** | Resolver + Ensure (3c.g stub E2E) |
| Real Stripe checkout link (Main-integrated) | **Proven** | 3d.7b ï¿½ `WH-260528-5369`, stop at checkout URL |
| Isolated Create Payment Session | **Proven** | 3d.4 |
| Stripe Webhook Handler payment truth | **Proven** (isolated) | 3d.5b on `WH-260528-1493` |
| Send Confirmation (dry-run) | **Proven** (isolated) | 3d.6e |
| Pay + webhook on Main-created session | **Proven** | 3d.8b organic Stripe on `WH-260528-5369` |
| Integrated Send Confirmation (dry-run) | **Proven** | 3d.9b exec **1077** on same booking |
| Rooming / reassign E2E | **Proven** | **3e.4 PASS** ï¿½ `WH-260528-5322`, beds R3-B1/R3-B2 |

**Not proven in Stage 3:** real WhatsApp send; Send Confirmation schedule-poll; single-window E2E; full package intelligence.

**Freeze:** [`PHASE-3c-3d-FREEZE.md`](PHASE-3c-3d-FREEZE.md) ï¿½ formal 3c+3d checkpoint before Phase 3e.3+.

**Detail:** [`PROJECT-STATE.md`](PROJECT-STATE.md) ï¿½ [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

### Stage 3 exit criteria

Stage 3 is **complete only when all of the following are met** (or explicitly deferred with documented safe fallback):

**Core behavior proven:**
- [ ] `booking_flow` hold creation (PG + Airtable backfill) ?
- [ ] `payment_details_provided` route + Ensure ?
- [ ] Real Stripe checkout link (Main-integrated) ?
- [ ] Isolated Create Payment Session ?
- [ ] Stripe Webhook Handler payment truth ?
- [ ] Send Confirmation (dry-run) ?
- [ ] Integrated pay + webhook + confirmation ?
- [ ] Rooming / reassign E2E ?

**Safety invariants proven:**
- [ ] No Main direct writes to `payments` / `payment_events` ? (static proof)
- [ ] No payment/confirmation path writes `booking_beds` ? (static proof)
- [ ] Hosted/prod URLs removed from all local test paths ? (3e.2)
- [ ] Terminal evidence bookings not reused without reset (policy established)

**Guards verified or explicitly deferred:**
- [x] Wrong-booking guard tested for dangerous actions (rooming, payment, cancel) ï¿½ **3e.5 CLOSED** (L1+L2 PASS; L3 deferred ï¿½ Airtable-coupled runtime deferred to Postgres source-of-truth cutover; see ï¿½15.6ï¿½ï¿½15.7)
- [x] Duplicate / idempotency protections verified at Stage 3 bar ï¿½ **3e.6 CLOSED** (I1 schema PASS ï¿½ I4 runtime PASS ï¿½ I6 invariant PASS; I2/I3/I5 deferred: I2 ? manual-pay gate ï¿½ I3 ? Stage 3.5 ï¿½ I5 ? Postgres cutover)
- [ ] All dangerous actions have handoff / fail-safe behavior when required business rule is missing ï¿½ *3x.7ï¿½3x.8 spec done; implementation pending*

**Acceptable deferrals (do not block Stage 3 exit if documented):**
- Real WhatsApp send ï¿½ dry-run mode (`WHATSAPP_DRY_RUN=true`) is sufficient; shadow mode (Stage 3y) covers real send
- Send Confirmation schedule-poll ï¿½ schedule `disabled=true` gate is sufficient for Stage 3; verify in Stage 3y
- Single-window integrated E2E ï¿½ isolated gate chains are sufficient for Stage 3

**Acceptance metric gates:**
- 0 double bookings in all runtime test gates
- 0 wrong-booking dangerous actions in test gates
- 0 payment truth updates outside Stripe Webhook Handler
- 0 confirmations without payment truth
- 0 real WhatsApp sends in dry-run test gates
- 100% dangerous-action routes have handoff/fail-safe when required business logic is missing

---

## Stage 3.5 ï¿½ Safety Rails Before Reliability

**Purpose:** Pull forward the minimum safety plumbing required to safely run more runtime gates and prepare for live/shadow mode. This is not full Stage 4 observability ï¿½ it is seatbelts.

**When to do Stage 3.5:** After Stage 3 exit criteria are met, before Stage 3y (shadow/co-pilot) or live guest operation.

### Minimum safety requirements (Stage 3.5)

| Item | Why |
|------|-----|
| `automation_errors` capture/write path | Know when bot fails silently |
| Standard workflow error handler pattern | Consistent safe fallback across all n8n workflows |
| Idempotency: inbound WhatsApp message id | No duplicate booking from retry/double-delivery |
| Idempotency: Stripe event id | No duplicate `payment_events` row |
| Idempotency: payment-link reuse | No duplicate checkout session without explicit guard |
| Idempotency: Send Confirmation | Cannot confirm twice (`confirmation_sent_at` + flag) |
| Idempotency: rooming/reassign | Cannot double-assign or double-delete beds |
| Double-booking guard / DB overlap check | `booking_beds` overlap detection query; reject or alert before insert |
| Stuck booking detection (basic) | Bookings in `payment_pending` > N hours with no event; holds expired but not released |
| Workflow active-state safety check | Automated assertion: only expected workflows active before dangerous test or runtime |
| Schedule disabled/enabled safety check | Send Confirmation schedule `disabled=true` verified before any payment/confirmation test |
| Minimum execution logging | For each execution: `resolved_route`, confidence, selected booking id, dangerous action taken (or no-op reason) |
| Golden-runner stub | Even a fixture-file runner (`test:golden-messages`) blocks regression in CI before Stage 4 |

**Stage 3.5 does not include:** full monitoring dashboards, Azure deploy, Staff UI, broad n8n ? backend refactor.

**Full sub-phase spec:** [`PHASE-3.5-SAFETY-RAILS-PLAN.md`](PHASE-3.5-SAFETY-RAILS-PLAN.md) ï¿½ 3.5aï¿½3.5g with entry/exit criteria, work-type classification, and first implementation step.

**Key schema finding:** `automation_errors` and `workflow_events` tables exist in migration 001 but are not yet wired into any n8n workflow. Stage 3.5b is a pure wire-in task.

---

## Stage 3y ï¿½ Shadow / Co-pilot Pilot

**Purpose:** Bridge the gap between isolated dry-run proof and autonomous live guest operation. Reduces the dry-run ? real-guest cliff; generates real labeled data; builds Ale/Cami trust in the system.

**Full plan:** [`PHASE-3y-SHADOW-COPILOT-PLAN.md`](PHASE-3y-SHADOW-COPILOT-PLAN.md) ï¿½ entry criteria, operating modes Aï¿½D, allowed/forbidden actions, staff approval workflow, infrastructure requirements, 15-test matrix (Y-T1ï¿½Y-T15), exit criteria.

### How shadow/co-pilot mode works

| Step | Who acts |
|------|----------|
| Real guest message arrives (or pasted in offline shadow) | n8n / Main reads it |
| Bot resolves route + drafts response | Bot (automated) |
| Bot suggests safe action (if any) | Bot outputs draft; **no autonomous send** |
| Staff reviews draft | Ale / Cami |
| Staff approves and sends | **Staff (manual)** |
| Staff edit logged as labeled example | System records correction (interim: offline log) |

### Operating modes (ascending risk ï¿½ gate each separately)

| Mode | Description | Gate |
|------|-------------|------|
| **A ï¿½ Offline shadow** | Pasted/copied messages; local n8n; no live connection | ? Ready to start (no new infra) |
| **B ï¿½ Real inbound, no sends** | Real WhatsApp inbound; `DRY_RUN=true` enforced | Separate explicit approval required |
| **C ï¿½ Staff-approved draft queue** | Bot writes draft to review queue; staff approves and sends manually | Mode B stable + review UI |
| **D ï¿½ Staff-approved action proposals** | Bot proposes dangerous action; staff clicks approve | Stage 6 Staff UI + all 3x complete |

### What is and is not allowed in Stage 3y

| Allowed | Not allowed without explicit approval |
|---------|--------------------------------------|
| Bot reads / classifies message text | Autonomous WhatsApp reply |
| Bot resolves route and flags uncertainty | Autonomous payment link creation |
| Bot drafts response for staff review | Autonomous booking confirmation |
| Bot identifies missing required fields | Autonomous cancellation or room reassign |
| Bot logs decision to `workflow_events` | Payment truth writes |
| Staff-approved sends (manual copy-paste) | Any dangerous action without per-action gate |

### Why Stage 3y before Stage 4

- Avoids big-bang flip from dry-run to fully autonomous
- Creates real labeled guest-message data from actual interactions
- Staff corrections become labeled training examples for Stage 4
- Ale/Cami can see and trust bot behavior before handing over
- "AI drafts, staff approves" is a distinct, sellable product tier

---

## Stage 3x ï¿½ Bot knowledge + safety guardrails

**Mini-phase before fully entering Stage 4 (Reliable).**

**Master spec:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)  
**Owner questionnaire:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### Purpose

Define the business knowledge and decision rules the bot needs to act safely, ask smart follow-up questions, and avoid dangerous guesses.

**Important:** Stage 3x delivers **specs, fixtures, and configurable rules** ï¿½ not a huge expansion of n8n IF nodes. Implementation belongs in code modules (Stage 5) fed by client config.

| Sub-phase | Status |
|-----------|--------|
| **3x.1** Full roadmap ï¿½3x.1ï¿½3x.11 + exit criteria + 35 golden rows | **Done** (2026-05-28 retry) |
| **3x.1b** Customer memory layered model (ï¿½3x.5) | **Done** (2026-05-28) |
| **3x.2b** Minimum Business Logic Baseline + Stage 4 entry gate | **Done** (2026-05-29) |
| **3x.2c** Applied owner P1 answers ? baseline v0.2 + handoff/add-on plans | **Done** (2026-05-29) |
| **3x.2d** Working prices + policies ? baseline v0.3 (provisional pricing) | **Done** (2026-05-29) |
| **3x.2** Ale/Cami **confirm** provisional prices + fill gaps ? confirmed config | In progress |
| **3x.3** WhatsApp mining + golden fixtures + customer extract | Planned |
| **3x.4** Golden runner + Stage 4 reliability hooks | Planned |

**Stage 3x includes:** required-field map ï¿½ package decision flow ï¿½ Wolfhouse knowledge collection ï¿½ **WhatsApp history mining** ï¿½ **customer memory migration** ï¿½ golden message tests ï¿½ dangerous-action gates ï¿½ human handoff ([`STAFF-HANDOFF-PLAN.md`](STAFF-HANDOFF-PLAN.md)) ï¿½ during-stay add-ons ([`DURING-STAY-ADDONS-PLAN.md`](DURING-STAY-ADDONS-PLAN.md)) ï¿½ wrong-booking protection ï¿½ duplicate protection ï¿½ client-config architecture ï¿½ **exit criteria** ([`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)).

### Summary index (detail in master spec)

### 3x.1 ï¿½ Required field map

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

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ï¿½3x.1](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x1--required-field-map) + fixture tables keyed by `resolved_route`.

### 3x.2 ï¿½ Package explanation + package decision flow

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
| ï¿½What packages do you have?ï¿½ | Briefly explain all packages |
| Wants to book, package missing | Ask: accommodation only vs surf package |
| Unsure | Recommend by goal: cheapest ? shared accommodation; beginner ? lesson package; full arrange ? full surf; already surfs ? accommodation + rentals |
| Price question | Do **not** quote exact price unless dates, guest count, package, and price source are known |
| Still uncertain | Follow-up question or staff handoff |

### 3x.3 ï¿½ Wolfhouse knowledge collection

Operational gaps only (not public website facts). Questionnaire for Ale/Cami:

**Deliverable:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### 3x.4 ï¿½ WhatsApp history mining plan

Redacted Cami/Ale guest threads ? **dual outputs:** (A) anonymized bot knowledge + (B) structured customer memory (see ï¿½3x.5).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ï¿½3x.4](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x4--whatsapp-history-mining-plan); redacted samples under `docs/knowledge/whatsapp-samples/` (not in git until anonymized).

### 3x.5 ï¿½ Customer memory + WhatsApp history migration

Layered model: temporary raw import ? structured customer facts (PG, `client_id`-scoped) ? anonymized fixtures. Proposed tables: `customers`, `customer_booking_history`, `conversation_summaries`, `customer_preferences`, `customer_notes`, `privacy_requests` (future).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ï¿½3x.5](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x5--customer-memory--whatsapp-history-migration). Owner questions: [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) ï¿½ Customer memory.

### LLM safety requirements (across Stage 3x + Stage 4)

The bot must never act on LLM output alone for dangerous actions. The following are required:

| Requirement | Stage |
|-------------|-------|
| Low confidence ? human handoff (not silent no-op) | 3x.8 spec ? 3.5 impl |
| LLM/API error ? handoff or logged safe fallback | 3.5 |
| Parsing uncertainty ? clarification question, not action | 3x.8 spec ? 3.5 impl |
| `resolved_route`, confidence, selected booking, and action logged per execution | 3.5 |
| Golden-message suite used as prompt regression evaluation | 3x.6 ? 4 |
| Multilingual behavior tested: English / Spanish / Italian | 3x.6 |
| Bot never marks `paid` / `cancelled` / `confirmed` based only on LLM interpretation | 3x.7 gate ï¿½ proven in 3d.5b (webhook owns truth) |

### Stage 3x exit criteria

Documented in master spec ï¿½ planning complete when ï¿½3x.1ï¿½3x.11 + exit checklist exist; full golden fixture set may complete in 3x.3.

### 3x.6 ï¿½ Golden message tests

**30ï¿½50** realistic guest messages with expected:

- `resolved_route`
- Missing fields
- Safe action (or explicit no-op)
- Clarification question text (pattern, not exact LLM wording)
- Handoff behavior

**Categories to include:**

- Booking request ï¿½ package questions ï¿½ payment-link request ï¿½ ï¿½I paidï¿½
- Cancellation ï¿½ room preference ï¿½ couple/friends/gender rooming ï¿½ date changes
- Surfboard/wetsuit rental ï¿½ breakfast/transfer ï¿½ unclear / low-confidence messages

**Deliverable:** `docs/fixtures/golden-messages/` + runner stub (Stage 4+). Schema + samples in master spec ï¿½3x.6.

### 3x.7 ï¿½ Dangerous action gates

Strict proof required before:

| Action | Proof |
|--------|--------|
| Send payment link | Hold + Ensure + CPS contract; no terminal booking |
| Confirm booking | Webhook payment truth + Send Confirmation eligibility |
| Cancel booking | Booking status + policy |
| Change room/bed | Assignment rules + capacity |
| Change dates | Availability + policy |
| Mark payment-related states | Webhook or authorized staff only |

### 3x.8 ï¿½ Human handoff rules

Bot must stop guessing and alert staff when:

- Low route confidence
- Conflicting dates or guest count
- Multiple active holds for same conversation
- Guest says they paid but no payment record
- Refund / dispute / cancellation ambiguity
- Angry guest / complaint
- Medical / emergency / legal issues
- Rooming / reassign uncertainty

**Deliverable:** `handoffRules` spec ? later `client_config.handoff_rules`.

### 3x.9 ï¿½ Wrong-booking protection

Formalize (align with existing resolver + PG):

- `conversation.current_hold_booking_id` wins over phone-only fallback
- Terminal bookings (`confirmed`, `cancelled`, etc.) cannot be modified by guest path
- Old holds must not be selected because phone matches alone
- Active booking must match conversation context and latest intent

### 3x.10 ï¿½ Duplicate protection

Verify and document:

| Scenario | Expected |
|----------|----------|
| Same WhatsApp message id | No duplicate booking |
| Repeated payment-link request | No duplicate checkout session without idempotency |
| Same Stripe event id | No duplicate `payment_events` row |
| Confirmation | Cannot send twice (`confirmation_sent_at`, flags) |

### 3x.11 ï¿½ Client-config architecture plan

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

## Source-of-truth cutover ï¿½ Airtable ? Postgres

This is a **first-class roadmap event**, not a scattered implementation detail. Airtable is the current operational source of truth for staff. Postgres is the engineering source of truth for the bot. Cutover must happen deliberately.

### Cutover phases

| Phase | Description | Gate |
|-------|-------------|------|
| **Current** | Airtable = staff SoT; Postgres = bot SoT; dual-write in progress | Active |
| **Read-only compare** | Run both reads; log discrepancies; do not act on mismatch | Before any cutover |
| **`DATA_SOURCE` flag** | Config-driven: `airtable` \| `postgres` per path; allows per-path rollout | Stage 4 |
| **Soak period** | Postgres-primary writes; Airtable as backup read; monitor for divergence | Stage 4ï¿½5 |
| **Airtable dependency removal** | Only after staff UI or equivalent replacement exists | Stage 6+ |
| **Backup policy** | Full Airtable export + PG dump before each cutover step | Required |
| **Rollback plan** | Revert `DATA_SOURCE` flag; restore from backup; documented runbook | Required |

**Do not remove Airtable dependency** until:
1. Staff UI (Stage 6) or equivalent is live for all Airtable use cases it currently covers
2. PG data has passed a soak period without divergence
3. Backup and rollback procedure is documented and tested

---

## Privacy / GDPR gate before customer memory

**No Layer-2 structured customer memory with personal data until all of the following exist:**

| Requirement | Status |
|-------------|--------|
| Documented purpose for each stored personal field | Planned (3x.2) |
| Retention policy per field type | Planned (3x.2) |
| Staff-only note handling (no guest-facing access to staff notes) | Planned |
| Delete / export / correction procedure documented | Planned |
| Marketing opt-in separated from booking support data | Planned |
| Raw WhatsApp exports kept off-repo / in `data/private/` (gitignored) | **Done** (`84fa45f`) |
| Only reviewed/sanitized fixtures in repo | Policy established |

**This gate applies before 3x.3 customer extract is written to PG.** Planning (3x.2) may proceed; PG insert of personal data requires privacy gate first.

---

## Stage 4 ï¿½ Reliable

**Status (2026-05-30): CLOSE WITH DEFERRALS.** Autonomous Booking Dry-Run complete ï¿½ all 14 scenarios PASS (commit `6cd9a21`). Evidence: `test-payloads/stage4/autonomous-dry-run/README.md`. Live WhatsApp, live holds, live Stripe, and live confirmation writes remain deferred. Structured add-on records and staff ops assistant deferred to Stages 5ï¿½6.

### Purpose

Make the working system **dependable and observable** after Stage 3 behavior is proven and Stage 3x rules are specified.

### Entry gate (defined in baseline config + ï¿½3x.2b)

Gate definition: [`config/clients/wolfhouse-somo.baseline.json`](../config/clients/wolfhouse-somo.baseline.json) (`stage4_entry_gate`) and [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ï¿½3x.2b/ï¿½3x.2c](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x2c--applied-owner-answers-2026-05-29).

**Reduced after 3x.2c** (payment-link auto-send, hold expiry, confirmation content, conditional cancel/date-change, rooming auto-assign + operator-room logic all confirmed). **Remaining owner blockers:** deposit amount/scope ï¿½ non-7-night pricing math ï¿½ cancellation/refund windows & % ï¿½ add-on service prices/scheduling (if in Stage 4 scope) ï¿½ real WhatsApp send gate or Stage 3y shadow ï¿½ final handoff channel. **Not blockers:** perfect tone ï¿½ full customer memory ï¿½ marketing opt-in ï¿½ exact add-on automation.

**Additional entry requirement:** Autonomous booking dry-run pass ï¿½ bot completes full booking flow (inbound message ? route ? availability ? hold ? payment-link ? Stripe webhook ? confirmation) without errors in all-stubbed mode, proving readiness before real sends or live operation are enabled.

### Includes

- **Autonomous booking dry-run** (first Stage 4 milestone): full booking flow end-to-end ï¿½ inbound message ? route ? availability ? hold ? payment-link ? Stripe webhook ? confirmation ï¿½ with all live side effects stubbed at the infrastructure boundary. Proves the bot completes the booking correctly before real sends or live operation are enabled. This is the regression anchor: once green, enabling real WhatsApp send or live operation is a config change, not a behavior change.
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
- **Staff query assistant** (read-only ops Q&A: "who has a surfboard today?", "who arrives today?", "which rooms need cleaning and by when?") gated by an **approved-staff allowlist** (`staff_directory`; portal = Stage 6) ï¿½ [`STAFF-QUERY-ASSISTANT-PLAN.md`](STAFF-QUERY-ASSISTANT-PLAN.md)

### Add-on structured records (Stage 4 design requirement)

Add-on dry-run tests (e.g. A9 ï¿½ lessons, yoga, rentals) must do more than verify the guest-facing price quote is correct. They must also prove the system can **represent add-on requests as structured, staff-queryable records**. This is the data foundation that makes Stage 6 staff queries possible.

Each add-on request that passes through the bot should be representable as a record with at minimum:
- Guest / booking reference
- Add-on type (lesson, wetsuit, board, yoga, dinner)
- Quantity / number of days
- Requested date(s)
- Payment status (pending / paid)
- Fulfillment status (not redeemed / redeemed ï¿½ staff-managed)
- A flag indicating whether staff scheduling / manual tracking applies (e.g. lessons require a manual slot assignment)

**Stage 4 does not require full add-on automation.** It requires that when the bot processes an add-on request, the output can be persisted in a shape that is queryable by staff. If no structured add-on record is written yet, the design must identify where it would be written and what the schema looks like ï¿½ so Stage 5 does not have to invent it from scratch.

---

## Stage 5 ï¿½ Clean

**Status (2026-05-31): CLOSE WITH DEFERRALS ï¿½ source-of-truth cleanup complete (5.1ï¿½5.8b); engine extraction / portability scope deferred.** All staff-queryable data tables are schema-stubbed and query helpers are proven. Migrations 007 (add-ons) and 008 (staff handoffs) are ready to apply. Live operation, engine extraction, and staff UI remain deferred (Stage 6). Detail: [`PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md`](PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md).

### Purpose

Simplify implementation after behavior is proven and reliability checks exist.

### Safety-critical early extractions (pull forward to Stage 3.5 / 4 only if needed)

Do **not** do broad Stage 5 refactor before Stage 3 / 3.5 safety gates. However, pull forward **only** these safety-critical items when required:

- Wrong-booking guard (if not proven in Stage 3 negative tests)
- Dangerous-action gate checks (missing required business rule ? handoff)
- Duplicate / idempotency checks (if Stage 3.5 requires them in code)
- Bed-assignment overlap / dedup logic (if DB constraint is insufficient)
- `client_config` loading skeleton (if Stage 3x requires it for golden tests)

### Includes

- Move decision logic out of n8n into `src/booking-assistant/` (n8n becomes I/O only).
- **Extract along the portability seam** ([ï¿½ Engine portability](#engine-portability--adding-a-new-vertical-surf-shop--lessons)): shared spine vs `inventory/` + `catalog/` plugins ï¿½ do **not** produce a tidied-up surf-house monolith.
- Implement `InventoryProvider` with **lodging** as the first concrete provider; keep the interface generic enough for `slots` / `rentals`.
- Split `client_config` into **engine config** (spine) + **vertical config** (catalog / inventory / capabilities); rooming behind a capability flag.
- Replace serialized-into-n8n Code nodes (e.g. the resolver) with calls to the extracted, version-checked modules.

**Target:** n8n calls backend decision engine; Postgres writes go through shared SQL/modules; n8n performs WhatsApp/Stripe/Airtable I/O.

**Portability acceptance for Stage 5:** the Wolfhouse spine compiles and passes golden tests with **zero surf-house nouns** outside `inventory/lodging.*` and `client_config`. (Verify against the portability gate checklist.)

### Staff-queryable operational data (Stage 5 requirement)

Source-of-truth cleanup must explicitly produce the structured Postgres records that power Stage 6 staff queries. The data design goal is: **staff questions are answered from reliable structured records, not guessed from chat logs or Airtable exports.**

The following tables/models must be designed (and at minimum stubbed in schema) during Stage 5, before the Stage 6 staff assistant is built:

| Table / model | Answers the question |
|---|---|
| `add_on_orders` | Which guests have requested add-ons? What is the payment status per order? |
| `add_on_items` | Line-item detail per order (type, qty, days, dates, price) |
| `lesson_requests` | Who has lessons today / tomorrow? What slot? (staff assigns; bot records request) |
| `rental_requests` | Who requested a board / wetsuit? For how many days? Pickup status? |
| `yoga_requests` | Who paid for yoga? For which date? (redeemed on-site by staff) |
| `staff_handoffs` / `staff_tasks` | Which conversations need a human reply? Why was it handed off? Current state? |
| `payment_balances` (view or table) | Who still owes money? Who paid deposit but not full balance? |

These are **not new features** ï¿½ they are the structured forms of data the bot already collects. The goal of Stage 5 is to ensure that data lands in Postgres in a queryable shape instead of only in Airtable or serialized chat session state.

**Design gate for Stage 5:** before beginning Stage 6 staff UI work, verify that a staff member can ask each of the following questions and get a correct answer from Postgres without touching Airtable or reading raw WhatsApp messages:

- "Who paid for yoga today?"
- "Who has lessons tomorrow?"
- "Who still owes money?"
- "Who requested a board?"
- "Which bookings need a human reply?"
- "Show today's arrivals and departures."
- "Who paid deposit but not full balance?"
- "Which guests requested rooming preferences?"

---

## Stage 6 ï¿½ Beautiful (Staff / Admin Layer)

**Status: CLOSED WITH DEFERRALS** (2026-05-31) ï¿½ All exit criteria MET. 6.0ï¿½6.9 DONE: 35-intent registry, CLI runner, batch reports, CLI write action, HTTP API, browser UI, smoke test, token-gated write endpoint. Production auth/TLS/live-ops deferred to Stage 7. See [`PHASE-6-STAFF-ASSISTANT-PLAN.md`](PHASE-6-STAFF-ASSISTANT-PLAN.md).

**Implementation slices:** 6.1 registry DONE ? 6.2 CLI runner DONE ? 6.3 handoffs DONE ? 6.4a/b/c/d batch reports DONE ? 6.5a/b CLI write action DONE ? 6.6 HTTP API DONE ? 6.7 intent smoke DONE ? 6.8 read-only UI DONE ? 6.9 token-gated write endpoint DONE.

### Purpose

Excellent staff and owner experience. This is where the **two-sided product** becomes visible: the guest-facing assistant (already built) and the **staff-facing operations assistant** (built here).

### Two sides of the product

| Side | Who uses it | What it does |
|------|------------|--------------|
| **Guest assistant** | Guests on WhatsApp | Bookings, questions, payments, confirmations, add-ons, rooming, handoff |
| **Staff assistant / admin** | Ale, Cami, operators | Operational queries, action review/approval, conversation takeover, status dashboards |

### Staff Operations Assistant

Staff can ask operational questions and get answers from **structured Postgres records** (not chat logs or guesses). All queries are read-only, gated by `staff_directory` approved numbers.

**Example questions the staff assistant must answer:**

- "Who paid for yoga today?"
- "Who has lessons tomorrow?"
- "Who still owes money?"
- "Who requested a board?"
- "Which conversations need a human reply?"
- "Show today's arrivals and departures."
- "Who paid deposit but not full balance?"
- "Which guests requested rooming preferences?"

**Design constraint:** these questions are answered from the structured records built in Stage 5 (`lesson_requests`, `add_on_orders`, `staff_handoffs`, `payment_balances`, etc.). The assistant maps natural-language questions to fixed safe parameterized intents ï¿½ it never generates arbitrary SQL.

### Staff Approval Controls

Staff can review, approve, and act on bot proposals without going directly into n8n or Airtable:

- View bot draft reply before it is sent
- Approve or reject risky bot action proposals (payment, cancellation, room reassign)
- Take over a conversation from the bot
- View payment / hold / rooming / add-on status per booking
- Mark add-on as redeemed (voucher fulfilled on site)
- Release or block operator rooms

### Staff UI

- Calendar / bed grid, guest list, booking detail
- Payment status, pending holds, confirmation queue
- Conversation history, human takeover
- Manual booking / edit / cancel tools
- Room/bed assignment UI
- Alerts for stuck workflows
- Owner dashboard

Airtable may remain a **bridge** during transition; long-term goal is a proper staff UI, not Airtable as daily ops surface.

**Airtable cutover prerequisite:** the staff UI (or equivalent) must cover all use cases Airtable currently serves before Airtable is removed as a dependency ï¿½ see the Source-of-truth cutover table above.

---

## Stage 7 ï¿½ Scalable

**Status: IN PROGRESS** (2026-06-02) ï¿½ 7.0ï¿½7.7 DESIGN DONE ï¿½ **7.2b+7.2c+7.3b+7.3c+7.3d+7.3e+7.3f+7.7aï¿½d+7.7fï¿½7.7j+7.7k1ï¿½k8 DONE**. **8.0+8.1+8.2+8.5+8.6+8.3 plan+8.3a-8.3k+8.3x+8.3y DONE**. **8.4 RE-SCOPED — PLAN/GATE CHECKPOINT (2026-06-02)**: manual booking creation split into gated slices with a **pricing/payment engine as a hard prerequisite** (1 engine plan ? 2 quote calculator ? 3 quote preview ? 4 create-from-quote-snapshot+payment records ? 5 Stripe payment-link/invoice ? 6 Stripe webhook truth ? 7 UI enablement). A provisional `POST /staff/manual-bookings/create` stub exists DISABLED-by-default (`MANUAL_BOOKING_ENABLED=false` ? 403) and UNWIRED from the UI; Create button stays disabled; no Stripe/invoice/payment-link/WhatsApp/n8n. Verifiers: `verify-staff-manual-booking-create-api` 41/41, `verify-staff-bed-calendar-ui` 167/167, `verify-staff-manual-booking-preview-api` PASS. Doc: [`STAGE-8.4-MANUAL-BOOKING-CREATION.md`](STAGE-8.4-MANUAL-BOOKING-CREATION.md). `STAFF_ACTIONS_ENABLED=false`; `MANUAL_BOOKING_ENABLED=false`. **8.3k ROLLBACK PROOF DONE (2026-06-02)**: staff-manual-booking-rollback-sql.js; 10 blockers; CASCADE delete; 52/52 static PASS; 59/59 runtime PASS; delta=0. All blockers proven (confirm, role, code/id mismatch, unsafe_payment, booking_not_found). No API. No UI. No Azure. STAFF_ACTIONS_ENABLED=false. **8.3l PREVIEW UI WIRED (2026-06-02)**: Preview Conflicts button enabled on cell selection; bc-preview-result panel; valid/blocked/warning/error states; POST only to /staff/manual-bookings/preview (preview_only=true, creates_booking=false, no_write_performed=true); Create Manual Booking stays disabled; 122/122 verify-staff-bed-calendar-ui PASS; bd.capacity schema bug fixed in preview query; Azure proof pending. **8.3q TOUR OPERATOR SKELETON (2026-06-02)**: bc-op-panel; operator/stay/defaults/notes; Source=Operator, Payment=Not requested, Booking=Operator Blocked; Stripe+n8n disabled; prefills from cell selection; Create+Preview buttons disabled; 142/142 verifier PASS. No API. No DB writes. No Azure. **8.3v AZURE DEPLOY (8.3u) (2026-06-02)**: image wh-staff-api:ea2437d-8x3v-ui-corrections; revision --0000013 (100% traffic, Healthy); /staff/login 200; STAGING+SHADOW MODE+STAFF ACTIONS DISABLED badges; Write actions DISABLED; Tour Operator tab+panels confirmed in source; demo chip absent; td.dataset.date fix present; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; n8n untouched; no DB writes. **8.3r OPERATOR ROOM RELEASE SKELETON (2026-06-02)**: bc-rr-panel; release-dates/release-scope/defaults/notes; release type (selected_beds/whole_room/selected_dates); Guest messaging+Stripe+n8n disabled; prefills from cell selection; Release Dates+Preview Release disabled; 162/162 verifier PASS. No API. No DB writes. No Azure. **8.3v AZURE DEPLOY (8.3u) (2026-06-02)**: image wh-staff-api:ea2437d-8x3v-ui-corrections; revision --0000013 (100% traffic, Healthy); /staff/login 200; STAGING+SHADOW MODE+STAFF ACTIONS DISABLED badges; Write actions DISABLED; Tour Operator tab+panels confirmed in source; demo chip absent; td.dataset.date fix present; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; n8n untouched; no DB writes. **8.3s BATCH AZURE DEPLOY (2026-06-02)**: image wh-staff-api:1894036-8x3s-batch; revision --0000012 (100% traffic, Healthy); /staff/login 200; auth-guard active; STAGING badge + STAFF ACTIONS DISABLED badge visible; Write actions DISABLED in logs; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; MANUAL_BOOKING_ENABLED=false; n8n untouched; no DB writes; no operator blocks; no room releases. **8.3j SCHEMA-ALIGNMENT FIX (2026-06-02)**: Fixed 3 schema mismatches + 2 enum casts in `buildManualBookingCreateSql()`. P1: `language` removed from bookings INSERT ? stored in `metadata` JSONB. P2: `inserted_payment` uses `status`/`payment_kind`/`amount_due_cents`/`currency` (no `provider`/`amount_cents`/`payment_status`). P3: `audit_written` uses `workflow_name`+`message` (no `event_type`). Also: `$16::booking_status`, `$17::payment_status` enum casts; `$5::text IS NOT NULL`. `verify-staff-manual-booking-create-sql.js` **47/47 PASS** (7 new schema checks). Fixture proof (`stage8.3i-manual-booking-create-proof.js`) updated ï¿½ no patching: **65/65 PASS**, delta=0. Helper is now production-schema-compatible. No API route. No UI. No Azure. `STAFF_ACTIONS_ENABLED=false`. `MANUAL_BOOKING_ENABLED=false`. **8.3y NEEDS HUMAN + DETAIL CLEANUP + AZURE DEPLOY (2026-06-02)**: Needs Human tab converted to same two-column conv-card layout as Inbox (filtered to `needs_human`/open handoff); `loadConvDetail(convId, targetEl)` refactored to support both panels; `handoffLabel()` reused in `renderHandoffQueue()`; Booking sidebar above Bot state; `Pending`/`Last reply` removed from Bot state; check-in/check-out combined as `Stay` row with `fmtDateOnly()`; "Messages" h3 removed from thread section; `.hq-table`/`hq-tbody` removed. `verify-staff-conversation-ui.js` **77/77 PASS**. No API changes. No DB writes. `STAFF_ACTIONS_ENABLED=false`. Azure deploy pending. **8.3x INBOX WHATSAPP-STYLE LAYOUT (2026-06-02)**: Inbox two-column, `handoffLabel()`, "Message thread" count removed, raw stage removed, "Back to inbox" removed. 66/66 PASS. Azure image `4e02763-8x3x-inbox` deployed. `staff-query-api.js` ï¿½ Inbox converted to persistent two-column layout (left = conv-card list; right = detail panel, always visible, empty-state default); `handoffLabel(code)` maps 11 raw codes to friendly labels (`date_change_requested`?"Date change request", etc.); `renderInbox()` uses `.conv-card` divs (guest name, phone, priority pill, handoff label); "Message thread ï¿½ N messages" title removed; raw "Stage:" removed from detail header; "Back to inbox" removed; `inbox-table`/`inbox-tbody` removed. `verify-staff-conversation-ui.js` 66/66 PASS. No API changes. No DB writes. `STAFF_ACTIONS_ENABLED=false`. **Azure DONE (2026-06-02): image `4e02763-8x3x-inbox` (build cb9) deployed, revision `wh-staging-staff-api--0000010` Healthy. Container exec proof: `inbox-two-col`=3, `conv-card`=15, `handoffLabel`=3 FOUND; `inbox-tbody`=0, "Back to inbox"=0 ABSENT. Login 200. Safety flags: `STAFF_ACTIONS_ENABLED=false`, `WHATSAPP_DRY_RUN=true`, `STAFF_AUTH_REQUIRED=true`. n8n untouched. Manual login UI proof pending Ty creds.** **8.3i MANUAL BOOKING FIXTURE WRITE PROOF (2026-06-02)**: `scripts/fixtures/stage8.3i-manual-booking-create-proof.js` ï¿½ proves `buildManualBookingCreateSql()` CTE logic; 9 cases (happy-path, idempotency, overlap conflict, touching boundary, invalid payment, confirm=false, role insufficient, invalid dates, client not found); all BEGIN/ROLLBACK; final delta=0; 3 schema mismatches documented+patched (P1 `language` col; P2 payment INSERT cols; P3 `event_type`?`workflow_name`+`message`); graceful SKIP when DB offline; `node --check` PASS; `proof:stage8.3i-manual-booking-create` in `package.json`. No API route. No UI. No Azure. `STAFF_ACTIONS_ENABLED=false`. `MANUAL_BOOKING_ENABLED=false`. **8.3h MANUAL BOOKING PREVIEW ENDPOINT (2026-06-02)**: `POST /staff/manual-bookings/preview` ï¿½ auth-gated (operator+), SELECT-only queries, calls `previewManualBookingAvailability()`, returns preview_only/creates_booking/no_write_performed safety fields + full availability output, file-only audit, does NOT require STAFF_ACTIONS_ENABLED. `scripts/lib/staff-manual-booking-preview-queries.js`: SELECT-only SQL builders (beds, assignments, client). `verify-staff-manual-booking-preview-api.js` 48/48 PASS. Proof fixture 31/31 PASS. No DB writes. No booking creation. `STAFF_ACTIONS_ENABLED=false`. **8.3g MANUAL BOOKING AVAILABILITY PREVIEW HELPER (2026-06-02)**: `scripts/lib/staff-manual-booking-availability.js` ï¿½ pure JS; `previewManualBookingAvailability()`; half-open overlap (existing_start < proposed_check_out AND existing_end > proposed_check_in); cancelled/expired exclusion; 7 blockers; 5 warnings (same_day, next_day, long_stay, protected_room, operator_room); structured output with is_valid/has_conflict/blockers/warnings/availability_by_bed/summary. `verify-staff-manual-booking-availability.js` 52/52 PASS. No DB. No API. No writes. `STAFF_ACTIONS_ENABLED=false`. **8.3f MANUAL BOOKING SQL STATIC PROOF (2026-06-02)**: `scripts/lib/staff-manual-booking-create-sql.js` ï¿½ 15-CTE chain, 14 blockers (`MANUAL_BOOKING_BLOCK_CODES`), half-open overlap + defense-in-depth, idempotency via `metadata` JSONB, audit_payload + rollback_payload, `confirmation_sent_at=NULL`. `verify-staff-manual-booking-create-sql.js` 40/40 PASS. NOT wired. No API route. No DB execution. `STAFF_ACTIONS_ENABLED=false`. Manual booking writes NOT implemented. **8.3e MANUAL BOOKING WRITE GATE PLAN (2026-06-02, docs-only)**: `docs/STAGE-8.3E-MANUAL-BOOKING-WRITE-GATE-PLAN.md` ï¿½ hard blockers, warning/second-confirm cases, audit/rollback/idempotency requirements, revised contiguous numbering (manual booking 8.3eï¿½8.3o; move/cancel/operator 8.3pï¿½8.3w), staging gates, sign-off table. Pilot NO_GO; writes NOT implemented. **8.3d MANUAL BOOKING PREVIEW (2026-06-02)**: full form skeleton (Selected Stay pre-filled, Guest, Payment w/ deposit, Notes, Avail placeholder, Safety notice, disabled Create+Conflicts), 105 verifier checks PASS. No writes. **8.3a BED CALENDAR READ-ONLY CLEANUP (2026-06-02)**: date `type="date"` inputs, 5 shortcut chips (Today/Week/30d/Julï¿½Aug/Demo), always-visible 7-status color legend, inline A/D markers moved to tooltip, operator+manual block colors, cleaner room/bed labels (code primary, label subtitle), taller 28px blocks, free-bed count in summary strip, `bcSetRange()` helper; 56 verifier checks PASS; all other verifiers PASS; local proof PASS; Azure proof pending. **8.3q TOUR OPERATOR SKELETON (2026-06-02)**: bc-op-panel; operator/stay/defaults/notes; Source=Operator, Payment=Not requested, Booking=Operator Blocked; Stripe+n8n disabled; prefills from cell selection; Create+Preview buttons disabled; 142/142 verifier PASS. No API. No DB writes. No Azure. **8.3v AZURE DEPLOY (8.3u) (2026-06-02)**: image wh-staff-api:ea2437d-8x3v-ui-corrections; revision --0000013 (100% traffic, Healthy); /staff/login 200; STAGING+SHADOW MODE+STAFF ACTIONS DISABLED badges; Write actions DISABLED; Tour Operator tab+panels confirmed in source; demo chip absent; td.dataset.date fix present; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; n8n untouched; no DB writes. **8.3r OPERATOR ROOM RELEASE SKELETON (2026-06-02)**: bc-rr-panel; release-dates/release-scope/defaults/notes; release type (selected_beds/whole_room/selected_dates); Guest messaging+Stripe+n8n disabled; prefills from cell selection; Release Dates+Preview Release disabled; 162/162 verifier PASS. No API. No DB writes. No Azure. **8.3v AZURE DEPLOY (8.3u) (2026-06-02)**: image wh-staff-api:ea2437d-8x3v-ui-corrections; revision --0000013 (100% traffic, Healthy); /staff/login 200; STAGING+SHADOW MODE+STAFF ACTIONS DISABLED badges; Write actions DISABLED; Tour Operator tab+panels confirmed in source; demo chip absent; td.dataset.date fix present; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; n8n untouched; no DB writes. **8.3u OPERATIONS UI CORRECTION (2026-06-02)**: Tour Operator tab added; bc-op-panel+bc-rr-panel moved from Bed Calendar to tour-operator tab; forms use date dropdowns; bcHandleCellClick td.dataset bug fixed; Demo Range chip removed; booking drawer: code-only title, Room/Beds merged into Stay; 164/164 verifier PASS. No API. No DB writes. No Azure. **8.3v AZURE DEPLOY (8.3u) (2026-06-02)**: image wh-staff-api:ea2437d-8x3v-ui-corrections; revision --0000013 (100% traffic, Healthy); /staff/login 200; STAGING+SHADOW MODE+STAFF ACTIONS DISABLED badges; Write actions DISABLED; Tour Operator tab+panels confirmed in source; demo chip absent; td.dataset.date fix present; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; n8n untouched; no DB writes. **8.3s BATCH AZURE DEPLOY (2026-06-02)**: image wh-staff-api:1894036-8x3s-batch; revision --0000012 (100% traffic, Healthy); /staff/login 200; auth-guard active; STAGING badge + STAFF ACTIONS DISABLED badge visible; Write actions DISABLED in logs; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; MANUAL_BOOKING_ENABLED=false; n8n untouched; no DB writes; no operator blocks; no room releases. **8.3 STAFF PORTAL BED CALENDAR OPERATIONS PLAN (2026-06-02)**: [`STAGE-8.3-STAFF-PORTAL-BED-CALENDAR-OPERATIONS-PLAN.md`](STAGE-8.3-STAFF-PORTAL-BED-CALENDAR-OPERATIONS-PLAN.md) ï¿½ bed calendar becomes the operations workspace; product language "Staff Portal" (not "Cami dashboard"); sub-slices 8.3aï¿½8.3o (read-only cleanup, drawer cleanup, cell selection, manual booking ladder, move preview, cancel/date-change design, tour operator booking, operator room release, dashboard extras); read-only 8.3a/8.3b = only demo prerequisites; all writes future + gated; backend bases exist (manual-entry, reassignment 7.7k1ï¿½k8, operator-room-release split). Pilot NO_GO. **8.6 DEMO DATA SEEDED (2026-06-02)**: 18 rows across 3 convs/7 msgs/3 bookings/2 booking_beds/1 handoff/2 payments + 2 demo rooms + 4 demo beds; proof 28/28 PASS; `STAFF_ACTIONS_ENABLED=false`, `WHATSAPP_DRY_RUN=true` confirmed; demo data intentionally retained for Ale/Cami walkthrough. **7.3f CUSTOM DOMAIN + TLS DONE (2026-06-02)**: `staff-staging.lunafrontdesk.com` bound to Azure Container App with Azure managed cert (`SniEnabled`); all smoke tests PASS on clean HTTPS URL. **7.3e LOGIN PAGE + LOGOUT FIX + COMPANY WORDING (2026-06-02)**: `GET /staff/login` serves Luna Front Desk branded form; `browserLoginRedirect()` for `/staff/ui`; logout fixed (`window.doLogout`); "Client" ? "Company" UI labels; deployed to Azure (revision 0000003). **7.3d AZURE STAGING DEPLOYED + LOGIN PROVEN (2026-06-01)**: Staff API + n8n live over Azure HTTPS; Ty owner login confirmed; `/staff/intents` total=35; 11 workflows imported `active=false`; safety flags confirmed. Calendar editing NOT wired. **7.7m DONE (design only)**: manual booking creation plan. **Stage 8 PLANNING STARTED (2026-06-02)**: [`STAGE-8-CLIENT-READY-STAGING-ROADMAP.md`](STAGE-8-CLIENT-READY-STAGING-ROADMAP.md) ï¿½ make Luna Front Desk show-ready for Ale/Cami as a polished shadow-mode staging demo while keeping all live gates closed; 8 pillars, slices 8.0ï¿½8.13, 14-item ready-to-show checklist; **8.0 roadmap + 8.1 UX cleanup plan DONE** (default landing "Today / Needs Attention"; sidebar nav; Query Tools ? admin/dev-only; Luna design tokens ï¿½ [`STAGE-8.1-DASHBOARD-UX-CLEANUP-PLAN.md`](STAGE-8.1-DASHBOARD-UX-CLEANUP-PLAN.md)). Pilot decision remains NO_GO. Next: Stage 8.2 (dashboard visual polish implementation).?# Wolfhouse Booking Assistant ï¿½ Product Roadmap

**Product:** AI booking operations for WhatsApp-first experience businesses ï¿½ **beachhead:** Wolfhouse (surf house / surf camp). Simpler label: *AI front desk for WhatsApp-heavy experience operators.*

**Product-level roadmap (15 pillars):** [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md) ï¿½ **Engineering snapshot:** [`PROJECT-STATE.md`](PROJECT-STATE.md) ï¿½ **Architecture:** [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) ï¿½ **Stripe isolated gates:** [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

> **This file is the stage-level / engineering roadmap.** For the **product-level view** ï¿½ the full 15-pillar product vision (Guest Assistant, SoT DB, Staff Brain, Dashboard, Rooming UI, Add-ons, Messaging Bridge, Multi-Client Config, Onboarding, PMS, AI Intent, Analytics, Production Hardening, Multi-Client Admin, Productization) mapped to these stages ï¿½ see [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md).

---

## Evolution order (do not skip)

```text
1. Correct and safe      ? Stage 3  (engineering gates + exit criteria)
   Safety rails          ? Stage 3.5 (seatbelts before live/shadow mode)
   Knowledge + guardrails ? Stage 3x (specs, client config, golden tests)
   Shadow / co-pilot     ? Stage 3y (staff-approved replies, real guest data)
2. Reliable              ? Stage 4
3. Clean                 ? Stage 5
4. Beautiful             ? Stage 6  (Staff / Admin Layer + Staff Operations Assistant)
5. Scalable              ? Stage 7
```

Stage 3 is **not** about making the bot beautiful or fully productized. It is about proving the bot does **not** make dangerous mistakes.

**Stage 3.5 is not full Stage 4 observability.** It is the minimum seatbelts required before serious runtime or live/shadow operation ï¿½ error capture, idempotency checks, overlap guards, basic execution logging.

**Stage 3y (Shadow/Co-pilot)** bridges dry-run proof and autonomous live operation. The bot reads real messages and drafts responses; staff approve and send manually. No autonomous payment/confirmation/cancellation/rooming without explicit staff approval. This reduces the dry-run ? real-guest cliff and generates real golden-message data.

---

## Architecture direction (long-term)

**Do not keep expanding n8n with more and more business logic forever.**

| Layer | Role |
|-------|------|
| **n8n** | Orchestrates ï¿½ webhooks, WhatsApp, Stripe callbacks, notifications, simple integration steps |
| **Backend / code** | Decides ï¿½ routing, required fields, package logic, safety guards, handoff rules |
| **Postgres** | Remembers ï¿½ bookings, payments, conversations, beds, audit trail |
| **Client config** | Controls ï¿½ packages, pricing, room rules, policies per property (Wolfhouse = client #1) |
| **Staff UI + Staff Assistant** | Manages ï¿½ holds, payments, assignments, takeover; answers operational queries; approves risky bot actions (Stage 6+) |

The current **n8n-heavy** implementation is acceptable for **proving behavior** in Stage 3. Future stages migrate decision logic into code/config modules; n8n calls the decision engine instead of owning the business brain.

**Target module layout (Stage 5):**

```text
src/booking-assistant/
  # --- shared spine (client- AND vertical-agnostic; never rebuilt per vertical) ---
  routeMessage.ts
  extractBookingDetails.ts
  requiredFields.ts
  safetyGuards.ts
  handoffRules.ts
  duplicateProtection.ts
  bookingContext.ts
  clientConfig.ts
  payments.ts              # Stripe link + webhook truth + confirmation (vertical-agnostic)
  # --- vertical plugin seam (the ONLY part that differs per business type) ---
  inventory/
    InventoryProvider.ts   # interface: findAvailability / hold / fulfill
    lodging.ts             # beds-in-rooms + rooming (Wolfhouse / hostels)
    slots.ts               # lesson/tour time-slot capacity (surf/kite schools, tours)
    rentals.ts             # item ï¿½ time-window ï¿½ quantity ï¿½ size (surf/bike/SUP shops)
  catalog/
    offerings.ts           # generic priced offering (packages | lessons | rental SKUs | departures)
    packageDecision.ts     # explain / recommend / quote ï¿½ driven by config, not hardcoded names
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

**Spine vs plugin (portability principle):** everything above the `inventory/` and `catalog/` folders is the **shared spine** and must contain **no surf-house-specific nouns** (no `bed`, `room`, `malibu`, `surfweek`). Anything vertical-specific lives behind the `InventoryProvider` interface or in `client_config`. A new vertical = new config + (at most) one new inventory provider ï¿½ see [ï¿½ Engine portability](#engine-portability--adding-a-new-vertical-surf-shop--lessons).

---

## Client category / market positioning

### Product category

**Primary:** AI booking operations for WhatsApp-first experience businesses.

**Simpler language:** AI front desk for WhatsApp-heavy experience operators.

This is **not** framed as a generic chatbot. It is an operations layer that handles guest questions, package/rental/lesson explanation, availability and detail collection, payment links, payment truth, confirmations, customer memory, staff handoff, and operational status.

### Beachhead

**Wolfhouse** ï¿½ surf houses / surf camps (client #1, `wolfhouse-somo`).

Hard first use case: combines accommodation, packages, rooming, payments, confirmations, WhatsApp, and staff operations in one property.

### Adjacent categories (same core pattern)

Guests ask on WhatsApp ? business explains options ? checks availability ? collects details ? sends payment/deposit link ? confirms ? staff handle changes and handoffs.

| Adjacent vertical | Typical scope (often simpler than surf house) |
|------------------|-----------------------------------------------|
| Surf schools | Lessons, levels, schedules |
| Surf shops | Rentals, retail-adjacent booking |
| Kite schools ï¿½ dive shops | Lessons, certifications, slots |
| Yoga retreats ï¿½ small retreat operators | Packages, dates, capacity |
| Hostels with activities | Beds + activity add-ons |
| Tour operators | Departures, group size, deposits |
| Rental businesses | Lessons, rentals, inventory, time slots, sizes ï¿½ surf shop / bike / e-bike / kayak / SUP / campervan patterns |

A **surf shop or lesson-rental** operator is likely a simpler config profile than Wolfhouse: fewer rooming rules, more slot/inventory semantics, still the same payment + confirmation + handoff spine.

### Competitive note

AI/WhatsApp tools already exist for hotels, hospitality, and tour operators. The opportunity is a **focused, configurable, operations-heavy** assistant for **small experience businesses** that live in WhatsApp and run **messy** packages, rentals, lessons, and deposits ï¿½ not clean hotel-only PMS flows.

### Roadmap implication

| Build now | Defer |
|-----------|--------|
| Wolfhouse as client #1 with full safety proofs | Multi-client SaaS platform |
| `client_config` specs that generalize | Client onboarding UI, billing, settings editor |
| Engine shaped for lessons/rentals/rooming via config | Hardcoding ï¿½surf house onlyï¿½ in shared workflows |

**Config dimensions per client** (see ï¿½3x.11 in [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)): packages ï¿½ lesson types ï¿½ rental inventory ï¿½ rooming rules (if applicable) ï¿½ pricing ï¿½ deposit rules ï¿½ cancellation policy ï¿½ handoff rules ï¿½ staff notifications ï¿½ customer memory policy.

---

## Engine portability ï¿½ adding a new vertical (surf shop / lessons)

**Goal:** when Wolfhouse is done, standing up a second vertical (surf-shop **rentals**, surf/kite-school **lessons**, tour **departures**) is a **config + inventory-plugin** exercise ï¿½ **not** a rewrite. This section defines the seam so that promise is real instead of aspirational.

### What is SHARED ï¿½ built once, reused by every vertical

| Shared spine capability | Where |
|-------------------------|-------|
| WhatsApp inbound/outbound I/O | n8n orchestration |
| Message routing / intent (`routeMessage`) | spine |
| Required-field gating per action (`requiredFields`) | spine + `client_config` |
| Payment link ? **Stripe webhook truth** ? confirmation (`payments`) | spine (proven 3d.x) |
| Handoff triggers (`handoffRules`) | spine + `client_config.handoff` |
| LLM safety (low-confidence ? handoff; never act on LLM alone) | spine + `client_config.llm_safety` |
| Duplicate / idempotency protection | spine (Stage 3.5) |
| Conversation / session state, customer memory + privacy | spine + Postgres |
| Error capture, golden-message runner | Stage 3.5 / 4 |

These **must not** be reimplemented per client. If a "new vertical" task touches these, the seam has leaked.

### What is VERTICAL-SPECIFIC ï¿½ plugged in, never forked

| Vertical concern | How it varies | Mechanism |
|------------------|---------------|-----------|
| The bookable resource + availability | bed-nights vs lesson slots vs rental items vs departure seats | `InventoryProvider` implementation |
| Catalog of offerings | packages vs lesson types vs rental SKUs vs departures | `catalog/offerings` + `client_config` |
| Fulfillment / assignment | rooming is **lodging-only**; most verticals skip it | capability flag, not core path |
| Required fields per booking type | dorm gender vs board size vs surf level | `client_config.required_fields` |
| Vocabulary / tone | surf-house terms vs shop terms | `client_config.language_tone` |

### The one abstraction that unlocks all of it: `InventoryProvider`

All verticals reduce to the same three-call contract ï¿½ `findAvailability(request)` ? `hold(unit, window)` ? `fulfill(booking)`:

| Vertical | Unit | Availability dimension | Special attribute | Rooming? |
|----------|------|------------------------|-------------------|----------|
| Surf house / hostel | bed | date-range overlap | gender / couple | **yes** (`lodging`) |
| Surf / kite / dive school | lesson slot | time + slot capacity | skill level | no (`slots`) |
| Surf / bike / SUP shop | rental item | time-window ï¿½ quantity | size / fit | no (`rentals`) |
| Tour operator | departure seat | departure-date capacity | group size | no (`slots`) |

The spine calls the interface and never knows which provider it is.

### Portability gate ï¿½ a vertical is "config-only ready" when:

- [ ] No surf-house nouns (`bed`, `room`, `matrimonial`, `surfweek`, `malibu`/`uluwatu`/`waimea`) appear in the shared spine ï¿½ only in `client_config` / providers.
- [ ] Rooming/assignment is behind a **capability flag**, not assumed.
- [ ] Catalog is generic `offerings`, not a hardcoded package enum.
- [ ] Inventory/availability is behind `InventoryProvider`; lodging is just one impl.
- [ ] `client_config` is split into **engine config** (spine) + **vertical config** (catalog/inventory/capabilities).
- [ ] Golden-message suite is parameterized by `client_id` (Wolfhouse fixtures don't hardcode the engine's behavior).

### Cheapest validation ï¿½ do this on paper during Stage 3x.3 (safe, docs-only)

Before any Stage 5 extraction, draft **sample configs for a second and third vertical** and run them against the schema to surface every leak:

- `config/clients/surf-shop-rental.sample.json` (rentals: items, sizes, time windows, deposits)
- `config/clients/surf-school.sample.json` (lessons: levels, slots, instructors)

Each gap found ("this field has no home," "this rule assumes beds") becomes a line item in the **Stage 5 extraction backlog**. If both samples fit the schema with only a new `InventoryProvider`, the backbone is portable; if not, you've found the surf-house assumptions cheaply, on paper, before writing engine code.

### Stage placement

| Work | Stage | Safe before runtime? |
|------|-------|----------------------|
| Spine/plugin seam **design** + sample vertical configs (paper test) | now / **3x.3** | yes (docs/config only) |
| Split `client_config` into engine vs vertical schema | 3x.3 ? Stage 5 | yes (config) |
| Extract spine modules; implement `InventoryProvider` (lodging first) | **Stage 5** | build stage |
| Second `InventoryProvider` (`slots` / `rentals`) + 2nd client live | **Stage 7** | scale stage |

**Do not** build multi-vertical infra early. **Do** lock the seam now so Stage 5 cleanup produces portable modules instead of a tidied-up surf-house monolith.

### Deploy config (the onboarding contract)

Every client-specific value (prices, seasons, gate code, phone numbers, packages, room map, policies) lives in **one per-client deploy config** + a gitignored secret file ï¿½ never hardcoded in code/workflows. A new client = fill the template, not rewrite logic. Template: [`config/clients/_deploy-config.template.json`](../config/clients/_deploy-config.template.json) ï¿½ Guide: [`DEPLOYMENT-CONFIG.md`](DEPLOYMENT-CONFIG.md). Wolfhouse's `wolfhouse-somo.baseline.json` is the worked example (`vertical: lodging_surf_house`).

---

## Legacy phase map (reference)

Older docs use **Phase 0ï¿½3d** for engineering milestones. They map to stages as follows:

| Legacy | Stage |
|--------|--------|
| Phase 0ï¿½2 local (frozen) | Foundation + Stripe/Main/Send Confirmation contracts |
| Phase 3b (frozen) | Stage 3 ï¿½ bed-ops / manual / operator paths |
| Phase 3cï¿½3g | Stage 3 ï¿½ Main + Postgres + stub E2E |
| Phase 3d.x | Stage 3 ï¿½ isolated real Stripe payment / webhook / confirmation gates |
| Phase 3e | Stage 3 ï¿½ rooming/reassign E2E ? |
| Stage 3.5 | Safety rails ï¿½ idempotency, error capture, overlap guards |
| Stage 3x | Bot knowledge + safety guardrails (specs, not n8n sprawl) |
| Stage 3y | Shadow / co-pilot ï¿½ staff-approved mode before autonomous |
| Azure / multi-client | Stage 7 (Scalable), not before Reliability + Clean |

---

## Stage 3 ï¿½ Correct and safe

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
| Wrong room assignment | Bed-ops forks; **hosted reassign URL** in Main fork (`3e.2` remap) ï¿½ see [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) |
| Duplicate payment / session / event | Idempotency checks; single webhook per event id |
| Accidental live Stripe / WhatsApp | Test keys; `WHATSAPP_DRY_RUN`; activation boundaries |
| Background workflow firing | Inactive workflows + schedule `disabled` in test windows |

### Complete or in progress (engineering)

| Area | Status | Notes |
|------|--------|--------|
| `booking_flow` hold creation | **Proven** | PG hold + Airtable backfill in Main fork (3c.e) |
| `payment_details_provided` route | **Proven** | Resolver + Ensure (3c.g stub E2E) |
| Real Stripe checkout link (Main-integrated) | **Proven** | 3d.7b ï¿½ `WH-260528-5369`, stop at checkout URL |
| Isolated Create Payment Session | **Proven** | 3d.4 |
| Stripe Webhook Handler payment truth | **Proven** (isolated) | 3d.5b on `WH-260528-1493` |
| Send Confirmation (dry-run) | **Proven** (isolated) | 3d.6e |
| Pay + webhook on Main-created session | **Proven** | 3d.8b organic Stripe on `WH-260528-5369` |
| Integrated Send Confirmation (dry-run) | **Proven** | 3d.9b exec **1077** on same booking |
| Rooming / reassign E2E | **Proven** | **3e.4 PASS** ï¿½ `WH-260528-5322`, beds R3-B1/R3-B2 |

**Not proven in Stage 3:** real WhatsApp send; Send Confirmation schedule-poll; single-window E2E; full package intelligence.

**Freeze:** [`PHASE-3c-3d-FREEZE.md`](PHASE-3c-3d-FREEZE.md) ï¿½ formal 3c+3d checkpoint before Phase 3e.3+.

**Detail:** [`PROJECT-STATE.md`](PROJECT-STATE.md) ï¿½ [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

### Stage 3 exit criteria

Stage 3 is **complete only when all of the following are met** (or explicitly deferred with documented safe fallback):

**Core behavior proven:**
- [ ] `booking_flow` hold creation (PG + Airtable backfill) ?
- [ ] `payment_details_provided` route + Ensure ?
- [ ] Real Stripe checkout link (Main-integrated) ?
- [ ] Isolated Create Payment Session ?
- [ ] Stripe Webhook Handler payment truth ?
- [ ] Send Confirmation (dry-run) ?
- [ ] Integrated pay + webhook + confirmation ?
- [ ] Rooming / reassign E2E ?

**Safety invariants proven:**
- [ ] No Main direct writes to `payments` / `payment_events` ? (static proof)
- [ ] No payment/confirmation path writes `booking_beds` ? (static proof)
- [ ] Hosted/prod URLs removed from all local test paths ? (3e.2)
- [ ] Terminal evidence bookings not reused without reset (policy established)

**Guards verified or explicitly deferred:**
- [x] Wrong-booking guard tested for dangerous actions (rooming, payment, cancel) ï¿½ **3e.5 CLOSED** (L1+L2 PASS; L3 deferred ï¿½ Airtable-coupled runtime deferred to Postgres source-of-truth cutover; see ï¿½15.6ï¿½ï¿½15.7)
- [x] Duplicate / idempotency protections verified at Stage 3 bar ï¿½ **3e.6 CLOSED** (I1 schema PASS ï¿½ I4 runtime PASS ï¿½ I6 invariant PASS; I2/I3/I5 deferred: I2 ? manual-pay gate ï¿½ I3 ? Stage 3.5 ï¿½ I5 ? Postgres cutover)
- [ ] All dangerous actions have handoff / fail-safe behavior when required business rule is missing ï¿½ *3x.7ï¿½3x.8 spec done; implementation pending*

**Acceptable deferrals (do not block Stage 3 exit if documented):**
- Real WhatsApp send ï¿½ dry-run mode (`WHATSAPP_DRY_RUN=true`) is sufficient; shadow mode (Stage 3y) covers real send
- Send Confirmation schedule-poll ï¿½ schedule `disabled=true` gate is sufficient for Stage 3; verify in Stage 3y
- Single-window integrated E2E ï¿½ isolated gate chains are sufficient for Stage 3

**Acceptance metric gates:**
- 0 double bookings in all runtime test gates
- 0 wrong-booking dangerous actions in test gates
- 0 payment truth updates outside Stripe Webhook Handler
- 0 confirmations without payment truth
- 0 real WhatsApp sends in dry-run test gates
- 100% dangerous-action routes have handoff/fail-safe when required business logic is missing

---

## Stage 3.5 ï¿½ Safety Rails Before Reliability

**Purpose:** Pull forward the minimum safety plumbing required to safely run more runtime gates and prepare for live/shadow mode. This is not full Stage 4 observability ï¿½ it is seatbelts.

**When to do Stage 3.5:** After Stage 3 exit criteria are met, before Stage 3y (shadow/co-pilot) or live guest operation.

### Minimum safety requirements (Stage 3.5)

| Item | Why |
|------|-----|
| `automation_errors` capture/write path | Know when bot fails silently |
| Standard workflow error handler pattern | Consistent safe fallback across all n8n workflows |
| Idempotency: inbound WhatsApp message id | No duplicate booking from retry/double-delivery |
| Idempotency: Stripe event id | No duplicate `payment_events` row |
| Idempotency: payment-link reuse | No duplicate checkout session without explicit guard |
| Idempotency: Send Confirmation | Cannot confirm twice (`confirmation_sent_at` + flag) |
| Idempotency: rooming/reassign | Cannot double-assign or double-delete beds |
| Double-booking guard / DB overlap check | `booking_beds` overlap detection query; reject or alert before insert |
| Stuck booking detection (basic) | Bookings in `payment_pending` > N hours with no event; holds expired but not released |
| Workflow active-state safety check | Automated assertion: only expected workflows active before dangerous test or runtime |
| Schedule disabled/enabled safety check | Send Confirmation schedule `disabled=true` verified before any payment/confirmation test |
| Minimum execution logging | For each execution: `resolved_route`, confidence, selected booking id, dangerous action taken (or no-op reason) |
| Golden-runner stub | Even a fixture-file runner (`test:golden-messages`) blocks regression in CI before Stage 4 |

**Stage 3.5 does not include:** full monitoring dashboards, Azure deploy, Staff UI, broad n8n ? backend refactor.

**Full sub-phase spec:** [`PHASE-3.5-SAFETY-RAILS-PLAN.md`](PHASE-3.5-SAFETY-RAILS-PLAN.md) ï¿½ 3.5aï¿½3.5g with entry/exit criteria, work-type classification, and first implementation step.

**Key schema finding:** `automation_errors` and `workflow_events` tables exist in migration 001 but are not yet wired into any n8n workflow. Stage 3.5b is a pure wire-in task.

---

## Stage 3y ï¿½ Shadow / Co-pilot Pilot

**Purpose:** Bridge the gap between isolated dry-run proof and autonomous live guest operation. Reduces the dry-run ? real-guest cliff; generates real labeled data; builds Ale/Cami trust in the system.

**Full plan:** [`PHASE-3y-SHADOW-COPILOT-PLAN.md`](PHASE-3y-SHADOW-COPILOT-PLAN.md) ï¿½ entry criteria, operating modes Aï¿½D, allowed/forbidden actions, staff approval workflow, infrastructure requirements, 15-test matrix (Y-T1ï¿½Y-T15), exit criteria.

### How shadow/co-pilot mode works

| Step | Who acts |
|------|----------|
| Real guest message arrives (or pasted in offline shadow) | n8n / Main reads it |
| Bot resolves route + drafts response | Bot (automated) |
| Bot suggests safe action (if any) | Bot outputs draft; **no autonomous send** |
| Staff reviews draft | Ale / Cami |
| Staff approves and sends | **Staff (manual)** |
| Staff edit logged as labeled example | System records correction (interim: offline log) |

### Operating modes (ascending risk ï¿½ gate each separately)

| Mode | Description | Gate |
|------|-------------|------|
| **A ï¿½ Offline shadow** | Pasted/copied messages; local n8n; no live connection | ? Ready to start (no new infra) |
| **B ï¿½ Real inbound, no sends** | Real WhatsApp inbound; `DRY_RUN=true` enforced | Separate explicit approval required |
| **C ï¿½ Staff-approved draft queue** | Bot writes draft to review queue; staff approves and sends manually | Mode B stable + review UI |
| **D ï¿½ Staff-approved action proposals** | Bot proposes dangerous action; staff clicks approve | Stage 6 Staff UI + all 3x complete |

### What is and is not allowed in Stage 3y

| Allowed | Not allowed without explicit approval |
|---------|--------------------------------------|
| Bot reads / classifies message text | Autonomous WhatsApp reply |
| Bot resolves route and flags uncertainty | Autonomous payment link creation |
| Bot drafts response for staff review | Autonomous booking confirmation |
| Bot identifies missing required fields | Autonomous cancellation or room reassign |
| Bot logs decision to `workflow_events` | Payment truth writes |
| Staff-approved sends (manual copy-paste) | Any dangerous action without per-action gate |

### Why Stage 3y before Stage 4

- Avoids big-bang flip from dry-run to fully autonomous
- Creates real labeled guest-message data from actual interactions
- Staff corrections become labeled training examples for Stage 4
- Ale/Cami can see and trust bot behavior before handing over
- "AI drafts, staff approves" is a distinct, sellable product tier

---

## Stage 3x ï¿½ Bot knowledge + safety guardrails

**Mini-phase before fully entering Stage 4 (Reliable).**

**Master spec:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)  
**Owner questionnaire:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### Purpose

Define the business knowledge and decision rules the bot needs to act safely, ask smart follow-up questions, and avoid dangerous guesses.

**Important:** Stage 3x delivers **specs, fixtures, and configurable rules** ï¿½ not a huge expansion of n8n IF nodes. Implementation belongs in code modules (Stage 5) fed by client config.

| Sub-phase | Status |
|-----------|--------|
| **3x.1** Full roadmap ï¿½3x.1ï¿½3x.11 + exit criteria + 35 golden rows | **Done** (2026-05-28 retry) |
| **3x.1b** Customer memory layered model (ï¿½3x.5) | **Done** (2026-05-28) |
| **3x.2b** Minimum Business Logic Baseline + Stage 4 entry gate | **Done** (2026-05-29) |
| **3x.2c** Applied owner P1 answers ? baseline v0.2 + handoff/add-on plans | **Done** (2026-05-29) |
| **3x.2d** Working prices + policies ? baseline v0.3 (provisional pricing) | **Done** (2026-05-29) |
| **3x.2** Ale/Cami **confirm** provisional prices + fill gaps ? confirmed config | In progress |
| **3x.3** WhatsApp mining + golden fixtures + customer extract | Planned |
| **3x.4** Golden runner + Stage 4 reliability hooks | Planned |

**Stage 3x includes:** required-field map ï¿½ package decision flow ï¿½ Wolfhouse knowledge collection ï¿½ **WhatsApp history mining** ï¿½ **customer memory migration** ï¿½ golden message tests ï¿½ dangerous-action gates ï¿½ human handoff ([`STAFF-HANDOFF-PLAN.md`](STAFF-HANDOFF-PLAN.md)) ï¿½ during-stay add-ons ([`DURING-STAY-ADDONS-PLAN.md`](DURING-STAY-ADDONS-PLAN.md)) ï¿½ wrong-booking protection ï¿½ duplicate protection ï¿½ client-config architecture ï¿½ **exit criteria** ([`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)).

### Summary index (detail in master spec)

### 3x.1 ï¿½ Required field map

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

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ï¿½3x.1](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x1--required-field-map) + fixture tables keyed by `resolved_route`.

### 3x.2 ï¿½ Package explanation + package decision flow

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
| ï¿½What packages do you have?ï¿½ | Briefly explain all packages |
| Wants to book, package missing | Ask: accommodation only vs surf package |
| Unsure | Recommend by goal: cheapest ? shared accommodation; beginner ? lesson package; full arrange ? full surf; already surfs ? accommodation + rentals |
| Price question | Do **not** quote exact price unless dates, guest count, package, and price source are known |
| Still uncertain | Follow-up question or staff handoff |

### 3x.3 ï¿½ Wolfhouse knowledge collection

Operational gaps only (not public website facts). Questionnaire for Ale/Cami:

**Deliverable:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### 3x.4 ï¿½ WhatsApp history mining plan

Redacted Cami/Ale guest threads ? **dual outputs:** (A) anonymized bot knowledge + (B) structured customer memory (see ï¿½3x.5).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ï¿½3x.4](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x4--whatsapp-history-mining-plan); redacted samples under `docs/knowledge/whatsapp-samples/` (not in git until anonymized).

### 3x.5 ï¿½ Customer memory + WhatsApp history migration

Layered model: temporary raw import ? structured customer facts (PG, `client_id`-scoped) ? anonymized fixtures. Proposed tables: `customers`, `customer_booking_history`, `conversation_summaries`, `customer_preferences`, `customer_notes`, `privacy_requests` (future).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ï¿½3x.5](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x5--customer-memory--whatsapp-history-migration). Owner questions: [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) ï¿½ Customer memory.

### LLM safety requirements (across Stage 3x + Stage 4)

The bot must never act on LLM output alone for dangerous actions. The following are required:

| Requirement | Stage |
|-------------|-------|
| Low confidence ? human handoff (not silent no-op) | 3x.8 spec ? 3.5 impl |
| LLM/API error ? handoff or logged safe fallback | 3.5 |
| Parsing uncertainty ? clarification question, not action | 3x.8 spec ? 3.5 impl |
| `resolved_route`, confidence, selected booking, and action logged per execution | 3.5 |
| Golden-message suite used as prompt regression evaluation | 3x.6 ? 4 |
| Multilingual behavior tested: English / Spanish / Italian | 3x.6 |
| Bot never marks `paid` / `cancelled` / `confirmed` based only on LLM interpretation | 3x.7 gate ï¿½ proven in 3d.5b (webhook owns truth) |

### Stage 3x exit criteria

Documented in master spec ï¿½ planning complete when ï¿½3x.1ï¿½3x.11 + exit checklist exist; full golden fixture set may complete in 3x.3.

### 3x.6 ï¿½ Golden message tests

**30ï¿½50** realistic guest messages with expected:

- `resolved_route`
- Missing fields
- Safe action (or explicit no-op)
- Clarification question text (pattern, not exact LLM wording)
- Handoff behavior

**Categories to include:**

- Booking request ï¿½ package questions ï¿½ payment-link request ï¿½ ï¿½I paidï¿½
- Cancellation ï¿½ room preference ï¿½ couple/friends/gender rooming ï¿½ date changes
- Surfboard/wetsuit rental ï¿½ breakfast/transfer ï¿½ unclear / low-confidence messages

**Deliverable:** `docs/fixtures/golden-messages/` + runner stub (Stage 4+). Schema + samples in master spec ï¿½3x.6.

### 3x.7 ï¿½ Dangerous action gates

Strict proof required before:

| Action | Proof |
|--------|--------|
| Send payment link | Hold + Ensure + CPS contract; no terminal booking |
| Confirm booking | Webhook payment truth + Send Confirmation eligibility |
| Cancel booking | Booking status + policy |
| Change room/bed | Assignment rules + capacity |
| Change dates | Availability + policy |
| Mark payment-related states | Webhook or authorized staff only |

### 3x.8 ï¿½ Human handoff rules

Bot must stop guessing and alert staff when:

- Low route confidence
- Conflicting dates or guest count
- Multiple active holds for same conversation
- Guest says they paid but no payment record
- Refund / dispute / cancellation ambiguity
- Angry guest / complaint
- Medical / emergency / legal issues
- Rooming / reassign uncertainty

**Deliverable:** `handoffRules` spec ? later `client_config.handoff_rules`.

### 3x.9 ï¿½ Wrong-booking protection

Formalize (align with existing resolver + PG):

- `conversation.current_hold_booking_id` wins over phone-only fallback
- Terminal bookings (`confirmed`, `cancelled`, etc.) cannot be modified by guest path
- Old holds must not be selected because phone matches alone
- Active booking must match conversation context and latest intent

### 3x.10 ï¿½ Duplicate protection

Verify and document:

| Scenario | Expected |
|----------|----------|
| Same WhatsApp message id | No duplicate booking |
| Repeated payment-link request | No duplicate checkout session without idempotency |
| Same Stripe event id | No duplicate `payment_events` row |
| Confirmation | Cannot send twice (`confirmation_sent_at`, flags) |

### 3x.11 ï¿½ Client-config architecture plan

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

## Source-of-truth cutover ï¿½ Airtable ? Postgres

This is a **first-class roadmap event**, not a scattered implementation detail. Airtable is the current operational source of truth for staff. Postgres is the engineering source of truth for the bot. Cutover must happen deliberately.

### Cutover phases

| Phase | Description | Gate |
|-------|-------------|------|
| **Current** | Airtable = staff SoT; Postgres = bot SoT; dual-write in progress | Active |
| **Read-only compare** | Run both reads; log discrepancies; do not act on mismatch | Before any cutover |
| **`DATA_SOURCE` flag** | Config-driven: `airtable` \| `postgres` per path; allows per-path rollout | Stage 4 |
| **Soak period** | Postgres-primary writes; Airtable as backup read; monitor for divergence | Stage 4ï¿½5 |
| **Airtable dependency removal** | Only after staff UI or equivalent replacement exists | Stage 6+ |
| **Backup policy** | Full Airtable export + PG dump before each cutover step | Required |
| **Rollback plan** | Revert `DATA_SOURCE` flag; restore from backup; documented runbook | Required |

**Do not remove Airtable dependency** until:
1. Staff UI (Stage 6) or equivalent is live for all Airtable use cases it currently covers
2. PG data has passed a soak period without divergence
3. Backup and rollback procedure is documented and tested

---

## Privacy / GDPR gate before customer memory

**No Layer-2 structured customer memory with personal data until all of the following exist:**

| Requirement | Status |
|-------------|--------|
| Documented purpose for each stored personal field | Planned (3x.2) |
| Retention policy per field type | Planned (3x.2) |
| Staff-only note handling (no guest-facing access to staff notes) | Planned |
| Delete / export / correction procedure documented | Planned |
| Marketing opt-in separated from booking support data | Planned |
| Raw WhatsApp exports kept off-repo / in `data/private/` (gitignored) | **Done** (`84fa45f`) |
| Only reviewed/sanitized fixtures in repo | Policy established |

**This gate applies before 3x.3 customer extract is written to PG.** Planning (3x.2) may proceed; PG insert of personal data requires privacy gate first.

---

## Stage 4 ï¿½ Reliable

**Status (2026-05-30): CLOSE WITH DEFERRALS.** Autonomous Booking Dry-Run complete ï¿½ all 14 scenarios PASS (commit `6cd9a21`). Evidence: `test-payloads/stage4/autonomous-dry-run/README.md`. Live WhatsApp, live holds, live Stripe, and live confirmation writes remain deferred. Structured add-on records and staff ops assistant deferred to Stages 5ï¿½6.

### Purpose

Make the working system **dependable and observable** after Stage 3 behavior is proven and Stage 3x rules are specified.

### Entry gate (defined in baseline config + ï¿½3x.2b)

Gate definition: [`config/clients/wolfhouse-somo.baseline.json`](../config/clients/wolfhouse-somo.baseline.json) (`stage4_entry_gate`) and [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ï¿½3x.2b/ï¿½3x.2c](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x2c--applied-owner-answers-2026-05-29).

**Reduced after 3x.2c** (payment-link auto-send, hold expiry, confirmation content, conditional cancel/date-change, rooming auto-assign + operator-room logic all confirmed). **Remaining owner blockers:** deposit amount/scope ï¿½ non-7-night pricing math ï¿½ cancellation/refund windows & % ï¿½ add-on service prices/scheduling (if in Stage 4 scope) ï¿½ real WhatsApp send gate or Stage 3y shadow ï¿½ final handoff channel. **Not blockers:** perfect tone ï¿½ full customer memory ï¿½ marketing opt-in ï¿½ exact add-on automation.

**Additional entry requirement:** Autonomous booking dry-run pass ï¿½ bot completes full booking flow (inbound message ? route ? availability ? hold ? payment-link ? Stripe webhook ? confirmation) without errors in all-stubbed mode, proving readiness before real sends or live operation are enabled.

### Includes

- **Autonomous booking dry-run** (first Stage 4 milestone): full booking flow end-to-end ï¿½ inbound message ? route ? availability ? hold ? payment-link ? Stripe webhook ? confirmation ï¿½ with all live side effects stubbed at the infrastructure boundary. Proves the bot completes the booking correctly before real sends or live operation are enabled. This is the regression anchor: once green, enabling real WhatsApp send or live operation is a config change, not a behavior change.
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
- **Staff query assistant** (read-only ops Q&A: "who has a surfboard today?", "who arrives today?", "which rooms need cleaning and by when?") gated by an **approved-staff allowlist** (`staff_directory`; portal = Stage 6) ï¿½ [`STAFF-QUERY-ASSISTANT-PLAN.md`](STAFF-QUERY-ASSISTANT-PLAN.md)

### Add-on structured records (Stage 4 design requirement)

Add-on dry-run tests (e.g. A9 ï¿½ lessons, yoga, rentals) must do more than verify the guest-facing price quote is correct. They must also prove the system can **represent add-on requests as structured, staff-queryable records**. This is the data foundation that makes Stage 6 staff queries possible.

Each add-on request that passes through the bot should be representable as a record with at minimum:
- Guest / booking reference
- Add-on type (lesson, wetsuit, board, yoga, dinner)
- Quantity / number of days
- Requested date(s)
- Payment status (pending / paid)
- Fulfillment status (not redeemed / redeemed ï¿½ staff-managed)
- A flag indicating whether staff scheduling / manual tracking applies (e.g. lessons require a manual slot assignment)

**Stage 4 does not require full add-on automation.** It requires that when the bot processes an add-on request, the output can be persisted in a shape that is queryable by staff. If no structured add-on record is written yet, the design must identify where it would be written and what the schema looks like ï¿½ so Stage 5 does not have to invent it from scratch.

---

## Stage 5 ï¿½ Clean

**Status (2026-05-31): CLOSE WITH DEFERRALS ï¿½ source-of-truth cleanup complete (5.1ï¿½5.8b); engine extraction / portability scope deferred.** All staff-queryable data tables are schema-stubbed and query helpers are proven. Migrations 007 (add-ons) and 008 (staff handoffs) are ready to apply. Live operation, engine extraction, and staff UI remain deferred (Stage 6). Detail: [`PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md`](PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md).

### Purpose

Simplify implementation after behavior is proven and reliability checks exist.

### Safety-critical early extractions (pull forward to Stage 3.5 / 4 only if needed)

Do **not** do broad Stage 5 refactor before Stage 3 / 3.5 safety gates. However, pull forward **only** these safety-critical items when required:

- Wrong-booking guard (if not proven in Stage 3 negative tests)
- Dangerous-action gate checks (missing required business rule ? handoff)
- Duplicate / idempotency checks (if Stage 3.5 requires them in code)
- Bed-assignment overlap / dedup logic (if DB constraint is insufficient)
- `client_config` loading skeleton (if Stage 3x requires it for golden tests)

### Includes

- Move decision logic out of n8n into `src/booking-assistant/` (n8n becomes I/O only).
- **Extract along the portability seam** ([ï¿½ Engine portability](#engine-portability--adding-a-new-vertical-surf-shop--lessons)): shared spine vs `inventory/` + `catalog/` plugins ï¿½ do **not** produce a tidied-up surf-house monolith.
- Implement `InventoryProvider` with **lodging** as the first concrete provider; keep the interface generic enough for `slots` / `rentals`.
- Split `client_config` into **engine config** (spine) + **vertical config** (catalog / inventory / capabilities); rooming behind a capability flag.
- Replace serialized-into-n8n Code nodes (e.g. the resolver) with calls to the extracted, version-checked modules.

**Target:** n8n calls backend decision engine; Postgres writes go through shared SQL/modules; n8n performs WhatsApp/Stripe/Airtable I/O.

**Portability acceptance for Stage 5:** the Wolfhouse spine compiles and passes golden tests with **zero surf-house nouns** outside `inventory/lodging.*` and `client_config`. (Verify against the portability gate checklist.)

### Staff-queryable operational data (Stage 5 requirement)

Source-of-truth cleanup must explicitly produce the structured Postgres records that power Stage 6 staff queries. The data design goal is: **staff questions are answered from reliable structured records, not guessed from chat logs or Airtable exports.**

The following tables/models must be designed (and at minimum stubbed in schema) during Stage 5, before the Stage 6 staff assistant is built:

| Table / model | Answers the question |
|---|---|
| `add_on_orders` | Which guests have requested add-ons? What is the payment status per order? |
| `add_on_items` | Line-item detail per order (type, qty, days, dates, price) |
| `lesson_requests` | Who has lessons today / tomorrow? What slot? (staff assigns; bot records request) |
| `rental_requests` | Who requested a board / wetsuit? For how many days? Pickup status? |
| `yoga_requests` | Who paid for yoga? For which date? (redeemed on-site by staff) |
| `staff_handoffs` / `staff_tasks` | Which conversations need a human reply? Why was it handed off? Current state? |
| `payment_balances` (view or table) | Who still owes money? Who paid deposit but not full balance? |

These are **not new features** ï¿½ they are the structured forms of data the bot already collects. The goal of Stage 5 is to ensure that data lands in Postgres in a queryable shape instead of only in Airtable or serialized chat session state.

**Design gate for Stage 5:** before beginning Stage 6 staff UI work, verify that a staff member can ask each of the following questions and get a correct answer from Postgres without touching Airtable or reading raw WhatsApp messages:

- "Who paid for yoga today?"
- "Who has lessons tomorrow?"
- "Who still owes money?"
- "Who requested a board?"
- "Which bookings need a human reply?"
- "Show today's arrivals and departures."
- "Who paid deposit but not full balance?"
- "Which guests requested rooming preferences?"

---

## Stage 6 ï¿½ Beautiful (Staff / Admin Layer)

**Status: CLOSED WITH DEFERRALS** (2026-05-31) ï¿½ All exit criteria MET. 6.0ï¿½6.9 DONE: 35-intent registry, CLI runner, batch reports, CLI write action, HTTP API, browser UI, smoke test, token-gated write endpoint. Production auth/TLS/live-ops deferred to Stage 7. See [`PHASE-6-STAFF-ASSISTANT-PLAN.md`](PHASE-6-STAFF-ASSISTANT-PLAN.md).

**Implementation slices:** 6.1 registry DONE ? 6.2 CLI runner DONE ? 6.3 handoffs DONE ? 6.4a/b/c/d batch reports DONE ? 6.5a/b CLI write action DONE ? 6.6 HTTP API DONE ? 6.7 intent smoke DONE ? 6.8 read-only UI DONE ? 6.9 token-gated write endpoint DONE.

### Purpose

Excellent staff and owner experience. This is where the **two-sided product** becomes visible: the guest-facing assistant (already built) and the **staff-facing operations assistant** (built here).

### Two sides of the product

| Side | Who uses it | What it does |
|------|------------|--------------|
| **Guest assistant** | Guests on WhatsApp | Bookings, questions, payments, confirmations, add-ons, rooming, handoff |
| **Staff assistant / admin** | Ale, Cami, operators | Operational queries, action review/approval, conversation takeover, status dashboards |

### Staff Operations Assistant

Staff can ask operational questions and get answers from **structured Postgres records** (not chat logs or guesses). All queries are read-only, gated by `staff_directory` approved numbers.

**Example questions the staff assistant must answer:**

- "Who paid for yoga today?"
- "Who has lessons tomorrow?"
- "Who still owes money?"
- "Who requested a board?"
- "Which conversations need a human reply?"
- "Show today's arrivals and departures."
- "Who paid deposit but not full balance?"
- "Which guests requested rooming preferences?"

**Design constraint:** these questions are answered from the structured records built in Stage 5 (`lesson_requests`, `add_on_orders`, `staff_handoffs`, `payment_balances`, etc.). The assistant maps natural-language questions to fixed safe parameterized intents ï¿½ it never generates arbitrary SQL.

### Staff Approval Controls

Staff can review, approve, and act on bot proposals without going directly into n8n or Airtable:

- View bot draft reply before it is sent
- Approve or reject risky bot action proposals (payment, cancellation, room reassign)
- Take over a conversation from the bot
- View payment / hold / rooming / add-on status per booking
- Mark add-on as redeemed (voucher fulfilled on site)
- Release or block operator rooms

### Staff UI

- Calendar / bed grid, guest list, booking detail
- Payment status, pending holds, confirmation queue
- Conversation history, human takeover
- Manual booking / edit / cancel tools
- Room/bed assignment UI
- Alerts for stuck workflows
- Owner dashboard

Airtable may remain a **bridge** during transition; long-term goal is a proper staff UI, not Airtable as daily ops surface.

**Airtable cutover prerequisite:** the staff UI (or equivalent) must cover all use cases Airtable currently serves before Airtable is removed as a dependency ï¿½ see the Source-of-truth cutover table above.

---

## Stage 7 ï¿½ Scalable

**Status: PLANNING CLOSED / IMPLEMENTATION STARTED** (2026-05-31) ï¿½ 7.0ï¿½7.6 DESIGN DONE. **7.2b+7.2c+7.3b DONE**: migration 009, auth middleware scaffold, Azure IaC scaffold (infra/azure/staging/ Bicep, 11 resource types, safety defaults, KV secret refs, runbook, 57-check verifier PASS). No Azure resources created. Next: 7.3c DNS/TLS or Cami dashboard.?# Wolfhouse Booking Assistant ï¿½ Product Roadmap

**Product:** AI booking operations for WhatsApp-first experience businesses ï¿½ **beachhead:** Wolfhouse (surf house / surf camp). Simpler label: *AI front desk for WhatsApp-heavy experience operators.*

**Product-level roadmap (15 pillars):** [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md) ï¿½ **Engineering snapshot:** [`PROJECT-STATE.md`](PROJECT-STATE.md) ï¿½ **Architecture:** [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) ï¿½ **Stripe isolated gates:** [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

> **This file is the stage-level / engineering roadmap.** For the **product-level view** ï¿½ the full 15-pillar product vision (Guest Assistant, SoT DB, Staff Brain, Dashboard, Rooming UI, Add-ons, Messaging Bridge, Multi-Client Config, Onboarding, PMS, AI Intent, Analytics, Production Hardening, Multi-Client Admin, Productization) mapped to these stages ï¿½ see [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md).

---

## Evolution order (do not skip)

```text
1. Correct and safe      ? Stage 3  (engineering gates + exit criteria)
   Safety rails          ? Stage 3.5 (seatbelts before live/shadow mode)
   Knowledge + guardrails ? Stage 3x (specs, client config, golden tests)
   Shadow / co-pilot     ? Stage 3y (staff-approved replies, real guest data)
2. Reliable              ? Stage 4
3. Clean                 ? Stage 5
4. Beautiful             ? Stage 6  (Staff / Admin Layer + Staff Operations Assistant)
5. Scalable              ? Stage 7
```

Stage 3 is **not** about making the bot beautiful or fully productized. It is about proving the bot does **not** make dangerous mistakes.

**Stage 3.5 is not full Stage 4 observability.** It is the minimum seatbelts required before serious runtime or live/shadow operation ï¿½ error capture, idempotency checks, overlap guards, basic execution logging.

**Stage 3y (Shadow/Co-pilot)** bridges dry-run proof and autonomous live operation. The bot reads real messages and drafts responses; staff approve and send manually. No autonomous payment/confirmation/cancellation/rooming without explicit staff approval. This reduces the dry-run ? real-guest cliff and generates real golden-message data.

---

## Architecture direction (long-term)

**Do not keep expanding n8n with more and more business logic forever.**

| Layer | Role |
|-------|------|
| **n8n** | Orchestrates ï¿½ webhooks, WhatsApp, Stripe callbacks, notifications, simple integration steps |
| **Backend / code** | Decides ï¿½ routing, required fields, package logic, safety guards, handoff rules |
| **Postgres** | Remembers ï¿½ bookings, payments, conversations, beds, audit trail |
| **Client config** | Controls ï¿½ packages, pricing, room rules, policies per property (Wolfhouse = client #1) |
| **Staff UI + Staff Assistant** | Manages ï¿½ holds, payments, assignments, takeover; answers operational queries; approves risky bot actions (Stage 6+) |

The current **n8n-heavy** implementation is acceptable for **proving behavior** in Stage 3. Future stages migrate decision logic into code/config modules; n8n calls the decision engine instead of owning the business brain.

**Target module layout (Stage 5):**

```text
src/booking-assistant/
  # --- shared spine (client- AND vertical-agnostic; never rebuilt per vertical) ---
  routeMessage.ts
  extractBookingDetails.ts
  requiredFields.ts
  safetyGuards.ts
  handoffRules.ts
  duplicateProtection.ts
  bookingContext.ts
  clientConfig.ts
  payments.ts              # Stripe link + webhook truth + confirmation (vertical-agnostic)
  # --- vertical plugin seam (the ONLY part that differs per business type) ---
  inventory/
    InventoryProvider.ts   # interface: findAvailability / hold / fulfill
    lodging.ts             # beds-in-rooms + rooming (Wolfhouse / hostels)
    slots.ts               # lesson/tour time-slot capacity (surf/kite schools, tours)
    rentals.ts             # item ï¿½ time-window ï¿½ quantity ï¿½ size (surf/bike/SUP shops)
  catalog/
    offerings.ts           # generic priced offering (packages | lessons | rental SKUs | departures)
    packageDecision.ts     # explain / recommend / quote ï¿½ driven by config, not hardcoded names
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

**Spine vs plugin (portability principle):** everything above the `inventory/` and `catalog/` folders is the **shared spine** and must contain **no surf-house-specific nouns** (no `bed`, `room`, `malibu`, `surfweek`). Anything vertical-specific lives behind the `InventoryProvider` interface or in `client_config`. A new vertical = new config + (at most) one new inventory provider ï¿½ see [ï¿½ Engine portability](#engine-portability--adding-a-new-vertical-surf-shop--lessons).

---

## Client category / market positioning

### Product category

**Primary:** AI booking operations for WhatsApp-first experience businesses.

**Simpler language:** AI front desk for WhatsApp-heavy experience operators.

This is **not** framed as a generic chatbot. It is an operations layer that handles guest questions, package/rental/lesson explanation, availability and detail collection, payment links, payment truth, confirmations, customer memory, staff handoff, and operational status.

### Beachhead

**Wolfhouse** ï¿½ surf houses / surf camps (client #1, `wolfhouse-somo`).

Hard first use case: combines accommodation, packages, rooming, payments, confirmations, WhatsApp, and staff operations in one property.

### Adjacent categories (same core pattern)

Guests ask on WhatsApp ? business explains options ? checks availability ? collects details ? sends payment/deposit link ? confirms ? staff handle changes and handoffs.

| Adjacent vertical | Typical scope (often simpler than surf house) |
|------------------|-----------------------------------------------|
| Surf schools | Lessons, levels, schedules |
| Surf shops | Rentals, retail-adjacent booking |
| Kite schools ï¿½ dive shops | Lessons, certifications, slots |
| Yoga retreats ï¿½ small retreat operators | Packages, dates, capacity |
| Hostels with activities | Beds + activity add-ons |
| Tour operators | Departures, group size, deposits |
| Rental businesses | Lessons, rentals, inventory, time slots, sizes ï¿½ surf shop / bike / e-bike / kayak / SUP / campervan patterns |

A **surf shop or lesson-rental** operator is likely a simpler config profile than Wolfhouse: fewer rooming rules, more slot/inventory semantics, still the same payment + confirmation + handoff spine.

### Competitive note

AI/WhatsApp tools already exist for hotels, hospitality, and tour operators. The opportunity is a **focused, configurable, operations-heavy** assistant for **small experience businesses** that live in WhatsApp and run **messy** packages, rentals, lessons, and deposits ï¿½ not clean hotel-only PMS flows.

### Roadmap implication

| Build now | Defer |
|-----------|--------|
| Wolfhouse as client #1 with full safety proofs | Multi-client SaaS platform |
| `client_config` specs that generalize | Client onboarding UI, billing, settings editor |
| Engine shaped for lessons/rentals/rooming via config | Hardcoding ï¿½surf house onlyï¿½ in shared workflows |

**Config dimensions per client** (see ï¿½3x.11 in [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)): packages ï¿½ lesson types ï¿½ rental inventory ï¿½ rooming rules (if applicable) ï¿½ pricing ï¿½ deposit rules ï¿½ cancellation policy ï¿½ handoff rules ï¿½ staff notifications ï¿½ customer memory policy.

---

## Engine portability ï¿½ adding a new vertical (surf shop / lessons)

**Goal:** when Wolfhouse is done, standing up a second vertical (surf-shop **rentals**, surf/kite-school **lessons**, tour **departures**) is a **config + inventory-plugin** exercise ï¿½ **not** a rewrite. This section defines the seam so that promise is real instead of aspirational.

### What is SHARED ï¿½ built once, reused by every vertical

| Shared spine capability | Where |
|-------------------------|-------|
| WhatsApp inbound/outbound I/O | n8n orchestration |
| Message routing / intent (`routeMessage`) | spine |
| Required-field gating per action (`requiredFields`) | spine + `client_config` |
| Payment link ? **Stripe webhook truth** ? confirmation (`payments`) | spine (proven 3d.x) |
| Handoff triggers (`handoffRules`) | spine + `client_config.handoff` |
| LLM safety (low-confidence ? handoff; never act on LLM alone) | spine + `client_config.llm_safety` |
| Duplicate / idempotency protection | spine (Stage 3.5) |
| Conversation / session state, customer memory + privacy | spine + Postgres |
| Error capture, golden-message runner | Stage 3.5 / 4 |

These **must not** be reimplemented per client. If a "new vertical" task touches these, the seam has leaked.

### What is VERTICAL-SPECIFIC ï¿½ plugged in, never forked

| Vertical concern | How it varies | Mechanism |
|------------------|---------------|-----------|
| The bookable resource + availability | bed-nights vs lesson slots vs rental items vs departure seats | `InventoryProvider` implementation |
| Catalog of offerings | packages vs lesson types vs rental SKUs vs departures | `catalog/offerings` + `client_config` |
| Fulfillment / assignment | rooming is **lodging-only**; most verticals skip it | capability flag, not core path |
| Required fields per booking type | dorm gender vs board size vs surf level | `client_config.required_fields` |
| Vocabulary / tone | surf-house terms vs shop terms | `client_config.language_tone` |

### The one abstraction that unlocks all of it: `InventoryProvider`

All verticals reduce to the same three-call contract ï¿½ `findAvailability(request)` ? `hold(unit, window)` ? `fulfill(booking)`:

| Vertical | Unit | Availability dimension | Special attribute | Rooming? |
|----------|------|------------------------|-------------------|----------|
| Surf house / hostel | bed | date-range overlap | gender / couple | **yes** (`lodging`) |
| Surf / kite / dive school | lesson slot | time + slot capacity | skill level | no (`slots`) |
| Surf / bike / SUP shop | rental item | time-window ï¿½ quantity | size / fit | no (`rentals`) |
| Tour operator | departure seat | departure-date capacity | group size | no (`slots`) |

The spine calls the interface and never knows which provider it is.

### Portability gate ï¿½ a vertical is "config-only ready" when:

- [ ] No surf-house nouns (`bed`, `room`, `matrimonial`, `surfweek`, `malibu`/`uluwatu`/`waimea`) appear in the shared spine ï¿½ only in `client_config` / providers.
- [ ] Rooming/assignment is behind a **capability flag**, not assumed.
- [ ] Catalog is generic `offerings`, not a hardcoded package enum.
- [ ] Inventory/availability is behind `InventoryProvider`; lodging is just one impl.
- [ ] `client_config` is split into **engine config** (spine) + **vertical config** (catalog/inventory/capabilities).
- [ ] Golden-message suite is parameterized by `client_id` (Wolfhouse fixtures don't hardcode the engine's behavior).

### Cheapest validation ï¿½ do this on paper during Stage 3x.3 (safe, docs-only)

Before any Stage 5 extraction, draft **sample configs for a second and third vertical** and run them against the schema to surface every leak:

- `config/clients/surf-shop-rental.sample.json` (rentals: items, sizes, time windows, deposits)
- `config/clients/surf-school.sample.json` (lessons: levels, slots, instructors)

Each gap found ("this field has no home," "this rule assumes beds") becomes a line item in the **Stage 5 extraction backlog**. If both samples fit the schema with only a new `InventoryProvider`, the backbone is portable; if not, you've found the surf-house assumptions cheaply, on paper, before writing engine code.

### Stage placement

| Work | Stage | Safe before runtime? |
|------|-------|----------------------|
| Spine/plugin seam **design** + sample vertical configs (paper test) | now / **3x.3** | yes (docs/config only) |
| Split `client_config` into engine vs vertical schema | 3x.3 ? Stage 5 | yes (config) |
| Extract spine modules; implement `InventoryProvider` (lodging first) | **Stage 5** | build stage |
| Second `InventoryProvider` (`slots` / `rentals`) + 2nd client live | **Stage 7** | scale stage |

**Do not** build multi-vertical infra early. **Do** lock the seam now so Stage 5 cleanup produces portable modules instead of a tidied-up surf-house monolith.

### Deploy config (the onboarding contract)

Every client-specific value (prices, seasons, gate code, phone numbers, packages, room map, policies) lives in **one per-client deploy config** + a gitignored secret file ï¿½ never hardcoded in code/workflows. A new client = fill the template, not rewrite logic. Template: [`config/clients/_deploy-config.template.json`](../config/clients/_deploy-config.template.json) ï¿½ Guide: [`DEPLOYMENT-CONFIG.md`](DEPLOYMENT-CONFIG.md). Wolfhouse's `wolfhouse-somo.baseline.json` is the worked example (`vertical: lodging_surf_house`).

---

## Legacy phase map (reference)

Older docs use **Phase 0ï¿½3d** for engineering milestones. They map to stages as follows:

| Legacy | Stage |
|--------|--------|
| Phase 0ï¿½2 local (frozen) | Foundation + Stripe/Main/Send Confirmation contracts |
| Phase 3b (frozen) | Stage 3 ï¿½ bed-ops / manual / operator paths |
| Phase 3cï¿½3g | Stage 3 ï¿½ Main + Postgres + stub E2E |
| Phase 3d.x | Stage 3 ï¿½ isolated real Stripe payment / webhook / confirmation gates |
| Phase 3e | Stage 3 ï¿½ rooming/reassign E2E ? |
| Stage 3.5 | Safety rails ï¿½ idempotency, error capture, overlap guards |
| Stage 3x | Bot knowledge + safety guardrails (specs, not n8n sprawl) |
| Stage 3y | Shadow / co-pilot ï¿½ staff-approved mode before autonomous |
| Azure / multi-client | Stage 7 (Scalable), not before Reliability + Clean |

---

## Stage 3 ï¿½ Correct and safe

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
| Wrong room assignment | Bed-ops forks; **hosted reassign URL** in Main fork (`3e.2` remap) ï¿½ see [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) |
| Duplicate payment / session / event | Idempotency checks; single webhook per event id |
| Accidental live Stripe / WhatsApp | Test keys; `WHATSAPP_DRY_RUN`; activation boundaries |
| Background workflow firing | Inactive workflows + schedule `disabled` in test windows |

### Complete or in progress (engineering)

| Area | Status | Notes |
|------|--------|--------|
| `booking_flow` hold creation | **Proven** | PG hold + Airtable backfill in Main fork (3c.e) |
| `payment_details_provided` route | **Proven** | Resolver + Ensure (3c.g stub E2E) |
| Real Stripe checkout link (Main-integrated) | **Proven** | 3d.7b ï¿½ `WH-260528-5369`, stop at checkout URL |
| Isolated Create Payment Session | **Proven** | 3d.4 |
| Stripe Webhook Handler payment truth | **Proven** (isolated) | 3d.5b on `WH-260528-1493` |
| Send Confirmation (dry-run) | **Proven** (isolated) | 3d.6e |
| Pay + webhook on Main-created session | **Proven** | 3d.8b organic Stripe on `WH-260528-5369` |
| Integrated Send Confirmation (dry-run) | **Proven** | 3d.9b exec **1077** on same booking |
| Rooming / reassign E2E | **Proven** | **3e.4 PASS** ï¿½ `WH-260528-5322`, beds R3-B1/R3-B2 |

**Not proven in Stage 3:** real WhatsApp send; Send Confirmation schedule-poll; single-window E2E; full package intelligence.

**Freeze:** [`PHASE-3c-3d-FREEZE.md`](PHASE-3c-3d-FREEZE.md) ï¿½ formal 3c+3d checkpoint before Phase 3e.3+.

**Detail:** [`PROJECT-STATE.md`](PROJECT-STATE.md) ï¿½ [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

### Stage 3 exit criteria

Stage 3 is **complete only when all of the following are met** (or explicitly deferred with documented safe fallback):

**Core behavior proven:**
- [ ] `booking_flow` hold creation (PG + Airtable backfill) ?
- [ ] `payment_details_provided` route + Ensure ?
- [ ] Real Stripe checkout link (Main-integrated) ?
- [ ] Isolated Create Payment Session ?
- [ ] Stripe Webhook Handler payment truth ?
- [ ] Send Confirmation (dry-run) ?
- [ ] Integrated pay + webhook + confirmation ?
- [ ] Rooming / reassign E2E ?

**Safety invariants proven:**
- [ ] No Main direct writes to `payments` / `payment_events` ? (static proof)
- [ ] No payment/confirmation path writes `booking_beds` ? (static proof)
- [ ] Hosted/prod URLs removed from all local test paths ? (3e.2)
- [ ] Terminal evidence bookings not reused without reset (policy established)

**Guards verified or explicitly deferred:**
- [x] Wrong-booking guard tested for dangerous actions (rooming, payment, cancel) ï¿½ **3e.5 CLOSED** (L1+L2 PASS; L3 deferred ï¿½ Airtable-coupled runtime deferred to Postgres source-of-truth cutover; see ï¿½15.6ï¿½ï¿½15.7)
- [x] Duplicate / idempotency protections verified at Stage 3 bar ï¿½ **3e.6 CLOSED** (I1 schema PASS ï¿½ I4 runtime PASS ï¿½ I6 invariant PASS; I2/I3/I5 deferred: I2 ? manual-pay gate ï¿½ I3 ? Stage 3.5 ï¿½ I5 ? Postgres cutover)
- [ ] All dangerous actions have handoff / fail-safe behavior when required business rule is missing ï¿½ *3x.7ï¿½3x.8 spec done; implementation pending*

**Acceptable deferrals (do not block Stage 3 exit if documented):**
- Real WhatsApp send ï¿½ dry-run mode (`WHATSAPP_DRY_RUN=true`) is sufficient; shadow mode (Stage 3y) covers real send
- Send Confirmation schedule-poll ï¿½ schedule `disabled=true` gate is sufficient for Stage 3; verify in Stage 3y
- Single-window integrated E2E ï¿½ isolated gate chains are sufficient for Stage 3

**Acceptance metric gates:**
- 0 double bookings in all runtime test gates
- 0 wrong-booking dangerous actions in test gates
- 0 payment truth updates outside Stripe Webhook Handler
- 0 confirmations without payment truth
- 0 real WhatsApp sends in dry-run test gates
- 100% dangerous-action routes have handoff/fail-safe when required business logic is missing

---

## Stage 3.5 ï¿½ Safety Rails Before Reliability

**Purpose:** Pull forward the minimum safety plumbing required to safely run more runtime gates and prepare for live/shadow mode. This is not full Stage 4 observability ï¿½ it is seatbelts.

**When to do Stage 3.5:** After Stage 3 exit criteria are met, before Stage 3y (shadow/co-pilot) or live guest operation.

### Minimum safety requirements (Stage 3.5)

| Item | Why |
|------|-----|
| `automation_errors` capture/write path | Know when bot fails silently |
| Standard workflow error handler pattern | Consistent safe fallback across all n8n workflows |
| Idempotency: inbound WhatsApp message id | No duplicate booking from retry/double-delivery |
| Idempotency: Stripe event id | No duplicate `payment_events` row |
| Idempotency: payment-link reuse | No duplicate checkout session without explicit guard |
| Idempotency: Send Confirmation | Cannot confirm twice (`confirmation_sent_at` + flag) |
| Idempotency: rooming/reassign | Cannot double-assign or double-delete beds |
| Double-booking guard / DB overlap check | `booking_beds` overlap detection query; reject or alert before insert |
| Stuck booking detection (basic) | Bookings in `payment_pending` > N hours with no event; holds expired but not released |
| Workflow active-state safety check | Automated assertion: only expected workflows active before dangerous test or runtime |
| Schedule disabled/enabled safety check | Send Confirmation schedule `disabled=true` verified before any payment/confirmation test |
| Minimum execution logging | For each execution: `resolved_route`, confidence, selected booking id, dangerous action taken (or no-op reason) |
| Golden-runner stub | Even a fixture-file runner (`test:golden-messages`) blocks regression in CI before Stage 4 |

**Stage 3.5 does not include:** full monitoring dashboards, Azure deploy, Staff UI, broad n8n ? backend refactor.

**Full sub-phase spec:** [`PHASE-3.5-SAFETY-RAILS-PLAN.md`](PHASE-3.5-SAFETY-RAILS-PLAN.md) ï¿½ 3.5aï¿½3.5g with entry/exit criteria, work-type classification, and first implementation step.

**Key schema finding:** `automation_errors` and `workflow_events` tables exist in migration 001 but are not yet wired into any n8n workflow. Stage 3.5b is a pure wire-in task.

---

## Stage 3y ï¿½ Shadow / Co-pilot Pilot

**Purpose:** Bridge the gap between isolated dry-run proof and autonomous live guest operation. Reduces the dry-run ? real-guest cliff; generates real labeled data; builds Ale/Cami trust in the system.

**Full plan:** [`PHASE-3y-SHADOW-COPILOT-PLAN.md`](PHASE-3y-SHADOW-COPILOT-PLAN.md) ï¿½ entry criteria, operating modes Aï¿½D, allowed/forbidden actions, staff approval workflow, infrastructure requirements, 15-test matrix (Y-T1ï¿½Y-T15), exit criteria.

### How shadow/co-pilot mode works

| Step | Who acts |
|------|----------|
| Real guest message arrives (or pasted in offline shadow) | n8n / Main reads it |
| Bot resolves route + drafts response | Bot (automated) |
| Bot suggests safe action (if any) | Bot outputs draft; **no autonomous send** |
| Staff reviews draft | Ale / Cami |
| Staff approves and sends | **Staff (manual)** |
| Staff edit logged as labeled example | System records correction (interim: offline log) |

### Operating modes (ascending risk ï¿½ gate each separately)

| Mode | Description | Gate |
|------|-------------|------|
| **A ï¿½ Offline shadow** | Pasted/copied messages; local n8n; no live connection | ? Ready to start (no new infra) |
| **B ï¿½ Real inbound, no sends** | Real WhatsApp inbound; `DRY_RUN=true` enforced | Separate explicit approval required |
| **C ï¿½ Staff-approved draft queue** | Bot writes draft to review queue; staff approves and sends manually | Mode B stable + review UI |
| **D ï¿½ Staff-approved action proposals** | Bot proposes dangerous action; staff clicks approve | Stage 6 Staff UI + all 3x complete |

### What is and is not allowed in Stage 3y

| Allowed | Not allowed without explicit approval |
|---------|--------------------------------------|
| Bot reads / classifies message text | Autonomous WhatsApp reply |
| Bot resolves route and flags uncertainty | Autonomous payment link creation |
| Bot drafts response for staff review | Autonomous booking confirmation |
| Bot identifies missing required fields | Autonomous cancellation or room reassign |
| Bot logs decision to `workflow_events` | Payment truth writes |
| Staff-approved sends (manual copy-paste) | Any dangerous action without per-action gate |

### Why Stage 3y before Stage 4

- Avoids big-bang flip from dry-run to fully autonomous
- Creates real labeled guest-message data from actual interactions
- Staff corrections become labeled training examples for Stage 4
- Ale/Cami can see and trust bot behavior before handing over
- "AI drafts, staff approves" is a distinct, sellable product tier

---

## Stage 3x ï¿½ Bot knowledge + safety guardrails

**Mini-phase before fully entering Stage 4 (Reliable).**

**Master spec:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)  
**Owner questionnaire:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### Purpose

Define the business knowledge and decision rules the bot needs to act safely, ask smart follow-up questions, and avoid dangerous guesses.

**Important:** Stage 3x delivers **specs, fixtures, and configurable rules** ï¿½ not a huge expansion of n8n IF nodes. Implementation belongs in code modules (Stage 5) fed by client config.

| Sub-phase | Status |
|-----------|--------|
| **3x.1** Full roadmap ï¿½3x.1ï¿½3x.11 + exit criteria + 35 golden rows | **Done** (2026-05-28 retry) |
| **3x.1b** Customer memory layered model (ï¿½3x.5) | **Done** (2026-05-28) |
| **3x.2b** Minimum Business Logic Baseline + Stage 4 entry gate | **Done** (2026-05-29) |
| **3x.2c** Applied owner P1 answers ? baseline v0.2 + handoff/add-on plans | **Done** (2026-05-29) |
| **3x.2d** Working prices + policies ? baseline v0.3 (provisional pricing) | **Done** (2026-05-29) |
| **3x.2** Ale/Cami **confirm** provisional prices + fill gaps ? confirmed config | In progress |
| **3x.3** WhatsApp mining + golden fixtures + customer extract | Planned |
| **3x.4** Golden runner + Stage 4 reliability hooks | Planned |

**Stage 3x includes:** required-field map ï¿½ package decision flow ï¿½ Wolfhouse knowledge collection ï¿½ **WhatsApp history mining** ï¿½ **customer memory migration** ï¿½ golden message tests ï¿½ dangerous-action gates ï¿½ human handoff ([`STAFF-HANDOFF-PLAN.md`](STAFF-HANDOFF-PLAN.md)) ï¿½ during-stay add-ons ([`DURING-STAY-ADDONS-PLAN.md`](DURING-STAY-ADDONS-PLAN.md)) ï¿½ wrong-booking protection ï¿½ duplicate protection ï¿½ client-config architecture ï¿½ **exit criteria** ([`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)).

### Summary index (detail in master spec)

### 3x.1 ï¿½ Required field map

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

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ï¿½3x.1](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x1--required-field-map) + fixture tables keyed by `resolved_route`.

### 3x.2 ï¿½ Package explanation + package decision flow

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
| ï¿½What packages do you have?ï¿½ | Briefly explain all packages |
| Wants to book, package missing | Ask: accommodation only vs surf package |
| Unsure | Recommend by goal: cheapest ? shared accommodation; beginner ? lesson package; full arrange ? full surf; already surfs ? accommodation + rentals |
| Price question | Do **not** quote exact price unless dates, guest count, package, and price source are known |
| Still uncertain | Follow-up question or staff handoff |

### 3x.3 ï¿½ Wolfhouse knowledge collection

Operational gaps only (not public website facts). Questionnaire for Ale/Cami:

**Deliverable:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### 3x.4 ï¿½ WhatsApp history mining plan

Redacted Cami/Ale guest threads ? **dual outputs:** (A) anonymized bot knowledge + (B) structured customer memory (see ï¿½3x.5).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ï¿½3x.4](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x4--whatsapp-history-mining-plan); redacted samples under `docs/knowledge/whatsapp-samples/` (not in git until anonymized).

### 3x.5 ï¿½ Customer memory + WhatsApp history migration

Layered model: temporary raw import ? structured customer facts (PG, `client_id`-scoped) ? anonymized fixtures. Proposed tables: `customers`, `customer_booking_history`, `conversation_summaries`, `customer_preferences`, `customer_notes`, `privacy_requests` (future).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ï¿½3x.5](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x5--customer-memory--whatsapp-history-migration). Owner questions: [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) ï¿½ Customer memory.

### LLM safety requirements (across Stage 3x + Stage 4)

The bot must never act on LLM output alone for dangerous actions. The following are required:

| Requirement | Stage |
|-------------|-------|
| Low confidence ? human handoff (not silent no-op) | 3x.8 spec ? 3.5 impl |
| LLM/API error ? handoff or logged safe fallback | 3.5 |
| Parsing uncertainty ? clarification question, not action | 3x.8 spec ? 3.5 impl |
| `resolved_route`, confidence, selected booking, and action logged per execution | 3.5 |
| Golden-message suite used as prompt regression evaluation | 3x.6 ? 4 |
| Multilingual behavior tested: English / Spanish / Italian | 3x.6 |
| Bot never marks `paid` / `cancelled` / `confirmed` based only on LLM interpretation | 3x.7 gate ï¿½ proven in 3d.5b (webhook owns truth) |

### Stage 3x exit criteria

Documented in master spec ï¿½ planning complete when ï¿½3x.1ï¿½3x.11 + exit checklist exist; full golden fixture set may complete in 3x.3.

### 3x.6 ï¿½ Golden message tests

**30ï¿½50** realistic guest messages with expected:

- `resolved_route`
- Missing fields
- Safe action (or explicit no-op)
- Clarification question text (pattern, not exact LLM wording)
- Handoff behavior

**Categories to include:**

- Booking request ï¿½ package questions ï¿½ payment-link request ï¿½ ï¿½I paidï¿½
- Cancellation ï¿½ room preference ï¿½ couple/friends/gender rooming ï¿½ date changes
- Surfboard/wetsuit rental ï¿½ breakfast/transfer ï¿½ unclear / low-confidence messages

**Deliverable:** `docs/fixtures/golden-messages/` + runner stub (Stage 4+). Schema + samples in master spec ï¿½3x.6.

### 3x.7 ï¿½ Dangerous action gates

Strict proof required before:

| Action | Proof |
|--------|--------|
| Send payment link | Hold + Ensure + CPS contract; no terminal booking |
| Confirm booking | Webhook payment truth + Send Confirmation eligibility |
| Cancel booking | Booking status + policy |
| Change room/bed | Assignment rules + capacity |
| Change dates | Availability + policy |
| Mark payment-related states | Webhook or authorized staff only |

### 3x.8 ï¿½ Human handoff rules

Bot must stop guessing and alert staff when:

- Low route confidence
- Conflicting dates or guest count
- Multiple active holds for same conversation
- Guest says they paid but no payment record
- Refund / dispute / cancellation ambiguity
- Angry guest / complaint
- Medical / emergency / legal issues
- Rooming / reassign uncertainty

**Deliverable:** `handoffRules` spec ? later `client_config.handoff_rules`.

### 3x.9 ï¿½ Wrong-booking protection

Formalize (align with existing resolver + PG):

- `conversation.current_hold_booking_id` wins over phone-only fallback
- Terminal bookings (`confirmed`, `cancelled`, etc.) cannot be modified by guest path
- Old holds must not be selected because phone matches alone
- Active booking must match conversation context and latest intent

### 3x.10 ï¿½ Duplicate protection

Verify and document:

| Scenario | Expected |
|----------|----------|
| Same WhatsApp message id | No duplicate booking |
| Repeated payment-link request | No duplicate checkout session without idempotency |
| Same Stripe event id | No duplicate `payment_events` row |
| Confirmation | Cannot send twice (`confirmation_sent_at`, flags) |

### 3x.11 ï¿½ Client-config architecture plan

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

## Source-of-truth cutover ï¿½ Airtable ? Postgres

This is a **first-class roadmap event**, not a scattered implementation detail. Airtable is the current operational source of truth for staff. Postgres is the engineering source of truth for the bot. Cutover must happen deliberately.

### Cutover phases

| Phase | Description | Gate |
|-------|-------------|------|
| **Current** | Airtable = staff SoT; Postgres = bot SoT; dual-write in progress | Active |
| **Read-only compare** | Run both reads; log discrepancies; do not act on mismatch | Before any cutover |
| **`DATA_SOURCE` flag** | Config-driven: `airtable` \| `postgres` per path; allows per-path rollout | Stage 4 |
| **Soak period** | Postgres-primary writes; Airtable as backup read; monitor for divergence | Stage 4ï¿½5 |
| **Airtable dependency removal** | Only after staff UI or equivalent replacement exists | Stage 6+ |
| **Backup policy** | Full Airtable export + PG dump before each cutover step | Required |
| **Rollback plan** | Revert `DATA_SOURCE` flag; restore from backup; documented runbook | Required |

**Do not remove Airtable dependency** until:
1. Staff UI (Stage 6) or equivalent is live for all Airtable use cases it currently covers
2. PG data has passed a soak period without divergence
3. Backup and rollback procedure is documented and tested

---

## Privacy / GDPR gate before customer memory

**No Layer-2 structured customer memory with personal data until all of the following exist:**

| Requirement | Status |
|-------------|--------|
| Documented purpose for each stored personal field | Planned (3x.2) |
| Retention policy per field type | Planned (3x.2) |
| Staff-only note handling (no guest-facing access to staff notes) | Planned |
| Delete / export / correction procedure documented | Planned |
| Marketing opt-in separated from booking support data | Planned |
| Raw WhatsApp exports kept off-repo / in `data/private/` (gitignored) | **Done** (`84fa45f`) |
| Only reviewed/sanitized fixtures in repo | Policy established |

**This gate applies before 3x.3 customer extract is written to PG.** Planning (3x.2) may proceed; PG insert of personal data requires privacy gate first.

---

## Stage 4 ï¿½ Reliable

**Status (2026-05-30): CLOSE WITH DEFERRALS.** Autonomous Booking Dry-Run complete ï¿½ all 14 scenarios PASS (commit `6cd9a21`). Evidence: `test-payloads/stage4/autonomous-dry-run/README.md`. Live WhatsApp, live holds, live Stripe, and live confirmation writes remain deferred. Structured add-on records and staff ops assistant deferred to Stages 5ï¿½6.

### Purpose

Make the working system **dependable and observable** after Stage 3 behavior is proven and Stage 3x rules are specified.

### Entry gate (defined in baseline config + ï¿½3x.2b)

Gate definition: [`config/clients/wolfhouse-somo.baseline.json`](../config/clients/wolfhouse-somo.baseline.json) (`stage4_entry_gate`) and [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ï¿½3x.2b/ï¿½3x.2c](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x2c--applied-owner-answers-2026-05-29).

**Reduced after 3x.2c** (payment-link auto-send, hold expiry, confirmation content, conditional cancel/date-change, rooming auto-assign + operator-room logic all confirmed). **Remaining owner blockers:** deposit amount/scope ï¿½ non-7-night pricing math ï¿½ cancellation/refund windows & % ï¿½ add-on service prices/scheduling (if in Stage 4 scope) ï¿½ real WhatsApp send gate or Stage 3y shadow ï¿½ final handoff channel. **Not blockers:** perfect tone ï¿½ full customer memory ï¿½ marketing opt-in ï¿½ exact add-on automation.

**Additional entry requirement:** Autonomous booking dry-run pass ï¿½ bot completes full booking flow (inbound message ? route ? availability ? hold ? payment-link ? Stripe webhook ? confirmation) without errors in all-stubbed mode, proving readiness before real sends or live operation are enabled.

### Includes

- **Autonomous booking dry-run** (first Stage 4 milestone): full booking flow end-to-end ï¿½ inbound message ? route ? availability ? hold ? payment-link ? Stripe webhook ? confirmation ï¿½ with all live side effects stubbed at the infrastructure boundary. Proves the bot completes the booking correctly before real sends or live operation are enabled. This is the regression anchor: once green, enabling real WhatsApp send or live operation is a config change, not a behavior change.
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
- **Staff query assistant** (read-only ops Q&A: "who has a surfboard today?", "who arrives today?", "which rooms need cleaning and by when?") gated by an **approved-staff allowlist** (`staff_directory`; portal = Stage 6) ï¿½ [`STAFF-QUERY-ASSISTANT-PLAN.md`](STAFF-QUERY-ASSISTANT-PLAN.md)

### Add-on structured records (Stage 4 design requirement)

Add-on dry-run tests (e.g. A9 ï¿½ lessons, yoga, rentals) must do more than verify the guest-facing price quote is correct. They must also prove the system can **represent add-on requests as structured, staff-queryable records**. This is the data foundation that makes Stage 6 staff queries possible.

Each add-on request that passes through the bot should be representable as a record with at minimum:
- Guest / booking reference
- Add-on type (lesson, wetsuit, board, yoga, dinner)
- Quantity / number of days
- Requested date(s)
- Payment status (pending / paid)
- Fulfillment status (not redeemed / redeemed ï¿½ staff-managed)
- A flag indicating whether staff scheduling / manual tracking applies (e.g. lessons require a manual slot assignment)

**Stage 4 does not require full add-on automation.** It requires that when the bot processes an add-on request, the output can be persisted in a shape that is queryable by staff. If no structured add-on record is written yet, the design must identify where it would be written and what the schema looks like ï¿½ so Stage 5 does not have to invent it from scratch.

---

## Stage 5 ï¿½ Clean

**Status (2026-05-31): CLOSE WITH DEFERRALS ï¿½ source-of-truth cleanup complete (5.1ï¿½5.8b); engine extraction / portability scope deferred.** All staff-queryable data tables are schema-stubbed and query helpers are proven. Migrations 007 (add-ons) and 008 (staff handoffs) are ready to apply. Live operation, engine extraction, and staff UI remain deferred (Stage 6). Detail: [`PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md`](PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md).

### Purpose

Simplify implementation after behavior is proven and reliability checks exist.

### Safety-critical early extractions (pull forward to Stage 3.5 / 4 only if needed)

Do **not** do broad Stage 5 refactor before Stage 3 / 3.5 safety gates. However, pull forward **only** these safety-critical items when required:

- Wrong-booking guard (if not proven in Stage 3 negative tests)
- Dangerous-action gate checks (missing required business rule ? handoff)
- Duplicate / idempotency checks (if Stage 3.5 requires them in code)
- Bed-assignment overlap / dedup logic (if DB constraint is insufficient)
- `client_config` loading skeleton (if Stage 3x requires it for golden tests)

### Includes

- Move decision logic out of n8n into `src/booking-assistant/` (n8n becomes I/O only).
- **Extract along the portability seam** ([ï¿½ Engine portability](#engine-portability--adding-a-new-vertical-surf-shop--lessons)): shared spine vs `inventory/` + `catalog/` plugins ï¿½ do **not** produce a tidied-up surf-house monolith.
- Implement `InventoryProvider` with **lodging** as the first concrete provider; keep the interface generic enough for `slots` / `rentals`.
- Split `client_config` into **engine config** (spine) + **vertical config** (catalog / inventory / capabilities); rooming behind a capability flag.
- Replace serialized-into-n8n Code nodes (e.g. the resolver) with calls to the extracted, version-checked modules.

**Target:** n8n calls backend decision engine; Postgres writes go through shared SQL/modules; n8n performs WhatsApp/Stripe/Airtable I/O.

**Portability acceptance for Stage 5:** the Wolfhouse spine compiles and passes golden tests with **zero surf-house nouns** outside `inventory/lodging.*` and `client_config`. (Verify against the portability gate checklist.)

### Staff-queryable operational data (Stage 5 requirement)

Source-of-truth cleanup must explicitly produce the structured Postgres records that power Stage 6 staff queries. The data design goal is: **staff questions are answered from reliable structured records, not guessed from chat logs or Airtable exports.**

The following tables/models must be designed (and at minimum stubbed in schema) during Stage 5, before the Stage 6 staff assistant is built:

| Table / model | Answers the question |
|---|---|
| `add_on_orders` | Which guests have requested add-ons? What is the payment status per order? |
| `add_on_items` | Line-item detail per order (type, qty, days, dates, price) |
| `lesson_requests` | Who has lessons today / tomorrow? What slot? (staff assigns; bot records request) |
| `rental_requests` | Who requested a board / wetsuit? For how many days? Pickup status? |
| `yoga_requests` | Who paid for yoga? For which date? (redeemed on-site by staff) |
| `staff_handoffs` / `staff_tasks` | Which conversations need a human reply? Why was it handed off? Current state? |
| `payment_balances` (view or table) | Who still owes money? Who paid deposit but not full balance? |

These are **not new features** ï¿½ they are the structured forms of data the bot already collects. The goal of Stage 5 is to ensure that data lands in Postgres in a queryable shape instead of only in Airtable or serialized chat session state.

**Design gate for Stage 5:** before beginning Stage 6 staff UI work, verify that a staff member can ask each of the following questions and get a correct answer from Postgres without touching Airtable or reading raw WhatsApp messages:

- "Who paid for yoga today?"
- "Who has lessons tomorrow?"
- "Who still owes money?"
- "Who requested a board?"
- "Which bookings need a human reply?"
- "Show today's arrivals and departures."
- "Who paid deposit but not full balance?"
- "Which guests requested rooming preferences?"

---

## Stage 6 ï¿½ Beautiful (Staff / Admin Layer)

**Status: CLOSED WITH DEFERRALS** (2026-05-31) ï¿½ All exit criteria MET. 6.0ï¿½6.9 DONE: 35-intent registry, CLI runner, batch reports, CLI write action, HTTP API, browser UI, smoke test, token-gated write endpoint. Production auth/TLS/live-ops deferred to Stage 7. See [`PHASE-6-STAFF-ASSISTANT-PLAN.md`](PHASE-6-STAFF-ASSISTANT-PLAN.md).

**Implementation slices:** 6.1 registry DONE ? 6.2 CLI runner DONE ? 6.3 handoffs DONE ? 6.4a/b/c/d batch reports DONE ? 6.5a/b CLI write action DONE ? 6.6 HTTP API DONE ? 6.7 intent smoke DONE ? 6.8 read-only UI DONE ? 6.9 token-gated write endpoint DONE.

### Purpose

Excellent staff and owner experience. This is where the **two-sided product** becomes visible: the guest-facing assistant (already built) and the **staff-facing operations assistant** (built here).

### Two sides of the product

| Side | Who uses it | What it does |
|------|------------|--------------|
| **Guest assistant** | Guests on WhatsApp | Bookings, questions, payments, confirmations, add-ons, rooming, handoff |
| **Staff assistant / admin** | Ale, Cami, operators | Operational queries, action review/approval, conversation takeover, status dashboards |

### Staff Operations Assistant

Staff can ask operational questions and get answers from **structured Postgres records** (not chat logs or guesses). All queries are read-only, gated by `staff_directory` approved numbers.

**Example questions the staff assistant must answer:**

- "Who paid for yoga today?"
- "Who has lessons tomorrow?"
- "Who still owes money?"
- "Who requested a board?"
- "Which conversations need a human reply?"
- "Show today's arrivals and departures."
- "Who paid deposit but not full balance?"
- "Which guests requested rooming preferences?"

**Design constraint:** these questions are answered from the structured records built in Stage 5 (`lesson_requests`, `add_on_orders`, `staff_handoffs`, `payment_balances`, etc.). The assistant maps natural-language questions to fixed safe parameterized intents ï¿½ it never generates arbitrary SQL.

### Staff Approval Controls

Staff can review, approve, and act on bot proposals without going directly into n8n or Airtable:

- View bot draft reply before it is sent
- Approve or reject risky bot action proposals (payment, cancellation, room reassign)
- Take over a conversation from the bot
- View payment / hold / rooming / add-on status per booking
- Mark add-on as redeemed (voucher fulfilled on site)
- Release or block operator rooms

### Staff UI

- Calendar / bed grid, guest list, booking detail
- Payment status, pending holds, confirmation queue
- Conversation history, human takeover
- Manual booking / edit / cancel tools
- Room/bed assignment UI
- Alerts for stuck workflows
- Owner dashboard

Airtable may remain a **bridge** during transition; long-term goal is a proper staff UI, not Airtable as daily ops surface.

**Airtable cutover prerequisite:** the staff UI (or equivalent) must cover all use cases Airtable currently serves before Airtable is removed as a dependency ï¿½ see the Source-of-truth cutover table above.

---

## Stage 7 ï¿½ Scalable

**Status: PLANNING CLOSED / IMPLEMENTATION STARTED** (2026-05-31) ï¿½ 7.0ï¿½7.6 DESIGN DONE. **7.2b+7.2c DONE**: migration 009 + auth middleware scaffold (login/logout/session/role checks) applied to local/dev. Staging/prod NOT secure. Next: 7.3b Azure scaffold or Cami dashboard plan: [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md), [`PHASE-7.1-ENV-SECRETS-INVENTORY.md`](PHASE-7.1-ENV-SECRETS-INVENTORY.md), [`PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md`](PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md), [`PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md`](PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md). Production hardening + pilot deployment defined (environments, auth, TLS, monitoring, backups, rollback, Airtable cutover gate, live WhatsApp/Stripe gates, pilot soak, go/no-go). 7.3 recommends Azure Container Apps (aligned with [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md)). No implementation; live operation NOT approved.

### Purpose

Repeatable platform for multiple clients, plus production hardening and a controlled Wolfhouse pilot.

### Includes

- Multi-client config onboarding
- Client-specific room/package rules (config-driven)
- Isolated data per `client_id`
- Reusable deployment process (see [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md) when approved)
- Billing/subscription model (product)
- Support tools, backup/restore, per-client monitoring
- Migration path away from Airtable
- Templates for surf houses, retreats, hostels, camps

### Adding the second vertical (surf shop / lessons)

By Stage 7 this should be a **checklist, not a project** ï¿½ provided the Stage 5 portability seam holds:

1. Start from the paper-tested sample config (`config/clients/surf-shop-rental.sample.json` / `surf-school.sample.json` drafted in 3x.3) ? promote to a real client config.
2. Fill the **vertical config** (catalog/offerings, inventory model, capabilities) and **engine config** (payment, handoff, llm, privacy) ï¿½ reuse the Wolfhouse engine defaults.
3. Implement or reuse the matching `InventoryProvider` (`rentals` / `slots`); **no new workflows** if lodging was the only thing forked before.
4. Add `client_id`-scoped data; seed inventory/offerings.
5. Run the **`client_id`-parameterized golden suite** for the new vertical before any live/shadow operation.
6. Onboard via Stage 3y **shadow/co-pilot mode** first (staff-approved), exactly as Wolfhouse did ï¿½ never straight to autonomous.

**If step 3 requires touching the shared spine, that is a portability regression** ï¿½ fix the seam, don't fork the workflow.

**Guiding principle:** Build Wolfhouse first; structure everything as **client #1**, not the only client.

---

## What to read next

| Role | Doc |
|------|-----|
| Product vision (15 pillars) | [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md) |
| Engineer (today) | [`PROJECT-STATE.md`](PROJECT-STATE.md) |
| Stage 3x spec | [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) |
| Owner / non-engineer | [`PROJECT-ROADMAP.md`](PROJECT-ROADMAP.md) |
| Agent rules | [`../CURSOR.md`](../CURSOR.md) |
| Stripe test gates | [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) |
