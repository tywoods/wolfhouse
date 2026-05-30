# Stage 5 — Targeted Source-of-Truth Cleanup (Planning)

**Status:** Planning only — **not started for implementation** (2026-05-30)  
**Prerequisite:** Stage 4 Autonomous Booking Dry-Run **CLOSE WITH DEFERRALS** (`beeb312`)  
**Next consumer:** Stage 6 staff/admin assistant (read-only queries first)

---

## 1. Objective (plain English)

Stage 5 makes **Postgres the reliable memory** for Wolfhouse pilot operations:

1. **Clean source of truth** — guest booking, payment, conversation, rooming, and add-on state live in queryable Postgres records, not scattered across Airtable mirrors and n8n session blobs.
2. **Reduce fragile Airtable dependency** — stop requiring Airtable reads/writes on core guest paths; keep Airtable only as an optional bridge until Stage 6 staff UI replaces it.
3. **Prepare structured data for pilot and staff ops** — when Ale asks *"Who paid for yoga today?"* or *"Who still owes money?"*, the answer comes from Postgres tables/views, not chat logs or exports.

**Scope boundary:** Wolfhouse beachhead only. No multi-client onboarding, no full PMS, no live autonomous operation, no real WhatsApp send — those stay behind separate gates.

---

## 2. Workstreams

| # | Workstream | Must-have before pilot | Should-have before pilot | Defer to multi-client / productization |
|---|------------|------------------------|--------------------------|----------------------------------------|
| 1 | **Conversation memory / session state** | Normalize `conversations.session_state` schema; PG-only conversation lookup (replace Airtable `Search Conversation` on Main path); document session keys (`route`, `missing_fields`, `payment_or_confirm_intent`, `current_hold_booking_id`) | Typed session-state contract + migration from legacy JSONB shapes | Cross-client session analytics; long-term customer memory productization |
| 2 | **Bookings / holds SoT** | Single PG write path for hold → payment_pending; `bookings` is authoritative for status, dates, guest_count, package_code, hold_expires_at | Stuck-hold detection query + runbook | Multi-property booking federation |
| 3 | **Payments / payment status** | Keep Stripe Webhook Handler as payment truth; `payments` + `payment_events` + `bookings.payment_status` aligned; **`payment_balances` view** (deposit paid, balance due, fully paid) | Automated duplicate-payment checks | Multi-currency / multi-Stripe-account |
| 4 | **Confirmation status** | Use existing `confirmation_sent_at` + `send_confirmation` flags; queryable "pending confirmation" list | Confirmation retry / idempotency audit trail | Branded confirmation templates per client |
| 5 | **Rooming / bed assignment** | `booking_beds` + `bookings.assignment_status` / rooming preference fields queryable; no Airtable required for read path | Needs-rooming-review queue view | Auto-assign optimization across properties |
| 6 | **Add-ons: lessons, yoga, rentals** | **Schema + write-path design** for structured add-on records (see §4); dry-run write stubs behind flag | Persist add-on intent when guest requests during stay; link to `payments` when paid | Full during-stay automation, voucher QR, inventory caps |
| 7 | **Staff handoffs / tasks** | **`staff_handoffs` / `staff_tasks`** table: conversation_id, reason, status, assigned_to, created_at | Handoff queue view; link to `conversations.needs_human` | Full task workflow engine |
| 8 | **Audit / logging** | Structured `workflow_events` for booking/payment/add-on mutations; fixture-scoped dry-run markers | Correlation IDs across Main → CPS → webhook → confirmation | Centralized observability platform (Stage 7) |
| 9 | **Pilot readiness gates** | Written gate checklist: PG-only core path, staff query smoke tests, protected-table invariants, explicit live-send approval | Shadow-mode pilot with staff approval per outbound message | Live autonomous operation |

---

## 3. Minimum data model for staff ops

