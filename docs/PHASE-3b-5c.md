# Phase 3b.5c — Operator Room Release local n8n fork (Postgres-first)

**Status:** **Signed off (MVP)** — validated locally 2026-05-27. Import **local n8n only**; workflow **inactive** after tests.

**Parents:** [`PHASE-3b-5.md`](PHASE-3b-5.md), [`PHASE-3b-5b.md`](PHASE-3b-5b.md), [`PHASE-3b-5a.md`](PHASE-3b-5a.md), [`PHASE-3b-5-PROPOSAL.md`](PHASE-3b-5-PROPOSAL.md), [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md)

**Not started:** **Phase 3c**, hosted Cloud cutover, Airtable mirror nodes, n8n Form wiring.

---

## Workflow identity

| Field | Value |
|-------|--------|
| **Name** | Wolfhouse - Operator Room Release (local PG) |
| **Stable local id** | `B3b5OperatorRoomLocal01` |
| **Webhook path** | `POST /webhook/operator-room-release` |
| **Webhook UUID** | `b3b5c001-0005-4000-8000-000000000005` |
| **Hosted export (read-only)** | [`n8n/Wolfhouse - Operator Room Release.json`](../n8n/Wolfhouse%20-%20Operator%20Room%20Release.json) |
| **Generated artifacts** | [`n8n/phase3b/Wolfhouse - Operator Room Release (local PG).json`](../n8n/phase3b/Wolfhouse%20-%20Operator%20Room%20Release%20(local%20PG).json) |

**Node count:** 13 (no Airtable nodes).

---

## Input (MVP)

**Primary:** direct JSON on webhook (same fields as CLI):

| Field | Required | Notes |
|-------|----------|--------|
| `operator` | yes | Exact trim match on `bookings.operator_name` |
| `room_code` | yes | e.g. `R7` |
| `release_start` | yes | `YYYY-MM-DD` |
| `release_end` | yes | After `release_start` |
| `request_code` | recommended | Idempotency via `operator_room_release_requests` |
| `dry_run` | no | `true` → plan preview only; omitted/false → execute path |
| `allow_overlap` | no | Default false |
| `notes` | no | Stored on request row when executing |
| `record_id` | deprecated | Ignored; `deprecated_record_id_ignored` in parse errors |

**Deferred:** n8n Form, internal operator UI. **Reference only:** Airtable Operator Room Release Request automation (`{ record_id }`).

---

## Routing (after Step 7)

```
Webhook → Parse → IF Parse OK
  → Postgres — Completed Request Check (SELECT only)
  → IF Completed Request (route_idempotent_response)
       true  → Build Response → Respond   ← idempotent replay
       false → IF Request Blocked (processing / failed)
          true  → Build Response → Respond
          false → Plan (read-only)
             → IF Dry Run
                true  → Build Response → Respond
                false → IF Plan OK
                   true  → Execute → Validate → Build Response → Respond
                   false → Build Response → Respond
```

**Why Step 7:** Plan matches only **non-cancelled** operator whole-room blocks. After first execute the original is cancelled, so a repeat webhook used to hit Plan → `no_match`. Completed-request check returns `idempotent=true` **before** Plan.

---

## Postgres nodes

| Node | Role |
|------|------|
| **Completed Request Check** | SELECT; `route_idempotent_response` when `request_code` + `status=completed` |
| **Plan** | SELECT only; dry-run preview (`dry_run=true`) |
| **Execute** | Single-statement transaction; mirrors [`operator-room-release-pg-sql.js`](../scripts/lib/operator-room-release-pg-sql.js) |

SQL source: [`operator-room-release-pg-n8n-sql.js`](../scripts/lib/operator-room-release-pg-n8n-sql.js). Regenerate workflow: [`build-operator-room-release-local.js`](../scripts/build-operator-room-release-local.js).

---

## Build and import

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools node scripts/build-operator-room-release-local.js --generate
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools node scripts/build-operator-room-release-local.js --verify-targets
```

```powershell
docker cp "n8n/phase3b/Wolfhouse - Operator Room Release (local PG).n8n-import.json" n8n-main:/tmp/operator-room-release-import.json
docker exec n8n-main n8n import:workflow --input=/tmp/operator-room-release-import.json
```

Map **Postgres account** (local Wolfhouse DB) on first UI import. **Deactivate** hosted `Wolfhouse - Operator Room Release` on local n8n if imported — only one workflow may use path `operator-room-release`.

See [`n8n/phase3b/README.md`](../n8n/phase3b/README.md).

---

## Test fixture

| Item | Value |
|------|--------|
| Operator | `OPER-LOCAL-RELEASE-TEST` |
| Room | `R7` |
| Booking | `WH-OPER-LOCAL-RELEASE-2027` |
| Release | `2027-05-10` → `2027-05-17` |
| UP SQL | `scripts/fixtures/operator-room-release-3b5a-up.sql` |

---

## Validated webhook evidence (2026-05-27)

### Dry-run

- Payload: `dry_run=true`, same operator/room/dates as fixture.
- Response: `ok=true`, `found_match=true`, `match_count=1`, `would_cancel_beds=4`, `would_create_a=true`, `would_create_b=true`.
- No mutations to bookings, beds, requests, payments.

### Execute

- `request_code`: `ORR-LOCAL-WEBHOOK-EXEC-001`, `dry_run=false`.
- Original **cancelled**, **4** `booking_beds` deleted.
- `WH-OPER-LOCAL-RELEASE-2027-A` and `-B` created.
- Request row **completed**.
- `payments` / `payment_events` unchanged (**0 / 0**).

### Idempotent replay (Step 6b)

- Same payload and `request_code` after Step 7 routing fix.
- Response: `ok=true`, `idempotent=true` (not `no_match`).
- A/B count still **2**; request still **completed**.

**PowerShell note:** use a BOM-free JSON file with `curl.exe --data-binary @file` if inline quoting fails.

---

## Safety and operations

| Rule | Detail |
|------|--------|
| **verify-targets** | Must pass before import (`--verify-targets`) |
| **No Airtable** | Zero Airtable nodes; no prod base in JSON |
| **No Sheets** | Not used |
| **No payment writes** | Read-only payment counts; execute aborts if payments exist |
| **Inactive by default** | `n8n publish:workflow` / `unpublish:workflow` + restart `n8n-main` (and worker) around tests |
| **Hosted unchanged** | Do not edit `n8n/Wolfhouse - Operator Room Release.json` |

---

## Deferred

| Item | Phase |
|------|--------|
| n8n Form posting same JSON | Post-MVP UX |
| Operator internal UI | Long-term |
| Airtable mirror branch | Deprecated |
| Optional fixture cleanup | After test sessions |
| Broader edge-case matrix | Non-blocking |
| Phase 3c Main integration | Not started |

---

## Commits (3b.5c track)

| Commit | Step |
|--------|------|
| `04c21ec` | Inventory build script |
| `88b66ec` | Read-only plan SQL |
| `1748560` | Dry-run workflow |
| `610b962` | Execute path |
| `1736578` | Idempotent replay routing |
