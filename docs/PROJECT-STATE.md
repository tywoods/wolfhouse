# Wolfhouse — Project State

**Last updated:** 2026-05-28 (Phase 3d.4 direct Stripe checkout session sign-off)  
**HEAD (expected):** after `Phase 3d.4: document direct Stripe checkout session success`

For direction and principles see [ARCHITECTURE-NORTH-STAR.md](ARCHITECTURE-NORTH-STAR.md). For agent rules see [CURSOR.md](../CURSOR.md).

---

## Product

**Wolfhouse Booking Assistant** — AI guest messaging plus staff/operator workflows for a surf house: availability, holds, Stripe payment sessions, confirmations, bed assignment, reassign, cancel, manual entries queue, operator room release.

**Quality bar today:** Correct and safe (not yet optimizing for UI scale or Azure).

---

## Environments

| Environment | Role | Rule |
|-------------|------|------|
| **Hosted prototype** | Airtable + n8n Cloud (`tywoods.app.n8n.cloud`) | **Do not change** while building here |
| **This repo (local)** | Postgres + Docker n8n + generated `n8n/phase2/` forks | All new implementation; dummy data OK |

---

## Completed major phases

### Phase 2 local (frozen)

Stripe test path, Main (local Stripe) fork, Send Confirmation (local), Booking Flow Router hardening. Signed off — [`PHASE-2-FREEZE.md`](PHASE-2-FREEZE.md).

### Phase 3b (frozen)

| Area | Sign-off | Key commit (examples) |
|------|----------|------------------------|
| Cancel / Assign / Reassign | 2026-05-26 | 3b.1–3b.3 runbooks |
| Manual Entries local fork | 2026-05-27 | `8aa74b9` |
| Operator Room Release MVP | 2026-05-27 | `de26bd4` |

Details: [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md).

### Phase 3c (closed scope) — Main / Postgres local + stub

| Substep | Status | Commit (if applicable) |
|---------|--------|-------------------------|
| **3c** proposal | Done | `2cd7ede` |
| **3c.a** Main workflow inventory | Done | `0b4bd8e` |
| **3c.b** PG availability report (SELECT-only) | Done | `32315db` |
| **3c.c.1** Hold read-only plan | Done | `1a8ebba` |
| **3c.c.2** Active-hold guard fixture | Done | `0741a9f` |
| **3c.c.3** Hold execute CLI | Done | `50294d3` |
| **3c.c.4** Ensure Booking promote CLI | Done | `8abfd4d` |
| **3c.d** Conversation / `current_hold` plan | **Proposal done** — [`PHASE-3c-d-PROPOSAL.md`](PHASE-3c-d-PROPOSAL.md) | docs only |
| **3c.e.1** Build target map + neutralize + `--verify-targets` | **Done** (uncommitted) | — |
| **3c.e.2** Ensure promote SQL in Main fork | Done | `c89890a` |
| **3c.e.3** PG availability gate in Main fork | Done | `5bdd465` |
| **3c.e.4** PG hold + AT backfill in Main fork | Done | `881ab1b` |
| **3c.e.5** PG conversation upsert | **Done** (uncommitted) | — |
| **3c.f** Payment / confirmation contract checks | **Review complete (3c.f.4)** — local-stub payment-details path signed off; real Stripe path still pending | [`PHASE-3c-f.md`](PHASE-3c-f.md) |
| **3c.g** E2E local Main tests | **3c.g.2l success** — fresh E2E `booking_flow -> payment_details_provided` local stub path proven | [`PHASE-3c-g.md`](PHASE-3c-g.md) |

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
  - hosted reassign URL deferral;
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

### Phase 3d (in progress) — isolated real Stripe path

| Substep | Status | Notes |
|---------|--------|-------|
| **3d.1** Isolated Stripe planning gate | Done | [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) |
| **3d.2** Stripe contract static checker | Done | `npm run db:report:stripe-contract` |
| **3d.3** Direct CPS test plan | Done | docs-only |
| **3d.4a** Preflight blockers cleared | Done | deactivate webhook/confirmation; CPS target `esuDIT96iPT63OaQ`; local cancel URL |
| **3d.4b** `.env.example` local cancel URL | Done | `fb6ceb9` |
| **3d.4** Direct isolated Create Payment Session | **PASS** | execution **1050**; booking `WH-260528-1493`; `cs_test_...` session; no webhook/confirmation/Main side effects |