Existing spine (`001_init.sql` + payment migrations): `bookings`, `booking_beds`, `payments`, `payment_events`, `conversations`, `messages`, `guests`. Stage 5 **adds** (migration plan only until approved):

### Core add-on order model

```text
add_on_orders
  id, client_id, booking_id, conversation_id (nullable)
  order_code, status (requested | quoted | awaiting_payment | paid | cancelled)
  payment_id (nullable), total_cents, currency
  source (whatsapp | staff), created_at, updated_at

add_on_items
  id, add_on_order_id
  item_type (lesson | yoga | rental | dinner | bundle)
  service_code (from service_addons.service_catalog)
  quantity, unit_price_cents, line_total_cents
  start_date, end_date (nullable), metadata JSONB
```

### Typed request tables (staff-query optimized)

```text
lesson_requests
  id, add_on_order_id, booking_id, guest_id
  requested_date, quantity, slot_group (nullable — staff assigns)
  payment_status, fulfillment_status (pending | scheduled | completed | refunded)
  staff_notes

yoga_requests
  id, add_on_order_id, booking_id
  class_date, quantity, payment_status
  fulfillment_status (pending | redeemed)
  booked_onsite (bool — per config: yoga often on-site)

rental_requests
  id, add_on_order_id, booking_id
  rental_type (wetsuit | softtop | hardboard | bundle)
  start_date, end_date, quantity
  payment_status, pickup_status (pending | active | returned)
```

### Staff ops + balances

```text
staff_handoffs  (or staff_tasks)
  id, conversation_id, booking_id (nullable)
  reason_code, summary, status (open | assigned | resolved)
  assigned_staff, opened_at, resolved_at

payment_balances  (VIEW, not new truth)
  booking_id, booking_code, guest_name, check_in, check_out
  total_amount_cents, deposit_paid_cents, amount_paid_cents, balance_due_cents
  payment_status, last_payment_at
```

### Staff query mapping

| Staff question | Primary source |
|----------------|----------------|
| "Who paid for yoga today?" | `yoga_requests` WHERE `class_date = today` AND `payment_status = paid` |
| "Who has lessons tomorrow?" | `lesson_requests` WHERE `requested_date = tomorrow` |
| "Who still owes money?" | `payment_balances` WHERE `balance_due_cents > 0` |
| "Who requested a board?" | `rental_requests` WHERE `rental_type IN (...board...)` AND active dates |
| "Which bookings need a human reply?" | `staff_handoffs` open OR `conversations.needs_human = true` |
| "Today's arrivals / departures?" | `bookings` WHERE `check_in = today` OR `check_out = today` |
| "Deposit paid but not full balance?" | `payment_balances` WHERE `payment_status = deposit_paid` |

**Design rule:** Config (`wolfhouse-somo.baseline.json` → `service_addons.service_catalog`) defines **prices and fulfillment**; Postgres records define **who requested what, when, and whether paid**. Stage 6 assistant maps NL → fixed parameterized queries over these tables — never arbitrary SQL.

---

## 4. What NOT to do in Stage 5

| Out of scope | Reason |
|--------------|--------|
| Full staff dashboard / admin UI | Stage 6 |
| Full PMS (housekeeping, channel manager, etc.) | Not product scope |
| Multi-client onboarding system | Stage 7 |
| Live autonomous guest operation | Separate gate after pilot readiness |
| Real WhatsApp send | Separate gate; dry-run / staff-approved send only until proven |
| Broad n8n refactor "for cleanliness" | Only paths tied to SoT cleanup |
| Airtable removal before staff UI | Bridge until Stage 6 cutover |
| Full decision-engine extraction in one step | Incremental; golden tests per module |

---

## 5. Recommended implementation order

One workstream at a time. Each step: **design doc → migration SQL → workflow/script wiring → dry-run proof → PROJECT-STATE update**.

