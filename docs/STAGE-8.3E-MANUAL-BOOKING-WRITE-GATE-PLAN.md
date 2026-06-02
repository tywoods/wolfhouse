# Stage 8.3e — Manual Booking Write Gate Plan (Luna Front Desk)

**Status:** PLANNING DONE (2026-06-02). Planning/docs only — **no code, no DB writes, no Azure changes**.
**Parent:** [`STAGE-8.3-STAFF-PORTAL-BED-CALENDAR-OPERATIONS-PLAN.md`](STAGE-8.3-STAFF-PORTAL-BED-CALENDAR-OPERATIONS-PLAN.md) — §4 (manual booking creation).
**Builds on:** Stage 8.3c (selection model DONE), Stage 8.3d (preview skeleton DONE), `scripts/lib/manual-entry-pg-sql.js` (proven local helper), `scripts/lib/staff-bed-reassignment-sql.js` (7.7k gate pattern), [`PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md`](PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md) (D1/D2/D4/D6/F8/F9 gates).
**HEAD at authoring:** `c25a593`.
**Pilot decision:** Remains **NO_GO**. Manual booking writes are **NOT implemented and NOT enabled**. `STAFF_ACTIONS_ENABLED=false`, `WHATSAPP_DRY_RUN=true`, all n8n workflows inactive.

> **Safety scope.** This document defines the *gates* that must be satisfied before a single manual booking write can ship. It builds nothing and enables nothing. Every capability described is a **future, gated** capability behind explicit feature flags, role checks, fixture proofs, and human sign-off.

---

## 1. Purpose

Manual booking creation from the bed calendar is the **highest-risk staff write** in the Staff Portal: it inserts guest-facing inventory rows, can collide with real availability, and touches payment-adjacent fields. It is the operation that will eventually **retire the spreadsheet + `scripts/manual-entry-postgres.js` CLI** as the primary new-booking path (pilot gate **F9**).

It must not be enabled until the system can safely:

- check availability for the exact selected beds × dates,
- prevent overlaps (no silent overwrite of an existing assignment),
- create `bookings` + `booking_beds` **consistently in one transaction**,
- record payment/deposit info **manually only** (no auto-charge),
- avoid every automatic WhatsApp / Stripe / confirmation action,
- audit the staff actor (who/what/when/result),
- roll back / undo a manual booking safely,
- prove idempotency (no duplicate booking on retry),
- pass the staging approval gates (§11) with human sign-off (§11, §16).

This plan also establishes the **reference write-gate pattern** that the other calendar write operations (move/cancel/date-change, tour-operator block, operator room release) will reuse (§13).

---

## 2. What the write operation will eventually create

When (and only when) all gates pass, a confirmed manual booking will create, **inside one explicit `BEGIN … COMMIT` transaction**, the following:

| Artefact | Condition | Source basis |
|---|---|---|
| `bookings` row | always | `upsertBookingForCreate()` in `manual-entry-pg-sql.js` (`booking_source='manual_staff'`) |
| `booking_beds` rows | if bed selection exists | `insertBookingBeds()` (`assignment_type='Manual Staff'`) |
| Manual payment/balance fields **or** one manual `payments` row | only if deposit/total entered | new helper; **never a Stripe charge** |
| Conversation link | optional, if guest phone matches/created | link only; no message send |
| `staff_handoffs` / task row | optional, if marked needs-review | review queue only; no auto-action |
| Audit row (`workflow_events` interim → durable table) | **always**, on attempt + result | §7 |

**Explicitly NOT created / triggered:**
- No WhatsApp send (`WHATSAPP_DRY_RUN=true` regardless).
- No Stripe checkout session or payment link.
- No confirmation send (`confirmation_sent_at` stays `NULL`).
- No n8n workflow activation, no webhook POST.

**Transaction requirement:** all rows commit together or none do. The bed overlap guard relies on `SELECT … FOR UPDATE` locks held until COMMIT (same rule as `staff-bed-reassignment-sql.js` §5a.5). Running outside a transaction is itself a hard blocker (§4).

---

## 3. Required form fields (v1)

