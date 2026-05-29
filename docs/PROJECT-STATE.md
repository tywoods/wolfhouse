# Wolfhouse ? Project State

**Last updated:** 2026-05-30 (Stage 4 Autonomous Booking Dry-Run scaffolded: A1-A10 payloads + runner + README)
**HEAD (expected):** `d2288b7` (Stage 3.5d: harden Assign overlap conflict path)

**Roadmap:** [ROADMAP.md](ROADMAP.md) (stages 3?7, 3x guardrails) ? **Architecture:** [ARCHITECTURE-NORTH-STAR.md](ARCHITECTURE-NORTH-STAR.md) ? **Agent:** [CURSOR.md](../CURSOR.md)

**Quality bar:** Stage 3 — CLOSED. Stage 3.5 — CLOSED (d08c64e). Stage 3y — Mode A gate 5 all 10 PASS (Y-X13 decision: fbd6fbc). **Stage 4 — Autonomous Booking Dry-Run scaffolded (2026-05-30):** A1-A10 scenario payloads created, validator runner scaffolded. Stub shapes defined. Required implementation changes listed in README. No runtime yet.

---

## Product

**Wolfhouse Booking Assistant** ? client #1 (**beachhead**) for the broader product category: **AI booking operations for WhatsApp-first experience businesses** (AI front desk for WhatsApp-heavy experience operators).

**Wolfhouse scope today:** surf house ? availability, holds, Stripe, confirmations, bed assignment, reassign, cancel, manual entries, operator room release.

