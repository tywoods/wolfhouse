# Phase 3b.1b — Postgres-only cancel bed assignments (proposal)

**Status:** Proposal only — **no implementation**, migrations, workflow edits, Airtable/Sheets writes, or production changes.  
**Prerequisites:** Phase **3b.1a** passed (`2c710fb` — cancel impact report).  
**Parents:** [`PHASE-3b-1-PROPOSAL.md`](PHASE-3b-1-PROPOSAL.md), [`PHASE-3b-1a.md`](PHASE-3b-1a.md)

**Explicitly out of scope for 3b.1b:**

- Hosted n8n **`cancel-booking-beds`** export and Cloud webhooks — read-only reference only  
- **Airtable** API (no delete/update of Booking Beds or Bookings)  
- **Google Sheets**  
- **`payments`**, **`payment_events`**, **`bookings.payment_status`**, Stripe workflows  
- **`bookings.status`** change (remains whatever it was before; staff/automation sets `cancelled` in AT)  
- **3b.1c** local n8n fork (PG → AT mirror)  
- **3b.2+** Assign / Reassign  

---

## Executive summary

3b.1b adds a **local CLI script** that performs the **Postgres half** of hosted **Cancel Bed Assignments**: delete all `booking_beds` for one booking and set `assignment_status` / `availability_check_status` to **`needs_review`**. It mirrors the inventory effect described in [`PHASE-3b-1-PROPOSAL.md`](PHASE-3b-1-PROPOSAL.md) §2.2 without calling Airtable.

**Dry-run is the default.** Mutations happen only when **`--execute`** is passed explicitly. Run **`db:report:cancel-impact`** (3b.1a) before every first execute on a booking.

---

## 1. Script goal

| Objective | Detail |
|-----------|--------|
| **Release beds in Postgres** | `DELETE` all `booking_beds` rows for the resolved `booking_id` (+ `client_id`) |
| **Match hosted assignment fields** | `UPDATE bookings` → `assignment_status = 'needs_review'`, `availability_check_status = 'needs_review'` |
| **Preserve booking row** | **Never** `DELETE FROM bookings` (`payments` FK is `ON DELETE CASCADE`) |
| **Preserve payment data** | **No** `UPDATE`/`DELETE` on `payments`, `payment_events`, or `bookings.payment_status` |
| **Preserve conversations** | No writes to `conversations` / `messages` |
| **Local only** | No staff-facing or hosted URL change; Airtable may still have Booking Beds until 3b.1c or manual staff action |

### Alignment with hosted Cancel workflow

Hosted export `n8n/Wolfhouse - Cancel Bed Assignments.json` (read-only):

1. Read Bookings by `record_id`  
2. Delete each linked **Booking Beds** record  
3. Update Bookings: **Assignment Status** / **Availability Check Status** → **Needs Review**  

3b.1b implements steps 2–3 **in Postgres only**. Step 1 is replaced by `--booking-code` / `--airtable-record-id` lookup.

### Relationship to 3b.1a

| Tool | Role |
|------|------|
| [`report-cancel-impact.js`](../scripts/report-cancel-impact.js) | **Before** execute: read-only plan (beds, planning rows, drift expectation) |
| **`cancel-booking-beds-postgres.js`** (proposed) | **Execute** the plan in PG when `--execute` |

---

## 2. Command design

### Proposed script and npm entry

| Item | Value |
|------|--------|
| **Script** | `scripts/cancel-booking-beds-postgres.js` |
| **npm** | `db:cancel:booking-beds` |

### Invocation

```powershell
# Default: dry-run (no mutations)
npm run db:cancel:booking-beds -- --booking-code=WH-rechKjCcySkfLzxUD

# Explicit dry-run (same as default)
npm run db:cancel:booking-beds -- --booking-code=WH-rechKjCcySkfLzxUD --dry-run

# Apply mutations (requires explicit flag)
npm run db:cancel:booking-beds -- --booking-code=WH-rechKjCcySkfLzxUD --execute

# Optional client
npm run db:cancel:booking-beds -- --booking-code=WH-recX --client=wolfhouse-somo --execute
```

