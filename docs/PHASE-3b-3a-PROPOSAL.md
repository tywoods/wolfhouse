# Phase 3b.3a — Reassign impact report (read-only) (proposal)

**Status:** Proposal only — **no implementation**, workflow JSON edits, hosted import, or Airtable writes.  
**Prerequisites:** Phase **3b.1a** (cancel impact), **3b.2a** (assign impact), **3b.3** proposal (`998dc7f`).  
**Parents:** [`PHASE-3b-3-PROPOSAL.md`](PHASE-3b-3-PROPOSAL.md), [`PHASE-3b-2a.md`](PHASE-3b-2a.md), [`PHASE-3b-1a.md`](PHASE-3b-1a.md), [`PHASE-3b-PROPOSAL.md`](PHASE-3b-PROPOSAL.md)

**Explicitly out of scope for 3b.3a:**

- **`scripts/report-reassign-impact.js`** implementation (this document only)  
- **3b.3b** local Reassign n8n fork (`build-reassign-beds-local.js`)  
- Editing **hosted** n8n exports or importing to n8n Cloud  
- **Airtable** / **Google Sheets** reads or writes  
- **`payments`**, **`payment_events`**, **`bookings.payment_status`** mutations  
- **Main**, Stripe, Send Confirmation  
- **`bookings` DELETE**  

---

## Executive summary

3b.3a adds a **read-only CLI report** that answers: *“If we reassigned this booking in Postgres (delete all current beds, then assign these new beds), what would change?”*

Reassign in production is **reset + assign**. The report **composes** two existing mental models:

1. **Cancel phase (PG)** — all current `booking_beds` for the booking would be **removed** (same scope as [`cancel-booking-beds-postgres.js`](../scripts/cancel-booking-beds-postgres.js) / 3b.1a).  
2. **Assign phase (PG)** — proposed `--beds` would be **inserted** (same rules as [`assign-booking-beds-postgres.js`](../scripts/assign-booking-beds-postgres.js) / 3b.2a).

The CLI does **not** call n8n, does **not** simulate **Code - Choose Beds**, and does **not** write Airtable. For bed codes, the operator passes **`--beds`** explicitly (from staff intent, a prior assign-impact run, or expected Choose Beds outcome).

**Deliverable when implemented:** `npm run db:report:reassign-impact` → `reports/reassign-impact-<booking_code>-<timestamp>.json`.

---

## 1. What the impact report shows

### 1.1 Questions answered

| # | Question |
|---|----------|
| 1 | Which **Postgres booking** is affected |
| 2 | Which **`booking_beds` rows would be removed** (full reassign reset — all beds for this booking) |
| 3 | Which **beds are proposed** for the post-reassign assign (`--beds`) |
| 4 | Which **`booking_beds` would be inserted** after reassign (natural keys, dates) |
| 5 | Whether proposed beds **overlap** other bookings in Postgres (excluding this booking’s current rows, which are treated as removed in the assign phase) |
| 6 | Whether **guest count** matches proposed bed count (warn / actionable) |
| 7 | **Planning report** rows **before**, **after cancel-only**, and **after full reassign** (simulated) |
| 8 | Whether **`payments` / `payment_events` / `payment_status`** remain untouched |

### 1.2 Section-by-section output (proposed JSON)

| Section | Content |
|---------|---------|
| `no_mutations` | Always `true`; policy statement |
| `postgres_booking` | Resolved booking row (codes, dates, guest_count, assignment fields) |
| `summary` | Counts: existing beds, would_delete, would_insert, overlaps, guest_count, planning |
| **Reset (cancel) phase** | |
| `postgres_booking_beds_existing[]` | Current PG rows for booking (same as cancel-impact) |
| `postgres_booking_beds_would_delete[]` | **All** existing rows (reassign clears entire set) |
| `booking_fields_after_cancel_phase` | Simulated: `unassigned` / `not_checked` (reassign-ready; aligns with 3b.3 proposal) |
| **Assign phase** | |
| `proposed_beds[]` | Each `--beds` entry + natural key + dates |
| `postgres_booking_beds_would_insert[]` | Rows 3b.2b would INSERT after reset |
| `postgres_booking_beds_would_skip[]` | Should be **empty** after full delete simulation; non-empty → warning (stale plan) |
| `postgres_overlap_conflicts[]` | Other bookings on same bed/date range (this booking’s old beds **not** counted as blockers) |
| `guest_count_check` | `guest_count`, `proposed_bed_count`, `matches`, `warning` |
| `booking_fields_after_full_reassign` | Simulated: `assigned` / `available` if no conflict; else `needs_review` / `conflict` |
| `payments_untouched` | `payments_count`, `payment_status_before` snapshot, `policy` |
| `planning_report_impact` | See §1.3 |
| `warnings[]`, `actionable[]` | Human-readable findings |
| `csv_bed_assignments_note` | Optional cross-check vs CSV export (read-only, like cancel-impact) |

