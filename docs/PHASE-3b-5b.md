# Phase 3b.5b — Operator Room Release Postgres mirror (local only)

**Status:** Implemented (local). **Does not** call Airtable, Google Sheets, n8n (3b.5c), or payment tables.

**Parents:** [`PHASE-3b-5-PROPOSAL.md`](PHASE-3b-5-PROPOSAL.md), [`PHASE-3b-5a.md`](PHASE-3b-5a.md)

## Purpose

Execute an **Operator Room Release** in **Postgres only**: cancel the matched operator whole-room block, delete its `booking_beds`, and insert **Block A** / **Block B** bookings (no beds on new blocks). Mirrors hosted split semantics; PG uses **DELETE** beds (not Airtable Status Cancelled).

## Before first execute

1. Apply fixture (or real test data): [`scripts/fixtures/operator-room-release-3b5a-up.sql`](../scripts/fixtures/operator-room-release-3b5a-up.sql)
2. Impact report exit **0**:

```powershell
npm run db:report:operator-room-release-impact -- --operator="OPER-LOCAL-RELEASE-TEST" --room-code=R7 --release-start=2027-05-10 --release-end=2027-05-17 --request-code=ORR-LOCAL-TEST-001
```

## Dry-run (default)

```powershell
npm run db:operator-room-release:postgres -- --operator="OPER-LOCAL-RELEASE-TEST" --room-code=R7 --release-start=2027-05-10 --release-end=2027-05-17 --request-code=ORR-LOCAL-TEST-001
```

Docker tools:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:operator-room-release:postgres -- --operator="OPER-LOCAL-RELEASE-TEST" --room-code=R7 --release-start=2027-05-10 --release-end=2027-05-17 --request-code=ORR-LOCAL-TEST-001
```

## Execute

```powershell
npm run db:operator-room-release:postgres -- --operator="OPER-LOCAL-RELEASE-TEST" --room-code=R7 --release-start=2027-05-10 --release-end=2027-05-17 --request-code=ORR-LOCAL-TEST-001 --execute
```

### Flags

| Flag | Description |
|------|-------------|
| `--execute` | Apply mutations (default: dry-run) |
| `--allow-overlap` | Allow execute despite `overlap_conflicts` from impact plan |
| `--request-code=…` | **Recommended** — idempotency via `operator_room_release_requests` |
| (same as 3b.5a) | `--operator`, `--room-code`, `--release-start`, `--release-end`, `--client`, `--notes`, `--json-file` |

## Fixture workflow

| Step | Command |
|------|---------|
| **UP** | `Get-Content scripts\fixtures\operator-room-release-3b5a-up.sql \| docker exec -i wolfhouse-postgres psql -U wolfhouse -d wolfhouse -v ON_ERROR_STOP=1` |
| **Execute** | `db:operator-room-release:postgres` with `--execute` (above) |
| **Reset after execute** | See rollback below — `3b5a-down.sql` alone is **not** enough |

**Warning:** Do **not** run `npm run db:sync` after execute without cleanup — sync replaces all `booking_beds`.

### Expected result (fixture, exit 0)

| Check | Expected |
|-------|----------|
| `WH-OPER-LOCAL-RELEASE-2027` | `status = cancelled`, **0** `booking_beds` |
| `WH-OPER-LOCAL-RELEASE-2027-A` | exists; `2027-05-01` → `2027-05-10`; `assignment_status = unassigned` |
| `WH-OPER-LOCAL-RELEASE-2027-B` | exists; `2027-05-17` → `2027-05-31` |
| `operator_room_release_requests` | `request_code = ORR-LOCAL-TEST-001`, `status = completed` |
| `payments` / `payment_events` | **0** for original booking |

Re-run same command with same `--request-code` → **exit 0**, idempotent, no duplicate A/B.

## Payment guard

- Abort if `payments` or `payment_events` count **> 0** on original booking before transaction.
- Inside transaction: assert payment row count and `payment_status` unchanged on original.
- **Never** INSERT/UPDATE/DELETE `payments` or `payment_events`.

## Idempotency

| Case | Behavior |
|------|----------|
| Same `--request-code`, request `completed` | Exit **0**, print linked bookings, no writes |
| Original already `cancelled`, no completed request | Exit **2** `already_cancelled_ambiguous` |
| `WH-…-A` / `WH-…-B` exist with wrong dates | Exit **2** `block_booking_code_conflict` |
| Second `--execute` without completed request | Blocked by cancelled original / match failure |

## Rollback / cleanup after execute

`operator-room-release-3b5a-down.sql` only removes the **active** fixture booking. After execute, also delete:

```sql
DELETE FROM booking_beds WHERE booking_id IN (
  SELECT id FROM bookings WHERE booking_code LIKE 'WH-OPER-LOCAL-RELEASE-2027%'
);
DELETE FROM operator_room_release_requests WHERE request_code = 'ORR-LOCAL-TEST-001';
DELETE FROM bookings WHERE booking_code IN (
  'WH-OPER-LOCAL-RELEASE-2027',
  'WH-OPER-LOCAL-RELEASE-2027-A',
  'WH-OPER-LOCAL-RELEASE-2027-B'
) AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = bookings.id);
```

Then re-run **UP** fixture SQL.

## Deferred (not 3b.5b)

| Item | Phase |
|------|--------|
| `build-operator-room-release-local.js` | 3b.5c |
| n8n Form webhook | 3b.5c |
| Airtable mirror branch | 3b.5c (deprecated) |

## Rollback (remove tooling)

Remove `scripts/operator-room-release-postgres.js`, `scripts/lib/operator-room-release-pg-sql.js`, this doc, and `package.json` script entry.
