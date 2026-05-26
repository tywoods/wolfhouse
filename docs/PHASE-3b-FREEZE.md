# Phase 3b local — bed ops freeze & regression

**Status:** Phase 3b local **signed off** (2026-05-26). Cancel, Assign, and Reassign local forks verified on Docker + local n8n + Postgres + test Airtable.

**Not started:** Phase **3b.4** Manual Entries, **3b.5** Operator Room Release, **Phase 3c** Main integration, production cutover, hosted n8n Cloud changes.

**Sign-off:** Engineer Cursor · Owner Ty · 2026-05-26.

**Master checklist:** [`regression-test-plan.md`](regression-test-plan.md) — Phase 3b sections and **Phase 2 local sign-off** (unchanged for payment flow).

---

## 1. What is complete

| Stage | Scope | Runbook |
|-------|--------|---------|
| **3b.0** | Bed / `booking_beds` drift audit (read-only) | [`PHASE-3b-0.md`](PHASE-3b-0.md) |
| **3b.1** | Cancel — impact report, PG execute script, local n8n fork | [`PHASE-3b-1a.md`](PHASE-3b-1a.md) · [`PHASE-3b-1b.md`](PHASE-3b-1b.md) · [`PHASE-3b-1c.md`](PHASE-3b-1c.md) |
| **3b.2** | Assign — impact report, PG execute script, local n8n fork | [`PHASE-3b-2a.md`](PHASE-3b-2a.md) · [`PHASE-3b-2b.md`](PHASE-3b-2b.md) · [`PHASE-3b-2c.md`](PHASE-3b-2c.md) |
| **3b.3** | Reassign — impact report, local n8n fork (PG reset + AT reset + chained local Assign) | [`PHASE-3b-3a.md`](PHASE-3b-3a.md) · [`PHASE-3b-3.md`](PHASE-3b-3.md) |

### 3b.0 — Bed drift audit

- `npm run db:report:bed-drift` — compares CSV export vs Postgres `booking_beds` (read-only).
- No mutations; baseline gate before/after bed-op tests.

### 3b.1 — Cancel

| Sub-step | Deliverable |
|----------|-------------|
| **3b.1a** | `db:report:cancel-impact` — read-only cancel preview |
| **3b.1b** | `db:cancel:booking-beds` — Postgres DELETE all beds + `needs_review` (CLI) |
| **3b.1c** | Webhook `POST /webhook/cancel-booking-beds` — PG first, then Airtable delete/update |

### 3b.2 — Assign

| Sub-step | Deliverable |
|----------|-------------|
| **3b.2a** | `db:report:assign-impact` — read-only assign preview (`--beds`) |
| **3b.2b** | `db:assign:booking-beds` — Postgres INSERT + assignment fields (CLI) |
| **3b.2c** | Webhook `POST /webhook/assign-beds-to-booking` — Choose Beds → PG insert → AT create |

### 3b.3 — Reassign

| Sub-step | Deliverable |
|----------|-------------|
| **3b.3a** | `db:report:reassign-impact` — read-only full reset + proposed `--beds` preview |
| **3b.3b** | Webhook `POST /webhook/reassign-booking-beds` — PG delete all → AT reset → PG mirror `unassigned`/`unknown` → HTTP → local Assign |