### 1.3 Planning rows before / after

| View | Meaning |
|------|---------|
| `planning_rows_before[]` | Current PG `booking_beds` formatted via [`planning-row-format.js`](../scripts/lib/planning-row-format.js) |
| `planning_rows_after_cancel_only[]` | **Empty** for this booking (all beds removed) |
| `planning_rows_after_reassign[]` | Proposed `--beds` as if assign ran (same shape as assign-impact `planning_report_impact`) |
| `planning_delta` | `removed_count`, `added_count`, `bed_codes_removed[]`, `bed_codes_added[]` |

Planning report is **Postgres-only** (3a tool); no Sheets write.

### 1.4 Overlap / conflict semantics

| Check | Rule |
|-------|------|
| **Overlap query** | Same as [`assign-booking-beds-plan.js`](../scripts/lib/assign-booking-beds-plan.js): other `booking_id`, same `bed_code`, date range overlap, status not `cancelled`/`expired` |
| **This booking’s current beds** | **Excluded** from overlap blockers (simulates delete-before-insert) |
| **Conflict with self** | Reassigning to the **same** beds/dates as today → would_delete N, would_insert N same keys → overlap count 0; guest_count check still applies |
| **Busy bed elsewhere** | Actionable overlap (exit 2) |

### 1.5 Payment rows untouched

| Item | Report behaviour |
|------|------------------|
| `payments` | `SELECT` count + id list for `booking_id` |
| `payment_events` | Optional count only (no content dump required) |
| `bookings.payment_status` | Included in snapshot; report states **no UPDATE** in reassign path |
| `bookings.status` | Snapshot only; reassign fork must not change (3b.3 proposal) |

---

## 2. Command shape

### 2.1 Primary example

```powershell
npm run db:report:reassign-impact -- --booking-code=WH-rechKjCcySkfLzxUD --beds=R7-B1,R7-B2,R7-B3
```

### 2.2 With explicit assignment dates (date-change reassign)

```powershell
npm run db:report:reassign-impact -- --booking-code=WH-recSyn7QcPdVrYa1D --beds=R1-B1,R1-B2 --check-in=2026-06-01 --check-out=2026-06-05
```

Defaults: `--check-in` / `--check-out` from `bookings.check_in` / `bookings.check_out` when omitted.