| Phase | Workstream | Deliverable | Live writes? |
|-------|------------|-------------|--------------|
| **5.0** | Planning | This doc + schema RFC | No |
| **5.1** | Conversation PG path | Replace Airtable conversation search on Main; session_state contract | Dry-run first |
| **5.2** | Bookings/holds SoT | Document single write authority; remove Airtable hold mirror from critical path | Stubs until gate |
| **5.3** | Payments + balances | `payment_balances` view; align booking payment fields with webhook truth | Protected-table rules unchanged |
| **5.4** | Confirmation status | Query views for pending/sent; no new send logic | Dry-run only |
| **5.5** | Add-on schema | Migration `007_add_on_orders.sql` (proposed); no runtime writes until 5.6 | Schema only in 5.5 |
| **5.6** | Add-on write path | Persist `add_on_intent` from bot (A9-style quotes → structured record) | Fixture-scoped dry-run |
| **5.7** | Staff handoffs | `staff_handoffs` populated from handoff routes (A6/A7 patterns) | Dry-run |
| **5.8** | Rooming queryability | Views for preferences + assignment status; no new auto-assign | Read-only |
| **5.9** | Pilot readiness gates | Checklist run: staff query smoke tests against PG | Shadow mode only |
| **5.10** | Decision engine (partial) | Extract highest-churn modules (`routeMessage`, `requiredFields`) — only after SoT stable | Tests only |

**Parallel (non-blocking):** 3x.2 price confirmation (provisional → confirmed for live charge); audit logging improvements.

---

## 6. Pilot readiness gates (Stage 5 exit)

Before any **live WhatsApp** or **live autonomous** gate:

- [ ] Core guest path reads/writes Postgres without Airtable on Main hold/conversation/search
- [ ] All eight staff sample questions answerable from PG (§3 table) with fixture data
- [ ] Protected tables invariant documented and enforced (Main must not write `payments` / `payment_events`)
- [ ] Add-on request → structured record → payment link → webhook → paid status traceable in PG (dry-run proven)
- [ ] Handoff queue queryable without reading raw WhatsApp exports
- [ ] Real WhatsApp send explicitly **not approved** until separate owner gate
- [ ] Pricing `global_pricing_status` reviewed before live autonomous charge

**Stage 5 success ≠ live pilot.** Stage 5 success = **data and paths ready** so Stage 6 staff assistant and a controlled shadow pilot can operate safely.

---

---

## Stage 5.1 — Conversation PG Path (Detailed Plan)

**Status:** Planning only — **not started for implementation** (2026-05-30)  
**Slice:** First Stage 5 implementation slice.  
**Input:** Stage 4 state — `applyPGConversationRead` already wired, PG read exists, write gated.

---

### 5.1.1 Current conversation/session flow (Stage 4 state)

```
Inbound WA
  → Normalize Incoming Message (phone normalization, guest_message extract)
  → [shared path]
      Search Conversation (Airtable)                ← primary read, always runs
        → Postgres - Search Conversation (PG)        ← SELECT only, alwaysOutputData=true, series
            → IF Conversation Exists?                ← checks AIRTABLE records count (not PG)
                ↓ true (AT found)  │  ↓ false (AT not found)
      [booking_flow path]
      Parser Node → Merge Session State              ← direct; reads AT-first, PG fallback
          atSession  = Search Conversation['Session State']
          pgSession  = Postgres - Search Conversation (PG).session_state
          priority:  atSession || pgSession          ← AIRTABLE FIRST

  → ... routing (BSR, pick-active-booking) ...

  → [on hold success]
      IF - DRY RUN? (Postgres - Create Booking Hold)  ← protected: gated
          → true (live): real PG hold write (bookings table)
          → false (dry-run): PG_HOLD_STUB (fake booking_id, no DB write)

      IF - DRY RUN? (Postgres - Upsert Conversation Hold)  ← gated even though conversations ≠ protected
          → true (live): real PG conversation upsert (conversations table)
          → false (dry-run): PG_CONV_STUB (pg_ok=true, NO write)
          ⚠ stub reason: FK constraint — current_hold_booking_id references a fake stub booking_id
```