Proposals (design-only, optional reference): [`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md), [`PHASE-3b-1-PROPOSAL.md`](PHASE-3b-1-PROPOSAL.md) through [`PHASE-3b-3-PROPOSAL.md`](PHASE-3b-3-PROPOSAL.md).

---

## 2. Commit hashes

| Stage | Commit | Message (short) |
|-------|--------|-----------------|
| **3b.0** | `140d434` | Phase 3b.0: booking bed drift audit |
| **3b.1a** | `2c710fb` | Phase 3b.1a: cancel impact report |
| **3b.1b** | `0788f06` | Phase 3b.1b: Postgres cancel booking beds script |
| **3b.1c** | `9556297` | Phase 3b.1c: local cancel workflow with Postgres mirror |
| **3b.2a** | `aa278c3` | Phase 3b.2a: assign impact report |
| **3b.2b** | `15e53bb` | Phase 3b.2b: Postgres assign booking beds script |
| **3b.2c** | `1085e56` | Phase 3b.2c: local assign workflow with Postgres mirror |
| **3b.3a** | `3d4ed65` | Phase 3b.3a: reassign impact report |
| **3b.3b** | `dfcf3c4` | Phase 3b.3b: local reassign workflow with Postgres mirror |

**Latest Phase 3b commit:** `dfcf3c4` (3b.3b).

Proposal-only commits (not implementation): e.g. `2f4e3bb`, `4d0637c`, `218d9df`, `998dc7f`, `255f0ba` — safe to ignore for freeze sign-off.

---

## 3. What remains local-only

### n8n workflows (`n8n/phase3b/`)

Import and activate **only** on `http://localhost:5678`. Regenerate from build scripts; do not hand-edit generated JSON except credentials mapping in UI.

| Workflow | Stable local id | Webhook path | Build |
|----------|-----------------|--------------|-------|
| Wolfhouse - Cancel Bed Assignments (local PG) | `KchhRC9b3MIdkzPT` | `cancel-booking-beds` | `npm run build:cancel-beds:local` |
| Wolfhouse - Bed Assignment (local PG) | `B3c2AssignLocalPg01` | `assign-beds-to-booking` | `npm run build:assign-beds:local` |
| Wolfhouse - Reassign Bed Assignments (local PG) | `B3c3ReassignLocal01` | `reassign-booking-beds` | `npm run build:reassign-beds:local` |

See [`n8n/phase3b/README.md`](../n8n/phase3b/README.md).

### Postgres mirror scripts

| Script | Role |
|--------|------|
| [`scripts/cancel-booking-beds-postgres.js`](../scripts/cancel-booking-beds-postgres.js) | CLI cancel (`db:cancel:booking-beds`) |
| [`scripts/assign-booking-beds-postgres.js`](../scripts/assign-booking-beds-postgres.js) | CLI assign (`db:assign:booking-beds`) |
| [`scripts/lib/assign-booking-beds-pg-sql.js`](../scripts/lib/assign-booking-beds-pg-sql.js) | SQL shared by assign build + CLI |
| [`scripts/lib/reassign-booking-beds-pg-sql.js`](../scripts/lib/reassign-booking-beds-pg-sql.js) | SQL shared by reassign build |
| [`scripts/lib/assign-booking-beds-plan.js`](../scripts/lib/assign-booking-beds-plan.js) | Plan logic for impact reports + assign CLI |
| [`scripts/lib/reassign-impact-plan.js`](../scripts/lib/reassign-impact-plan.js) | Plan logic for reassign impact |

### Read-only reports

| Command | Script |
|---------|--------|
| `db:report:bed-drift` | `report-booking-bed-drift.js` |
| `db:report:cancel-impact` | `report-cancel-impact.js` |
| `db:report:assign-impact` | `report-assign-impact.js` |
| `db:report:reassign-impact` | `report-reassign-impact.js` |

### Local test helpers

| Helper | Purpose |
|--------|---------|
| [`scripts/test-cancel-beds-webhook.ps1`](../scripts/test-cancel-beds-webhook.ps1) | POST cancel webhook |
| [`scripts/test-assign-beds-webhook.ps1`](../scripts/test-assign-beds-webhook.ps1) | POST assign webhook |
| [`scripts/test-reassign-beds-webhook.ps1`](../scripts/test-reassign-beds-webhook.ps1) | POST reassign webhook |
| [`scripts/prep-assign-e2e-airtable.js`](../scripts/prep-assign-e2e-airtable.js) | Reset test booking to Unassigned for assign E2E |
| [`scripts/prep-reassign-e2e-airtable.js`](../scripts/prep-reassign-e2e-airtable.js) | Set Assigned + guest count for reassign E2E |
| [`scripts/run-assign-e2e-local.js`](../scripts/run-assign-e2e-local.js) | Prep + assign webhook ×2 |
| [`scripts/run-reassign-e2e-local.js`](../scripts/run-reassign-e2e-local.js) | Sync + prep + reassign webhook ×2 + duplicate check |

**Baseline restore:** `npm run db:sync` — reloads beds/bookings from CSV export into local Postgres.

---

## 4. What remains untouched

| Area | Rule |
|------|------|
| **Hosted n8n Cloud** (`tywoods.app.n8n.cloud`) | No import/activation of `n8n/phase3b/*` forks |
| **Hosted exports** | `n8n/Wolfhouse - Cancel Bed Assignments.json`, `n8n/Wolfhouse - Bed Assignment.json`, `n8n/Wolfhouse - Reassign Bed Assignments.json` — read-only inputs to build scripts |
| **Phase 2 forks** | `n8n/phase2/*` — Main, Stripe, Send Confirmation unchanged by 3b |
| **Main** | No WhatsApp / booking-assistant changes for bed ops |
| **Stripe / payment workflows** | No changes |
| **Send Confirmation** | No changes |
| **Production Airtable** | Test base/PAT only for local webhooks unless explicitly approved |
| **Google Sheets** | No reads/writes in Phase 3b |
| **`database/migrations/*`** | No new migrations in 3b |
| **`payments` / `payment_events` / `bookings.payment_status`** | No INSERT/UPDATE/DELETE in cancel/assign/reassign paths |
| **`bookings` DELETE** | Never |
| **3b.4 / 3b.5** | Not started |

---

## 5. Known behavior

### Reassign (3b.3b)

- **Destructive / re-runnable**, not a full end-to-end no-op. A second `reassign-booking-beds` call **deletes** current PG beds again and **inserts** again via chained Assign.
- Response sets `idempotent: false` for the whole reassign webhook.
- Verified: second call `pg_deleted_count > 0` and `pg_inserted_count > 0` with **no duplicate PG natural keys** for the same booking.

### Assign (3b.2c)

- Second assign on the same beds/dates: **`pg_skipped_count > 0`**, `pg_inserted_count === 0`, `idempotent: true` (natural-key skip).
- Choose Beds picks bed list; webhook does not accept `--beds` (use `db:report:assign-impact` or `db:report:reassign-impact` for explicit bed previews).

### Cancel (3b.1c)

- Second cancel when beds already cleared: **`pg_deleted_count === 0`**, `idempotent: true` (no-op on PG/AT when already clean).

### Postgres vs Airtable

- Dual-write is **best-effort** with `partial_failure` in JSON responses (PG ahead of AT or vice versa). See runbooks for recovery.
- Reassign chains Assign via **`http://n8n-main:5678/webhook/assign-beds-to-booking`** (workers cannot use `localhost`).
- Pause Airtable automation **“Assign Beds When Booking Is Unassigned”** during assign/reassign E2E to avoid racing the chained HTTP assign.

### PG enum note

- Reassign mirror uses Postgres `availability_check_status = 'unknown'` (maps Airtable **Not Checked**; PG has no `not_checked` enum value).

### Baseline

- `npm run db:sync` restores local Postgres bed/booking rows from CSV export after experiments.

---

## 6. Required regression commands

Run from repo root. Prefer Docker tools profile when `node` is not on PATH:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run <script>
```

### Tier A — always (read-only)

| Command | Pass criteria |
|---------|----------------|
| `npm run db:report:bed-drift` | Exit 0; no actionable drift (or documented test-base exceptions) |
| `npm run planning:report:postgres` | Exit 0; row count matches assigned beds in PG |
| `npm run test:phase2f-resolver` | 10/10 fixtures |

### Tier B — before/after bed-op experiments

| Command | When |
|---------|------|
| `npm run db:sync` | Restore CSV baseline before a test day |
| `npm run db:report:cancel-impact -- --booking-code=WH-rec…` | Before cancel execute/webhook |
| `npm run db:report:assign-impact -- --booking-code=WH-rec… --beds=R7-B1,…` | Before assign execute/webhook |
| `npm run db:report:reassign-impact -- --booking-code=WH-rec… --beds=R1-B1,…` | Before reassign webhook |

### Tier C — local n8n E2E (test Airtable only)

Prerequisites: local forks **active**; hosted duplicates on same webhook paths **deactivated** on local n8n.

| Flow | Commands |
|------|----------|
| **Cancel** | `scripts/test-cancel-beds-webhook.ps1 -RecordId rec…` (×2 for idempotency) |
| **Assign** | `node scripts/prep-assign-e2e-airtable.js --record-id=rec…` then `scripts/test-assign-beds-webhook.ps1` (×2) |
| **Reassign** | `node scripts/prep-reassign-e2e-airtable.js --record-id=recBtWzIvmjQ5mmo0 --guest-count=3` then `scripts/test-reassign-beds-webhook.ps1` (×2) |

Optional orchestrators:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm `
  -e N8N_WEBHOOK_URL=http://host.docker.internal:5678/webhook/ `
  wolfhouse-tools node scripts/run-assign-e2e-local.js --record-id=recSyn7QcPdVrYa1D

docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm `
  -e N8N_WEBHOOK_URL=http://host.docker.internal:5678/webhook/ `
  wolfhouse-tools node scripts/run-reassign-e2e-local.js --record-id=recBtWzIvmjQ5mmo0
```

After Tier C: run Tier A again; optionally `npm run db:sync`.

---

## 7. Rollback

| Goal | Action |
|------|--------|
| **Stop local bed-op webhooks** | Deactivate `n8n/phase3b/* (local PG)` workflows in local n8n UI |
| **Restore hosted behavior on local n8n** | Re-import read-only hosted JSON from `n8n/Wolfhouse - *.json` if needed; deactivate local forks |
| **Restore Postgres beds from CSV** | `npm run db:sync` |
| **Clear PG beds only** | `npm run db:cancel:booking-beds -- --booking-code=WH-rec… --execute` |
| **CLI assign without n8n** | `npm run db:assign:booking-beds -- --booking-code=… --beds=… --execute` |
| **Regenerate forks after SQL fix** | `npm run build:cancel-beds:local` / `build:assign-beds:local` / `build:reassign-beds:local` + docker import |

**Never roll back** `payments`, `payment_events`, or `bookings.payment_status` via Phase 3b tooling — out of scope.

---

## 8. Next possible stages

| Stage | Status | Notes |
|-------|--------|-------|
| **3b.4 Manual Entries Queue** | Not started | Proposal TBD — Sheets + webhook queue; separate from bed-assignment webhooks |
| **3b.5 Operator Room Release** | Not started | Proposal TBD — operator block/release flows |
| **Phase 3c** | Not started | Broader Main / staff integration with Postgres-backed bed state |
| **Production cutover** | Much later | Hosted Cloud activation, production Airtable automations, staff-facing URLs — only after extended local sign-off |

Parent roadmap: [`PROJECT-ROADMAP.md`](PROJECT-ROADMAP.md) · Phase 3b parent: [`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md).

---

## Quick reference — webhook paths (local only)

| Path | Local fork workflow |
|------|---------------------|
| `/webhook/cancel-booking-beds` | Cancel (local PG) |
| `/webhook/assign-beds-to-booking` | Bed Assignment (local PG) |
| `/webhook/reassign-booking-beds` | Reassign (local PG) |

**Phase 2 freeze (payments):** [`PHASE-2-FREEZE.md`](PHASE-2-FREEZE.md) — still authoritative for Stripe/Main/Send Confirmation; unchanged by this document.