### 2.3 Docker tools profile

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:reassign-impact -- --booking-code=WH-rec... --beds=R5-B1,R5-B2
```

### 2.4 Options (proposed)

| Flag | Required | Description |
|------|----------|-------------|
| `--booking-code=WH-rec…` | Yes* | Public booking code |
| `--beds=R7-B1,R7-B2` | **Yes** | Comma-separated **proposed** post-reassign beds (simulates Choose Beds output) |
| `--check-in=YYYY-MM-DD` | No | Assignment dates after reassign (default: booking.check_in) |
| `--check-out=YYYY-MM-DD` | No | Assignment end (default: booking.check_out) |
| `--airtable-record-id=rec…` | Alt* | Lookup by Airtable record id |
| `--client=wolfhouse-somo` | No | Client slug |

\* At least one of `booking-code` or `airtable-record-id`.

### 2.5 Relationship to other reports

| Command | When to use |
|---------|-------------|
| `db:report:cancel-impact` | Cancel **only** (no proposed new beds) |
| `db:report:assign-impact` | Assign **only** (no delete-all first) |
| `db:report:reassign-impact` | **Delete all + assign proposed** (full reassign) |

---

## 3. Data read (SELECT only)

### 3.1 Postgres tables

| Table | Purpose |
|-------|---------|
| `clients` | Resolve `client_id` by slug |
| `bookings` | Target booking, dates, guest_count, assignment/payment fields |
| `booking_beds` | Existing rows for booking; overlap queries on other bookings |
| `beds` | Validate `bed_code` → `bed_id` |
| `rooms` | Optional join for planning row labels / room metadata (read-only, no inventory mutation) |
| `payments` | Count + ids for untouched confirmation |
| `payment_events` | Optional count for untouched confirmation |

### 3.2 Not read

| System | Reason |
|--------|--------|
| **Airtable API** | Out of scope; PG is local mirror for impact |
| **Google Sheets** | Out of scope |
| **n8n** | Out of scope |

### 3.3 Shared library (implementation sketch)

| Module | Role |
|--------|------|
| [`assign-booking-beds-plan.js`](../scripts/lib/assign-booking-beds-plan.js) | Assign phase: `loadAssignPlan` with **`existingBedRows` forced empty** after simulated delete |
| Cancel-impact logic (inline or extract) | List all `booking_beds` for `booking_id` as `would_delete` |
| [`bed-drift-keys.js`](../scripts/lib/bed-drift-keys.js) | Natural keys, date normalization |
| [`planning-row-format.js`](../scripts/lib/planning-row-format.js) | Planning CSV-shaped rows |

Optional new file: `scripts/lib/reassign-impact-plan.js` exporting `loadReassignPlan(client, flags)` — composes cancel list + assign plan; keeps `report-reassign-impact.js` thin.

---

## 4. No writes

| Layer | Guarantee |
|-------|-----------|
| **Postgres** | `SELECT` only; no `BEGIN`/`INSERT`/`UPDATE`/`DELETE` |
| **Airtable** | No API calls |
| **Google Sheets** | No API calls |
| **n8n** | No workflow import or webhook |
| **Report file** | Writes `reports/reassign-impact-*.json` only (artifact on disk) |

Console footer (same family as 3b.1a / 3b.2a):

```text
No Postgres, Airtable, Sheets, or payment mutations.
```

---

## 5. Pass / fail criteria

### 5.1 Exit codes (proposed)

| Code | Meaning |
|------|---------|
| **0** | Report written; no actionable issues |
| **1** | Usage error, booking not found, ambiguous lookup, invalid date range, client not found |
| **2** | Actionable: unknown bed code(s), overlap conflict(s), or guest_count mismatch (strict) |

Non-fatal items (exit 0 with `warnings[]`):

- Booking has **zero** existing beds (reassign still valid; delete phase empty)  
- `payment_status` is `deposit_paid` / `paid` (informational; beds still releasable in PG-only test)  
- Proposed beds same as current beds (reassign no-op from inventory view)  

### 5.2 Pass criteria checklist

| Criterion | Pass when |
|-----------|-----------|
| **Old beds found** | `postgres_booking_beds_existing.length` ≥ 0 (0 allowed with warning) |
| **Would delete** | `would_delete` count equals existing count (all rows for booking) |
| **New beds valid** | Every `--beds` code exists in `beds` table |
| **No overlap conflicts** | `postgres_overlap_conflicts.length` === 0 |
| **Guest count** | `proposed_bed_count` === `guest_count` OR warning only (config: strict → exit 2) |
| **Payments untouched** | Report documents `payments_count` unchanged; no payment SQL in script |
| **Planning coherent** | `after_reassign` row count equals proposed bed count |

### 5.3 Actionable[] examples

| Code | Condition |
|------|-----------|
| `unknown_bed_codes` | `--beds` not in inventory |
| `postgres_overlap_conflicts` | Another booking holds bed/dates |
| `guest_count_mismatch` | `--beds` count ≠ `guest_count` |
| `booking_not_found` | Lookup failed |
| `invalid_date_range` | check_out ≤ check_in |

---

## 6. Test plan

**Environment:** Local Postgres only (`npm run db:sync` baseline). No Airtable, no n8n reassign fork.

| # | Scenario | Command sketch | Expected |
|---|----------|----------------|----------|
| T1 | Booking **with existing beds** | `--booking-code=WH-rechKjCcySkfLzxUD --beds=R7-B1,R7-B2,R7-B3` | `would_delete` = 3; `would_insert` = 3; exit 0 |
| T2 | **Different beds** than today | Same booking, `--beds=R5-B1,R5-B2` (2 beds, guest_count 3) | `would_delete` all old; new keys; guest_count warning or exit 2 |
| T3 | **Overlap / conflict** | Propose bed/date already held by **another** booking | `postgres_overlap_conflicts` non-empty; exit 2 |
| T4 | **Guest count mismatch** | 3 guests, `--beds=R7-B1` only | `guest_count_check.matches` false; exit 2 (if strict) |
| T5 | **Unknown bed** | `--beds=R99-B1` | `unknown_bed_codes`; exit 2 |
| T6 | **No existing beds** | Booking with 0 PG beds | `would_delete` 0; `would_insert` > 0; warning; exit 0 |
| T7 | **Idempotent keys** | Propose same beds as current after sync | delete N + insert same N keys; overlap 0 |
| T8 | `db:report:bed-drift` | After report only | No mutations; exit unchanged |
| T9 | `planning:report:postgres` | After report only | No mutations |
| T10 | `test:phase2f-resolver` | After report only | 10/10 |

**Compare to split reports:**

```powershell
npm run db:report:cancel-impact -- --booking-code=WH-rec...
npm run db:report:assign-impact -- --booking-code=WH-rec... --beds=R7-B1,R7-B2,R7-B3
```

Reassign impact **should match** cancel would_delete + assign would_insert (with assign overlap excluding own old beds).

---

## 7. Files if approved (implementation)

| Action | Path |
|--------|------|
| **Create** | `scripts/report-reassign-impact.js` |
| **Create** | `scripts/lib/reassign-impact-plan.js` (optional; compose cancel + assign plan) |
| **Create** | `docs/PHASE-3b-3a.md` (runbook) |
| **Modify** | `package.json` — `"db:report:reassign-impact": "node scripts/report-reassign-impact.js"` |
| **Modify** | `docs/regression-test-plan.md` — Phase 3b.3a section |
| **Modify** | `docs/PHASE-3b-3-PROPOSAL.md` — link 3b.3a as prerequisite step T1 |

**Not modified in 3b.3a:**

| Path | Reason |
|------|--------|
| `n8n/Wolfhouse - Reassign Bed Assignments.json` | Hosted export |
| `n8n/phase3b/*` | 3b.3b+ |
| `scripts/build-reassign-beds-local.js` | 3b.3b |
| `database/migrations/*` | No schema change |
| Airtable / Sheets / payment workflows | Out of scope |

### Implementation order (after approval)

```
3b.3a  report-reassign-impact.js (this proposal)  ← read-only gate
3b.3b  (optional) reassign-postgres CLI if needed before n8n
3b.3c  build-reassign-beds-local.js + local n8n fork
```

Exact 3b.3 sub-lettering can match parent [`PHASE-3b-3-PROPOSAL.md`](PHASE-3b-3-PROPOSAL.md) when 3b.3a lands.

---

## 8. Approval checklist

- [ ] Owner approves **`--beds` required** (explicit proposed assignment; no Choose Beds in CLI)  
- [ ] Owner approves **delete-all-then-assign** simulation (not per-bed diff)  
- [ ] Overlap logic **excludes** this booking’s current beds during assign phase  
- [ ] Guest count mismatch → **exit 2** (or warn-only — pick one)  
- [ ] **No** Airtable / n8n / payment writes in 3b.3a  
- [ ] 3b.3b Reassign fork **not** started until 3b.3a report exists and is used in tests  

---

## 9. Sequence in Phase 3b

```
3b.0   bed drift audit                         ✅
3b.1   Cancel                                   ✅
3b.2   Assign                                   ✅ 1085e56
3b.3   Reassign                                 proposal 998dc7f
3b.3a  reassign impact report (read-only)       ← this proposal
3b.3b  reassign local n8n fork                  not started
3b.4   Manual Entries                          not started
3b.5   Operator Room Release                   not started
```

---

## References

| Item | Location |
|------|----------|
| Reassign fork proposal | [`PHASE-3b-3-PROPOSAL.md`](PHASE-3b-3-PROPOSAL.md) |
| Cancel impact | [`PHASE-3b-1a.md`](PHASE-3b-1a.md), `scripts/report-cancel-impact.js` |
| Assign impact | [`PHASE-3b-2a.md`](PHASE-3b-2a.md), `scripts/report-assign-impact.js` |
| Assign plan lib | `scripts/lib/assign-booking-beds-plan.js` |
| Hosted Reassign export | `n8n/Wolfhouse - Reassign Bed Assignments.json` (read-only reference) |
