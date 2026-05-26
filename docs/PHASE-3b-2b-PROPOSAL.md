# Phase 3b.2b — Postgres-only assign booking beds (proposal)

**Status:** Proposal only — **no implementation**, migrations, workflow edits, Airtable/Sheets writes, or production changes.  
**Prerequisites:** Phase **3b.2a** (`aa278c3` — assign impact report).  
**Parents:** [`PHASE-3b-2-PROPOSAL.md`](PHASE-3b-2-PROPOSAL.md), [`PHASE-3b-2a.md`](PHASE-3b-2a.md), [`PHASE-3b-1b-PROPOSAL.md`](PHASE-3b-1b-PROPOSAL.md)

**Explicitly out of scope for 3b.2b:**

- Hosted n8n **`assign-beds-to-booking`** export and Cloud webhooks — read-only reference only  
- **Airtable** API (no create/update of Booking Beds or Bookings)  
- **Google Sheets**  
- **`payments`**, **`payment_events`**, **`bookings.payment_status`**, Stripe / Main / Send Confirmation  
- **`bookings.status`** change (Confirmed, `payment_pending`, etc. stay as-is)  
- **`bookings` DELETE** (never; `payments` FK is `ON DELETE CASCADE`)  
- **3b.2c** local n8n Assign fork (PG → AT mirror)  
- **3b.3** Reassign  

---

## Executive summary

3b.2b adds a **local CLI script** that performs the **Postgres half** of hosted **Bed Assignment** for an **explicit bed list**: INSERT missing `booking_beds` rows and UPDATE `bookings.assignment_status` / `availability_check_status` to match a successful assign path. It does **not** run `Code - Choose Beds`; staff or tests supply `--beds`.

**Dry-run is the default.** Mutations happen only when **`--execute`** is passed. Run **`db:report:assign-impact`** (3b.2a) before every first execute on a booking.

---

## 1. Script goal

| Objective | Detail |
|-----------|--------|
| **Assign beds in Postgres** | `INSERT` `booking_beds` for each proposed bed/date not already present (natural key) |
| **Match hosted assignment fields (success path)** | `UPDATE bookings` → `assignment_status = 'assigned'`, `availability_check_status = 'available'` |
| **Conflict path (optional)** | If overlaps detected and `--allow-conflict` not set: refuse `--execute`; with `--allow-conflict`: set `needs_review` / `conflict` (mirror AT conflict branch) |
| **Preserve booking row** | **Never** `DELETE FROM bookings` |
| **Preserve payment data** | **No** `UPDATE`/`DELETE` on `payments`, `payment_events`, or `bookings.payment_status` |
| **Preserve conversations** | No writes to `conversations` / `messages` |
| **Local only** | No staff-facing or hosted URL change; Airtable may have zero Booking Beds until 3b.2c or manual staff action |
| **No algorithm port** | Does not duplicate `Code - Choose Beds` (~23k LOC); bed list comes from CLI |

### Alignment with hosted Bed Assignment workflow

Hosted export `n8n/Wolfhouse - Bed Assignment.json` (read-only):

1. Read Bookings; gate on Assignment Status / Status  
2. Search Beds, Booking Beds (overlap), Rooms  
3. **Code - Choose Beds** → pick beds  
4. Create **Booking Beds** rows  
5. Update Bookings: **Assigned** / **Available** (or **Needs Review** / **Conflict**)  

3b.2b implements steps 4–5 **inventory effect in Postgres only**, with beds supplied via **`--beds`** instead of step 3.

### Relationship to 3b.2a

| Tool | Role |
|------|------|
| [`report-assign-impact.js`](../scripts/report-assign-impact.js) | **Before** execute: read-only plan (would insert, overlaps, guest count, planning preview) |
| **`assign-booking-beds-postgres.js`** (proposed) | **Execute** the plan in PG when `--execute` |

**Recommendation:** Share validation logic (natural key, overlap query, bed lookup) between 3b.2a and 3b.2b via a small `scripts/lib/assign-booking-beds-plan.js` helper in implementation — proposal only; not required for approval.

---

## 2. Command design

### Proposed script and npm entry

| Item | Value |
|------|--------|
| **Script** | `scripts/assign-booking-beds-postgres.js` |
| **npm** | `db:assign:booking-beds` |

### Invocation

```powershell
# Default: dry-run (no mutations)
npm run db:assign:booking-beds -- --booking-code=WH-rechKjCcySkfLzxUD --beds=R7-B1,R7-B2,R7-B3

# Explicit dry-run (same as default)
npm run db:assign:booking-beds -- --booking-code=WH-recX --beds=R7-B1 --dry-run

# Apply mutations (requires explicit flag)
npm run db:assign:booking-beds -- --booking-code=WH-rechKjCcySkfLzxUD --beds=R7-B1,R7-B2,R7-B3 --check-in=2026-08-07 --check-out=2026-08-12 --execute

# Optional client
npm run db:assign:booking-beds -- --booking-code=WH-recX --beds=R7-B1,R7-B2 --client=wolfhouse-somo --execute
```

