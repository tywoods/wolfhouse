# Phase 3c.c — Main PG booking hold (plan → execute → workflow)

**Status:** **3c.c.1** implemented (read-only hold plan). **No Postgres writes**, no workflow changes.

**Parents:** [`PHASE-3c-PROPOSAL.md`](PHASE-3c-PROPOSAL.md), [`PHASE-3c-b.md`](PHASE-3c-b.md), [`PHASE-3c-a.md`](PHASE-3c-a.md)

---

## Scope

| Substep | Deliverable | Mutations |
|---------|-------------|-----------|
| **3c.c.1** (this) | `db:report:main-hold-plan` — availability + guards + `would_upsert` | **None** |
| **3c.c.2** | Execute CLI / mutation SQL in lib | `bookings` only |
| **3c.c.3** | Ensure Booking promote shared SQL | `bookings` |
| **3c.c.4** | Fixtures `WH-3C-HOLD-*` | test data |
| **3c.e** | `build-main-local-stripe.js` inject PG before `Create Booking Hold` | workflow |

**Out of scope for 3c.c:** `booking_beds`, `conversations`/`messages` (3c.d), `payments`/`payment_events`, workflow JSON (3c.e).

---

## Why read-only first

1. **3c.b** proved overlap semantics — holds must not run when `availability_found=false`.
2. **Active-hold guard** must be visible before any INSERT (same phone + overlapping dates).
3. **`booking_code`** collisions must be classified (insert / update / promote / conflict) before dual-write with Airtable.

---

## Relationship to Main workflow

### Create Booking Hold (Airtable)

Today: `Code - Prepare Hold Records` → **`Create Booking Hold`** (AT create).

Target (3c.e): **`Postgres - Create Booking Hold`** → IF ok → **`Create Booking Hold`** (mirror only).

### Postgres - Ensure Booking In Postgres

Today: Stripe branch INSERT with `payment_pending` / `waiting_payment`; `airtable_record_id` NULL.

Target: **Promote** existing hold row by `booking_code`; backfill `airtable_record_id` after AT create.

---

## `booking_code` strategy

| Pattern | Use |
|---------|-----|
| `WH-YYMMDD-####` | Main `Code - Prepare Hold Records` (production shape) |
| `WH-3C-HOLD-TEST-001` | Local plan/execute fixtures (explicit, no random) |

Unique key: `(client_id, booking_code)`.

---

## CLI (3c.c.1)

```powershell
npm run db:report:main-hold-plan -- --help

npm run db:report:main-hold-plan -- ^
  --booking-code=WH-3C-HOLD-TEST-001 ^
  --check-in=2026-08-07 ^
  --check-out=2026-08-12 ^
  --guest-count=2 ^
  --phone=+353300000001
```

Docker:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:main-hold-plan -- --booking-code=WH-3C-HOLD-TEST-001 --check-in=2026-08-07 --check-out=2026-08-12 --guest-count=2
```

---

## Report fields

- `availability_summary` — from [`main-availability-pg-sql.js`](../scripts/lib/main-availability-pg-sql.js)
- `active_hold_guard` — SELECT overlapping `hold` / `payment_pending` for phone
- `booking_code_guard` — SELECT by code + `planned_action`
- `would_upsert_booking` — null when plan blocked
- `proposed_*` status fields — `hold` vs `payment_pending` from guest name+email
- `airtable_record_id_plan` — null until AT mirror (3c.e)
- `downstream_contract` — booking_code for AT + Stripe; UUID only after execute

---

## Safety

| Rule | 3c.c.1 |
|------|--------|
| Availability first | Blocks plan if `no_availability` |
| PG failure blocks AT (later) | Plan shows `plan_allowed=false` |
| No `booking_beds` | Documented |
| No payments | No read/write |
| `read_only` / `no_mutations` | Always true in 3c.c.1 |

---

## Exit codes

| Code | When |
|------|------|
| `0` | Plan allowed (`plan_allowed=true`) |
| `1` | Bad args / client not found / DB error |
| `2` | `actionable`: `no_availability`, `active_hold_exists`, `booking_code_conflict` |

---

## Implementation files

| File | Role |
|------|------|
| [`scripts/lib/main-booking-hold-pg-sql.js`](../scripts/lib/main-booking-hold-pg-sql.js) | SELECT guards + future SQL TODO names |
| [`scripts/lib/main-booking-hold-plan.js`](../scripts/lib/main-booking-hold-plan.js) | Plan builder |
| [`scripts/report-main-hold-plan.js`](../scripts/report-main-hold-plan.js) | CLI |

---

## Next steps

1. **3c.c.2** — mutation SQL + `db:main-hold:upsert` execute (fixtures only).
2. **3c.c.3** — shared Ensure Booking promote SQL + CLI test.
3. **3c.d** — conversation `current_hold_booking_id`.
4. **3c.e** — build script inject + regenerate fork.