Current 8.3d skeleton already renders these (read-only preview): guest name, phone, email, guest count, language, package/stay type, source/channel, notes, check-in, check-out, nights, selected room/bed, payment status, deposit amount, total amount.

**Fields confirmed required for a safe v1 write:**

| Field | Required | Validation / notes |
|---|---|---|
| Guest name | Yes | non-empty, trimmed |
| Phone | Yes | WhatsApp-format preferred; used for optional conversation link |
| Email | Optional | format-checked if present |
| Guest count | Yes | integer ≥ 1, ≤ selected capacity (§4) |
| Language | Yes | default `en` |
| Package / stay type | Yes | must match a valid `package_code` |
| Source / channel | **Yes (required)** | `walk_in` / `whatsapp_staff` / `email` / `phone` / `direct` |
| Booking status | **Yes** | `hold` / `payment_pending` / `confirmed` |
| Payment status | Yes | `unpaid` / `deposit_paid` / `paid` — **manual, no auto-charge** |
| Deposit amount paid | Optional | numeric ≥ 0; only meaningful when `deposit_paid`/`paid` |
| Total amount | Optional | numeric ≥ 0 |
| Remaining balance | Derived/optional | total − deposit; display-only, never charges |
| Check-in | Yes | valid date; from selection |
| Check-out | Yes | valid date; `> check-in` (§4) |
| Nights | Derived | `check-out − check-in`; must be ≥ 1 |
| Selected room / bed(s) | Yes | from selection; must exist + be sellable (§4) |
| Room preference | Optional | informational; mismatch → warning (§5) |
| **Reason / source for manual creation** | **Yes (required)** | free-text staff justification (audit) |
| **Staff note (manual creation)** | **Yes (required)** | internal note explaining the manual booking |

**System-set metadata (not user-editable):**
- `booking_source = 'manual_staff'`
- `metadata.source = 'staff_manual'` (and/or `manual_created = true`)
- `confirmation_sent_at = NULL` (confirmation NOT sent)
- `staff_user_id`, `staff_role`, `client_id` stamped into the audit row
- `idempotency_key` (§9)

---

## 4. Hard blockers (write refused — `blocked=true`, no rows written)

Manual booking creation **must block** (return a structured `blocked` result, write nothing) if **any** of:

**Authn / authz / flags**
- `STAFF_ACTIONS_ENABLED=false`
- `MANUAL_BOOKING_ENABLED=false` (new dedicated flag, §11)
- staff not authenticated (`STAFF_AUTH_REQUIRED=true` and no valid session)
- role below `operator` (must be `operator` / `admin` / `owner`)
- no `staff_user_id`
- `client_id` / company missing or unresolved

**Selection / dates**
- selected dates invalid / unparseable
- `check_out <= check_in`
- `nights <= 0`
- selected bed does not exist (for this client)
- selected bed inactive / not sellable
- **selected bed already occupied for any selected night** (half-open overlap, FOR UPDATE)
- selected range crosses a booked cell (gap in selection)
- guest count exceeds selected bed count / capacity

**Data integrity**
- payment/deposit fields invalid (negative, non-numeric, deposit > total)
- booking code collision (would duplicate an existing `booking_code`)

**System guarantees**
- production / live gate not approved (running against a production DB pattern → refuse, mirror `assertNotProduction()` in `stage8-demo-cleanup.js`)
- audit write cannot be guaranteed (audit sink unavailable → refuse the whole transaction)
- rollback strategy not available (no proven delete/void path → refuse to enable)

> Blockers reuse the **named block-code** pattern from `REASSIGN_BLOCK_CODES` in `staff-bed-reassignment-sql.js` so the future handler + verifier can assert each one symbolically.

---

## 5. Warning / second-confirm cases (preview warns; explicit re-confirm required)

These do **not** block, but the preview must surface a warning and the confirm action must require an **explicit acknowledgement / second confirmation**:

- same-day or next-day arrival
- manually marking **deposit paid** (no Stripe record exists)
- manually marking **paid in full**
- selected bed in a protected / private / couple / operator room
- room preference mismatch (requested type ≠ selected room type)
- long stay (over a configurable threshold, e.g. > 30 nights)
- interaction with an existing **operator block** on the same room/bed/date space
- an open conversation / handoff already exists for the same phone
- duplicate guest phone, or an overlapping booking for the same guest/dates

