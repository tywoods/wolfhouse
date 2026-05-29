# Phase 3e.6 — Idempotency Verification Plan

**Status:** I1 L2 schema proof PASS · I4 runtime PASS (2026-05-29) · I2/I3/I5 deferred  
**Created:** 2026-05-29 (Stage 3 closeout)  
**HEAD at creation:** `af24b79`

---

## Purpose

Prove that repeated/duplicate actions by each major workflow produce at most the idempotent final state and do not duplicate rows, re-send messages, double-charge, or corrupt protected tables. This plan extends the Stage 3 wrong-booking guard work (3e.5) into the duplicate-action dimension.

---

## Source-of-truth context (from 3e.5-rt findings)

Current local forks are **Airtable-primary / Postgres-mirror**:

- Main's booking/hold/conversation lookup: **Airtable** (`Search Conversation`, `Search Active Booking - Phone/Hold`, `Code - Pick Active Booking` all query Airtable before Postgres operations).
- Reassign fork: **Airtable** (`Get Booking To Reassign`, `Cancel Old Booking Bed`, `Mark Booking Ready For Reassignment` run before/around the PG delete).
- Send Confirmation: **Postgres-primary** for its selection + mark-confirmed step. The webhook trigger path uses a PG query for booking selection and a PG UPDATE for the guard.
- Stripe Webhook Handler: **Postgres-primary** for `payment_events` insert + `payments` update; unique index enforces dedup at DB level.
- WhatsApp message dedup: **Postgres schema** provides a unique index on `(client_id, whatsapp_message_id)` in the `messages` table, but upstream **Airtable** conversation/booking writes are not guarded at the PG level.

**Implication for faithful L3 runtime:** Only I3 (Stripe event dedup), I4 (Send Confirmation), and the Postgres-layer guard of I1 (`messages` unique index) can be proven with PG-only fixtures. I1 full-path (booking/conversation dedup), I2 (payment-link dedup), and I5 (reassign dedup) require Airtable test-base fixture tooling or the Postgres source-of-truth cutover for faithful runtime proof.

---

## Candidate classification

| # | Concern | Workflow(s) | SoT path | PG-only fixture faithful? | Runtime this window? | Notes |
|---|---------|-------------|----------|--------------------------|----------------------|-------|
| **I1** | Duplicate WhatsApp message id (wamid) | Main | **Mixed** — `messages` table has `UNIQUE (client_id, whatsapp_message_id)` (PG guard); but full booking/conversation creation path is Airtable-driven | **Partial** — PG `messages` unique index is provable via static schema inspection; full duplicate booking/conversation path requires Airtable | **Partial L2 (schema proof only)**; full L3 deferred (Airtable-coupled) | DB enforces no-dup row; Main may still create a duplicate Airtable conversation/booking on a duplicate POST if the conversation lookup returns stale/empty |
| **I2** | Duplicate `payment_details_provided` / payment-link request | Main (+ CPS) | **Airtable-driven** (booking lookup) + Stripe | No | **Defer — manual-pay gate** (needs CPS + Stripe; Airtable-coupled hold selection) | Ensure Booking plan shows idempotent `refreshed` action on 2nd call, but full runtime needs faithful Airtable + Stripe |
| **I3** | Duplicate Stripe event id | Stripe Webhook Handler | **Postgres-primary** — `payment_events.stripe_event_id TEXT UNIQUE`; DB enforces uniqueness | **Yes** — can be proven via crafted local POST with `STRIPE_WEBHOOK_SKIP_VERIFY=true` + known test event id | **Yes — include (dry-run crafted event)** | No real payment needed; use previously-used `evt_test_phase3d5b_001` style. Guard already proven structurally by migration 001 schema + unique index. Runtime is confirmatory. |
| **I4** | Duplicate Send Confirmation trigger | Send Confirmation (local) | **Postgres-primary** — selection SQL: `WHERE send_confirmation=TRUE AND status='payment_pending' AND confirmation_sent_at IS NULL`; UPDATE guard: `WHERE send_confirmation=TRUE AND status='payment_pending' AND confirmation_sent_at IS NULL` | **Yes** | **RUNTIME PASS (2026-05-29)** — exec 1087 confirmed; exec 1088 was a no-op: SELECT 0 rows, no UPDATE, `confirmation_sent_at` and `send_confirmation` unchanged | `WHATSAPP_DRY_RUN=true`; no real send; teardown clean |
| **I5** | Duplicate reassign request | Reassign → Assign | **Airtable-coupled** (same finding as Gate C: `Get Booking To Reassign` is Airtable before PG delete) | No — same class as 3e.5 Gate C | **Defer — Airtable fixture tooling or Postgres cutover** | L2 `report-reassign-impact` already proves PG scope guard; runtime deferred |
| **I6** | Protected-count invariant | All | — | Yes (read-only) | **Yes — runs around every test** | `payments`/`payment_events`/`booking_beds` counts before==after for every non-payment test |
| **I7** | Duplicate cancellation | Cancel Bed Assignments (local PG) | Postgres-primary for bed ops; but Cancel workflow sourcing is unclear without further inspection | Unknown | **Out of scope for Stage 3e.6** — cancel path not in 3e.5 scope; defer | Can be added to Stage 3.5 or post-cutover testing |

