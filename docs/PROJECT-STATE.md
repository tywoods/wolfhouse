# Wolfhouse — Project State

**Last updated:** 2026-05-27 (after `8abfd4d` Phase 3c.c.4)  
**HEAD (expected):** `8abfd4d` — Phase 3c.c.4: add Main ensure booking promote CLI

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

### Phase 3c (in progress) — Main / Postgres

| Substep | Status | Commit (if applicable) |
|---------|--------|-------------------------|
| **3c** proposal | Done | `2cd7ede` |
| **3c.a** Main workflow inventory | Done | `0b4bd8e` |
| **3c.b** PG availability report (SELECT-only) | Done | `32315db` |
| **3c.c.1** Hold read-only plan | Done | `1a8ebba` |
| **3c.c.2** Active-hold guard fixture | Done | `0741a9f` |
| **3c.c.3** Hold execute CLI | Done | `50294d3` |
| **3c.c.4** Ensure Booking promote CLI | Done | `8abfd4d` |
| **3c.d** Conversation / `current_hold` plan | **Not started** | — |
| **3c.e** Inject hold + Ensure into `build-main-local-stripe.js` | **Not started** | — |
| **3c.f** Payment / confirmation contract checks | **Not started** | — |
| **3c.g** E2E local Main tests | **Not started** | — |

**Phase 3c.c (CLI/script side) is nearly complete.** Remaining 3c work is conversation state (3c.d), workflow wiring (3c.e), then contract checks and E2E (3c.f–g).

Runbooks: [`PHASE-3c-PROPOSAL.md`](PHASE-3c-PROPOSAL.md), [`PHASE-3c-a.md`](PHASE-3c-a.md), [`PHASE-3c-b.md`](PHASE-3c-b.md), [`PHASE-3c-c.md`](PHASE-3c-c.md).

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

**Ensure gap (why 3c.c.4 existed):** Old Ensure only INSERTs when missing; after 3c.c.3 a PG `hold` row would be returned unchanged. Promote SQL fixes that before 3c.e wires it into the fork.

---

## Preferred next step (not 3c.c.4)

**Do 3c.d before 3c.e.**

| Option | Work | Why |
|--------|------|-----|
| **A — Preferred** | **3c.d** — conversation / message / `current_hold_booking_id` discovery and plan | Main wiring depends on stable conversation↔hold linkage |
| **B — Later** | **3c.e** — plan then inject hold + Ensure SQL via build script | After 3c.d; regenerate fork; `--verify-targets`; import inactive only if allowed |

Do **not** start 3c.e workflow injection or 3c.f/g until 3c.d plan is agreed unless owner explicitly reprioritizes.

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
