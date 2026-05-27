# Phase 3b.5a — Operator Room Release impact report (read-only)

**Status:** Implemented (local). **Does not** implement Postgres execute (3b.5b), n8n fork (3b.5c), or any DB/Airtable/Sheets writes.

**Parents:** [`PHASE-3b-5-PROPOSAL.md`](PHASE-3b-5-PROPOSAL.md), [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md)

## Purpose

Answer what **would** happen if an **Operator Room Release** ran against Postgres — cancel original operator whole-room block, optionally create Block A/B bookings — **without** INSERT/UPDATE/DELETE, Airtable API, webhooks, or payment mutations.

MVP staff input is **direct payload** (CLI today; **n8n Form** recommended for 3b.5c). Airtable `record_id` lookup is **deprecated** and **deferred** in 3b.5a.

## Command

```powershell
npm run db:report:operator-room-release-impact -- --operator="Surf Week Co" --room-code=R7 --release-start=2027-06-01 --release-end=2027-06-08
```

Docker tools:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:operator-room-release-impact -- --operator="Surf Week Co" --room-code=R7 --release-start=2027-06-01 --release-end=2027-06-08
```

Help:

```powershell
npm run db:report:operator-room-release-impact -- --help
```

### Options

| Flag | Required | Description |
|------|----------|-------------|
| `--operator=…` | Yes | Operator name (trimmed **exact** match to `bookings.operator_name`) |
| `--room-code=R7` | Yes | Room code for match |
| `--release-start` | Yes | `YYYY-MM-DD` |
| `--release-end` | Yes | `YYYY-MM-DD` (must be **after** start) |
| `--client=wolfhouse-somo` | No | Client slug |
| `--request-code=…` | No | Preview `operator_room_release_requests.request_code` |
| `--notes=…` | No | Preview notes |
| `--json-file=path.json` | No | Webhook/form body (`operator`, `room_code`, `release_start`, `release_end`) |
| `--release-record-id=rec…` | No | **Deprecated** — warning only; no Airtable fetch |

## Input surface recommendation

| Priority | Surface |
|----------|---------|
| **MVP** | **n8n Form** → `POST /webhook/operator-room-release` with direct JSON fields |
| **Dev** | This CLI (`db:report:operator-room-release-impact`) |
| **Later** | Simple internal web form or full operator UI |
| **Deprecated** | Airtable Operator Room Release Request + `{ record_id }` |

Report JSON includes `input_surface_recommendation` documenting the above.

## Read-only guarantee

- Script uses **SELECT** only via `pg` client.
- No `INSERT` / `UPDATE` / `DELETE` on any table.
- No Airtable, Google Sheets, or n8n webhook calls.
- No changes to `payments` or `payment_events`.

## Room match rule (`pg_room_match_v1`)

Find operator whole-room bookings where:

1. `booking_source = operator`, `block_type = whole_room`, status not `cancelled` / `expired`
2. `trim(operator_name)` equals input operator (case-sensitive)
3. Date overlap: `check_in < release_end` AND `release_start < check_out`
4. Room matches **any** of:
   - `bookings.primary_room_code` = `--room-code` (preferred; populated from CSV **Room ID** on `db:sync`)
   - `rooms.room_code` via `bookings.room_to_block_id`
   - `booking_beds.room_code` on the same booking

**Not used alone:** Airtable-linked `room_to_block_id` without the fallbacks above (often unset in PG after sync).

## Operator match

- **Rule:** trimmed exact equality on `bookings.operator_name`
- **Risk:** case/spelling differences between staff input and PG → `match_count = 0`

## Output

`reports/operator-room-release-impact-<room_code>-<timestamp>.json`

### Top-level sections

| Section | Content |
|---------|---------|
| `parsed_input` | Normalized CLI/JSON input |
| `input_surface_recommendation` | n8n Form / direct payload; AT deprecated |
| `match_phase` | `found_match`, `match_count`, `candidates[]`, `error_notes` |
| `cancel_phase` | Original booking preview, `booking_beds_affected[]`, field changes |
| `split_phase` | `should_create_a/b`, Block A/B date ranges, provisional `WH-YYMMDD-*` codes |
| `create_blocks_phase` | 0–2 new booking previews; **no beds** in release workflow |
| `overlap_conflicts` | Other `booking_beds` in room during release window |
| `payments_untouched` | Policy + read-only payment row list for matched booking |
| `warnings` / `actionable` | Human + exit-code drivers |
| `hosted_parity_notes` | AT trigger, missing `found_match` gate, bed cancel semantics |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Report written; no actionable items |
| 1 | Bad args, client/room not found, parse error |
| 2 | Actionable: 0 or >1 match, invalid dates, overlap conflicts, release window issues |

## Tables read (SELECT only)

`clients`, `rooms`, `bookings`, `booking_beds`, `payments`, `payment_events`

**Not written:** `operator_room_release_requests` (preview only in JSON).

## Known unknowns / fixtures

- Local PG may have **no** operator `whole_room` bookings after CSV sync → report exits **2** with `no_matching_operator_booking` (expected until test fixture seeded).
- `--release-record-id` does not call Airtable (deferred).
- Block A/B provisional `booking_code` values are **preview only** (hosted uses random `WH-YYMMDD-A-####`).

## Sample output shape (abbreviated)

```json
{
  "phase": "3b.5a",
  "read_only": true,
  "match_phase": { "found_match": true, "match_count": 1, "candidates": [] },
  "split_phase": { "should_create_a": true, "should_create_b": true },
  "create_blocks_phase": { "new_booking_count": 2 },
  "payments_untouched": { "payments_count": 0 },
  "actionable": []
}
```

## Deferred (not 3b.5a)

| Item | Phase |
|------|--------|
| `db:operator-room-release:postgres` execute | 3b.5b |
| `build-operator-room-release-local.js` | 3b.5c |
| Airtable Get Release Request by `record_id` | Deprecated compat branch |
| n8n Form wiring | 3b.5c |

## Rollback

Remove:

- `scripts/report-operator-room-release-impact.js`
- `scripts/lib/operator-room-release-impact-plan.js`
- `docs/PHASE-3b-5a.md`
- `package.json` entry `db:report:operator-room-release-impact`
- `reports/operator-room-release-impact-*.json` artifacts

Postgres unchanged (SELECT-only).