---

## Detailed candidate specifications

### I1 — Duplicate WhatsApp message id (wamid)

**Workflow:** Main (`RBfGNtVgrAkvhBHJ`)  
**Duplicate action:** POST same wamid + phone twice to `http://localhost:5678/webhook/booking-assistant`  
**SoT classification: Mixed**

**Postgres guard (provable without runtime):**
- `messages` table has `UNIQUE INDEX idx_messages_whatsapp_id ON messages (hostel_id, whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL` (migration 001).
- Schema-level dedup is **proven by inspection** — no runtime needed for this layer.
- Renamed to `(client_id, whatsapp_message_id)` after migration 003.

**What is NOT provable with PG-only fixture:**
- Whether a 2nd POST with the same wamid would create a duplicate Airtable conversation row (conversation lookup reads Airtable, not PG).
- Whether a 2nd POST could trigger a duplicate booking hold in Airtable (Airtable active-hold guard in Main reads Airtable).

**L2 (schema inspection) — RUNNABLE NOW:**
```sql
-- Confirm unique index exists on messages table:
-- Note: migration 003 renamed idx_messages_whatsapp_id → idx_messages_whatsapp_client
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'messages'
  AND indexname = 'idx_messages_whatsapp_client';

-- Confirm no duplicate wamid rows exist currently:
SELECT whatsapp_message_id, COUNT(*) AS c
FROM messages
GROUP BY whatsapp_message_id
HAVING COUNT(*) > 1;
```

**L3 runtime:**
- DEFERRED — full-path proof (booking/conversation dedup) requires Airtable or post-cutover.
- If run anyway: activate Main only; POST same wamid twice; assert `messages` count for wamid = 1; assert bookings/conversations for phone ≤ 1 new. But Airtable-coupled path means the 2nd POST may duplicate Airtable data in a way that is hard to reverse.

**Expected idempotent result:** `messages` row count for wamid = 1 (PG unique index violation on 2nd INSERT); no duplicate booking.

**Teardown:** DELETE fixture message/booking rows; verify counts back to baseline.

**Hard stops:** any `payments` count change; any `payment_events` count change; any unrelated `booking_beds` change; unexpected workflow executions.

---

### I2 — Duplicate `payment_details_provided` / payment-link request

**Workflow:** Main + CPS (`esuDIT96iPT63OaQ`)  
**SoT classification: Airtable-driven hold lookup + Stripe**  
**Runtime this window: DEFER (manual-pay gate)**

**Why deferred:** CPS creates a Stripe Checkout session (real Stripe test-mode call). Two identical POSTs may create two Stripe sessions. The Ensure Booking plan shows idempotent `action=refreshed` on a 2nd call to the PG-side Ensure, but the upstream booking selection is Airtable-driven and the Stripe session creation is not idempotent without explicit session-id guard logic.

**L2 static evidence already available:** `report-main-ensure-booking-plan` returns `action=refreshed` on 2nd call (3c.f proven). No runtime needed to confirm PG-side Ensure idempotency.

**Defer to:** manual-pay gate (after Airtable fixture tooling or Postgres cutover).

---

### I3 — Duplicate Stripe event id

**Workflow:** Stripe Webhook Handler (`KZUQvwR6SPWpvaZ5`)  
**SoT classification: Postgres-primary**  
**Runtime this window: YES (crafted local POST, `STRIPE_WEBHOOK_SKIP_VERIFY=true`)**