Docker tools (same pattern as 3b.1a):

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools `
  npm run db:cancel:booking-beds -- --booking-code=WH-rechKjCcySkfLzxUD --execute
```

### Flags (proposed)

| Flag | Default | Description |
|------|---------|-------------|
| `--booking-code=WH-rec…` | — | **Required** unless `--airtable-record-id` |
| `--airtable-record-id=rec…` | — | Alternative lookup (same as 3b.1a) |
| `--client=wolfhouse-somo` | `wolfhouse-somo` | Client slug |
| `--dry-run` | **on** (implicit) | Print plan; no `DELETE`/`UPDATE` |
| `--execute` | off | Perform mutations inside a single transaction |
| `--require-status-cancelled` | off | **Optional strict mode:** refuse `--execute` unless `bookings.status IN ('cancelled','expired')` |
| `--json-log` | off | Write `reports/cancel-execute-<code>-<timestamp>.json` audit artifact |

**Design choice:** Default is **dry-run** without requiring the flag (backfill uses opt-in `--dry-run`; here **safer default is no writes** unless `--execute`). Document clearly: *absence of `--execute` = dry-run*.

### Exit codes (proposed)

| Code | Meaning |
|------|---------|
| 0 | Success (dry-run or execute; including idempotent second execute with 0 deletes) |
| 1 | Missing args, booking not found, ambiguous lookup, transaction error, or `--require-status-cancelled` violation |

---

## 3. Exact DB mutations if `--execute`

All mutations in **one transaction** (`BEGIN` → work → `COMMIT`; `ROLLBACK` on error).

### 3.1 DELETE `booking_beds`

```sql
DELETE FROM booking_beds
 WHERE client_id = $client_id
   AND booking_id = $booking_id;
```

- Scope: **only** the resolved booking.  
- Returns `rowCount` for console summary.  
- Does **not** delete by `bed_id` alone.

### 3.2 UPDATE `bookings`

```sql
UPDATE bookings
   SET assignment_status = 'needs_review',
       availability_check_status = 'needs_review'
 WHERE id = $booking_id
   AND client_id = $client_id;
```

- **Does not** set `status = 'cancelled'`.  
- **Does not** touch `payment_status`, money columns, `check_in`/`check_out`, guest fields.  
- `updated_at` set by existing trigger.

### 3.3 No other mutations

| Table | 3b.1b |
|-------|--------|
| `payments` | **No** read required for write; optional SELECT for warnings only |
| `payment_events` | **No** |
| `conversations`, `messages` | **No** |
| `rooms`, `beds` | **No** |
| `bookings` DELETE | **No** |

### 3.4 Optional audit (no migration)

If approved, append to `bookings.metadata` on execute only (JSONB merge):

```json
{
  "beds_cancelled_at": "2026-05-26T12:00:00.000Z",
  "beds_cancelled_by": "cancel-booking-beds-postgres.js",
  "beds_removed_count": 3
}
```

**Proposal:** include in v1 for local traceability; skip if owner prefers zero metadata writes.

---

## 4. Safety checks

### 4.1 Before any output

| Check | On failure |
|-------|------------|
| Client exists (`clients.slug`) | Exit 1 |
| Exactly one booking for lookup | Exit 1 (not found / ambiguous) |
| Booking `client_id` matches resolved client | Exit 1 |

### 4.2 Dry-run and execute (both)

| Check | Behaviour |
|-------|-----------|
| List current `booking_beds` | Print table: `booking_bed_id`, `bed_code`, start/end, `natural_key` |
| Show current `assignment_status`, `availability_check_status`, `status`, `payment_status` | Console + optional JSON |
| Compare to 3b.1a | Suggest: `npm run db:report:cancel-impact -- --booking-code=…` if not run recently |

### 4.3 Execute-only guards

| Guard | Behaviour |
|-------|-----------|
| **`--execute` required** | Without it: **never** call `DELETE`/`UPDATE` |
| **Confirmation line** | Print: `EXECUTE: will delete N booking_beds and update booking <code>` |
| **`--require-status-cancelled`** (optional) | If set and `status` ∉ (`cancelled`,`expired`): exit 1 |