**Consequence for multi-turn (A2/A3/A4):** T2 always sees `IF Conversation Exists? = false` (Airtable has no record), and T2 reads empty session state (AT empty, PG empty because conversation write was stubbed). Stage 4 runner worked around this by manually seeding PG conversation rows between turns.

---

### 5.1.2 Desired Stage 5.1 flow

```
Inbound WA
  → Normalize Incoming Message
  → [shared path]
      Search Conversation (Airtable)                ← still runs; keeps AT as optional bridge
        → Postgres - Search Conversation (PG)        ← SELECT only, alwaysOutputData=true
            → IF Conversation Exists?               ← checks PG conversation_id OR AT records
                ↓ true (PG or AT found)  │  ↓ false (neither)

      [booking_flow path]
      Parser Node → Merge Session State
          pgSession  = Postgres - Search Conversation (PG).session_state
          atSession  = Search Conversation['Session State']
          priority:  pgSession || atSession          ← PG FIRST (AT bridge/fallback)

  → ... routing (BSR reads PG session_state for current_hold_id hint) ...

  → [on hold success]
      Postgres - Create Booking Hold  ← STAYS gated (bookings = protected table)
          → true (live): real PG hold write
          → false (dry-run): PG_HOLD_STUB

      Postgres - Upsert Conversation Hold  ← GATE REMOVED for conversations
          → always writes to PG conversations (not protected)
          → passes NULL for current_hold_booking_id when hold is a dry-run stub
          ← FK null-safety: SQL upsert already supports nullable booking FK
```

**Result:** T2 naturally reads PG session from T1 write. Runner does not need to seed conversations between turns. Airtable is still queried as a bridge but does not gate the flow.

---

### 5.1.3 `session_state` contract

All keys stored in `conversations.session_state` JSONB. Each turn's `Merge Session State` shallow-merges new keys; non-null, non-empty values overwrite.

| Key | Type | Set by | Notes |
|-----|------|--------|-------|
| `language` | `string` | BSR / parser | `en`, `it`, `de`, `es` |
| `route` | `string` | BSR | `booking_flow`, `general_question`, `payment_or_confirm_intent`, `payment_details_provided`, `existing_booking_modify`, `human_handoff`, `closed_month_guard` |
| `check_in` | `YYYY-MM-DD` | Parser node | |
| `check_out` | `YYYY-MM-DD` | Parser node | |
| `guest_count` | `number` | Parser node | |
| `package` | `string` | Parser node | `malibu`, `uluwatu`, `waimea`, or custom |
| `room_type` | `string` | Merge Session State | `shared` (default), `private` |
| `room_preference` | `string` | Parser node | Free text preference |
| `missing_fields` | `string[]` | BSR | Fields still required before hold |
| `ready_for_availability_check` | `bool` | Merge Session State | `check_in` + `check_out` + `guest_count` present |
| `current_hold_id` | `string` | Merge Session State | Booking code `WH-…` (Airtable mirror) |
| `hold_booking_id` | `string` | Merge Session State / upsert | Same booking code |
| `active_booking_id` | `string` | Merge Session State | Same booking code |
| `current_hold_booking_code` | `string` | Upsert SQL | Written by `buildConversationHoldUpsertN8nSql` |
| `payment_or_confirm_intent` | `string\|null` | BSR / parser | `deposit`, `full`, or null |
| `payment_choice` | `string` | Parser node | Guest's stated choice |
| `guest_name` | `string` | Parser node / Code - Extract Guest Details | |
| `guest_email` | `string` | Parser node / Code - Extract Guest Details | |
| `handoff_reason` | `string` | BSR | Reason for human_handoff route |
| `add_on_intent` | `object` | Stage 5.6 (not yet written) | Requested add-ons draft; links to `add_on_orders` in Stage 5.6 |
| `_pg_fallback_used` | `bool` | Merge Session State | Debug: true when AT session was empty |
| `_pg_conversation_id` | `uuid string` | Merge Session State | PG conversations.id for this session |