**Idempotency mechanism (proven by schema inspection):**
- `payment_events.stripe_event_id TEXT UNIQUE` — DB enforces one row per event id.
- UPDATE on `payments` is conditional on current status, not unconditional.

**Fixture needed:** one existing paid booking from prior evidence (e.g. `WH-260528-5369` which already has `payment_events` row for `evt_1Tc9ehG36qRefvdPg9mXYrcr`). **Do not use a new fixture requiring payment table inserts.**

**Duplicate action:** POST the same crafted event id (NOT `evt_1Tc9ehG36qRefvdPg9mXYrcr` — that is live evidence; instead use a new disposable `evt_test_idemp_i3_001`) twice. Because `stripe_event_id` is UNIQUE, the 2nd INSERT into `payment_events` should fail/be caught, producing 0 additional rows.

**Fixture:** a minimal PG-only booking in state that the Webhook Handler would try to update, with a corresponding `payments` row and no `payment_events` for `evt_test_idemp_i3_001`. Set `STRIPE_WEBHOOK_SKIP_VERIFY=true`.

**Expected result:**
- 1st POST: `payment_events` count +1, booking promoted (or state-guarded).
- 2nd POST (same event id): 0 new `payment_events` rows; booking state unchanged (already promoted).

**Evidence queries:**
```sql
SELECT COUNT(*) FROM payment_events WHERE stripe_event_id = 'evt_test_idemp_i3_001';
-- Must be 1 after both POSTs.
SELECT status, payment_status FROM bookings WHERE booking_code = 'WH-IDEMP-I3';
-- State stable; not double-promoted.
```

**Teardown:** DELETE fixture booking + payments + payment_events rows; verify counts back to 25/5/15.

**Hard stop:** `payment_events` count for the test event id > 1; any unrelated payment row changes; booking_beds changes.

**Risk note:** This test requires inserting a row into the `payments` table as fixture setup (to give the Webhook Handler a booking + payment to update). Insertion into `payments` is a protected-table write. The fixture must be clearly reversible (`-down.sql` removes it) and must use a disposable booking code. No Stripe checkout or real charge is needed — just a pre-seeded `payments` row in `checkout_created` state.

---

### I4 — Duplicate Send Confirmation trigger — **RUNTIME PASS (2026-05-29)**

**Workflow:** Send Confirmation local (`gxivKRJexzTCw9x6`)  
**SoT classification: Postgres-primary**  
**Runtime this window: YES (dry-run, `WHATSAPP_DRY_RUN=true`)**

**Result:** PASS

**Evidence:**

| Item | Value |
|------|-------|
| booking_code | `WH-IDEMP-I4` |
| booking_id | `b3e60000-0000-4000-8000-000000000001` |
| Trigger #1 execution id | **1087** |
| Trigger #2 execution id | **1088** |
| `confirmation_sent_at` before Trigger #1 | `NULL` |
| `confirmation_sent_at` after Trigger #1 | `2026-05-29 10:50:01.668902+00` |
| `confirmation_sent_at` after Trigger #2 | `2026-05-29 10:50:01.668902+00` (unchanged) |
| `send_confirmation` before | `true` |
| `send_confirmation` after Trigger #1 | `false` |
| `send_confirmation` after Trigger #2 | `false` (unchanged) |
| `status` after Trigger #1 | `confirmed` |
| `status` after Trigger #2 | `confirmed` (unchanged) |
| dry_run | `WHATSAPP_DRY_RUN=true` confirmed before activation |
| payments count | 25 → 25 → 25 (unchanged throughout) |
| payment_events count | 5 → 5 → 5 (unchanged throughout) |
| booking_beds count | 15 → 15 → 15 (unchanged throughout) |
| Workflows activated | Send Confirmation (`gxivKRJexzTCw9x6`) only |
| All other max exec ids | Unchanged: Main=1082, Reassign=1083, Assign=1084, Stripe=1086, CPS=1065, CPS stub=1037, Cancel=305 |
| Teardown | WH-IDEMP-I4 deleted; counts verified at baseline |
| Final workflow state | All 8 workflows `active=false` |

