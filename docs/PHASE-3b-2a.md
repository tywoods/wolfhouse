# Phase 3b.2a — Assign impact report (read-only)

**Status:** Implemented (local). **Does not** implement assign (3b.2b), n8n fork (3b.2c), or Reassign (3b.3).

**Parent:** [`PHASE-3b-2-PROPOSAL.md`](PHASE-3b-2-PROPOSAL.md)

## Goal

Answer what **would** happen if the given beds were assigned to one booking — without INSERT/UPDATE.

| # | Question |
|---|----------|
| 1 | Which Postgres booking is affected |
| 2 | Which beds are proposed (`--beds`) |
| 3 | Which `booking_beds` rows would be inserted later (3b.2b+) |
| 4 | Whether bed/date ranges overlap other bookings in Postgres |
| 5 | Whether bed count matches `guest_count` |
| 6 | Which planning report rows would appear after assign |
| 7 | Whether `payments` / `payment_events` / `payment_status` stay untouched |

## Command

```powershell
npm run db:report:assign-impact -- --booking-code=WH-rechKjCcySkfLzxUD --beds=R7-B1,R7-B2,R7-B3 --check-in=2026-08-07 --check-out=2026-08-12
```

Docker tools:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:assign-impact -- --booking-code=WH-rec... --beds=R7-B1,R7-B2
```

### Options

| Flag | Required | Description |
|------|----------|-------------|
| `--booking-code=WH-rec…` | Yes* | Public booking code |
| `--beds=R7-B1,R7-B2` | Yes | Comma-separated bed codes to simulate |
| `--check-in=YYYY-MM-DD` | No | Assignment start (default: `bookings.check_in`) |
| `--check-out=YYYY-MM-DD` | No | Assignment end (default: `bookings.check_out`) |
| `--airtable-record-id=rec…` | Alt* | Lookup by Airtable record id |
| `--client=wolfhouse-somo` | No | Client slug |

\* At least one of `booking-code` or `airtable-record-id`.

## Output

`reports/assign-impact-<booking_code>-<timestamp>.json`

### Top-level sections

| Section | Content |
|---------|---------|
| `postgres_booking` | Resolved booking |
| `summary` | Counts: existing, would insert/skip, overlaps, guest count, planning |
| `proposed_beds[]` | Each requested bed + natural key |
| `postgres_booking_beds_existing[]` | Current PG rows for booking |
| `postgres_booking_beds_would_insert[]` | Rows that 3b.2b would INSERT |
| `postgres_booking_beds_would_skip[]` | Already exist (same natural key) |
| `postgres_overlap_conflicts[]` | Other bookings occupying bed/dates |
| `guest_count_check` | `matches` boolean + totals |
| `booking_fields_would_update_if_assign_ran` | `assignment_status` / `availability_check_status`; status/payment unchanged |
| `payments_untouched` | Policy + payment row list |
| `planning_report_impact` | Rows after assign (`is_new_if_assign_ran`) |
| `warnings[]`, `actionable[]` | Non-fatal findings |

## Tables read (SELECT only)

`clients`, `bookings`, `booking_beds`, `beds`, `payments`, `payment_events`

**No writes.**

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Report written; no actionable warnings |
| 1 | Missing args, booking not found, ambiguous lookup, invalid dates |
| 2 | Actionable: overlaps, unknown bed codes, or guest_count mismatch |

## Rollback

Remove:

- `scripts/report-assign-impact.js`
- `docs/PHASE-3b-2a.md`
- `package.json` script `db:report:assign-impact`
- Regression section in `docs/regression-test-plan.md`

No DB or workflow changes to undo.

## Test plan

```powershell
npm run db:report:assign-impact -- --booking-code=WH-rec... --beds=R7-B1,R7-B2,R7-B3 --check-in=2026-08-07 --check-out=2026-08-12
npm run db:report:bed-drift
npm run planning:report:postgres
npm run test:phase2f-resolver
```

### Pass criteria

- JSON has `read_only` / `no_mutations` true
- `postgres_booking_beds_would_insert` lists proposed beds when booking has none (or new keys)
- Overlap fixture: `postgres_overlap_conflicts` non-empty → exit **2**
- Guest count ≠ beds → `guest_count_mismatch` warning → exit **2**
- `payments_untouched.policy` present
- Other regression commands still run (bed-drift may exit 1 independently)

## Out of scope

- `assign-booking-beds-postgres.js` (3b.2b)
- n8n Bed Assignment fork (3b.2c)
- Reassign (3b.3)
- Airtable / hosted workflow changes