**Product direction:** Same engine + `client_config` should eventually serve adjacent verticals (surf schools, rental shops, tour operators, etc.) without re-architecting ? see [ROADMAP.md ? Client category](ROADMAP.md#client-category--market-positioning).

**Quality bar today:** Stage 3 ? correct and safe. See [ROADMAP.md ? Stage 3](ROADMAP.md#stage-3--correct-and-safe).

**Architecture direction:** n8n orchestrates; backend/code decides; Postgres remembers; client config controls; staff UI manages (later). Do not grow business logic indefinitely inside n8n ? Stage 3x defines specs; Stage 5 migrates logic to `src/booking-assistant/`.

---

## Stage snapshot (product roadmap)

| Stage | Status | Notes |
|-------|--------|--------|
| **3** Correct and safe | **CLOSED ? local safety bar** (2026-05-29) | 3e.5 wrong-booking CLOSED (L1+L2, L3 deferred); 3e.6 idempotency CLOSED (I1+I4+I6 PASS; I2/I3/I5 deferred to Stage 3.5/cutover). Caveats: real WhatsApp, Airtable-coupled L3, Stripe/payment gates remain deferred. |
| **3.5** Safety rails | **CLOSED ? minimum safety bar MET (d08c64e)** | [PHASE-3.5-SAFETY-RAILS-PLAN.md](PHASE-3.5-SAFETY-RAILS-PLAN.md). 3.5a ACCEPTED. 3.5b Gap 2 runtime PASS (exec 1089). 3.5e success-path logging runtime PASS. 3.5c/I3 runtime PASS (execs 1093/1094). 3.5d D1+D2+D3 L2 PASS + wire-in static PASS; D8 runtime BLOCKED/deferred (Airtable-coupled upstream). 3.5f I3 PASS + I2/I5 deferred with written reason. 3.5g closeout G1?G13 DONE. Deferrals: D6/D8/D9/I2/I5 runtime ? Airtable cutover; Gap 1/Gap 3 runtime ? Stage 4; 3.5d.8b PG-only trigger path ? NOT REQUIRED before Stage 3y. **Next: Stage 3.5 closeout commit (user approves), then Stage 3y shadow/co-pilot planning.** |
| **3x** Bot knowledge + guardrails | **3x.1 planning complete (docs)** | Master spec [STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md); execution 3x.2?3x.4 pending |
| **3y** Shadow / co-pilot | **MODE A GATE 5 ALL 10 PASS — closeout decision made (2026-05-30)** | [PHASE-3y-SHADOW-COPILOT-PLAN.md](PHASE-3y-SHADOW-COPILOT-PLAN.md). All 10 payloads offline-safe PASS. 69 dry-run gates, zero mutations. Y-X13 decision: proceed to Stage 4. Mode B/C/D deferred (non-blocking parallel work). Next: Stage 4 Autonomous Booking Dry-Run. |
| **4** Reliable | **Autonomous Booking Dry-Run — scaffolded (2026-05-30)** | A1–A10 scenario payloads + validator runner created. Next: implement shaped stub returns in `build-main-local-stripe.js` to allow full flow, then extend runner to POST and execute. |
| **5** Clean | Planned | Decision engine out of n8n |
| **6** Beautiful | Planned | Staff UI; Airtable cutover |
| **7** Scalable | Planned | Multi-client + Azure when approved |

---

## Environments

| Environment | Role | Rule |
|-------------|------|------|
| **Hosted prototype** | Airtable + n8n Cloud (`tywoods.app.n8n.cloud`) | **Do not change** while building here |
| **This repo (local)** | Postgres + Docker n8n + generated `n8n/phase2/` forks | All new implementation; dummy data OK |

---

## Completed major phases

### Phase 2 local (frozen)

Stripe test path, Main (local Stripe) fork, Send Confirmation (local), Booking Flow Router hardening. Signed off ? [`PHASE-2-FREEZE.md`](PHASE-2-FREEZE.md).

### Phase 3b (frozen)

| Area | Sign-off | Key commit (examples) |
|------|----------|------------------------|
| Cancel / Assign / Reassign | 2026-05-26 | 3b.1?3b.3 runbooks |
| Manual Entries local fork | 2026-05-27 | `8aa74b9` |
| Operator Room Release MVP | 2026-05-27 | `de26bd4` |

Details: [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md).

### Phase 3c + 3d (frozen)

Formal checkpoint: **[`PHASE-3c-3d-FREEZE.md`](PHASE-3c-3d-FREEZE.md)** ? 3c stub path + 3d real Stripe / webhook / Send Confirmation dry-run. **Do not** reuse evidence bookings without reset. Phase **3e.3+** rooming work continues after freeze commit.

### Phase 3c (closed scope) ? Main / Postgres local + stub

| Substep | Status | Commit (if applicable) |
|---------|--------|-------------------------|
| **3c** proposal | Done | `2cd7ede` |
| **3c.a** Main workflow inventory | Done | `0b4bd8e` |
| **3c.b** PG availability report (SELECT-only) | Done | `32315db` |
| **3c.c.1** Hold read-only plan | Done | `1a8ebba` |
| **3c.c.2** Active-hold guard fixture | Done | `0741a9f` |
| **3c.c.3** Hold execute CLI | Done | `50294d3` |
| **3c.c.4** Ensure Booking promote CLI | Done | `8abfd4d` |
| **3c.d** Conversation / `current_hold` plan | **Proposal done** ? [`PHASE-3c-d-PROPOSAL.md`](PHASE-3c-d-PROPOSAL.md) | docs only |
| **3c.e.1** Build target map + neutralize + `--verify-targets` | **Done** (uncommitted) | ? |
| **3c.e.2** Ensure promote SQL in Main fork | Done | `c89890a` |
| **3c.e.3** PG availability gate in Main fork | Done | `5bdd465` |
| **3c.e.4** PG hold + AT backfill in Main fork | Done | `881ab1b` |
| **3c.e.5** PG conversation upsert | **Done** (uncommitted) | ? |
| **3c.f** Payment / confirmation contract checks | **Review complete (3c.f.4)** ? local-stub payment-details path signed off; real Stripe path still pending | [`PHASE-3c-f.md`](PHASE-3c-f.md) |
| **3c.g** E2E local Main tests | **3c.g.2l success** ? fresh E2E `booking_flow -> payment_details_provided` local stub path proven | [`PHASE-3c-g.md`](PHASE-3c-g.md) |

**Phase 3c local Main+PG+stub scope is complete.** The proven boundary is: fresh `booking_flow` hold creation and fresh `payment_details_provided` promotion/link-update path with local stub callback and no forbidden side effects.

Runbooks: [`PHASE-3c-PROPOSAL.md`](PHASE-3c-PROPOSAL.md), [`PHASE-3c-a.md`](PHASE-3c-a.md), [`PHASE-3c-b.md`](PHASE-3c-b.md), [`PHASE-3c-c.md`](PHASE-3c-c.md), [`PHASE-3c-f.md`](PHASE-3c-f.md), [`PHASE-3c-g.md`](PHASE-3c-g.md).

### 3c.f latest runtime evidence (3c.f.3af)

- Main execution `1009` succeeded on `payment_details_provided`.
- Stub execution `1010` succeeded; checkout URL returned from `example.test`.
- Ensure resolved target booking idempotently (`action=refreshed`) for `WH-260528-1493`.
- No legacy Create Payment Session execution, no Stripe call, no `payments`/`payment_events` writes, no `booking_beds` writes.
- Booking remained safe: `payment_pending/waiting_payment`, `send_confirmation=false`, `confirmation_sent_at=NULL`.
- Queue-mode callback URL requirement: use `http://n8n:5678/webhook/create-payment-session-stub-local` (worker-reachable), not `localhost`/`127.0.0.1`.

### 3c.f.4 sign-off posture

- **Go:** continue 3c.g runtime coverage and broader local integration tests.
- **No-go (still pending):** real Stripe production path and real Stripe webhook-confirmation chain.
- Key residuals tracked in [`PHASE-3c-f.md`](PHASE-3c-f.md):
  - queue-mode callback URL dependency (`http://n8n:5678/...`);
  - Airtable still in payment path;
  - hosted reassign URL ? **remapped** in 3e.2 (`8dfa450`);
  - prepare-context blank `booking_code` mitigated by Ensure Airtable-record fallback.

### 3c.g.2l fresh E2E evidence (latest)

- POST #2 runtime success with Main execution `1036` and stub execution `1037`.
- Resolver route correctness: `resolved_route=payment_details_provided`, override decision `R2F_PAYMENT_DETAILS_PRIORITY_ON_CONTACT_AND_LINK_FROM_HANDOFF`.
- Correct hold selection and update:
  - Search Hold selected fresh Airtable record `rec4VXB7Rf1VxDr0C` (not old `recIP3DFb0nCx8gBh`).
  - Ensure promoted target booking `WH-260528-9437` to `payment_pending/waiting_payment`.
  - Stub returned `https://example.test/...` checkout URL and payment link write targeted fresh record only.
- Safety maintained:
  - no legacy Create Payment Session execution;
  - no Stripe call;
  - `payments/payment_events` unchanged globally (`23/3`) and unchanged for target booking (`0/0`);
  - no `booking_beds` writes;
  - no Send Confirmation side effect;
  - Main/stub/legacy workflows returned inactive.

### Phase 3d (in progress) ? isolated Stripe path + integrated Main?pay?webhook?dry-run confirm complete

| Substep | Status | Notes |
|---------|--------|-------|
| **3d.1** Isolated Stripe planning gate | Done | [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) |
| **3d.2** Stripe contract static checker | Done | `npm run db:report:stripe-contract` |
| **3d.3** Direct CPS test plan | Done | docs-only |
| **3d.4a** Preflight blockers cleared | Done | deactivate webhook/confirmation; CPS target `esuDIT96iPT63OaQ`; local cancel URL |
| **3d.4b** `.env.example` local cancel URL | Done | `fb6ceb9` |
| **3d.4** Direct isolated Create Payment Session | **PASS** | execution **1050**; booking `WH-260528-1493`; `cs_test_...` session; no webhook/confirmation/Main side effects |
| **3d.5** Stripe Webhook Handler isolated plan | Done | [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) ?3d.5 |
| **3d.5a** Webhook preflight + schedule isolation | **Done** | read-only checks; n8n DB schedule disable (local only) ? ?3d.5a |
| **3d.5b** Isolated webhook runtime | **PASS** | execution **1058**; `evt_test_phase3d5b_001`; booking `WH-260528-1493` payment truth; no confirmation/WhatsApp |
| **3d.6a** Send Confirmation preflight | **Done** | read-only; Option B direct webhook |
| **3d.6b** Send Confirmation runtime (1st) | Safe / functional FAIL | exec **1059**; Airtable Conversation 0 rows stopped chain |
| **3d.6c** Postgres credential / SQL verify | **Done** | no runtime; credential name alignment |
| **3d.6d** Airtable-empty fallback patch | **Done** | `324c104`; `alwaysOutputData` on Conversation + Booking Beds |
| **3d.6e** Send Confirmation runtime retry | **PASS** | exec **1061**; dry-run WhatsApp ? `confirmed`; schedule still disabled |
| **3d.7a** Main-integrated preflight + real CPS env | **Done** | `N8N_CREATE_PAYMENT_SESSION_URL` ? real CPS; container recreate; static reports PASS |
| **3d.7b** (1st) Main two-POST E2E (real CPS) | **FAIL** (safe) | exec **1062**; typing indicator #131009 on phase test wamid; no data mutations |
| **3d.7c** Main typing guard for phase test wamids | **Done** | `e620822`; regex `^wamid\.PHASE[0-9A-Z]+` |
| **3d.7b** (retry) Main two-POST E2E (real CPS) | **PASS** | Main **1063**/**1064**; CPS **1065**; booking `WH-260528-5369`; stop at checkout URL |
| **3d.8a** Pay + webhook preflight | **Done** | read-only; session open; Option B plan |
| **3d.8b-pay** Manual Stripe Checkout pay | **PASS** | session complete/paid; `pi_3Tc9egG36qRefvdP0oNvU2VT` |
| **3d.8b-webhook (crafted POST)** | **Not run** | hard stop ? DB already post-webhook |
| **3d.8b** Paid Checkout + webhook truth | **PASS** | organic Stripe delivery; execs **1066?1076**; `evt_1Tc9eh?`; not `evt_test_phase3d8b_001` |
| **3d.9a** Integrated Send Confirmation preflight | **Done** | read-only; `WH-260528-5369` eligible |
| **3d.9b** Integrated Send Confirmation dry-run | **PASS** | exec **1077**; webhook + `booking_id` filter; schedule disabled |

**3d.4 evidence (summary):** Direct POST to `create-payment-session` with only `esuDIT96iPT63OaQ` active. Booking `33ac2766-537c-4b95-85d4-91c01c862beb` moved `waiting_payment` ? `payment_link_sent`; one `payments` row created (`10ad0f21-0aa4-42c9-9adb-571a82f91698`); global `payment_events` unchanged; `send_confirmation` false; not confirmed; `booking_beds` 0.

**3d.5a (summary):** `db:report:stripe-contract` + `--verify-targets` PASS. `active=false` on Send Confirmation did **not** stop 3?min schedule (1055?1057). Fix: schedule node `disabled=true` in n8n DB.

**3d.5b evidence (summary):** One POST to `stripe-webhook` with only `KZUQvwR6SPWpvaZ5` active (`STRIPE_WEBHOOK_SKIP_VERIFY=true`). Payment `10ad0f21-?` ? `paid`; `payment_events` 3?4; booking `payment_link_sent`?`deposit_paid`; `send_confirmation` true; `status` still `payment_pending`; `confirmation_sent_at` NULL. Send Confirmation max exec **1057**; Main **1036**; CPS **1050**; `booking_beds` 0.

**3d.6 evidence (summary):** One POST to `send-confirmation-local` with only `gxivKRJexzTCw9x6` active after **publish + n8n restart** (`WHATSAPP_DRY_RUN=true`). Exec **1061**: 0 Airtable conversation/bed rows continued via 3d.6d patch; `whatsapp_sent=true`, `dry_run=true`; booking `WH-260528-1493` ? `confirmed`, `send_confirmation=false`, `confirmation_sent_at` set; `payment_status` stayed `deposit_paid`; global `payment_events` **4**; `booking_beds` **0**; webhook/Main/CPS max execs unchanged. **Do not** reuse this booking for another isolated gate without reset.

**3d.7b evidence (summary):** Fresh two-POST E2E via `booking-assistant` with only Main `RBfGNtVgrAkvhBHJ` + real CPS `esuDIT96iPT63OaQ` active; phone `+353399990330`; wamids `PHASE3D7B.001` / `.002`. POST #1 exec **1063**: hold `WH-260528-5369`, conversation + Airtable `recJLWBVonS7UEG3t`, no payment writes. POST #2 exec **1064** + CPS **1065**: `payment_pending` / `payment_link_sent`; Stripe `cs_test_a1izqISOeaPkavMYxmDJmJJHLxKunHC0CKi1HpQ5U4G8feWqnvVj6wps6O`; payment `389a5fdd-daa7-4bc1-a5e0-2bf105a5f471`; `payments` 24?25; `payment_events` unchanged; not confirmed; webhook/Send Confirmation/stub did not run.

**3d.8b evidence (summary):** User manually paid Main-created Checkout (full URL with `#` fragment). Stripe session **complete/paid**; `payment_intent=pi_3Tc9egG36qRefvdP0oNvU2VT`. **Organic** Stripe webhook delivery updated PG (~19:31:48?19:31:51 UTC): Webhook Handler execs **1066?1076** (burst; max **1076**); one `payment_events` row `evt_1Tc9ehG36qRefvdPg9mXYrcr`; payment `389a5fdd-?` ? **paid** (20000 cents); global `payment_events` 4?5; booking `deposit_paid`, `send_confirmation=true`, not confirmed, `booking_beds=0`. Crafted `evt_test_phase3d8b_001` **not sent** (correct hard stop). Send Confirmation max **1061**; Main **1064**; CPS **1065**. **Operational note:** future pay-only windows must either include webhook delivery in scope or disable Stripe forward to local `stripe-webhook`. **Do not** pay again or POST crafted event.

**3d.9b evidence (summary):** One POST to `send-confirmation-local` with only `gxivKRJexzTCw9x6` active after **publish + n8n restart** (`WHATSAPP_DRY_RUN=true`); schedule **`disabled: true`**. Exec **1077**: full chain through dry-run WhatsApp ? Mark Confirmed; `whatsapp_sent=true`, `dry_run=true`, `to=+353399990330`; Airtable Conversation/Beds `alwaysOutputData` with 0 beds; booking `WH-260528-5369` ? **`confirmed`**, `send_confirmation=false`, `confirmation_sent_at` set; `payment_status` stayed `deposit_paid`; global `payment_events` **5**; target **1**; `booking_beds` **0**; Webhook/Main/CPS/stub max execs unchanged. **Do not** reuse this booking without reset.

**Integrated chain on `WH-260528-5369` ? PROVEN (dry-run confirmation):**

| Gate | Execution / delivery | Booking state after |
|------|----------------------|---------------------|
| 3d.7b Main + CPS | **1063** / **1064** / **1065** | `payment_link_sent` |
| 3d.8b Pay + webhook | manual pay + organic Stripe | `deposit_paid`, `send_confirmation=true` |
| 3d.9b Send Confirmation | webhook exec **1077** | **`confirmed`**, dry-run WhatsApp only |

**Isolated Stripe chain on `WH-260528-1493`:**

| Gate | Execution | Booking state after |
|------|-----------|---------------------|
| 3d.4 CPS | 1050 | `payment_link_sent`, payment `checkout_created` |
| 3d.5b Webhook | 1058 | `deposit_paid`, `send_confirmation=true`, not confirmed |
| **3d.6 Send Confirmation** | **1061** | **`confirmed`**, `confirmation_sent_at` set, dry-run WhatsApp |

**Local gate state (after 3d.6):**

| Workflow | Id | Active | Notes |
|----------|-----|--------|--------|
| Stripe Webhook Handler | `KZUQvwR6SPWpvaZ5` | false | |
| Send Confirmation (local) | `gxivKRJexzTCw9x6` | false | schedule **disabled**; unpublished after 3d.6e |
| Create Payment Session | `esuDIT96iPT63OaQ` | false | |
| CPS stub | `whCreatePaymentStubLocal01` | false | |
| Main (local Stripe) | `RBfGNtVgrAkvhBHJ` | false | |
| Stripe Checkout Success | `kipSFRdsnXfTPLUc` | false | |

**3d.6 signed off (dry-run):** isolated Send Confirmation via direct webhook + `booking_id` filter. **Not** signed off: real WhatsApp send, schedule-poll trigger mode, integrated Main?Stripe?webhook?confirmation in one run.

**3d.7 signed off (payment-link only):** Main-integrated `booking_flow` ? `payment_details_provided` ? real CPS; stop at Stripe test checkout URL.

**3d.8 signed off (pay + webhook truth):** Manual Checkout pay + **organic** Stripe webhook on `WH-260528-5369` (not crafted skip-verify POST).

**3d.9 signed off (integrated dry-run confirmation):** Send Confirmation on `WH-260528-5369` after 3d.8b ? direct webhook + `booking_id` filter; `WHATSAPP_DRY_RUN=true`; exec **1077**. Completes integrated chain **3d.7b ? 3d.8b ? 3d.9b** (separate windows). **Not** signed off: real WhatsApp send; schedule-poll mode; single-window E2E.

**Integrated Stripe + confirmation dry-run chain:** **PROVEN** on `WH-260528-5369` (Main real CPS ? manual pay ? organic webhook ? dry-run confirm).

**Disposable bookings (do not reuse without reset):**

| Booking | Phone | Terminal / notes |
|---------|-------|------------------|
| `WH-260528-1493` | `+353399990329` | `confirmed` after 3d.6 ? full **isolated** chain |
| `WH-260528-5369` | `+353399990330` | `confirmed` after 3d.9b ? full **integrated** dry-run chain |
| `WH-260528-9437` | (3c.g) | stub path `waiting_payment` |

Remaining exclusions (still separate):
- Real WhatsApp send (`WHATSAPP_DRY_RUN` was true for 3d.6 and 3d.9b)
- Send Confirmation **schedule poll** mode (schedule node still disabled)
- Single-window integrated E2E (all steps in one run)
- Rooming/reassign E2E ? **3e.4 complete** (3e.4b retry PASS `WH-260528-5322`, beds R3-B1/R3-B2) ? see [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) ?13.7
- **3e.5 negative/wrong-booking guard tests CLOSED for Stage 3:** L1 static/unit PASS (25/25 resolver), L2 fixture+report PASS (T1?T3, T5?T7), Gate A preflight PASS. L3 runtime (Gates B/C) BLOCKED before activation ? current local forks perform booking lookup via Airtable before Postgres operations; PG-only fixtures are not faithful. No workflows activated, no POSTs made, no data mutated for B/C. L3 deferred to Postgres source-of-truth cutover. See ?15.6??15.7.
- Airtable-removal/cleanup-refactor work

---

## Phase 3c.c deliverables (hold + ensure)

### Hold path

| Artifact | Purpose |
|----------|---------|
| `scripts/lib/main-booking-hold-pg-sql.js` | Guards + hold upsert SQL |
| `scripts/lib/main-booking-hold-plan.js` | Read-only plan |
| `scripts/report-main-hold-plan.js` | `db:report:main-hold-plan` |
| `scripts/main-booking-hold-postgres.js` | `db:main-hold:postgres` (dry-run default; `--execute`) |
| Fixtures `main-hold-3cc-*` | Active-hold guard, exec cleanup |

Hold execute: `status=hold`, `payment_status=not_requested`, no `booking_beds`, no payments.

### Ensure Booking promote (3c.c.4)

| Artifact | Purpose |
|----------|---------|
| `scripts/lib/main-ensure-booking-pg-sql.js` | Promote / insert / block SQL |
| `scripts/lib/main-ensure-booking-plan.js` | Read-only plan |
| `scripts/report-main-ensure-booking-plan.js` | `db:report:main-ensure-booking-plan` |
| `scripts/main-ensure-booking-postgres.js` | `db:main-ensure-booking:postgres` |
| Fixtures `main-ensure-3cc-promote-*` | Blocked confirmed row, cleanup |

Verified on `8abfd4d`: hold ? promote same `booking_id`; idempotent refresh; missing code inserts; confirmed blocked (exit 2); no beds/payments; cleanup `WH-3C-PROMOTE-*`.

**Workflow wiring deferred to 3c.e** ? shared SQL exists; `build-main-local-stripe.js` and generated Main JSON not updated yet.

### Availability (3c.b)

`scripts/lib/main-availability-pg-sql.js`, `scripts/report-main-availability.js` ? `db:report:main-availability` (SELECT-only).

---

## Main workflow context (do not run casually)

| Item | Detail |
|------|--------|
| Target fork | `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` |
| Build script | `scripts/build-main-local-stripe.js` |
| Hosted export (read-only) | `n8n/Wolfhouse Booking Assistant - Main.json` |
| Scale | ~189 nodes, ~64 Airtable, **1** Postgres node today |
| Risks | Rooming E2E not run; activate bed-ops only in gated 3e.4 window |

**Do not run Main locally** until `--verify-targets` passes and testing is explicitly approved.

**3c.e.1:** `node scripts/build-main-local-stripe.js --verify-targets` ? runbook [`PHASE-3c-e.md`](PHASE-3c-e.md). Regenerate sets `active=false` and test Airtable base on fork.

**Ensure gap (why 3c.c.4 existed):** Old Ensure only INSERTs when missing; after 3c.c.3 a PG `hold` row would be returned unchanged. Promote SQL fixes that before 3c.e wires it into the fork.

---

## Stage 3x (bot knowledge + guardrails)

| Sub-phase | Status | Artifact |
|-----------|--------|----------|
| **3x.1** Full planning roadmap | **Done** | [STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) ?3x.1?3x.11 + exit criteria |
| **3x.1b** Customer memory + WhatsApp migration | **Done** | Same doc ?3x.5; three-layer model *(no import/DB yet)* |
| **3x.2b** Minimum Business Logic Baseline + Stage 4 entry gate | **Done** (2026-05-29) | [config/clients/wolfhouse-somo.baseline.json](../config/clients/wolfhouse-somo.baseline.json) |
| **3x.2c** Applied owner/user P1 answers ? baseline v0.2 + handoff/add-on plans | **Done** (2026-05-29) | baseline v0.2 ? [STAFF-HANDOFF-PLAN.md](STAFF-HANDOFF-PLAN.md) ? [DURING-STAY-ADDONS-PLAN.md](DURING-STAY-ADDONS-PLAN.md) ? [STAFF-QUERY-ASSISTANT-PLAN.md](STAFF-QUERY-ASSISTANT-PLAN.md) |
| **3x.2d** Working prices + policies ? baseline v0.3 (PROVISIONAL pricing) | **Done** (2026-05-29) | deposit ?200 ? 2026 package table ? proration ? derived add-ons ? check-in/out ? WhatsApp handoff ? `pricing_policy` guard |
| **3x.2** Ale/Cami **confirm** provisional prices + fill gaps ? confirmed config | In progress | [knowledge/wolfhouse-somo-gaps.md](knowledge/wolfhouse-somo-gaps.md) ? remaining items |
| **3x.3** WhatsApp mining + golden + customer extract | Planned | Layer 1 off-repo; Layer 2/3 outputs; staff review queue |
| **3x.4** Golden runner (Stage 4 prep) | Planned | 	est:golden-messages stub |

**In scope for Stage 3x:** WhatsApp history mining ? customer memory migration planning ? client-config architecture ? privacy/safety boundaries ? golden messages ? dangerous-action gates.

**Integrated chain (terminal evidence):** `WH-260528-5369` ? do **not** reuse without reset.

---

## Preferred next step

**Stage 3d (engineering):** Integrated pay + webhook + dry-run confirmation **complete** on `WH-260528-5369` (terminal; do not reuse).

**Immediate (Stage 3x execution):**
- **3x.2c done** ? applied owner P1 answers to baseline v0.2 (payment-link auto-send, 60-min hold, auto-confirm content, conditional cancel/date-change, rooming auto-assign + operator-room logic). Created [`STAFF-HANDOFF-PLAN.md`](STAFF-HANDOFF-PLAN.md) and [`DURING-STAY-ADDONS-PLAN.md`](DURING-STAY-ADDONS-PLAN.md).
- **3x.2** ? Ale/Cami complete remaining P1 in [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) (deposit amount/scope, non-7-night pricing, cancel/refund windows, add-on prices, handoff channel); then promote provisional ? confirmed and draft `config/clients/wolfhouse-somo.json`.
- **3x.3** ? Redacted WhatsApp mining (?3x.4 + ?3x.5): Layer 3 fixtures + Layer 2 customer extract (owner-approved fields only).

**Stage 3 residual ? CLOSED (2026-05-29):**
- **3e.5 wrong-booking guard:** L1 static/unit PASS (25/25 resolver) ? L2 fixture+report PASS (T1?T3, T5?T7) ? L3 runtime deferred ? current local forks have Airtable-coupled hold/reassign lookup; PG-only fixtures are not faithful. See ?15.6??15.7.
- **3e.6 idempotency:** I1 schema PASS (`idx_messages_whatsapp_client` confirmed) ? **I4 runtime PASS** (Send Confirmation dry-run, exec 1087 confirmed; exec 1088 no-op; `confirmation_sent_at` unchanged) ? I6 invariant PASS (payments/payment_events/booking_beds at baseline throughout). See [`PHASE-3e-IDEMPOTENCY-PLAN.md`](PHASE-3e-IDEMPOTENCY-PLAN.md).
- **Deferred (not blocked):** I2 ? manual-pay gate ? I3 ? Stage 3.5/manual-pay gate (structural schema guard proven; runtime needs `payments` write) ? I5 ? Postgres cutover. Airtable-coupled L3 runtime (T2, T5) ? post-cutover.
- **Caveats remaining:** real WhatsApp send (dry-run only) ? schedule-poll mode ? single-window integrated E2E ? Stripe/payment idempotency (I2, I3).

**Stage 3.5 ? CLOSED (d08c64e).** Minimum safety bar MET. G1?G13 DONE. Deferrals documented.

**Stage 3y planning ? STARTED (2026-05-29).** Plan doc: [`PHASE-3y-SHADOW-COPILOT-PLAN.md`](PHASE-3y-SHADOW-COPILOT-PLAN.md). Entry criteria Y-E1?Y-E13 defined. 4 operating modes (A?D) with gates. 15-test matrix (Y-T1?Y-T15). Exit criteria (Y-X1?Y-X13) defined.

**Stage 3y Mode A runtime gate 1 ? BLOCKED (2026-05-29).** Activated Main `RBfGNtVgrAkvhBHJ` only (had to unpublish a stale-active `Stripe Checkout Success` first), POSTed Y-T1. Two blockers found: (1) flat payload nests under `input.body` so `Normalize` test path (`input.phone`) misses it ? stops at `IF - Ignore Non Guest Message`; (2) Meta-envelope payload reaches `Send Typing Indicator`, which makes a real `graph.facebook.com` call NOT gated by `WHATSAPP_DRY_RUN` and errors 400 before routing. Route/draft unreachable offline. **No DB mutations, all protected counts at baseline, no other workflow executed, all workflows inactive after gate.** Y-T2/Y-T5/Y-T6/Y-T9 not run (same blocker). See `docs/PHASE-3y-SHADOW-COPILOT-PLAN.md ?Mode A runtime gate`.

**Stage 3y Mode A offline-safety fix ? IMPLEMENTED / NOT RUNTIME TESTED (2026-05-29).** `scripts/build-main-local-stripe.js` updated: `applyLocalTypingIndicatorBypass()` now checks `$env.WHATSAPP_DRY_RUN`; when `true`, IF false branch is taken ? `Send Typing Indicator` skipped ? workflow continues to `Create Inbound Message`. Local Main regenerated; `--verify-targets` hard safety checks PASS; `workflow.active=false`; hosted file unchanged. All five Mode A payload files converted to Meta-envelope shape. No runtime run; static verification only.

**Stage 3y Mode A runtime gate 2 ? BLOCKED (2026-05-29, critical).** Typing guard worked. Y-T1 (exec 1097) exposed 3 critical violations: real WhatsApp send (Send WhatsApp Reply1 returned real wamid), Airtable writes (inbound+outbound+conv records), Postgres booking hold created (bookings 41?42). Root cause: `WHATSAPP_DRY_RUN` gated only the typing indicator ? all 17 send nodes, Airtable writes, and hold creation were ungated. **Hard-stopped after Y-T1.** Main deactivated; Postgres test rows deleted; all protected counts restored to baseline. See `docs/PHASE-3y-SHADOW-COPILOT-PLAN.md ?Mode A runtime gate 2`.

**Stage 3y Mode A runtime gate 3 ? PASS (2026-05-29).** `applyShadowModeDryRunGates(workflow)` in `scripts/build-main-local-stripe.js`. 67 `IF - DRY RUN?` gates added: 16 WA sends + 47 Airtable writes + 4 PG+read nodes (including `Search Messages - Recent Conversation` for new-conversation path). 211 expression patches across all node types (`.isExecuted` ternary). Stub pass-through connections added. Enhanced runner `scripts/run-stage3y-mode-a.js` with 90s queue-mode poll. Generated workflow: 336 nodes, `active=false`, `phase3y-shadow-safe` tag. All 5 tests PASS ? zero protected mutations.

**Immediate next step: Mode A gate 4 - run 10-payload batch (Y-T1 through Y-T10).** Staff review of all drafts, then expand to Y-T11+.

**Parallel: Stage 3x completion.**
- 3x.2: Ale/Cami confirm provisional prices ? promoted config from v0.3 to confirmed.
- 3x.3: Ale/Cami provide redacted WhatsApp samples ? enriches Mode A test messages.

**Not next:** Mode B/C/D without separate gate; Stage 5 backend migration; Stage 6 staff UI; Azure (Stage 7); Airtable cutover without staff UI; autonomous live replies without per-action staff approval.

---

## Must not touch (without explicit approval)

| Area | Reason |
|------|--------|
| Hosted n8n exports / cloud instance | Production prototype |
| `payments`, `payment_events` | Stripe webhook owns truth |
| Stripe Webhook Handler, Send Confirmation | Phase 2 frozen contracts |
| `build-main-local-stripe.js` / Main JSON | **3c.e** scope |
| Workflow activation, webhooks, live Postgres/Airtable/Sheets writes | Test gates |
| Azure deploy, DNS, production URLs | After 3c + reliability + cleanup |
| Starting 3c.f, 3c.g, or Phase 4 cutover | Sequencing |

Safe without extra approval: docs-only, read-only reports, reversible fixtures, SELECT-only SQL, dry-run CLIs (default), commits after verified tests when user asks.

---

## Why Azure / staff UI is not next

Deployment and multi-client scale are **Stage 7**. Staff product UI is **Stage 6**. Immediate priority is finishing **Stage 3** safe proofs, then **Stage 3x** specs, then **Stage 4** reliability. See [ROADMAP.md](ROADMAP.md) and [ARCHITECTURE-NORTH-STAR.md](ARCHITECTURE-NORTH-STAR.md).

---

## Quick commands

```powershell
cd C:\Users\tywoo\Desktop\WH
git log -1 --oneline
git status --short

# When host npm unavailable:
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:main-hold-plan -- --help
```

Fixture SQL (example):

```powershell
Get-Content scripts/fixtures/main-ensure-3cc-promote-cleanup-down.sql | docker compose -f infra/docker-compose.local.yml exec -T wolfhouse-postgres psql -U wolfhouse -d wolfhouse
```

---

## Bookmark index

| Need | Doc |
|------|-----|
| Product roadmap (stages) | [ROADMAP.md](ROADMAP.md) |
| North star | [ARCHITECTURE-NORTH-STAR.md](ARCHITECTURE-NORTH-STAR.md) |
| This snapshot | PROJECT-STATE.md |
| Cursor agent | [CURSOR.md](../CURSOR.md) |
| Owner summary | [PROJECT-ROADMAP.md](PROJECT-ROADMAP.md) |
| Stripe gates | [PHASE-3d-STRIPE-ISOLATED-PLAN.md](PHASE-3d-STRIPE-ISOLATED-PLAN.md) |
| Stage 3x spec | [STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) |
| Owner knowledge gaps | [knowledge/wolfhouse-somo-gaps.md](knowledge/wolfhouse-somo-gaps.md) |
| 3c proposal | [PHASE-3c-PROPOSAL.md](PHASE-3c-PROPOSAL.md) |
| Regression | [regression-test-plan.md](regression-test-plan.md) |
| Azure (later) | [azure-n8n-hosting-plan.md](azure-n8n-hosting-plan.md) |