**Idempotency mechanism confirmed at runtime:** The second execution ran (exec 1088) but the Postgres SELECT (`WHERE send_confirmation=TRUE AND status='payment_pending' AND confirmation_sent_at IS NULL`) returned 0 rows because the booking no longer matched (already `confirmed`, `send_confirmation=false`, `confirmation_sent_at` set). The `Mark Confirmed` UPDATE path was never reached. `confirmation_sent_at` was not mutated by `COALESCE(confirmation_sent_at, NOW())` because no UPDATE executed. State was fully stable.

**Why PG-only fixture is faithful:**
- The webhook trigger path runs `Code - Parse Webhook Filter` → Postgres SELECT (filter by `booking_id`) → IF row found → ... → `Mark Confirmed` UPDATE.
- The SELECT is: `WHERE send_confirmation=TRUE AND status='payment_pending' AND confirmation_sent_at IS NULL AND (filter IS NULL OR id=filter)`.
- The UPDATE is: `WHERE send_confirmation=TRUE AND status='payment_pending' AND confirmation_sent_at IS NULL` — guarded; 2nd run hits 0 rows because `confirmation_sent_at` is now set.
- The Airtable Conversation and Booking Beds nodes use `alwaysOutputData` (0 rows continues chain) — their absence does not block the flow.
- **No Airtable record needed for the confirmation mark path.** The fixture only needs a Postgres booking row.

**Fixture:** `WH-IDEMP-I4` booking with `send_confirmation=true`, `status='payment_pending'`, `payment_status='deposit_paid'`, `confirmation_sent_at NULL`. No `payments`/`payment_events` rows needed.

**Duplicate action:** POST to `http://localhost:5678/webhook/send-confirmation-local` with `{"booking_id": "<WH-IDEMP-I4-uuid>"}` twice.

**Expected result:**
- 1st POST: booking moves to `confirmed`, `send_confirmation=false`, `confirmation_sent_at` set; dry-run WhatsApp only.
- 2nd POST: SELECT returns 0 rows (confirmation_sent_at already set → filter excludes it); no UPDATE; no WhatsApp send. Execution completes as no-op.

**Evidence queries:**
```sql
-- After 1st POST:
SELECT booking_code, status, send_confirmation, confirmation_sent_at
FROM bookings WHERE booking_code='WH-IDEMP-I4';
-- status=confirmed, send_confirmation=false, confirmation_sent_at NOT NULL.

-- After 2nd POST (must be identical to above — no state change):
SELECT booking_code, status, send_confirmation, confirmation_sent_at
FROM bookings WHERE booking_code='WH-IDEMP-I4';
-- Same result; no new execution of Mark Confirmed.
```

**Teardown:** DELETE fixture booking; verify `booking_beds=15`, `payments=25`, `payment_events=5`.

**Hard stop:** any `payments` count change; any `payment_events` count change; `booking_beds` changes; real WhatsApp send (`WHATSAPP_DRY_RUN` lost); any unexpected workflow executions.

---

### I5 — Duplicate reassign request

**Workflow:** Reassign (`B3c3ReassignLocal01`) → Assign (`B3c2AssignLocalPg01`)  
**SoT classification: Airtable-coupled (same as Gate C)**  
**Runtime this window: DEFER**

**PG-side guard already proven (L2):** `report-reassign-impact` and `PG_REASSIGN_DELETE_SQL` use `resolved_count=1` guard. A duplicate POST would:
1. Airtable gate (`Get Booking To Reassign` + `can_reassign`) — same booking, same state; would pass again.
2. PG delete: deletes beds for that booking (which after 1st run are the newly-inserted beds from Assign).
3. Assign: re-assigns to same beds (or possibly same set) — producing same final state.

Whether a duplicate POST is truly idempotent depends on whether Assign's overlap detection handles re-assigning the same beds that were just deleted in the same transaction. This is a runtime-only question because the Airtable gate blocks a PG-only fixture from reaching the PG delete.

**L2 evidence already available:** `report-reassign-impact` shows `wouldDelete + wouldInsert` is stable for the same input (3e.5b T5). The PG-side dedup is scope-safe even if invoked twice.

**Defer to:** Airtable fixture tooling or Postgres source-of-truth cutover.

---

### I6 — Protected-count invariant

**Cross-cutting guard, runs around every test.**

Before every test group and after teardown, verify:
```sql
SELECT 'payments='||COUNT(*) FROM payments
UNION ALL SELECT 'payment_events='||COUNT(*) FROM payment_events
UNION ALL SELECT 'booking_beds='||COUNT(*) FROM booking_beds;
```

