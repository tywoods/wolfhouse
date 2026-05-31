# Wolfhouse — Product Master Roadmap

**Purpose:** Track the **full product vision** as 15 pillars, mapped to the engineering stages already in flight. This is the **product-level** roadmap; the **stage-level / engineering** roadmap is [`ROADMAP.md`](ROADMAP.md), and the live engineering snapshot is [`PROJECT-STATE.md`](PROJECT-STATE.md).

**Product category:** AI booking operations for WhatsApp-first experience businesses (AI front desk for WhatsApp-heavy experience operators). **Beachhead:** Wolfhouse surf house (`wolfhouse-somo`) as client #1.

**Last updated:** 2026-05-31

---

## How to read this document

- **Pillars** describe *what the product is* (capabilities a customer/owner would recognize).
- **Stages** (3, 3.5, 3x, 3y, 4, 5, 6, 7) describe *how we build safely* (engineering gates). See [`ROADMAP.md`](ROADMAP.md).
- A pillar usually spans **multiple stages**; a stage usually advances **multiple pillars**.
- Status labels are deliberately conservative. **Nothing here marks an unproven capability as done.**

### Status legend

| Label | Meaning |
|-------|---------|
| **Proven** | Demonstrated under a gate with evidence (dry-run acceptable where noted) |
| **In progress** | Actively being built this stage |
| **Planned** | Designed or scheduled, not yet built |
| **Deferred** | Explicitly postponed with a documented reason |
| **Not started** | No design or implementation yet |

> Dry-run / local proofs are **not** the same as live production operation. Live WhatsApp, live Stripe writes, live holds, and Airtable cutover remain deferred across multiple pillars — see each pillar's deferrals.

---

## Pillar → Stage map (at a glance)

| # | Pillar | Primary stage(s) | Status |
|---|--------|------------------|--------|
| 1 | Guest Booking Assistant | 3, 3x, 3y, 4 | Proven (dry-run); live deferred |
| 2 | Source-of-Truth Database | 3c, 5 | Proven (schema + cleanup); cutover deferred |
| 3 | Staff Assistant Brain | 5 (data), 6 | CLOSED WITH DEFERRALS |
| 4 | Staff Operations Dashboard | 6 | Planned (CLI-first underway) |
| 5 | Rooming / Bed Grid UI | 3e (engine), 6 (UI) | Engine proven; UI not started |
| 6 | Add-ons & Revenue Layer | 4 (pricing), 5 (records), 6 (queries) | In progress |
| 7 | Staff Messaging Bridge | 3y (handoff), 6+ | Planned / deferred |
| 8 | Multi-Client Config System | 3x.11, 5 | Planned (config schema started) |
| 9 | Client Onboarding System | 7 | Planning (Stage 7 plan) |
| 10 | PMS / Integration Layer | 7 | Not started |
| 11 | AI Intent Layer | 3x, 4 | Proven (guest); staff NL deferred |
| 12 | Analytics / Owner Dashboard | 6+ / 7 | Not started |
| 13 | Production Hardening | 3.5, 4, 7 | Partial (safety rails proven); Stage 7 PLANNING CLOSED: 7.0–7.6 design done. Implementation pending: Azure deploy, auth (migration 009), restore drill, Cami dashboard, monitoring config. Pilot decision: NO_GO. |
| 14 | Multi-Client Admin | 7 | Not started |
| 15 | Productization / Scale | 7 | Not started |

---

## 1. Guest Booking Assistant

**Purpose:** The guest-facing WhatsApp assistant ("Luna") that handles availability, holds, package explanation, payment links, payment truth, confirmations, add-ons, rooming preferences, and human handoff.

**Current status:** **Proven in dry-run.** Stage 4 Autonomous Booking Dry-Run closed with deferrals (commit `6cd9a21`): all 14 scenarios PASS (A1–A10, A9, IT-1/2/3, DE-1), protected tables Δ=0 across all gates. Stage 3y shadow/co-pilot Mode A: all 10 payloads offline-safe PASS. Live operation **not** enabled.