**Not in session_state (live in PG columns instead):**
- `needs_human`, `bot_mode`, `conversation_stage`, `pending_action`, `current_hold_booking_id` — all are top-level `conversations` table columns.

---

### 5.1.4 Migration / compatibility strategy

| Risk | Mitigation |
|------|-----------|
| Existing Airtable-backed conversations have session_state in AT only | AT still queried as bridge; PG row created on first Stage 5.1 write; `pgSession \|\| atSession` handles transition |
| Legacy session_state JSONB has inconsistent key names (`current_hold_id` vs `hold_booking_id` vs `active_booking_id`) | `sessionHoldCode()` in `main-conversation-state-pg-sql.js` already handles all aliases; no migration needed in 5.1 |
| PG conversation upsert FK constraint: `current_hold_booking_id` references `bookings.id` (UUID) | Conversation upsert must accept NULL for FK when hold is a dry-run stub. The upsert SQL already handles nullable FK (no NOT NULL constraint). Pass `NULL` instead of fake `dry-run-conv` UUID. |
| Stage 4 test conversation rows in PG (from runner seed) | Cleanup SQL pattern: `DELETE FROM conversations WHERE phone LIKE '+346000001%'` (Stage 4 dry-run phones 346000001xx). Document as known-fixture cleanup. |
| `IF Conversation Exists?` condition currently in source workflow JSON | Change applied by `applyPGConversationRead` in build script — no raw JSON edit needed |

---

### 5.1.5 Dry-run proof criteria

After Stage 5.1 build changes, the multi-turn scenarios must pass without runner conversation seed:

| Check | Pass criteria |
|-------|---------------|
| A2 T1 runs | `conversations` row created in PG for phone `+34600000102` |
| A2 T2 runs (no runner seed) | `Postgres - Search Conversation (PG)` returns T1 session_state; BSR reads package_required hint; `IF Conversation Exists?` = true |
| A2 T3 runs | Flow completes; missing_fields path still triggered |
| A3/A4 T2 | `payment_or_confirm_intent` preserved from T1 session in PG |
| Protected tables Δ=0 | `bookings` / `payments` / `payment_events` / `booking_beds` unchanged |
| `conversations` allowed to change | Δ > 0 expected (write + read per turn) |
| No Airtable writes | No `Create Conversation`, `Update Conversation` Airtable nodes fire |
| No real WhatsApp | `WHATSAPP_DRY_RUN=true`; no `graph.facebook.com` |
| Cleanup | `DELETE FROM conversations WHERE phone IN ('+34600000101', ..., '+34600000114')` restores pre-test state |

---

### 5.1.6 Implementation steps

Each step is docs/static only until approved for a runtime gate.

| Step | Change | File(s) | Write? |
|------|--------|---------|--------|
| **5.1-S1** | Patch `IF Conversation Exists?` condition in `applyPGConversationRead` to check `$('Postgres - Search Conversation (PG)').first().json.conversation_id != null \|\| $json.records?.length > 0` | `scripts/build-main-local-stripe.js` | Build only |
| **5.1-S2** | Invert `Merge Session State` priority: `pgSessionRaw \|\| atSession` (PG-first) in `PG_SEARCH_CONV_JS_CODE` | `scripts/build-main-local-stripe.js` | Build only |
| **5.1-S3** | Remove `PG_CONV_STUB` gate from `applyShadowModeDryRunGates` (`Postgres - Upsert Conversation Hold`) — conversations are not protected tables | `scripts/build-main-local-stripe.js` | Build only |
| **5.1-S4** | Modify conversation upsert params: pass `NULL` for `current_hold_booking_id` when hold has `dry_run: true` (check upstream hold node output); update `buildConversationHoldUpsertN8nSql` expression or add a guard Code node | `scripts/build-main-local-stripe.js` or `scripts/lib/main-conversation-pg-sql.js` | Build only |
| **5.1-S5** | Add `applyPGConversationPrimary` verification checks to `verifyPGConversationRead` (IF condition check, priority check) | `scripts/build-main-local-stripe.js` | Build only |
| **5.1-S6** | Regenerate Main workflow: `node scripts/build-main-local-stripe.js` | `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` | Generated |
| **5.1-S7** | Import inactive: `node scripts/build-main-local-stripe.js --import-inactive` | n8n DB | n8n DB only |
| **5.1-S8** | Run A2/A3/A4 dry-run without runner seed; verify conversation PG read/write works; confirm protected counts Δ=0 | Runner | No protected writes |
| **5.1-S9** | Add Stage 5.1 cleanup SQL pattern to runner or as named fixture | `scripts/fixtures/stage5.1-conversations-cleanup.sql` | Fixture |
| **5.1-S10** | Update `PROJECT-STATE.md` and this doc | Docs | Docs only |