Baseline from Gate A: payments=25, payment_events=5, booking_beds=15.

Exception for I3: `payment_events` will be +1 after the 1st POST (expected); teardown must DELETE the test row to restore 5.  
Exception for I4: no payment changes expected; booking_beds unchanged.

---

## Recommended execution order for Stage 3e.6

| Priority | Item | Status |
|----------|------|--------|
| 1st | **I1 L2 schema proof** (read-only) | **PASS** (2026-05-29) — `idx_messages_whatsapp_client` confirmed; 0 dup wamid pairs |
| 2nd | **I4 runtime (dry-run)** | **PASS** (2026-05-29) — exec 1087 confirmed; exec 1088 no-op |
| 3rd | **I3 runtime** | **DEFERRED to Stage 3.5/manual-pay gate** — structural `stripe_event_id UNIQUE` guard proven by schema; runtime requires 1 `payments` fixture insert (protected-table write); deferred rather than run under Stage 3 closeout |
| Deferred | **I1 full-path, I2, I5** | Airtable-coupled or Stripe-coupled; deferred to cutover or manual-pay gate |
| Out of scope | **I7** | Cancel workflow path not in Stage 3e scope |

### Completed: I1 L2 + I4 runtime (2026-05-29)

**I1 L2:** `idx_messages_whatsapp_client UNIQUE (client_id, whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL` confirmed by `pg_indexes` query. Zero duplicate wamid pairs in current `messages` table. PG dedup guard proven at schema level without any activation.

**I4 runtime:** See detailed evidence above. Idempotency mechanism confirmed end-to-end: `confirmation_sent_at IS NULL` guard in both SELECT and UPDATE ensures 2nd execution is a safe no-op with zero state mutation.

### Stage 3 idempotency bar: CLOSED (2026-05-29)

**I1 + I4 + I6 collectively satisfy the Stage 3 idempotency bar:**
- I1 proves at schema level that duplicate WhatsApp message ids cannot produce duplicate rows in the `messages` table.
- I4 proves at runtime that duplicate Send Confirmation triggers produce a safe DB no-op (zero state mutation on the 2nd execution).
- I6 proves that no protected payment tables were touched across all test gates.

**Deferred items are explicitly out-of-scope for Stage 3, not ignored:**
- **I2** (duplicate payment-link) → manual-pay / Stripe gate (Airtable-coupled hold selection + Stripe session creation).
- **I3** (duplicate Stripe event id) → Stage 3.5 / manual-pay gate. Structural guard (`payment_events.stripe_event_id TEXT UNIQUE`) proven by schema inspection; runtime is confirmatory and requires a `payments` fixture insert (protected-table write). Deferred to Stage 3.5 where payment-path testing is gated.
- **I5** (duplicate reassign) → Postgres source-of-truth cutover or Airtable fixture tooling. PG scope guard already proven at L2 by `report-reassign-impact`.

---

## Gating and approval policy

Each runtime gate requires separate explicit approval. Pre-checks (I6 counts + workflow active-states + git status) must pass before any activation. Workflows deactivated immediately after each gate. All fixtures torn down before stopping.

**Stage 3 closeout declaration (2026-05-29):** Stage 3 idempotency verification is **CLOSED**.
- I1 schema proof PASS · I4 runtime PASS · I6 invariant PASS.
- I2, I3, I5 are explicitly deferred to later gates (Stage 3.5 / manual-pay / Postgres cutover); they are not ignored.
- No workflows were left active. All protected counts (payments=25, payment_events=5, booking_beds=15) confirmed at baseline after teardown.
- **Next: Stage 3.5 Safety Rails** (idempotency enforcement in code, error capture, overlap guards, execution logging).

---

## Environment note (from Gate A)

`infra/.env` `WOLFHOUSE_DATABASE_URL` has a typo'd password (`oEGMh19w59Ym4Gf` vs working `oGFMhl9w59Ym4Gf`). Host `node` reports require an inline-corrected `WOLFHOUSE_DATABASE_URL`. `docker exec wolfhouse-postgres psql` is unaffected. Not edited (secrets file, out of scope).

---

## Related docs

- [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) §15–§16 — 3e.5 wrong-booking plan + idempotency summary
- [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) — Stripe + confirmation prior evidence
- [`PROJECT-STATE.md`](PROJECT-STATE.md) — Stage 3 residual tracker