Each acknowledged warning is recorded in the audit row (`warnings_acknowledged`, §7).

---

## 6. Preview-first flow (Stage 1 is proposal-only)

The write path is **always preview-first**. No confirm button is ever live without a passing preview.

1. UI sends the selection + form fields to a **preview/proposal endpoint** (auth-gated, **read-only, no writes** — slice 8.3h).
2. Preview returns:
   - selected dates / beds (normalised),
   - conflicts (hard blockers from §4),
   - warnings (§5),
   - calculated nights,
   - suggested `booking_code`,
   - total / deposit / remaining summary,
   - the exact **rows that would be created** (`bookings`, `booking_beds`, optional payment/handoff).
3. Confirm button stays **disabled** unless preview returns `ok=true` (no hard blockers) and all warnings are acknowledged.

> This document does **not** implement the endpoint. It defines its contract for slice 8.3h.

---

## 7. Audit requirements

Every manual-booking **attempt** (success, block, or failure) must write a durable audit record capturing:

- `staff_user_id`, `staff_role`, `client_id`
- `timestamp` (UTC)
- source IP / user-agent **hash** (if available; hashed, never raw PII in logs)
- selected dates, selected rooms/beds
- guest name / phone (PII-minimised per retention policy)
- payment / deposit fields entered
- reason / source (required free-text, §3)
- preview result (ok / blocked + block codes)
- warnings acknowledged (§5)
- success / failure + booking_id / booking_code on success
- rollback reference (id usable by the undo path, §8)
- before/after snapshots where a row is mutated (for the update path)

**Sink:** prefer a **durable audit table** (e.g. a future `booking_rooming_events` / `staff_action_events`). `workflow_events` is acceptable **only as an explicitly documented interim sink** (same caveat as `staff-bed-reassignment-sql.js`), and migrating off it is a hardening item before real staff use (§11/§16).

**Guarantee:** if the audit write cannot be performed, the booking transaction is refused (§4 — "audit write cannot be guaranteed").

---

## 8. Rollback / undo requirements

Before any confirmed create is enabled, the following must be **proven by fixture** (slice 8.3k):

- delete / void of a manual booking fixture works,
- beds are **freed** after rollback (no orphan `booking_beds`),
- payments / manual payment rows are removed **or voided** (never silently dropped if real),
- linked conversation / handoff behaviour on rollback is defined and proven,
- cleanup **does not delete non-demo / non-fixture data** (scoped by `booking_source='manual_staff'` + `metadata.source='staff_manual'` + fixture tag, mirroring `stage8-demo-cleanup.js` production-refusal + tag-scoped deletes),
- rollback is **blocked** if the booking later acquired a live payment or guest communication (those route to handoff, never auto-undo),
- a **rollback audit event** is written (§7).

---

## 9. Idempotency requirements

Manual booking create must be idempotent:

- a repeated identical request **cannot create a duplicate** booking,
- idempotency key derived from `client_id` + `staff_user_id` + session + normalised selection (beds + dates) + form hash, **or** an explicit client-generated key sent with the request,
- `booking_code` is unique (collision is a hard blocker, §4),
- a duplicate attempt returns a **safe response** (the existing booking, `created=false`) rather than a second row,
- **fixture proof required** (slice 8.3i): submit twice, assert exactly one `bookings` row and one set of `booking_beds`.

> Aligns with the project-wide idempotency bar (ROADMAP Stage 3.5 / 3e.6 invariants).

---

## 10. Implementation ladder + revised numbering (conflict resolution)

**Conflict found.** The existing `STAGE-8.3` plan §4–§7 already assigns `8.3e–8.3o` to a *mixed* set of features:
- existing `8.3e–8.3h` = manual booking SQL/fixture/API/UI,
- existing `8.3i–8.3j` = move/cancel/change-dates,
- existing `8.3k–8.3l` = tour operator,
- existing `8.3m–8.3n` = operator room release.

