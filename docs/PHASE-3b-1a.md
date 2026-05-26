# Phase 3b.1a — Cancel impact report (read-only)

**Status:** Implemented (local). **Does not** implement cancel (3b.1b), n8n dual-write (3b.1c), or any mutations.

**Parent:** [`PHASE-3b-1-PROPOSAL.md`](PHASE-3b-1-PROPOSAL.md)

## Goal

Answer what **would** happen if cancel-bed logic ran for one booking — without DELETE/UPDATE.

| # | Question |
|---|----------|
| 1 | Which Postgres booking is affected |
| 2 | How many `booking_beds` would be removed |
| 3 | Which bed/date assignments would be released |
| 4 | Which booking fields would be updated (future 3b.1b+) |
| 5 | Whether `payments` / `payment_events` stay untouched |
| 6 | Which planning report rows would disappear |
| 7 | Expected `db:report:bed-drift` impact |

## Command

```powershell
npm run db:report:cancel-impact -- --booking-code=WH-rechKjCcySkfLzxUD
```

Docker tools:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:cancel-impact -- --booking-code=WH-rechKjCcySkfLzxUD
```

### Options

| Flag | Required | Description |
|------|----------|-------------|
| `--booking-code=WH-rec…` | Yes* | Public booking code |
| `--airtable-record-id=rec…` | Alt* | Lookup by Airtable record id |
| `--client=wolfhouse-somo` | No | Client slug (default `wolfhouse-somo`) |

\* At least one of `booking-code` or `airtable-record-id`.

## Output

`reports/cancel-impact-<booking_code>-<timestamp>.json`

### Top-level sections

| Section | Content |
|---------|---------|
| `postgres_booking` | Resolved booking row (id, codes, status fields) |
| `summary` | Counts: beds to remove, payments, planning rows |
| `postgres_booking_beds_would_remove[]` | Each bed with `natural_key`, dates, `booking_bed_id` |
| `booking_fields_would_update_if_cancel_beds_ran` | `assignment_status` / `availability_check_status` → `needs_review`; `status` / `payment_status` unchanged by cancel-bed workflow |
| `payments_untouched` | Policy + read-only payment row list |
| `planning_report_impact` | Rows that appear in 3a planning report today |
| `bed_drift_impact` | CSV vs PG key counts before/after (expected) |
| `warnings[]` | e.g. status not yet `cancelled`, zero beds |

## Tables read (SELECT only)

`clients`, `bookings`, `booking_beds`, `payments`, `payment_events`  
CSV: `database/Booking Beds-Active Bed Assignments.csv`, `Bookings-Grid view.csv` (compare only)

**No writes.**

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Report written |
| 1 | Missing args, booking not found, or ambiguous lookup |

## Rollback

Remove:

- `scripts/report-cancel-impact.js`
- `docs/PHASE-3b-1a.md`
- `package.json` script `db:report:cancel-impact`
- Regression section in `docs/regression-test-plan.md`

No DB or workflow changes to undo.

## Test plan

```powershell
npm run db:report:cancel-impact -- --booking-code=WH-rechKjCcySkfLzxUD
npm run db:report:bed-drift
npm run planning:report:postgres
npm run test:phase2f-resolver
```

### Pass criteria

- JSON lists ≥1 `postgres_booking_beds_would_remove` for a booked fixture with beds
- `payments_untouched.policy` present; no mutation flags false
- `read_only` / `no_mutations` true in JSON
- Other regression commands still exit 0

## Out of scope

- 3b.1b Postgres cancel script (`--apply`)
- 3b.1c local n8n fork
- Airtable / Sheets writes
