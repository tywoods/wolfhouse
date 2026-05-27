# Phase 3c.b — Main PG availability report (read-only)

**Status:** Implemented (CLI + lib). **No Main workflow wiring** (that is 3c.e).

**Parents:** [`PHASE-3c-PROPOSAL.md`](PHASE-3c-PROPOSAL.md), [`PHASE-3c-a.md`](PHASE-3c-a.md), [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md)

---

## Purpose

Given **session-like inputs** (dates, guest count, room preference), report **Postgres bed availability** for the Main booking flow using the **same overlap semantics** as Phase 3b assign/reassign impact tools.

This step does **not** change n8n, Airtable, or booking holds.

---

## Read-only guarantee

| Allowed | Forbidden |
|---------|-----------|
| `SELECT` on `clients`, `rooms`, `beds`, `bookings`, `booking_beds` | `INSERT` / `UPDATE` / `DELETE` on any table |
| JSON report under `reports/` | `payments`, `payment_events` read or write |
| | Airtable / Google Sheets API |

Report JSON includes `read_only: true` and `no_mutations: true`.

---

## Commands

```powershell
# Help
npm run db:report:main-availability -- --help

# Basic session-shaped query
npm run db:report:main-availability -- --check-in=2026-08-07 --check-out=2026-08-12 --guest-count=2 --room-type=shared

# Optional assign-impact parity (same dates + beds + existing booking)
npm run db:report:main-availability -- --check-in=2026-08-07 --check-out=2026-08-12 --guest-count=2 --compare-booking-code=WH-recBtWzIvmjQ5mmo0 --compare-beds=R7-B1,R7-B2

# Session JSON file (CLI flags override file keys when both set)
npm run db:report:main-availability -- --json-file=fixtures/3c-session-example.json --check-in=2026-08-07 --check-out=2026-08-12
```

Docker tools profile (from repo root):

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:main-availability -- --check-in=2026-08-07 --check-out=2026-08-12 --guest-count=2
```

---

## Report fields

| Field | Meaning |
|-------|---------|
| `parsed_input` | Normalized CLI/session input |
| `availability_found` | At least one candidate room fits guest count + filters |
| `candidate_rooms` | Rooms with enough free beds after overlap filter |
| `available_beds` | Sellable active beds with no PG overlap in window |
| `blocked_beds` | Beds with overlap conflicts |
| `overlap_conflicts` | Flat list (3b-style date intersection) |
| `room_capacity_summary` | Per-room free/blocked counts |
| `recommended_room_or_beds` | Simple PG heuristic (lowest `fill_priority`) |
| `warnings` / `actionable` | Human + exit-code hints |
| `parity_notes_with_main_airtable_logic` | Documented gaps vs Main JS |
| `parity_comparison_with_assign_impact` | Optional per-bed check vs `loadAssignPlan` |

---

## Relationship to Main workflow nodes

Maps to **`booking_flow`** / **`payment_details_provided`** availability subgraph (inventory P1):

- `Search Active Beds - WA`, `Search Existing Bed Assignments - WA`, `Search Rooms - WA`
- `Code - Check Bed Availability - WA`
- `Search Existing Bed Assignments - Nearby`, `Search Rooms - Nearby`, `Code - Check Nearby Availability` (nearby **not** implemented in 3c.b)

---

## Relationship to 3b overlap logic

Implemented in [`scripts/lib/main-availability-pg-sql.js`](../scripts/lib/main-availability-pg-sql.js):

- Overlap: `assignment_start_date < check_out` AND `assignment_end_date > check_in`
- Booking status: `NOT IN ('cancelled', 'expired')` — same as [`assign-booking-beds-plan.js`](../scripts/lib/assign-booking-beds-plan.js)

Optional parity: `--compare-booking-code` + `--compare-beds` uses `loadAssignPlan` from the same module family as `db:report:assign-impact`.

---

## Known gaps (Main JS vs PG report)

1. **Room scoring** — Main `Code - Check Bed Availability - WA` applies matrimonial, operator-room, multi-room, and richer gender rules; 3c.b uses simplified filters.
2. **Airtable status filter** — Main assignment search uses Hold/Confirmed/Checked_In/Blocked; PG excludes only `cancelled` / `expired` (may be stricter).
3. **Nearby alternatives** — Not computed in 3c.b.
4. **No hold create** — Availability does not write `bookings` (3c.c).

---

## Exit codes

| Code | When |
|------|------|
| `0` | Success; `availability_found` true |
| `1` | Bad args, client not found, DB error |
| `2` | `actionable` includes `no_availability` |

---

## Implementation files

| File | Role |
|------|------|
| [`scripts/lib/main-availability-pg-sql.js`](../scripts/lib/main-availability-pg-sql.js) | Core SELECT logic |
| [`scripts/report-main-availability.js`](../scripts/report-main-availability.js) | CLI + JSON report |
| `package.json` | `db:report:main-availability` |

---

## Next step (after 3c.b sign-off)

**3c.c** — PG booking hold / upsert (`Create Booking Hold` path), still local-only, using PG-first write order from the proposal.