### 4.4 Payment / paid booking policy

| Scenario | Recommendation |
|----------|----------------|
| `payment_status` ∈ `deposit_paid`, `paid` | **Warn** in console and JSON; **do not block** execute |
| Rationale | Hosted Cancel workflow does not alter payment fields; staff may cancel paid bookings; Phase 2 payment history must remain |
| Future | Owner may add `--block-if-paid` for extra-local caution; **not** default |

### 4.5 Wrong-booking prevention

| Rule | Detail |
|------|--------|
| Lookup | By `booking_code` or `airtable_record_id` only — **not** by phone |
| Single booking | `LIMIT 2` on SELECT; abort if >1 row |
| No bulk | No `--all` flag in 3b.1b |

### 4.6 Airtable drift warning (execute)

After execute, print:

> Airtable Booking Beds for this booking are **unchanged**. Expect `db:report:bed-drift` actionable mismatch until 3b.1c or manual AT delete.

---

## 5. Idempotency

### 5.1 Second `--execute` on same booking

| Step | Second run |
|------|------------|
| `DELETE booking_beds` | **0 rows** — success |
| `UPDATE bookings` | Sets same enum values again — harmless |
| Exit code | **0** |
| Console | `deleted_beds: 0 (idempotent)` |

### 5.2 Dry-run after execute

- Reports **0 beds** would be removed.  
- Still shows UPDATE targets (already `needs_review`).

### 5.3 Interaction with `db:sync`

- `db:sync` **re-imports** `booking_beds` from CSV for the whole client (destructive local rebuild).  
- Not idempotent across sync — document in recovery (§6).

---

## 6. Rollback / recovery

### 6.1 Undo 3b.1b in Postgres only

| Method | When to use |
|--------|-------------|
| **`npm run db:sync`** | Local dev: rebuild `booking_beds` (and other tables) from `database/*.csv` for `wolfhouse-somo`. **Wipes** client-scoped bed rows then re-inserts from export. |
| **Re-insert from CSV row** | If only one booking: sync is heavy; acceptable for local because export contains active assignments |

**Why CSV works:** `Booking Beds-Active Bed Assignments.csv` is the Airtable export snapshot; sync maps rows into `booking_beds` by `booking_code` + bed/dates.

### 6.2 What not to roll back

| Data | Rule |
|------|------|
| **`payments` / `payment_events`** | Never delete or “rollback” as part of bed cancel |
| **`bookings.payment_status`** | Unchanged by 3b.1b — no payment rollback |
| **Hosted Airtable** | Untouched by 3b.1b — no AT rollback needed for script itself |

### 6.3 Partial / mistaken execute

| Situation | Recovery |
|-----------|----------|
| Wrong booking executed | `db:sync` from known-good CSV export; fix AT separately if staff already changed it |
| PG cleared, AT still has beds | Expected until 3b.1c; drift report documents keys only in CSV |
| Need assignment fields reverted | Manual `UPDATE` or re-sync booking row from CSV (assignment columns in Bookings export) |

### 6.4 Return to pre-3b.1b behaviour

Remove script + npm entry; Postgres state is whatever last execute/sync left. No workflow rollback.

---

## 7. Test plan

### 7.1 Fixture

Use a booking with **≥1** `booking_beds` in Postgres (verified in 3b.1a):

- **Example:** `WH-rechKjCcySkfLzxUD` (3 beds, 3 planning rows in impact report)  
- Prefer a **local/test** booking; avoid production staff actions on shared AT during PG-only tests  

### 7.2 Steps