**Do not begin 5.1-S1 until this plan is approved.**

---

### 5.1.7 Verification commands (reference, no runtime)

```bash
# Build and static verify (docs/static only — no activation, no runtime)
node scripts/build-main-local-stripe.js --verify-targets

# Check PG conversation wiring after build
node scripts/report-main-conversation-state.js --phone +34600000102

# After runtime gate is approved:
# Cleanup dry-run conversation rows
node scripts/run-sql.js --file scripts/fixtures/stage5.1-conversations-cleanup.sql
```

---

## Stage 5.1 runtime gate — A3/A4 without seed (plan)

**Status:** **PASS** — 2026-05-30 (execs 1214/1215/1216/1217). No runner seed. WHATSAPP_DRY_RUN=true. Only Main RBfGNtVgrAkvhBHJ active.

---

### 5.1.8 Runtime gate scope analysis

Before defining the gate, a key constraint was identified:

| Scenario | T1 fires hold? | T1 writes conversation to PG? | T2 can read T1 session? | Gate scope |
|----------|---------------|-------------------------------|------------------------|------------|
| **A3** | ✅ Yes (all fields present) | ✅ Yes — `Postgres - Upsert Conversation Hold` now ungated, FK null-safe write | ✅ Yes — PG-primary | **Stage 5.1 gate** |
| **A4** | ✅ Yes (all fields present) | ✅ Yes | ✅ Yes | **Stage 5.1 gate** |
| **A2** | ❌ No (missing package) | ❌ No — upsert only runs on hold-success path | ❌ No — no PG row from T1 | **Deferred to Stage 5.1b** |

**A2 deferral reason:** `Postgres - Upsert Conversation Hold` is wired on the hold-success path only. When T1 has missing fields and doesn't create a hold, no PG conversation row is written. T2 cannot read T1 session. A2 still requires either a seed or a new Stage 5.1b fix: a "write session state on any routing" PG path (not gated on hold creation).

**Runner note:** `seedConversationState()` is defined in the runner but **not called automatically** in `main()`. Stage 4 seeds were applied via manual `_tmp*.js` scripts between turns. No `--no-seed` flag is needed — the runner does not auto-seed. The Stage 5.1 gate runs T1 then T2 with no manual seed between turns.

---

### 5.1.9 Runtime gate — A3 and A4

**Preconditions:**
- Main workflow active (`node scripts/build-main-local-stripe.js --import-inactive` then activate in n8n UI)
- `WHATSAPP_DRY_RUN=true`
- No manual conversation seed for phones `34600000103` or `34600000104`
- Protected table baseline: bookings=41, payments=25, payment_events=5, booking_beds=15 (verify before starting)

**Per-turn runtime evidence:**