**Related stages:** Stage 3 (correct & safe), Stage 3x (knowledge/guardrails), Stage 3y (shadow/co-pilot), Stage 4 (reliable).

**Major milestones:**
- Hold creation, payment-details route, real Stripe checkout link (Main-integrated) — Stage 3d, proven.
- Integrated pay → webhook truth → dry-run confirmation chain — proven on `WH-260528-5369`.
- Closed-month guard, multi-turn PG conversation state, multilingual baseline — Stage 4, proven.
- Idempotency + wrong-booking guards — Stage 3e, closed with deferrals.

**Deferrals / not started:**
- Real WhatsApp send (dry-run only today).
- Live Stripe writes / live holds / live confirmation writes.
- Send Confirmation schedule-poll mode; single-window integrated E2E.
- Full package intelligence and extensive multilingual polish (Italian primary acceptance language still pending).

---

## 2. Source-of-Truth Database

**Purpose:** Postgres as the authoritative store for bookings, payments, payment_events, beds, conversations, handoffs, and add-on records — so every other pillar reads reliable structured data instead of chat logs or Airtable exports.

**Current status:** **Proven for schema + cleanup.** Stage 5 SoT cleanup CLOSED WITH DEFERRALS (`ae545a2`). All staff-queryable schemas stubbed; migrations **007 (add-ons)** and **008 (staff handoffs)** applied to local/dev DB; fixture smoke 26/26 PASS; `hostel_id→client_id` reconciliation bugfix. Luna staff handoff write path wired and runtime-proven (Stage 5.9b, `de6c3c0`).

**Related stages:** Stage 3c (PG availability/hold/ensure/conversation), Stage 5 (SoT cleanup).

**Major milestones:**
- PG hold + ensure-promote + availability + conversation upsert in Main fork — Stage 3c.
- Structured tables for staff queries: `add_on_orders`, `add_on_items`, `lesson_requests`, `rental_requests`, `yoga_requests`, `staff_handoffs`, `payment_balances` view — Stage 5.
- Idempotent handoff write (`Postgres - Open Staff Handoff`, NOT EXISTS guard) — Stage 5.9b.

