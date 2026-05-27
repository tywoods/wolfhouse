# Phase 3b.4c — Manual Entries Queue Processor local fork (PG + Airtable + Sheet)

**Status:** **Signed off (MVP)** — validated locally 2026-05-27. Import **local n8n only**; workflow **inactive** after tests.

**Parents:** [`PHASE-3b-4c-PROPOSAL.md`](PHASE-3b-4c-PROPOSAL.md), [`PHASE-3b-4b.md`](PHASE-3b-4b.md), [`PHASE-3b-4a.md`](PHASE-3b-4a.md), [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md)

**Not started:** **3b.5** Operator Room Release, **Phase 3c** Main integration, hosted Cloud cutover.

---

## Workflow identity

| Field | Value |
|-------|--------|
| **Name** | Wolfhouse - Manual Entries Queue Processor (local PG) |
| **Stable local id** | `B3c4ManualEntriesLocal01` |
| **Webhook path** | `POST /webhook/wolfhouse-manual-entries-queue` |
| **Hosted export (read-only)** | [`n8n/Wolfhouse - Manual Entries Queue Processor.json`](../n8n/Wolfhouse%20-%20Manual%20Entries%20Queue%20Processor.json) |
| **Generated artifacts** | [`n8n/phase3b/Wolfhouse - Manual Entries Queue Processor (local PG).json`](../n8n/phase3b/Wolfhouse%20-%20Manual%20Entries%20Queue%20Processor%20(local%20PG).json) |

---

## Test targets (local only)

| Target | ID |
|--------|-----|
| **Google Sheet** (Manual Entries tab) | `1JIY22nrtHXWEi6gPWvvpDfgG8Xe0jT6hmGGzkNXRs10` |
| **Airtable base** | `appiyO4FmkKsyHZdK` |
| **Postgres client slug** | `wolfhouse-somo` |

Run `node scripts/build-manual-entries-local.js --verify-targets` before import or E2E — must show **0** prod Sheet and **0** prod Airtable hits.

---

## What it does

Webhook reads the **Manual Entries** sheet (`Manual Entries!A1:R1000`), picks the next queue row by **Sync Status** priority, then:

| Action | Sync Status (column P) | Order |
|--------|------------------------|--------|
| **Delete** | `Delete Ready` / `Delete Processing` | PG cancel + delete beds → AT cancel booking + delete booking beds → sheet `Deleted` |
| **Update** | `Update Ready` / `Update Processing` | PG update booking fields → AT update booking → sheet `Synced` (beds unchanged) |
| **Create** | `Ready` / `Processing` | PG create → AT create booking + beds → PG backfill AT ids → sheet `Synced` |

Pick priority (first match wins): `delete processing` → `delete ready` → `update processing` → `update ready` → `processing` → `ready`.

**Update MVP:** booking fields only (no bed reassignment in fork).

**Never** writes `payments` or `payment_events`.

---

## Build and import

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools node scripts/build-manual-entries-local.js --generate
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools node scripts/build-manual-entries-local.js --verify-targets
```

```powershell
docker cp "n8n/phase3b/Wolfhouse - Manual Entries Queue Processor (local PG).n8n-import.json" n8n-main:/tmp/manual-entries-import.json
docker exec n8n-main n8n import:workflow --input=/tmp/manual-entries-import.json
docker restart n8n-main
```

Map credentials in n8n UI on first import (Postgres local, Google OAuth, Airtable test PAT).

**Deactivate** any other workflow on local n8n using path `wolfhouse-manual-entries-queue` (including hosted Manual Entries if imported).

See [`n8n/phase3b/README.md`](../n8n/phase3b/README.md).

---

## Safety and operations

| Rule | Detail |
|------|--------|
| **Inactive by default** | Keep workflow **inactive** except during controlled tests. |
| **Webhook registration** | After `update:workflow --active=true/false`, **restart `n8n-main`** so the webhook registers/unregisters reliably. |
| **Verify targets** | `--verify-targets` must pass before import/run. |
| **Payments** | No `payments` / `payment_events` writes in any branch. |
| **Body ignored** | Webhook POST body is `{}`; queue state comes from the sheet only. |
| **Assign Beds race** | Pause hosted/local **Assign Beds When Unassigned** automation during manual **create** tests if it races. |

---

## Controlled MVP test evidence (local n8n)

| Exec | Action | Result | Key artifacts |
|------|--------|--------|----------------|
| **613** | **Create** | **Pass** | `MAN-LOCAL-CREATE-20260526C`; PG booking + `booking_beds`; AT `recfMmhpl2lE01Tqd` + `recDu3aAtmdc8jI0D`; PG `airtable_record_id` backfilled on booking and bed; sheet **Synced** |
| **621** | **Update** | **Pass** | Guest/notes updated in PG + AT; `booking_beds` unchanged; sheet **Synced** |
| **623** | **Delete** | **Pass** | PG booking **cancelled**; PG `booking_beds` **0**; AT booking **Cancelled**; AT booking bed **deleted**; sheet **Deleted** |
| **602** | **Create (overlap)** | **Pass (gate)** | PG `postgres_overlap_conflicts`; sheet **Error**; no AT create (expected safety) |

`payments` / `payment_events` counts unchanged across all runs (23 / 3 at sign-off).

---

## Manual webhook test (one run)

```powershell
docker exec n8n-main n8n update:workflow --id=B3c4ManualEntriesLocal01 --active=true
docker restart n8n-main
curl.exe -s -X POST "http://localhost:5678/webhook/wolfhouse-manual-entries-queue" -H "Content-Type: application/json" -d "{}"
docker exec n8n-main n8n update:workflow --id=B3c4ManualEntriesLocal01 --active=false
docker restart n8n-main
```

Pre-check: `db:report:manual-entry-impact` for the row (optional).

---

## CLI mirror (reference)

Same semantics without n8n:

```powershell
npm run db:report:manual-entry-impact -- --action=create ...
npm run db:manual-entry:postgres -- --action=create|update|delete ... --execute
```

See [`PHASE-3b-4b.md`](PHASE-3b-4b.md).

---

## Deferred (non-blocking for MVP sign-off)

| Item | Notes |
|------|--------|
| Repeat create / repeat delete webhook idempotency | Not run as dedicated E2E |
| Unknown-bed / missing-field webhook paths | Covered in 3b.4a impact report; not re-run on fork |
| `npm run build:manual-entries:local` in `package.json` | Optional; use `node scripts/build-manual-entries-local.js` |
| `scripts/test-manual-entries-webhook.ps1` | Optional helper |
| Test sheet / AT cleanup | Optional (`MAN-LOCAL-CREATE-20260526C` row left **Deleted**) |
| `Respond to Webhook` / structured `partial_failure` JSON | Not implemented |
| Post-test `db:report:bed-drift` / `planning:report:postgres` / `test:phase2f-resolver` | Recommended before production cutover |

---

## Implementation commits (reference)

Latest: **`ed3a6f6`** — Step 8c: fix Manual Entries bed backfill pairs.

Fork build chain: `374e319` … `ed3a6f6` (see git log `Phase 3b.4c`).

---

## Sign-off

| Role | Date | Notes |
|------|------|--------|
| MVP validated | 2026-05-27 | Create / update / delete + overlap gate on local Docker stack |
| Workflow state | 2026-05-27 | **Inactive**; git clean at doc write |