Docker tools:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools `
  npm run db:assign:booking-beds -- --booking-code=WH-rec... --beds=R7-B1,R7-B2 --execute
```

### Flags (proposed)

| Flag | Default | Description |
|------|---------|-------------|
| `--booking-code=WH-rec…` | — | **Required** unless `--airtable-record-id` |
| `--beds=R7-B1,R7-B2` | — | **Required** comma-separated bed codes (uppercased) |
| `--check-in=YYYY-MM-DD` | booking `check_in` | Assignment start date (ISO) |
| `--check-out=YYYY-MM-DD` | booking `check_out` | Assignment end date (ISO) |
| `--airtable-record-id=rec…` | — | Alternative booking lookup |
| `--client=wolfhouse-somo` | `wolfhouse-somo` | Client slug |
| `--dry-run` | **on** (implicit) | Print plan; no `INSERT`/`UPDATE` |
| `--execute` | off | Perform mutations inside a single transaction |
| `--assignment-type=…` | `Auto Assigned` | Stored on `booking_beds.assignment_type` (e.g. `Manual Staff Assignment`) |
| `--strict-guest-count` | off | Refuse `--execute` if total beds ≠ `guest_count` after assign |
| `--strict-overlap` | **on for execute** | Refuse `--execute` if PG overlap with another booking (default **true**) |
| `--allow-conflict` | off | On overlap: still execute but set `needs_review` / `conflict` instead of `assigned` / `available` |
| `--json-log` | off | Write `reports/assign-execute-<code>-<timestamp>.json` audit artifact |

**Design choice:** Same as 3b.1b — *absence of `--execute` = dry-run*. Document in `PHASE-3b-2b.md` runbook.

### Exit codes (proposed)

| Code | Meaning |
|------|---------|
| 0 | Success (dry-run or execute; including idempotent second execute with 0 inserts) |
| 1 | Missing args, booking not found, ambiguous lookup, unknown bed code, invalid dates, overlap (strict), guest-count (strict), transaction error |
| 2 | *(Reserved — not used by script; 3b.2a uses 2 for actionable read-only warnings)* |

---

## 3. Exact DB mutations if `--execute`

All mutations in **one transaction** (`BEGIN` → work → `COMMIT`; `ROLLBACK` on error).

### 3.1 INSERT `booking_beds` (per bed to insert)

For each bed in the plan’s `would_insert` list (see 3b.2a), one row:

```sql
INSERT INTO booking_beds (
  client_id,
  booking_id,
  bed_id,
  bed_code,
  room_code,
  assignment_start_date,
  assignment_end_date,
  assignment_type,
  assignment_notes,
  guest_name,
  airtable_record_id
) VALUES (
  $client_id,
  $booking_id,
  $bed_id,
  $bed_code,
  $room_code,
  $start::date,
  $end::date,
  $assignment_type,
  $notes,
  $guest_name,
  NULL
);
```

| Column | Source |
|--------|--------|
| `bed_id` | `beds.id` WHERE `bed_code` = `--beds` entry |
| `bed_code` | Normalized `R7-B1` |
| `room_code` | Derived from bed code prefix (`R7` from `R7-B1`) or `rooms` join |
| `assignment_start_date` / `assignment_end_date` | `--check-in` / `--check-out` (or booking dates) |
| `guest_name` | Copy from `bookings.guest_name` |
| `airtable_record_id` | **`NULL`** until 3b.2c backfills from AT create |
| `assignment_notes` | e.g. `Assigned via assign-booking-beds-postgres.js (local 3b.2b)` |

**Skip INSERT** when natural key already exists for this booking:

```text
{booking_code}|{bed_code}|{start_iso}|{end_iso}
```

(same as [`bed-drift-keys.js`](../scripts/lib/bed-drift-keys.js))

### 3.2 UPDATE `bookings`

**Success path** (no overlaps, or overlaps ignored only when policy allows):

```sql
UPDATE bookings
   SET assignment_status = 'assigned',
       availability_check_status = 'available'
 WHERE id = $booking_id
   AND client_id = $client_id;
```

**Conflict path** (`--allow-conflict` and overlaps detected, or internal conflict flag):

```sql
UPDATE bookings
   SET assignment_status = 'needs_review',
       availability_check_status = 'conflict'
 WHERE id = $booking_id
   AND client_id = $client_id;
```