| Turn | Exec | Status | Key proof |
|------|------|--------|-----------|
| A3-T1 | 1214 | success | `Postgres - Upsert Conversation Hold` pg_ok=true, created=true, booking_not_in_pg=true, conversation_id=150ee5a7 for +34600000103 |
| A3-T2 | 1215 | success | `IF Conversation Exists?` → branch0 (TRUE via PG conv_id), `Merge Session State` old_state from PG, route=payment_or_confirm_intent (LLM conf=0.85) |
| A4-T1 | 1216 | success | `Postgres - Upsert Conversation Hold` pg_ok=true, created=true, booking_not_in_pg=true, conversation_id=22b14336 for +34600000104 |
| A4-T2 | 1217 | success | `IF Conversation Exists?` → branch0 (TRUE via PG conv_id), `Merge Session State` old_state from PG, route=payment_or_confirm_intent (LLM conf=0.95) |

**Notes:**
- Phones stored with `+` prefix by n8n normalisation (e.g. `+34600000103`, not `34600000103`). Cleanup SQL updated to include both formats.
- `session_state` written by T1 contains `check_in/check_out/guest_count/primary_room_code/current_hold_booking_code`. `package` and `language` not included in the conversation upsert SQL template — BSR lacked full booking context in T2. LLM still correctly classified payment intent from guest message alone.
- Protected counts baseline confirmed unchanged: bookings=41, payments=25, payment_events=5, booking_beds=15.
- Cleanup: 2 rows deleted from `conversations`, remaining=0.

```
# A3 T1
node scripts/run-stage4-autonomous-dry-run.js --only a3 --turn 1 --execute --run

# A3 T2 (no seed — T1 should have written conversations row naturally)
node scripts/run-stage4-autonomous-dry-run.js --only a3 --turn 2 --execute --run

# A4 T1
node scripts/run-stage4-autonomous-dry-run.js --only a4 --turn 1 --execute --run

# A4 T2 (no seed)
node scripts/run-stage4-autonomous-dry-run.js --only a4 --turn 2 --execute --run
```

**Expected per-turn behavior:**

| Turn | Expected | Key check |
|------|----------|-----------|
| A3-T1 | route=booking_flow, hold stub fires, `Postgres - Upsert Conversation Hold` executes, `pg_ok=true`, `booking_not_in_pg=true` (FK null, session_state written) | `conversations` Δ=+1 for phone 34600000103 |
| A3-T2 | `IF Conversation Exists?` → TRUE (via PG `conversation_id`), `Merge Session State` reads PG session, route=payment_or_confirm_intent or booking_flow with hold hint | `_pg_primary_used=true` in session state |
| A4-T1 | Same as A3-T1 for phone 34600000104 | `conversations` Δ=+1 for phone 34600000104 |
| A4-T2 | Same as A3-T2 for phone 34600000104 | |

---

### 5.1.10 Pass/fail criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| A3-T1 `Postgres - Upsert Conversation Hold` executes | `pg_ok=true`, `booking_not_in_pg=true` | node not executed, or `pg_ok=false` due to missing phone |
| A3-T1 writes conversation to PG | `conversations` Δ=+1 for 34600000103 | Δ=0 |
| A3-T2 IF Conversation Exists? via PG | `stage51-pg-conv-exists` condition TRUE | FALSE — meaning PG write from T1 failed |
| A3-T2 uses PG session | `_pg_primary_used=true` in merged session | false |
| A4 same as A3 for phone 34600000104 | both T1/T2 pass | — |
| Protected tables Δ=0 | bookings=41, payments=25, payment_events=5, booking_beds=15 | any non-zero delta |
| WHATSAPP_DRY_RUN=true throughout | no graph.facebook.com | any live WA call |
| Cleanup succeeds | conversations rows deleted, count=0 | row still present after cleanup |
| **A2 without seed** | _not tested in this gate_ | — |

---

### 5.1.11 Cleanup SQL

Run after A3/A4 gate completes (success or failure):