The user's requested manual-booking ladder (8.3e plan → 8.3o sign-off) collides with the tour-operator slot (8.3k) and the operator-release slots (8.3m–n). **Resolution: give manual booking a clean contiguous block `8.3e–8.3o`, and renumber move/cancel and operator features to `8.3p+`.** Manual booking becomes the reference pattern (§13), which the later operations explicitly reuse.

### 10.1 Manual booking ladder (this plan = 8.3e)

| Slice | Scope | Writes? | Gate to advance |
|---|---|---|---|
| **8.3e** | **Manual booking write gate plan** (this doc) | No | Plan reviewed |
| **8.3f** | Manual booking **SQL helper static proof** � `scripts/lib/staff-manual-booking-create-sql.js`; 15-CTE chain; 14 blockers; `MANUAL_BOOKING_BLOCK_CODES`; half-open overlap guard + defense-in-depth; idempotency via `metadata` JSONB (column migration documented); `no_selected_beds`, `overlap_conflict`, `booking_code_collision`, `invalid_payment_amounts`, etc.; audit_payload + rollback_payload; `verify-staff-manual-booking-create-sql.js` **40/40 PASS** | No (static) | **DONE** � `node --check` + static verifier 40/40 PASS |
| **8.3g** | **Conflict / availability preview helper** (pure function over beds×dates; half-open overlap; FOR UPDATE design) | No (static) | unit/fixture of overlap logic |
| **8.3h** | **Preview / proposal endpoint** (auth-gated, role-gated, **read-only**; returns §6 payload) | No | endpoint returns proposal, asserts zero writes |
| **8.3i** | **Fixture write proof** (create in test DB, verify rows + audit + payments delta=0; **idempotency** double-submit proof) | Yes (test DB only) | fixture PASS + idempotency PASS |
| **8.3j** | **Confirmed API route** behind `STAFF_ACTIONS_ENABLED` + `MANUAL_BOOKING_ENABLED` + role + explicit confirm | Gated | route refuses when any flag off |
| **8.3k** | **Rollback / delete / void proof** (§8 fixture) | Yes (test DB only) | rollback PASS + scoped-cleanup PASS |
| **8.3l** | **UI preview modal** wired to the 8.3h preview endpoint only | No | UI shows proposal; confirm still disabled |
| **8.3m** | **UI confirm button** behind staging-only feature flag (live only when flag+role+HTTPS; reason+source required) | Gated | confirm hidden unless gated |
| **8.3n** | **Staging fixture proof through the UI** (end-to-end on staging demo data, behind flag) | Gated (staging) | E2E PASS on staging |
| **8.3o** | **Sign-off gate** before real staff use (Ty + owner/operator; §11/§16) | — | recorded sign-off |

### 10.2 Renumbered downstream operations (reuse the 8.3e pattern)

| New slice | Was | Scope |
|---|---|---|
| **8.3p** | 8.3i | Move room/bed — **preview only** (backend 7.7k1–k8 already proven) |
| **8.3q** | (new) | Move room/bed — gated confirm |
| **8.3r** | 8.3j | Cancel booking / change dates / change beds — preview |
| **8.3s** | (new) | Cancel / change — gated confirm (paid → handoff) |
| **8.3t** | 8.3k | Tour-operator booking / block — plan + SQL static |
| **8.3u** | 8.3l | Tour-operator booking / block — gated implementation |
| **8.3v** | 8.3m | Operator room release / split — plan + SQL static |
| **8.3w** | 8.3n | Operator room release / split — gated implementation |