| Column | 3b.2b |
|--------|--------|
| `status` | **No UPDATE** |
| `payment_status` | **No UPDATE** |
| `check_in` / `check_out` | **No UPDATE** (assignment dates live on `booking_beds`) |
| Money / deposit columns | **No UPDATE** |

`updated_at` via existing trigger.

### 3.3 No other mutations

| Table | 3b.2b |
|-------|--------|
| `payments` | SELECT only (count before/after; abort if count changes) |
| `payment_events` | SELECT only |
| `conversations`, `messages` | **No** |
| `rooms`, `beds` | **No** (read `beds` for FK) |
| `bookings` DELETE | **No** |
| `booking_beds` DELETE | **No** (use 3b.1b cancel script to undo) |

### 3.4 Post-execute assertions (inside transaction)

Same pattern as 3b.1b:

1. `COUNT(payments WHERE booking_id)` unchanged  
2. `payment_status` on booking unchanged  
3. Optional: log `inserted_count`, `skipped_count`

---

## 4. Safety checks

### 4.1 Before any output

| Check | On failure |
|-------|------------|
| Client exists | Exit 1 |
| `--beds` non-empty | Exit 1 |
| Exactly one booking | Exit 1 (not found / ambiguous) |
| `check_in` / `check_out` resolvable and `end > start` | Exit 1 |

### 4.2 Dry-run and execute (both)

| Check | Behaviour |
|-------|-----------|
| Each bed code exists in `beds` for client | Exit 1; list `unknown_bed_codes[]` |
| Natural key already on booking | **Skip** (idempotent); print in `would_skip` |
| PG overlap: same `bed_id`, intersecting dates, **other** `booking_id`, status not cancelled/expired | **Strict (default on execute):** exit 1; **dry-run:** print conflicts |
| `guest_count` vs total beds after assign | **Warn** on stdout; exit 1 only if `--strict-guest-count` on execute |
| Booking `status` cancelled/expired | **Warn**; exit 1 on execute unless `--force` *(optional; default refuse execute)* |
| `assignment_status` already `assigned` | **Warn**; allow execute if only inserting missing keys |

### 4.3 Console output (both modes)

Print before summary (mirror 3b.1b bed table):

1. Resolved booking (`booking_code`, `status`, `guest_count`, dates)  
2. **Existing** `booking_beds` (id, bed_code, dates, natural_key)  
3. **Proposed inserts** (bed_code, dates, natural_key, overlap flag)  
4. **Skipped** (reason)  
5. **Would-update** assignment fields  
6. Payments: `N rows (untouched)`  

### 4.4 Execute-only guards

| Guard | Detail |
|-------|--------|
| `--execute` confirmation line | `EXECUTE: will INSERT N booking_beds and UPDATE booking <code>` |
| Transaction rollback | Any assertion failure → full rollback |
| Zero inserts + zero assignment change needed | Still exit **0** (idempotent) |

---

## 5. Idempotency

| Scenario | Expected behaviour |
|----------|-------------------|
| **Same command twice** (`--execute`, same beds/dates) | Second run: **0 INSERT**; assignment UPDATE may run again (same values); exit **0** |
| **Partially assigned booking** | Only missing natural keys inserted; existing rows untouched |
| **Duplicate natural keys** | Pre-INSERT SELECT; never two rows with same key for one booking |
| **Overlap with self** | Same booking + same bed + same dates → skip (already exists), not overlap error |
| **AT has beds, PG empty** | First execute inserts N rows; `db:report:bed-drift` may show keys only in PG until sync/3b.2c |

**Not idempotent across Reassign:** Removing beds is **3b.3** / `db:cancel:booking-beds` — out of scope.

---

## 6. Rollback / recovery

### 6.1 Undo PG assign for one booking

| Method | Command |
|--------|---------|
| **Cancel beds in PG only** | `npm run db:cancel:booking-beds -- --booking-code=WH-rec… --execute` (3b.1b) — DELETE all `booking_beds` for booking; sets assignment fields to `needs_review` |
| **Does not remove AT beds** | Staff or 3b.2c must align Airtable separately |

### 6.2 Rebuild from CSV mirror

| Method | Use when |
|--------|----------|
| **`npm run db:sync`** | Local dev: replace all client `booking_beds` from `database/Booking Beds-Active Bed Assignments.csv` |

### 6.3 What never gets rolled back by assign undo

| Data | Rule |
|------|------|
| **`payments`, `payment_events`** | Never deleted or modified by assign or cancel-bed scripts |
| **`bookings` row** | Never DELETE |
| **`payment_status`** | Unchanged by 3b.2b |

### 6.4 Partial failure

| Failure mode | Recovery |
|--------------|----------|
| **INSERT succeeded, script crashed before COMMIT** | Transaction rollback — no partial commit |
| **COMMIT ok, wrong beds** | `db:cancel:booking-beds --execute` then re-run with correct `--beds` |
| **PG assigned, AT empty** | Expected until 3b.2c; use `db:report:bed-drift` to track |