| Step | Command | Expected |
|------|---------|----------|
| T0 | `npm run db:report:cancel-impact -- --booking-code=WH-rechKjCcySkfLzxUD` | JSON: 3 beds would remove; payments untouched |
| T1 | `npm run db:cancel:booking-beds -- --booking-code=…` (no `--execute`) | Dry-run; **0** DB mutations; lists 3 beds |
| T2 | `npm run db:cancel:booking-beds -- --booking-code=… --execute` | `deleted_beds: 3`; assignment fields `needs_review` |
| T3 | Same `--execute` again | `deleted_beds: 0`; exit 0 |
| T4 | `npm run db:report:bed-drift` | For this booking: PG bed count 0; possible **actionable** CSV-only keys until AT caught up |
| T5 | `npm run planning:report:postgres` | Fixture bed rows **gone** if `status` still active; gone from bed join regardless |
| T6 | `npm run db:report:cancel-impact -- --booking-code=…` | 0 beds would remove |
| T7 | Phase 2 regression | All green (below) |

### 7.3 Regression commands (must still pass)

```powershell
npm run test:phase2f-resolver
npm run test:planning-row-format
npm run test:bed-drift-keys
npm run db:report:drift
```

**Note:** After T2, `db:report:bed-drift` may exit **1** if the booking is in CSV export and AT export still has bed keys — **expected** until AT delete (3b.1c). Document as pass with documented drift, or run test on a **PG-only** local booking.

### 7.4 Pass criteria (3b.1b sign-off)

| Criterion | Pass |
|-----------|------|
| Dry-run never mutates | Verified via row counts / re-run impact report |
| Execute removes only scoped `booking_beds` | Impact + manual SELECT |
| `payments` row count unchanged | `SELECT COUNT(*)` before/after |
| Second execute idempotent | `deleted_beds: 0` |
| No n8n / AT / Sheets changes | Git diff clean under `n8n/` |

---

## 8. Files to create/modify if approved

| Action | Path |
|--------|------|
| **Create** | `scripts/cancel-booking-beds-postgres.js` |
| **Create** | `docs/PHASE-3b-1b.md` (runbook; implementation status after merge) |
| **Modify** | `package.json` — `"db:cancel:booking-beds": "node scripts/cancel-booking-beds-postgres.js"` |
| **Modify** | `docs/regression-test-plan.md` — Phase 3b.1b section |
| **Modify** | `docs/PHASE-3b-1a.md` — link “next step: 3b.1b” (one line) |

**Reuse (no fork):**

- `scripts/lib/pg-connect.js`  
- `scripts/lib/bed-drift-keys.js` — `assignmentNaturalKey`, `toIsoDateString` for pre-delete listing  

**Not created in 3b.1b:**

- `scripts/build-cancel-beds-local.js` / `n8n/phase3b/*` — **3b.1c**  
- Migrations / unique indexes on `booking_beds`  

---

## 9. Approval checklist (before implementation)

- [ ] Owner approves **Postgres DELETE** on `booking_beds` for explicit `--execute` only  
- [ ] Owner accepts **warn-but-do-not-block** on `deposit_paid` / `paid`  
- [ ] Owner accepts **AT drift** after PG-only execute until 3b.1c  
- [ ] Default **dry-run unless `--execute`** confirmed  
- [ ] Optional: `metadata` audit on `bookings` — yes/no  
- [ ] Optional: `--require-status-cancelled` — enable by default? (**proposal: off by default** for local inventory tests on `confirmed` bookings)  

---

## 10. Sequence after 3b.1b

```
3b.1a  cancel-impact report (read-only)     ✅ done
3b.1b  cancel-booking-beds-postgres.js      ← this proposal
3b.1c  local n8n fork: PG → AT delete       proposal in PHASE-3b-1-PROPOSAL.md
3b.2   Assign dual-write                    PHASE-3b-PROPOSAL.md
```

---

## References

| Doc / commit | Content |
|--------------|---------|
| `4d0637c` | Phase 3b.1 cancel proposal |
| `2c710fb` | Phase 3b.1a cancel impact report |
| `scripts/report-cancel-impact.js` | Pre-execute read-only report |
| `n8n/Wolfhouse - Cancel Bed Assignments.json` | Hosted behaviour (read-only) |
| `docs/airtable-automations.md` §4 | Automation trigger |
| `scripts/sync-csv-to-postgres.js` | Local recovery via `db:sync` |
