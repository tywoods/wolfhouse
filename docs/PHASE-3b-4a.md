# Phase 3b.4a — Manual Entry impact report (read-only)

**Status:** Implemented (local). **Does not** implement Postgres mirror CLI (3b.4b), Manual Entries n8n fork (3b.4c), or any DB/Airtable/Sheets writes.

**Parents:** [`PHASE-3b-4-PROPOSAL.md`](PHASE-3b-4-PROPOSAL.md), [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md)

## Goal

Answer what **would** happen if a **Manual Entries** queue row were mirrored into Postgres (create / update / delete) — without INSERT/UPDATE/DELETE, Airtable, or Google Sheets.

## Command

```powershell
npm run db:report:manual-entry-impact -- --action=create --manual-entry-id=MAN-test --guest-name="Guest" --check-in=2026-06-05 --check-out=2026-06-10 --guest-count=2 --beds=R1-B1,R1-B2
```

Docker tools:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:manual-entry-impact -- --action=create --manual-entry-id=MAN-test --guest-name=Ty --check-in=2026-06-05 --check-out=2026-06-10 --guest-count=2 --beds=R1-B1,R1-B2
```

### Options

| Flag | Required | Description |
|------|----------|-------------|
| `--manual-entry-id=MAN-…` | Yes | Queue row id |
| `--action=create\|update\|delete` | Yes* | Or derive from `--sync-status` |
| `--sync-status=ready` | Alt* | `ready`→create, `update ready`→update, `delete ready`→delete |
| `--guest-name=…` | Create | Guest name |
| `--check-in` / `--check-out` | Create | ISO dates `YYYY-MM-DD` |
| `--beds=R1-B1,R1-B2` | Create | Comma-separated bed codes |
| `--guest-count=N` | No | Default 1 on create |
| `--booking-code=WH-rec…` | Update/delete | Lookup existing PG booking |
| `--airtable-record-id=rec…` | Update/delete | Alt lookup |
| `--json-file=path.json` | No | Full queue item (n8n pick-node shape) |
| `--client=wolfhouse-somo` | No | Client slug |

\* `--action` or derivable `--sync-status`.

## Output

`reports/manual-entry-impact-<manual_entry_id>-<timestamp>.json`

### Sections by action

| Action | Key sections |
|--------|----------------|
| **create** | `create_phase` (proposed booking + beds), overlaps, unknown beds, `guest_count_check`, `planning_report_impact.rows_after` |
| **update** | `update_phase.booking_fields_would_update` — **no bed simulation** in MVP |
| **delete** | `delete_phase` (beds to remove, `status`→cancelled) |

Always: `payments_untouched`, `postgres_booking_match`, `warnings[]`, `actionable[]`.

## Tables read (SELECT only)

`clients`, `bookings`, `booking_beds`, `beds`, `payments`, `payment_events`

**No writes.**

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Report written; no actionable items |
| 1 | Missing args, booking not found, ambiguous lookup, missing required fields |
| 2 | Actionable: unknown beds, overlaps, guest_count mismatch, invalid date range |

## Rollback

Remove:

- `scripts/report-manual-entry-impact.js`
- `scripts/lib/manual-entry-impact-plan.js`
- `docs/PHASE-3b-4a.md`
- `package.json` script `db:report:manual-entry-impact`
- Regression section in `docs/regression-test-plan.md`
- Delete `reports/manual-entry-impact-*.json` artifacts

Postgres unchanged (SELECT-only).

## Regression

After 3b.4a:

```powershell
npm run db:report:bed-drift
npm run planning:report:postgres
npm run test:phase2f-resolver
```

**3b.4b+** not started.