> The existing `STAGE-8.3` §4 ladder table and §5–§7 headers should be updated to point at this revised numbering (done in this task's doc edits).

---

## 11. Staging gates before enabling any confirm button

**All must be green** before the 8.3m confirm button can be unhidden, even on staging:

| Gate | Required state | Reference |
|---|---|---|
| `STAFF_AUTH_REQUIRED` | `true` | auth gate |
| `STAFF_ACTIONS_ENABLED` | `false` by default (flip is the deliberate enabling act) | global write flag |
| `MANUAL_BOOKING_ENABLED` | `false` by default (dedicated flag) | new, this plan |
| Staging DB backup configured | Yes | pilot **D1/D2** |
| Restore drill complete **or** explicitly waived for demo-only | recorded | pilot **D4** |
| Audit event visible | Yes (§7) | this plan |
| Rollback proof passes | Yes (8.3k) | §8 |
| Idempotency proof passes | Yes (8.3i) | §9 |
| Preview endpoint passes | Yes (8.3h) | §6 |
| Conflict test passes | Yes (8.3g) | §4 overlap |
| Emergency toggle drill | done | pilot **D6** |
| Ty sign-off | recorded | §16 |
| Owner/operator sign-off (before real usage) | recorded | §16, pilot **F9** |
| No live WhatsApp / Stripe | enforced (`WHATSAPP_DRY_RUN=true`, no Stripe call) | global |
| No production gate | not approved | pilot NO_GO |

---

## 12. Relationship to the Ale/Cami demo

| Tier | Items |
|---|---|
| **Required before demo** | read-only manual booking **skeleton** (8.3d, DONE); clear "coming soon / not enabled" wording; **no writes** |
| **Optional for demo** | preview-only conflict modal (8.3l) **if** 8.3g/8.3h land safely and stay read-only |
| **NOT required before demo** | confirmed manual booking write (8.3j/8.3m) |
| **Required before spreadsheet replacement** | confirmed create (8.3j) + rollback/undo (8.3k) + audit (§7) + backup/restore (D1/D2/D4) + training/sign-off (8.3o, F9) |

The demo can show the polished skeleton and (optionally) a read-only conflict preview. It must **not** show a working create. The spreadsheet + `manual-entry-postgres.js` CLI remains the primary new-booking path until 8.3o sign-off.

---

## 13. Relationship to tour-operator booking and room release

Manual booking is the **reference write-gate pattern**. Every other calendar write reuses the same five pillars:

| Pillar | Manual booking | Move room/bed (8.3p–q) | Cancel/change (8.3r–s) | Tour operator (8.3t–u) | Operator release (8.3v–w) |
|---|---|---|---|---|---|
| Preview-first | §6 | yes | yes | yes | yes |
| Conflict checks | §4 overlap | 7.7k overlap | new-span availability | block overlap | payments==0 + split guard |
| Role gates | operator+ | operator+ | operator+ (paid→handoff) | operator+ | operator+ |
| Audit | §7 | 7.7k audit | required | required | before/after split |
| Rollback | §8 | 7.7k7 undo | required | required | required |
| Disabled by default | `MANUAL_BOOKING_ENABLED=false` | flag | flag | flag | flag |

The user's goal of reaching **tour-operator booking/release** before demoing maps to slices **8.3t–8.3w** — each gated behind its own flag and the same proof ladder. None ships a live write before its fixture proof + sign-off.

---

## 14. Out of scope for this plan

- Any code, migration, endpoint, or UI wiring.
- Any DB write, even to a test DB.
- Any Azure change, secret change, or workflow activation.
- Enabling `STAFF_ACTIONS_ENABLED` or introducing a live `MANUAL_BOOKING_ENABLED=true`.
- Gender/private/couple constraint modelling (deferred, later slice).

---

## 15. Open questions (resolve before 8.3f)

1. **Durable audit table** name/schema — design now or keep `workflow_events` interim through 8.3i and migrate before 8.3o? (Recommend: design the table at 8.3f, write to it from first fixture.)
2. **Manual payment representation** — dedicated `payments` row vs. booking-level cents fields only? (Recommend: booking-level fields for v1; a manual `payments` row only if reporting needs it.)
3. **Idempotency key** — server-derived vs. client-supplied? (Recommend: support both; require at least the server-derived selection hash.)
4. **`MANUAL_BOOKING_ENABLED`** — separate flag vs. role-only gating under `STAFF_ACTIONS_ENABLED`? (Recommend: separate flag, so manual booking can be enabled independently of move/cancel.)

---

## 16. Sign-off (8.3o gate — to be recorded later)

| Approver | Role | Decision | Date | Evidence |
|---|---|---|---|---|
| Ty | Technical owner | — | — | gate table §11 all green |
| Owner (Ale) | Account owner | — | — | training + walkthrough |
| Operator (Cami) | Daily operator | — | — | training + first supervised use |

**Until every row above is signed: manual booking writes stay disabled. Pilot remains NO_GO.**
