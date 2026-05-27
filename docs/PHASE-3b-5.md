# Phase 3b.5 — Operator Room Release (local MVP)

**Status:** **Signed off (MVP)** — validated locally 2026-05-27. **Postgres-first** local fork; **no Airtable nodes** in n8n workflow; workflow **inactive** after tests.

**Parents:** [`PHASE-3b-5-PROPOSAL.md`](PHASE-3b-5-PROPOSAL.md), [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md)

**Not started:** **Phase 3c** Main / Postgres integration, hosted n8n Cloud cutover, production Airtable automations for this flow.

---

## MVP scope

| Layer | Deliverable | Runbook |
|-------|-------------|---------|
| **3b.5a** | Read-only impact report + reversible fixture | [`PHASE-3b-5a.md`](PHASE-3b-5a.md) |
| **3b.5b** | Postgres execute CLI (single transaction) | [`PHASE-3b-5b.md`](PHASE-3b-5b.md) |
| **3b.5c** | Local n8n fork — direct JSON webhook (dry-run + execute + idempotent replay) | [`PHASE-3b-5c.md`](PHASE-3b-5c.md) |

**Hosted export (read-only):** [`n8n/Wolfhouse - Operator Room Release.json`](../n8n/Wolfhouse%20-%20Operator%20Room%20Release.json) — not modified; reference for parity only.

---

## Workflow identity (3b.5c)

| Field | Value |
|-------|--------|
| **Name** | Wolfhouse - Operator Room Release (local PG) |
| **Stable local id** | `B3b5OperatorRoomLocal01` |
| **Webhook path** | `POST /webhook/operator-room-release` |
| **Webhook UUID** | `b3b5c001-0005-4000-8000-000000000005` |
| **Generated artifacts** | [`n8n/phase3b/Wolfhouse - Operator Room Release (local PG).json`](../n8n/phase3b/Wolfhouse%20-%20Operator%20Room%20Release%20(local%20PG).json) |

---

## Input surface (MVP)

| Path | Status |
|------|--------|
| **Direct JSON webhook** | **MVP** — `operator`, `room_code`, `release_start`, `release_end`, optional `request_code`, `dry_run`, `allow_overlap`, `notes` |
| **CLI impact / execute** | Dev / regression (`db:report:operator-room-release-impact`, `db:operator-room-release:postgres`) |
| **n8n Form / internal operator UI** | Deferred |
| **Airtable `record_id` primary path** | **Deprecated / reference only** — hosted automation pattern; not used in local fork |

Parse node ignores `record_id` with `deprecated_record_id_ignored` if present.

---

## Test fixture (local)

| Field | Value |
|-------|--------|
| **Operator** | `OPER-LOCAL-RELEASE-TEST` |
| **Room** | `R7` |
| **Original booking** | `WH-OPER-LOCAL-RELEASE-2027` (`2027-05-01` → `2027-05-31`, 4 `booking_beds`) |
| **Release window** | `2027-05-10` → `2027-05-17` |
| **Fixture SQL** | [`scripts/fixtures/operator-room-release-3b5a-up.sql`](../scripts/fixtures/operator-room-release-3b5a-up.sql) / [`down`](../scripts/fixtures/operator-room-release-3b5a-down.sql) |
| **Post-execute cleanup** | [`PHASE-3b-5b.md`](PHASE-3b-5b.md) rollback section |

Webhook E2E used `request_code` **`ORR-LOCAL-WEBHOOK-EXEC-001`**. CLI execute examples use **`ORR-LOCAL-TEST-001`**.

---

## Validated runtime evidence (2026-05-27)

| Test | Result |
|------|--------|
| **Dry-run webhook** | `ok=true`, `dry_run=true`, `found_match=true`, `match_count=1`, `would_cancel_beds=4`, `would_create_a=true`, `would_create_b=true`; no DB mutation |
| **Execute webhook** | `ok=true`, `dry_run=false`; original `WH-OPER-LOCAL-RELEASE-2027` **cancelled**, **4** beds deleted; `WH-OPER-LOCAL-RELEASE-2027-A` / `-B` created; `operator_room_release_requests` **completed**; `payments` / `payment_events` **0 / 0** |
| **Idempotent replay** | Same `request_code` → `ok=true`, `idempotent=true`; no duplicate A/B; no `no_match` after Step 7 routing fix |
| **Build verify** | `node scripts/build-operator-room-release-local.js --verify-targets` — OK |
| **Workflow after tests** | **Inactive** (unpublished on local n8n) |

---

## Safety (MVP)

| Rule | Detail |
|------|--------|
| **No Airtable in local fork** | Zero Airtable nodes; zero prod base `appOCWIN47Bui9CSS` in generated JSON |
| **No Google Sheets** | Not used |
| **No payment writes** | Never INSERT/UPDATE/DELETE `payments` or `payment_events`; guards in plan, execute SQL, and validate node |
| **Postgres writes (execute only)** | `bookings`, `booking_beds`, `operator_room_release_requests` only |
| **Inactive by default** | Keep workflow **inactive** except controlled tests; restart `n8n-main` after publish/unpublish |
| **Local n8n only** | Do not import `n8n/phase3b/*` Operator Room Release fork into hosted Cloud |

---

## Commit hashes (implementation)

| Step | Commit | Message (short) |
|------|--------|-----------------|
| **3b.5a report** | `a2ea0fc` | Phase 3b.5a: add Operator Room Release impact report |
| **3b.5a fixture** | `cc88603` | Phase 3b.5a: add reversible operator room release fixture |
| **3b.5b CLI** | `f99f360` | Phase 3b.5b: add Operator Room Release Postgres execute CLI |
| **3b.5c Step 1** | `04c21ec` | Phase 3b.5c Step 1: add Operator Room Release inventory build script |
| **3b.5c Step 2** | `88b66ec` | Phase 3b.5c Step 2: add Operator Room Release read-only n8n plan SQL |
| **3b.5c Step 3** | `1748560` | Phase 3b.5c Step 3: generate Operator Room Release dry-run local workflow |
| **3b.5c Step 5** | `610b962` | Phase 3b.5c Step 5: add Operator Room Release execute workflow path |
| **3b.5c Step 7** | `1736578` | Phase 3b.5c Step 7: fix Operator Room Release idempotent replay |

**Latest Phase 3b.5 commit:** `1736578`.

---

## Deferred (non-blocking)

| Item | Notes |
|------|--------|
| **n8n Form UX** | Staff-facing form posting same JSON fields |
| **Internal web form / operator UI** | Long-term; shares PG APIs with 3b.5b |
| **Fixture cleanup** | Optional after tests — see 3b.5b rollback SQL |
| **Wider edge-case webhooks** | Ambiguous match, overlap without `allow_overlap`, payments guard, stuck `processing` |
| **Airtable mirror branch** | Deprecated for MVP; hosted dual-write not ported |
| **Phase 3c** | Main WhatsApp / booking assistant Postgres integration — not started |
| **`npm run build:operator-room-release:local`** | Optional convenience script (build via `node scripts/build-operator-room-release-local.js` today) |

---

## Quick commands

```powershell
# Impact (read-only)
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:operator-room-release-impact -- --operator="OPER-LOCAL-RELEASE-TEST" --room-code=R7 --release-start=2027-05-10 --release-end=2027-05-17

# Regenerate / verify local workflow
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools node scripts/build-operator-room-release-local.js --generate
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools node scripts/build-operator-room-release-local.js --verify-targets
```

See [`n8n/phase3b/README.md`](../n8n/phase3b/README.md) and [`regression-test-plan.md`](regression-test-plan.md) Phase 3b.5 sections.