**Deferrals / not started:**
- **Airtable → Postgres cutover** (the first-class roadmap event) — gated on staff UI (Stage 6) + soak period + tested rollback. See [`ROADMAP.md` § Source-of-truth cutover](ROADMAP.md#source-of-truth-cutover--airtable--postgres).
- Production data migration of real customer memory (blocked by privacy/GDPR gate).

---

## 3. Staff Assistant Brain

**Purpose:** The read-only operations brain that answers staff questions ("who still owes money?", "who arrives today?", "which conversations need a human reply?") from structured Postgres records via a fixed, safe query registry — never arbitrary SQL.

**Current status:** **CLOSED WITH DEFERRALS (2026-05-31).** All Stage 6 exit criteria MET: 35-intent registry, CLI runner, batch reports (6.4a–6.4d), CLI write action (6.5a/b), read-only HTTP API (6.6), 35-intent smoke test (6.7), read-only browser UI (6.8), token-gated HTTP write endpoint (6.9). All proofs against dev DB with zero protected-table delta. Production auth/TLS/live-ops deferred to Stage 7.

**Related stages:** Stage 5 (data foundation), Stage 6 (assistant layer).

**Major milestones:**
- Stage 6.1 — staff query registry (35 intents) + static verifier.
- Stage 6.2 — staff query CLI runner with audit log.
- Stage 6.3 — handoff queue batch report.
- Stage 6.4a/6.4b/6.4c/6.4d — payments, rooming, add-ons batch reports + combined digest — DONE.
- Stage 6.5a/6.5b — proposal-only + confirmed CLI handoff.resolve write action — DONE.
- Stage 6.6 — read-only HTTP API (GET /staff/query, GET /staff/intents) — DONE.
- Stage 6.7 — 35-intent smoke test, 0 failed, 144 rows, protected tables unchanged — DONE.
- Stage 6.8 — read-only browser UI at GET /staff/ui — DONE.
- Stage 6.9 — token-gated POST /staff/handoff/:id/resolve — DONE.

**Deferrals / not started:**
- Natural-language question parsing (intent classification) — currently explicit intent keys only.
- Safe write/action intents (handoff resolve, mark add-on redeemed) — Stage 6.5 stubs, then gated runtime.
- HTTP API surface — Stage 6.6 (deferred).

---

## 4. Staff Operations Dashboard

**Purpose:** The staff-facing surface for daily operations: stuck bookings, payment status, pending confirmations, handoff queue, arrivals/departures, add-on fulfillment.

**Current status:** **CLI and read-only browser UI proven (Stage 6).** Batch reports, HTTP API, and GET /staff/ui read-only browser page implemented. Full dashboard (calendar, bed grid, write controls, conversation history) deferred to Stage 7 after auth gate.

**Related stages:** Stage 6.

**Major milestones:**
- CLI batch reports (handoffs / payments / rooming / add-ons / digest) — DONE (Stage 6.3–6.4d).
- Add-ons batch report — planned (Stage 6.4c).
- Visual dashboard / web UI — planned, later in Stage 6.

**Deferrals / not started:**
- Web dashboard, auth/roles, real-time views.
- Owner-facing summaries (overlaps Pillar 12).

---

## 5. Rooming / Bed Grid UI

**Purpose:** Visual bed/room assignment management — calendar/bed grid, drag-to-assign, conflict and gender-rule visibility — on top of the proven rooming engine.

**Current status:** **Engine proven; UI not started.** Rooming/reassign E2E proven in Stage 3e (`WH-260528-5322`, beds R3-B1/R3-B2). Read-only rooming queries (roster, unassigned, review, preferences, occupied beds, arrivals) proven via Stage 6 batch report. No graphical grid UI yet.

**Related stages:** Stage 3e (engine), Stage 6 (UI).

**Major milestones:**
- Bed-ops assign / cancel / reassign forks — Stage 3b/3e, proven.
- Read-only rooming reporting — Stage 6.4b, proven (dev DB).

**Deferrals / not started:**
- Graphical bed grid / calendar UI.
- Interactive staff-driven reassignment from a UI (vs CLI/n8n today).

---

## 6. Add-ons & Revenue Layer

**Purpose:** Represent and operate paid extras (lessons, yoga, rentals, meals, transfers) as structured, staff-queryable, revenue-bearing records — quote, request, pay, redeem.

**Current status:** **In progress.** Add-on pricing proven in Stage 4 dry-run (A9). Structured add-on schema (migration 007: `add_on_orders`, `add_on_items`, `lesson_requests`, `rental_requests`, `yoga_requests`) stubbed and applied in Stage 5. Add-on query helpers exist in the Stage 6 registry; add-ons batch report planned (Stage 6.4c).

**Related stages:** Stage 4 (pricing), Stage 5 (records), Stage 6 (queries / fulfillment).

**Major milestones:**
- Add-on price quoting (guest-facing) — Stage 4, proven (dry-run).
- Structured add-on records — Stage 5, schema proven.
- Staff add-on queries (unpaid, lessons, yoga, rentals, etc.) — Stage 6 registry, in progress.

**Deferrals / not started:**
- Add-on payment-link path in Main workflow (not yet confirmed; A9 deferred at runtime).
- Add-on redemption/fulfillment write path (mark redeemed) — Stage 6.5+.
- Revenue reporting / reconciliation (overlaps Pillar 12).

---

## 7. Staff Messaging Bridge

**Purpose:** Let staff receive handoffs and reply to guests through the system (e.g., WhatsApp staff bridge / approval queue) rather than copy-pasting manually.

**Current status:** **Planned / deferred.** Handoff **detection + write** proven (Stage 3y handoff routing; Stage 5.9b structured `staff_handoffs` write). The actual messaging bridge (staff reply path, approval queue UI) is not built. Stage 3y Mode C/D (staff-approved draft queue / action proposals) are explicitly deferred.

**Related stages:** Stage 3y (handoff + approval modes), Stage 6+ (bridge surface).

**Major milestones:**
- Handoff trigger rules + structured handoff rows — proven.
- Staff-approved draft queue (Mode C) — deferred.
- Staff-approved action proposals (Mode D) — deferred, requires Stage 6 UI + all 3x complete.

**Deferrals / not started:**
- Live staff WhatsApp send.
- Approval queue UI and conversation takeover surface.

---

## 8. Multi-Client Config System

**Purpose:** One assistant engine, per-client configuration (packages, room rules, pricing, deposit/cancellation policy, handoff rules, language/tone, integrations) so a new property is a config change, not a fork.

**Current status:** **Planned — schema started.** Config architecture specified in Stage 3x.11; Wolfhouse baseline config exists (`config/clients/wolfhouse-somo.baseline.json`, vertical `lodging_surf_house`). Engine extraction along the portability seam (shared spine vs `inventory/`+`catalog/` plugins) is **deferred** out of Stage 5.

**Related stages:** Stage 3x.11 (config plan), Stage 5 (extraction — deferred), Stage 7 (multi-vertical).

**Major milestones:**
- Client-config category plan + deploy-config template — Stage 3x, done (docs/config).
- Wolfhouse baseline config v0.3 (provisional pricing/policies) — Stage 3x.2d.

**Deferrals / not started:**
- Split `client_config` into engine vs vertical config (Stage 5 extraction backlog).
- `InventoryProvider` abstraction implemented in code (lodging first).
- Confirmed (owner-signed) pricing/policy config (3x.2 in progress).

---

## 9. Client Onboarding System

**Purpose:** A repeatable process/tooling to stand up a new client (fill config template, seed inventory/offerings, run client-scoped golden suite, onboard via shadow mode).

**Current status:** **Not started.** The onboarding *contract* is documented (deploy config + gitignored secrets per client), and the portability gate is defined, but no onboarding tooling exists.

**Related stages:** Stage 7.

**Major milestones:**
- Onboarding contract + deploy-config template — documented (Stage 3x).
- Onboarding tooling / wizard — not started.

**Deferrals / not started:**
- Client onboarding UI, settings editor, inventory seeding tools — all Stage 7.

---

## 10. PMS / Integration Layer

**Purpose:** Integrations with property-management systems, channel managers, and external booking sources beyond WhatsApp + Stripe + Airtable.

**Current status:** **Not started.** Current integrations are WhatsApp (I/O), Stripe (payments), Airtable (legacy staff SoT, being migrated). No PMS/channel-manager integration exists.

**Related stages:** Stage 7.

**Major milestones:** none yet.

**Deferrals / not started:**
- All PMS/channel-manager integrations — Stage 7, after Wolfhouse pilot + multi-client base.

---

## 11. AI Intent Layer

**Purpose:** The LLM-driven routing/intent/extraction layer that classifies guest messages, extracts booking details, and (later) maps staff natural-language questions to safe query intents — always behind safety guards.

**Current status:** **Proven for guest routing.** Guest message routing, detail extraction, multilingual detection, and low-confidence → handoff behavior proven in Stage 4 dry-run. The bot never acts on LLM output alone for dangerous actions (webhook owns payment truth). **Staff-side** natural-language → query-intent mapping is **deferred** (Stage 6 uses explicit intent keys today).

**Related stages:** Stage 3x (LLM safety requirements), Stage 4 (routing proven), Stage 6 (staff NL — deferred).

**Major milestones:**
- Route resolver + override logic + confidence gating — proven.
- Multilingual baseline (EN/ES + DE; Italian primary acceptance pending) — partial.

**Deferrals / not started:**
- Staff natural-language question parsing.
- Golden-message suite as prompt-regression evaluation at scale (3x.6 → Stage 4 hook).

---

## 12. Analytics / Owner Dashboard

**Purpose:** Owner-facing insight — occupancy, revenue, add-on uptake, conversion, handoff volume, payment health — derived from the source-of-truth database.

**Current status:** **Not started.** The structured data foundation (Pillars 2, 6) is being built, which is a prerequisite, but no analytics or owner dashboard exists.

**Related stages:** Stage 6 (read foundation) → Stage 7 (owner product).

**Major milestones:** none yet.

**Deferrals / not started:**
- Owner dashboard, revenue/occupancy analytics, KPI views — Stage 6+/7.

---

## 13. Production Hardening

**Purpose:** Make the system dependable and observable in production — error capture, idempotency, monitoring/alerts, health checks, runbooks, rollback tooling.

**Current status:** **Partial — safety rails proven.** Stage 3.5 CLOSED (`d08c64e`): minimum safety bar met (error capture, idempotency checks, overlap guards, execution logging, golden-runner stub). Stage 4 reliability dry-run proven. Full production monitoring/dashboards, Azure deploy, and live health checks remain deferred.

**Related stages:** Stage 3.5 (safety rails), Stage 4 (reliability), Stage 7 (production deploy).

**Major milestones:**
- `automation_errors` / `workflow_events` wired; idempotency (message id, Stripe event id, confirmation) — Stage 3.5, proven.
- Autonomous booking dry-run as regression anchor — Stage 4, proven.

**Deferrals / not started:**
- Full monitoring dashboards, alerts, health checks across n8n/PG/Redis/webhooks.
- Azure deploy, production URLs, backup/restore automation — Stage 7 (staging deployment + TLS designed in [`PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md`](PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md): Azure Container Apps, Key Vault, HTTPS — design only, not deployed).
- Stuck-booking detection at production bar.

---

## 14. Multi-Client Admin

**Purpose:** Cross-client administration — per-`client_id` isolation, per-client monitoring, support tooling, tenant management.

**Current status:** **Not started (design begun).** All data is `client_id`-scoped by design (Wolfhouse = `wolfhouse-somo`), which is the prerequisite, but there is no multi-client admin surface. Stage 7.2 designed the staff auth model (per-user accounts, viewer/operator/admin roles, optional `staff_user_client_access` for multi-client) — design only, not built. See [`PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md`](PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md).

**Related stages:** Stage 7.

**Major milestones:** none yet.

**Deferrals / not started:**
- Tenant admin, per-client monitoring/isolation tooling, support console — Stage 7.

---

## 15. Productization / Scale

**Purpose:** Turn the proven Wolfhouse system into a repeatable, sellable platform — billing/subscriptions, templates per vertical, second vertical live, scale infrastructure.

**Current status:** **Not started.** Portability seam and second-/third-vertical sample-config paper tests are *planned* in the roadmap; no productization work has begun. Build Wolfhouse as client #1 first.

**Related stages:** Stage 7.

**Major milestones:**
- Portability gate + sample vertical configs (paper test) — planned (3x.3 / Stage 5 backlog).
- Second `InventoryProvider` (slots/rentals) + 2nd client live — Stage 7.

**Deferrals / not started:**
- Billing/subscription model, vertical templates, scale infra, multi-vertical go-live — Stage 7.

---

## Product principle (carried from ROADMAP)

> Build **Wolfhouse as client #1**, not as the only client the system can ever serve. Everything above the `inventory/` and `catalog/` seam is the shared spine and must contain **no surf-house-specific nouns**. A new vertical = new config + (at most) one new inventory provider.

See [`ROADMAP.md` § Engine portability](ROADMAP.md#engine-portability--adding-a-new-vertical-surf-shop--lessons) for the portability gate.

---

## What to read next

| Need | Doc |
|------|-----|
| Product-level roadmap (this) | `PRODUCT-MASTER-ROADMAP.md` |
| Stage-level / engineering roadmap | [`ROADMAP.md`](ROADMAP.md) |
| Live engineering snapshot | [`PROJECT-STATE.md`](PROJECT-STATE.md) |
| Architecture north star | [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) |
| Stage 6 staff assistant plan | [`PHASE-6-STAFF-ASSISTANT-PLAN.md`](PHASE-6-STAFF-ASSISTANT-PLAN.md) |