**3d.4 evidence (summary):** Direct POST to `create-payment-session` with only `esuDIT96iPT63OaQ` active. Booking `33ac2766-537c-4b95-85d4-91c01c862beb` moved `waiting_payment` → `payment_link_sent`; one `payments` row created (`10ad0f21-0aa4-42c9-9adb-571a82f91698`); global `payment_events` unchanged; `send_confirmation` false; not confirmed; `booking_beds` 0.

Remaining exclusions (still separate):
- Stripe Webhook Handler sign-off (next recommended gate)
- Send Confirmation chain sign-off
- Main-integrated real Stripe payment-details path
- Rooming/reassign E2E (deferred until hosted reassign URL remap)
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

Verified on `8abfd4d`: hold → promote same `booking_id`; idempotent refresh; missing code inserts; confirmed blocked (exit 2); no beds/payments; cleanup `WH-3C-PROMOTE-*`.

**Workflow wiring deferred to 3c.e** — shared SQL exists; `build-main-local-stripe.js` and generated Main JSON not updated yet.

### Availability (3c.b)

`scripts/lib/main-availability-pg-sql.js`, `scripts/report-main-availability.js` — `db:report:main-availability` (SELECT-only).

---

## Main workflow context (do not run casually)

| Item | Detail |
|------|--------|
| Target fork | `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` |
| Build script | `scripts/build-main-local-stripe.js` |
| Hosted export (read-only) | `n8n/Wolfhouse Booking Assistant - Main.json` |
| Scale | ~189 nodes, ~64 Airtable, **1** Postgres node today |
| Risks | Production Airtable refs; Reassign still hits hosted n8n.cloud webhook; Create Payment Session inside Code node; Ensure only on Stripe path |

**Do not run Main locally** until `--verify-targets` passes and testing is explicitly approved.

**3c.e.1:** `node scripts/build-main-local-stripe.js --verify-targets` — runbook [`PHASE-3c-e.md`](PHASE-3c-e.md). Regenerate sets `active=false` and test Airtable base on fork.

**Ensure gap (why 3c.c.4 existed):** Old Ensure only INSERTs when missing; after 3c.c.3 a PG `hold` row would be returned unchanged. Promote SQL fixes that before 3c.e wires it into the fork.

---

## Preferred next step

`3c.g.2l` proved fresh E2E local runtime coverage for:
- `booking_flow` fresh hold creation (POST #1)
- `payment_details_provided` promotion + stub checkout link update (POST #2)
- zero side effects on `payments`, `payment_events`, and `booking_beds`

Recommended immediate next step:
- **Phase 3d.5** — plan then run isolated **Stripe Webhook Handler** gate (`checkout.session.completed` / payment truth) on a separate disposable booking or test session; keep Send Confirmation inactive unless that gate is explicitly in scope.
- Before any runtime: `npm run db:report:stripe-contract` and workflow active-state / `webhook_entity` checks per [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md).
- Do **not** reuse `WH-260528-1493` for webhook/confirmation tests without a deliberate reset plan (already has open `checkout_created` payment from 3d.4).

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

## Why Azure is not next

Deployment is **Phase 4+ / Scalable** in the north star. Immediate priority is Postgres-safe Main booking logic on local forks, then reliability and cleanup. Deploying now would ship ~64 Airtable nodes, weak conversation state, and immature PG gates. See [ARCHITECTURE-NORTH-STAR.md](ARCHITECTURE-NORTH-STAR.md).

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
| North star | [ARCHITECTURE-NORTH-STAR.md](ARCHITECTURE-NORTH-STAR.md) |
| This snapshot | PROJECT-STATE.md |
| Cursor agent | [CURSOR.md](../CURSOR.md) |
| Owner roadmap | [PROJECT-ROADMAP.md](PROJECT-ROADMAP.md) |
| 3c proposal | [PHASE-3c-PROPOSAL.md](PHASE-3c-PROPOSAL.md) |
| Regression | [regression-test-plan.md](regression-test-plan.md) |
| Azure (later) | [azure-n8n-hosting-plan.md](azure-n8n-hosting-plan.md) |
