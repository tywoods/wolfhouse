# Phase 3b.3a — Reassign impact report (read-only)

**Status:** Implemented (local). **Does not** implement Reassign n8n fork (3b.3b), Assign/Cancel workflow changes, or any DB/Airtable writes.

**Parents:** [`PHASE-3b-3a-PROPOSAL.md`](PHASE-3b-3a-PROPOSAL.md), [`PHASE-3b-3-PROPOSAL.md`](PHASE-3b-3-PROPOSAL.md)

## Goal

Answer what **would** happen if a full reassign ran in Postgres: **delete all** current `booking_beds` for the booking, then **assign** the proposed `--beds` — without DELETE/INSERT/UPDATE.

Composes:

1. **Reset phase** — same scope as cancel (all PG beds for booking removed).
2. **Assign phase** — same rules as assign-impact, with existing beds treated as empty (overlaps exclude this booking’s current rows).

## Command

```powershell
npm run db:report:reassign-impact -- --booking-code=WH-rechKjCcySkfLzxUD --beds=R7-B1,R7-B2,R7-B3
```

Docker tools:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:reassign-impact -- --booking-code=WH-rec... --beds=R7-B1,R7-B2
```

### Options

| Flag | Required | Description |
|------|----------|-------------|
| `--booking-code=WH-rec…` | Yes* | Public booking code |
| `--beds=R7-B1,R7-B2` | Yes | Proposed post-reassign bed codes |
| `--check-in=YYYY-MM-DD` | No | Assignment start (default: `bookings.check_in`) |
| `--check-out=YYYY-MM-DD` | No | Assignment end (default: `bookings.check_out`) |
| `--airtable-record-id=rec…` | Alt* | Lookup by Airtable record id |
| `--client=wolfhouse-somo` | No | Client slug |

\* At least one of `booking-code` or `airtable-record-id`.

## Output

`reports/reassign-impact-<booking_code>-<timestamp>.json`

### Top-level sections

| Section | Content |
|---------|---------|
| `reset_phase` | Current beds, `would_delete`, simulated `unassigned` / `not_checked` |
| `assign_phase` | Proposed beds, `would_insert`, overlaps, unknown beds |
| `guest_count_check` | Proposed count vs `guest_count` after full reassign |
| `payments_untouched` | SELECT-only policy + payment rows |
| `planning_report_impact` | Rows before, after cancel-only (empty), after reassign |
| `warnings[]`, `actionable[]` | Actionable → exit 2 |

## Tables read (SELECT only)

`clients`, `bookings`, `booking_beds`, `beds`, `payments`, `payment_events`

**No writes.**

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Report written; no actionable warnings |
| 1 | Missing args, booking not found, ambiguous lookup, invalid dates |
| 2 | Actionable: unknown beds, overlaps, or guest_count mismatch |

## Rollback

Remove:

- `scripts/report-reassign-impact.js`
- `scripts/lib/reassign-impact-plan.js`
- `docs/PHASE-3b-3a.md`
- `package.json` script `db:report:reassign-impact`
- Regression section in `docs/regression-test-plan.md`
- Revert `ignoreExistingBookingBeds` in `assign-booking-beds-plan.js` if unused elsewhere

No DB or workflow changes to undo.

## Test plan

```powershell
npm run db:report:reassign-impact -- --booking-code=WH-rec... --beds=R7-B1,R7-B2,R7-B3
npm run db:report:reassign-impact -- --booking-code=WH-rec... --beds=R99-B1
npm run db:report:bed-drift
npm run planning:report:postgres
npm run test:phase2f-resolver
```

See [`regression-test-plan.md`](regression-test-plan.md) § Phase 3b.3a.