```sql
-- Delete Stage 5.1 gate conversation rows
-- Scoped to wolfhouse-somo client; only dry-run test phones
DELETE FROM conversations
WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo' LIMIT 1)
  AND phone IN ('34600000102', '34600000103', '34600000104');

-- Verify: expect 0 rows
SELECT COUNT(*) AS remaining
FROM conversations
WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo' LIMIT 1)
  AND phone IN ('34600000102', '34600000103', '34600000104');
-- expected: remaining = 0
```

Save as `scripts/fixtures/stage5.1-conversations-cleanup.sql`.

---

### 5.1.13 Stage 5.1b — enrich PG conversation session_state (STATIC DONE 2026-05-30)

**Problem addressed:** T1 `session_state` only stored `check_in/check_out/guest_count/primary_room_code/current_hold_booking_code`. BSR in T2 lacked `package` and `language` and relied on LLM classification alone.

**Changes (static only, no runtime):**

- `scripts/build-main-local-stripe.js` — `conversationQueryReplacement` `$6` (session_state_json) extended to an IIFE that conditionally populates all booking-relevant fields present at hold time:
  - `current_hold_booking_code`, `check_in`, `check_out`, `guest_count`, `primary_room_code` (existing)
  - **new:** `package`, `language`, `route`, `room_type`, `room_preference`, `guest_name`, `guest_email`, `missing_fields`
  - Null-safety: each field is only set if non-null/non-empty — `jsonb ||` merge on conflict means empty values never erase live session fields.
- `verifyPGConversationRead` — new S5b checks assert `_s.package` and `_s.language` present in the conversation hold node queryReplacement.
- `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` — regenerated; `active=false` confirmed after `--import-inactive`.

**Static checks passed:**
- `build-main-local-stripe.js` — PG conversation read verify (Stage 5.1 PG-primary): OK
- `--verify-targets` — OK: hard safety checks passed
- `report-main-payment-contract.js` — Overall OK: true
- `report-main-rooming-contract.js` — Overall OK: true
- `node --check run-stage4-autonomous-dry-run.js` — syntax OK
- `--import-inactive` — Import OK (active=false)

**Still deferred (see 5.1.12 below):** A2 non-hold session write path. The enriched session_state means once A2 gains a session write path, T2 will immediately have full context without LLM guessing.

---

### 5.1.12 Deferral: Stage 5.1b — write session without hold (A2)

**Problem:** A2 T1 does not create a hold (missing package → no hold path). `Postgres - Upsert Conversation Hold` never runs. No PG conversation row is written. T2 cannot read T1 state from PG.

**Required fix for A2:** A new PG node — "Postgres - Write Session State" — on the non-hold routing path. This node would upsert `conversations` with session_state after every routing decision (not just on hold success). It would:
- Write `phone`, `language`, `conversation_stage`, `session_state` to PG
- Not require a booking_code (no FK dependency)
- Run on all paths where Airtable currently writes `Create Conversation` / `Update Conversation`
- Be the natural counterpart to `Postgres - Search Conversation (PG)` (read + write pair)

**Scope of Stage 5.1b:** design the node, place it in the workflow, verify A2 T1 writes session, A2 T2 reads naturally. This is the next Stage 5.1 slice after this gate passes.

---

| Doc | Role |
|-----|------|
| [ROADMAP.md § Stage 5](ROADMAP.md#stage-5--clean) | Roadmap placement + staff-queryable data requirement |
| [ARCHITECTURE-NORTH-STAR.md](ARCHITECTURE-NORTH-STAR.md) | Postgres remembers; Airtable temporary |
| [PROJECT-STATE.md](PROJECT-STATE.md) | Execution tracker |
| [test-payloads/stage4/autonomous-dry-run/README.md](../test-payloads/stage4/autonomous-dry-run/README.md) | Stage 4 evidence + deferrals |
| `config/clients/wolfhouse-somo.baseline.json` | Add-on catalog, payment, confirmation rules |
| [STAFF-QUERY-ASSISTANT-PLAN.md](STAFF-QUERY-ASSISTANT-PLAN.md) | Stage 6 query assistant (blocked on Stage 5 tables) |