---

## 7. Test plan

Use fixture **`WH-rechKjCcySkfLzxUD`** (or dedicated test booking) after `db:sync` when a clean baseline is needed.

| ID | Step | Command / action | Expected |
|----|------|------------------|----------|
| T0 | Baseline | `db:report:assign-impact` with same flags | Plan matches script dry-run |
| T1 | Dry-run | `db:assign:booking-beds` without `--execute` | No mutations; lists would_insert |
| T2 | **Assign, no beds** | Booking with 0 PG beds; `--beds` = guest_count beds; `--execute` | N INSERT; assignment `assigned` |
| T3 | **Idempotent** | Repeat T2 | 0 INSERT; exit 0 |
| T4 | **Partial** | Booking with 1 bed; assign 2 more (same dates) | 2 INSERT only |
| T5 | **Unknown bed** | `--beds=FAKE-B1` | Exit 1 before execute |
| T6 | **Overlap** | Assign bed/dates already held by another booking | Strict: exit 1; dry-run shows conflict |
| T7 | **Guest count** | 2 beds for `guest_count=3` | Warn; exit 1 with `--strict-guest-count` |
| T8 | Payments | SELECT before/after | Count and `payment_status` unchanged |
| T9 | `db:report:bed-drift` | After T2 | May show keys only in PG until AT sync (documented) |
| T10 | `planning:report:postgres` | After T2 | New bed rows in CSV output |
| T11 | `test:phase2f-resolver` | — | 10/10 |
| T12 | Undo | `db:cancel:booking-beds --execute` | PG beds removed; restore via `db:sync` if needed |

### Pass criteria (3b.2b complete)

- Dry-run default; `--execute` required for writes  
- Idempotent second execute (0 inserts)  
- No payment mutations  
- `db:report:assign-impact` and script agree on would_insert / overlaps  
- Regression commands in T10–T11 still pass  

---

## 8. Files if approved (implementation)

| Action | Path |
|--------|------|
| **Create** | `scripts/assign-booking-beds-postgres.js` |
| **Create** | `docs/PHASE-3b-2b.md` (runbook after implementation) |
| **Optional create** | `scripts/lib/assign-booking-beds-plan.js` (shared with 3b.2a refactor) |
| **Modify** | `package.json` — `"db:assign:booking-beds": "node scripts/assign-booking-beds-postgres.js"` |
| **Modify** | `docs/regression-test-plan.md` — Phase 3b.2b section |

**Not modified:**

| Path | Reason |
|------|--------|
| `n8n/Wolfhouse - Bed Assignment.json` | Hosted export |
| `n8n/phase3b/*` | 3b.2c only |
| `n8n/Wolfhouse - Reassign Bed Assignments.json` | 3b.3 |
| `scripts/report-assign-impact.js` | Optional small refactor only; not required for 3b.2b MVP |
| `database/migrations/*` | No migration in 3b.2b |
| Payment / Main / Stripe paths | Out of scope |

---

## 9. Approval checklist

- [ ] Owner approves **explicit `--beds` list** (no auto picker in 3b.2b)  
- [ ] Owner approves **INSERT + assignment UPDATE** scope only  
- [ ] Owner approves **dry-run default** + **`--execute`** gate  
- [ ] Owner approves **strict overlap** default on execute  
- [ ] Guest-count: **warn** vs **`--strict-guest-count`** fail  
- [ ] Confirm **3b.2c** and **Reassign** remain separate  
- [ ] Run **`db:report:assign-impact`** before first execute on each test booking  

---

## 10. Sequence in Phase 3b

```
3b.0   bed drift audit                         ✅
3b.1   Cancel (impact → PG script → local n8n) ✅
3b.2a  assign impact report (read-only)       ✅ aa278c3
3b.2b  assign-booking-beds-postgres.js         ← this proposal
3b.2c  local n8n Assign fork (PG → AT)         not started
3b.3   Reassign                                 not started
```

---

## References

| Item | Location |
|------|----------|
| Assign impact report | `scripts/report-assign-impact.js`, `docs/PHASE-3b-2a.md` |
| Cancel PG script (undo pattern) | `scripts/cancel-booking-beds-postgres.js`, `docs/PHASE-3b-1b.md` |
| Hosted Assign export | `n8n/Wolfhouse - Bed Assignment.json` |
| Natural keys | `scripts/lib/bed-drift-keys.js` |
| Parent assign plan | `docs/PHASE-3b-2-PROPOSAL.md` |
| Regression §2 / §3b.2a | `docs/regression-test-plan.md` |
| Schema | `database/migrations/001_init.sql` (`booking_beds`, `bookings`) |
