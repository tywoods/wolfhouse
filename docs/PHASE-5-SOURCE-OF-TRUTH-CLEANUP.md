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

**Scope of Stage 5.1b:** design the node, place it in the workflow, verify A2 T1 writes session, A2 T2 reads naturally. This is the next Stage 5.1 slice after this gate passes. *(Stage 5.1b in this doc became the session_state enrichment — §5.1.13. The non-hold write path is now Stage 5.1c — §5.1.14.)*

---

### 5.1.14 Stage 5.1c — non-hold PG session write path (A2) (RUNTIME PASS 2026-05-30)

#### A2 T1 path (traced)

```
Normalize Incoming Message
→ Search Conversation (AT) → Postgres - Search Conversation (PG)
→ IF Conversation Exists? [FALSE — no PG row yet]
→ Router - Classify Message [LLM → booking_flow]
→ Code - Parse Route
→ Code - Booking State Resolver → Switch [booking_flow branch]
→ Parser Node  (extracts check_in, check_out, guest_count — no package)
→ Merge Session State  (PG primary | AT bridge)
→ Determine Missing Fields
    output: { session: {check_in, check_out, guest_count, missing_fields:['package_intent'], ready_for_availability_check:false}, ... }
→ Code - Check Closed Month → IF - Closed Month? [FALSE]
→ IF - Ready For Availability [FALSE — missing_fields non-empty]
→ Generate Next Reply  ← "ask for package" reply generated here
→ IF - DRY RUN? (Create Outbound Message)  →  [dry-run stub path]
```

`Postgres - Upsert Conversation Hold` is on the **TRUE** branch of `IF - PG Hold OK`, which is only reachable after hold creation succeeds. A2 T1 never gets there.

#### Best write point

Between `IF - Ready For Availability` **FALSE branch** (main[1]) and `Generate Next Reply`.

Rationale:
- Only fires when `ready_for_availability_check = false` (missing fields in booking context)
- Does not fire when ready (that path is covered by `Postgres - Upsert Conversation Hold`)
- Covers A2 and all future missing-fields booking turns
- Does not fire for non-booking routes (human_handoff, general_question, etc.)

#### New node: `Postgres - Write Session State`

| Property | Value |
|----------|-------|
| Type | `n8n-nodes-base.postgres` |
| Operation | `executeQuery` |
| Query | `buildSessionWriteN8nSql()` — new function in `main-conversation-pg-sql.js` |
| `alwaysOutputData` | `true` (chain must not break if write fails) |
| Credentials | `Wolfhouse Postgres (local)` |
| Node ID | `3ce006001-0001-4000-8000-000000000601` |
| Position | between `IF - Ready For Availability` FALSE and `Generate Next Reply` |

#### SQL design (`buildSessionWriteN8nSql`)

```sql
WITH params AS (
  SELECT
    NULLIF($1, '__NULL__') AS phone,
    NULLIF($2, '__NULL__') AS language,
    COALESCE(NULLIF($3, '__NULL__'), 'booking_flow') AS conversation_stage,
    COALESCE(NULLIF($4, '__NULL__')::jsonb, '{}'::jsonb) AS session_state_json
),
client AS (
  SELECT id FROM clients WHERE slug = 'wolfhouse-somo' LIMIT 1
)
INSERT INTO conversations (client_id, phone, conversation_stage, session_state, language)
SELECT c.id, p.phone, p.conversation_stage, p.session_state_json, p.language
FROM params p INNER JOIN client c ON TRUE
WHERE p.phone IS NOT NULL
ON CONFLICT (client_id, phone) DO UPDATE SET
  conversation_stage = EXCLUDED.conversation_stage,
  session_state = COALESCE(conversations.session_state, '{}'::jsonb) || EXCLUDED.session_state,
  language = COALESCE(EXCLUDED.language, conversations.language),
  updated_at = NOW()
RETURNING
  id::text AS conversation_id, phone, conversation_stage,
  (xmax = 0) AS created, (xmax <> 0) AS updated,
  TRUE AS pg_ok;
```

Key properties:
- No `current_hold_booking_id` column — FK stays `NULL` for new rows, preserved for existing rows
- `session_state` merges with existing: `existing || incoming` (incoming never has null/empty fields — IIFE builder filters them)
- Only guard: `phone IS NOT NULL`
- Returns `pg_ok=TRUE` always on success

#### queryReplacement parameter mapping

| Param | Value source |
|-------|-------------|
| `$1` phone | `$('Normalize Incoming Message').first().json.phone` |
| `$2` language | `$('Code - Parse Route').first().json.language \|\| $('Determine Missing Fields').first().json.session?.language` |
| `$3` conversation_stage | `'booking_flow'` (hard-coded) |
| `$4` session_state_json | IIFE reading from `$('Determine Missing Fields').first().json.session` — same conditional builder pattern as Stage 5.1b (only non-null/non-empty fields set) |

Session_state_json fields included (when non-null):
`check_in`, `check_out`, `guest_count`, `package` (if known), `language`, `route`, `room_type`, `room_preference`, `guest_name`, `guest_email`, `missing_fields` (always written, even if `[]`), `ready_for_availability_check`, `current_hold_booking_code` (if known)

#### Wiring change

```
BEFORE:  IF - Ready For Availability main[1]  →  Generate Next Reply
AFTER:   IF - Ready For Availability main[1]  →  Postgres - Write Session State  →  Generate Next Reply
```

No other connections change. `Postgres - Upsert Conversation Hold` (hold-success path) is unaffected.

#### Safety rules

- Writes `conversations` only — no bookings, payments, payment_events, booking_beds
- No `current_hold_booking_id` set (no FK to bookings)
- No Airtable writes
- No Stripe/CPS calls
- No WhatsApp live send
- `WHATSAPP_DRY_RUN=true` is sufficient — conversations is an allowed state table
- Test rows cleaned by fake phone numbers (same cleanup SQL pattern as Stage 5.1)

#### Verifier checks (to add to `verifyPGConversationRead` or separate `verifyPGSessionWrite`)

1. `Postgres - Write Session State` node exists in workflow
2. Node SQL does not contain `bookings`, `payments`, `payment_events`, `booking_beds` (writes only `conversations`)
3. Node SQL does not contain `current_hold_booking_id` in the INSERT column list
4. `IF - Ready For Availability` main[1] connects to `Postgres - Write Session State` (not directly to `Generate Next Reply`)
5. `Postgres - Write Session State` connects to `Generate Next Reply`
6. `Postgres - Write Session State` is NOT on the TRUE branch of `IF - Ready For Availability` (hold path must not double-write)
7. `alwaysOutputData: true` on the node

#### Static implementation (2026-05-30)

- `scripts/lib/main-conversation-pg-sql.js` — `buildSessionWriteN8nSql()` added; exported.
- `scripts/build-main-local-stripe.js` — `applyPGSessionWriteNonHoldPath(workflow)` adds and wires the node; `verifyPGSessionWrite(workflow)` checks all 7 verifier criteria; both wired into main build flow and `runVerifyTargets`.
- `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` — regenerated; 346 nodes (was 345); `Postgres - Write Session State` added; `active=false` confirmed after `--import-inactive`.
- Tag `stage5.1c-sess-write` added to workflow.

**Static checks (all pass):**
- `PG session write verify (Stage 5.1c non-hold path): OK`
- `PG conversation read verify (Stage 5.1 PG-primary): OK`
- `--verify-targets`: OK: hard safety checks passed
- `report-main-payment-contract.js`: Overall OK: true
- `report-main-rooming-contract.js`: Overall OK: true
- `node --check run-stage4-autonomous-dry-run.js`: OK
- `--import-inactive`: Import OK (active=false)

#### A2 runtime proof criteria (after implementation)

**A2 T1 (exec 1226 — 2026-05-30 PASS):**
- `IF Conversation Exists?` → FALSE (no prior row, clean baseline)
- `Postgres - Write Session State` executed (IIFE paren bug fixed in `pgParam` template)
- `Postgres - Upsert Conversation Hold` did NOT execute
- Conversation row created: `id=69164229-affe-4baa-bd2d-5eaecf74d5b1`, `phone=+34600000102`, `current_hold_booking_id=null`
- `session_state`: `check_in=2026-05-01`, `check_out=2026-05-08`, `guest_count=1`, `missing_fields=["package_intent"]`, `ready_for_availability_check=false`

**A2 T2 (exec 1227 — 2026-05-30 PASS, no seed):**
- `IF Conversation Exists?` → TRUE via PG `conversation_id=69164229` (from T1 WSS write)
- `Merge Session State` `old_state` = T1 session (check_in/check_out/guest_count/missing_fields from PG)
- `Code - Parse Route` → `route=payment_or_confirm_intent` (Malibu package confirmed)
- `IF - Ready For Availability` → TRUE branch
- `Postgres - Upsert Conversation Hold` executed: `pg_ok=true`, `booking_not_in_pg=true`, `conversation_id=69164229`
- Hold stub fired (`Code - DRY RUN Stub (Postgres - Create Booking Hold)`)
- Protected counts: bookings Δ=0, payments Δ=0, payment_events Δ=0, booking_beds Δ=0
- Cleanup: conversation row `+34600000102` deleted; remaining=0

**Fix applied:** Both `Postgres - Upsert Conversation Hold` and `Postgres - Write Session State` IIFEs had a missing closing `)` for `JSON.stringify(` in the `pgParam` template in `scripts/build-main-local-stripe.js`. This caused `esprima-next` to throw `ExpressionExtensionError: invalid syntax (Unexpected token :)`. Fixed by adding the missing `)` to close `JSON.stringify(` in both template literals (lines 686 and 1417 of build script).

---

| Doc | Role |
|-----|------|
| [ROADMAP.md § Stage 5](ROADMAP.md#stage-5--clean) | Roadmap placement + staff-queryable data requirement |
| [ARCHITECTURE-NORTH-STAR.md](ARCHITECTURE-NORTH-STAR.md) | Postgres remembers; Airtable temporary |
| [PROJECT-STATE.md](PROJECT-STATE.md) | Execution tracker |
| [test-payloads/stage4/autonomous-dry-run/README.md](../test-payloads/stage4/autonomous-dry-run/README.md) | Stage 4 evidence + deferrals |
| `config/clients/wolfhouse-somo.baseline.json` | Add-on catalog, payment, confirmation rules |
| [STAFF-QUERY-ASSISTANT-PLAN.md](STAFF-QUERY-ASSISTANT-PLAN.md) | Stage 6 query assistant (blocked on Stage 5 tables) |

---

## Stage 5.2 — Bookings/Holds Source-of-Truth Cleanup (PLANNING 2026-05-30)

### Objective

Make `bookings` in Postgres the authoritative, queryable record for hold and payment-pending state during the Wolfhouse pilot. Eliminate the dependency on Airtable writes on the booking/hold **critical path**. Ensure holds, expiry, and payment state are readable by staff and detectable by automated tooling — without enabling live holds or live payments.

### 5.2.1 Current booking/hold path (traced from Main workflow)

```
Code - Prepare Hold Records
  → IF - DRY RUN? (Postgres - Create Booking Hold)
      TRUE  → Code - DRY RUN Stub (Postgres - Create Booking Hold)   ← fake booking_id/code, no DB write
      FALSE → Postgres - Create Booking Hold                         ← buildHoldUpsertN8nSql()
  → Code - Validate PG Hold
  → IF - PG Hold OK
      TRUE  → Postgres - Upsert Conversation Hold                    ← real write, FK guard
      TRUE  → IF - PG Conversation OK
                → IF - DRY RUN? (Create Booking Hold)
                    TRUE  → Code - DRY RUN Stub (Create Booking Hold) ← fake AT id
                    FALSE → Create Booking Hold (Airtable)            ← mirror
                  → IF - DRY RUN? (Postgres - Backfill Booking AT Record Id)
                    TRUE  → Code - DRY RUN Stub (Backfill AT Rec Id)  ← noop
                    FALSE → Postgres - Backfill Booking AT Record Id  ← UPDATE bookings.airtable_record_id
                  → Code - Summarize Holds
                  → IF - Apply Stripe After Hold
                  → (payment / confirmation path)
```

**On T3 (payment details provided):**
```
  → IF - DRY RUN? (Postgres - Ensure Booking In Postgres)
      TRUE  → Code - DRY RUN Stub (Postgres - Ensure Booking In Postgres)  ← stub; passes through hold ids
      FALSE → Postgres - Ensure Booking In Postgres                         ← buildEnsurePromoteN8nSql()
                 promotes: hold → payment_pending + waiting_payment
  → IF - Booking ID Ready
  → Code - Call Create Payment Session (dry-run branch)
  → (Stripe CPS / checkout)
```

### 5.2.2 What still depends on Airtable on the critical path

| Node | Airtable dependency | Criticality |
|------|--------------------|----|
| `Create Booking Hold` (AT) | Creates AT record; returns `rec…` id | High — backfill writes to `bookings.airtable_record_id`; Summarize Holds reads AT Booking ID field |
| `Code - Summarize Holds` | Prefers AT Booking ID over PG booking_code | Medium — breaks payment path if AT id missing |
| `Postgres - Backfill Booking AT Record Id` | `UPDATE bookings SET airtable_record_id` | Medium — ties PG record to AT; not needed if AT mirror removed |
| `Postgres - Ensure Booking In Postgres` ($12 param) | Accepts `airtable_record_id` as fallback lookup | Low — fallback only; PG booking_code is primary |
| `Search Conversation` (AT) | Parallel to PG search | Already a bridge since Stage 5.1; PG is primary |

### 5.2.3 Gaps vs Stage 5.2 objective

| Gap | Impact | Fix scope |
|-----|--------|-----------|
| `Postgres - Create Booking Hold` is fully stubbed in dry-run | No real `bookings` row during any test | Must define a fixture-scoped dry-run gate (similar to Stage 5.1 conversation gate) to prove real hold write |
| `Code - Summarize Holds` reads AT Booking ID field, not PG booking_code | If AT mirror removed, payment path can't find the booking | Must patch Summarize Holds to use PG booking_code first |
| Backfill node ties hold success to AT mirror success | Critical path coupled to AT | Make backfill optional/deferred; remove from PG hold success gate |
| `hold_expires_at` set correctly in SQL but not surfaced in session_state | Staff can't see expiry from session | Add `hold_expires_at` to Conversation Hold upsert session_state |
| `proposeStatuses()` in hold SQL always writes `not_requested` | payment_pending is deferred to Ensure node — fine but undocumented explicitly | Document that hold → payment_pending promote is intentionally a separate node |
| `Postgres - Ensure Booking In Postgres` insert path doesn't set `hold_expires_at`, `assignment_status`, `availability_check_status` | Promoted row missing some metadata | Patch ensure insert to carry these through |
| No expired-hold query/view exists | Stuck holds invisible to staff | Define SQL/view for expired + active + payment_pending holds |
| `booking_not_in_pg=true` in dry-run means conversation FK is always NULL | PG conversation row has no FK to booking | After Stage 5.2 gate, FK should be set when PG hold is real |

### 5.2.4 Proposed booking/hold state contract

Fields that must be set at each lifecycle stage:

| Stage | Field | Required | Source |
|-------|-------|----------|--------|
| **hold** | `booking_code`, `client_id`, `phone`, `status=hold`, `payment_status=not_requested` | ✓ | hold upsert |
| **hold** | `check_in`, `check_out`, `guest_count`, `package_code` | ✓ | hold upsert |
| **hold** | `hold_expires_at = NOW() + interval '1 hour'` | ✓ | hold upsert (already present) |
| **hold** | `guest_name`, `email` | optional at hold; required at payment_pending | hold upsert when provided |
| **hold** | `primary_room_code`, `requested_room_type`, `room_preference` | optional | hold upsert when available |
| **hold** | `airtable_record_id` | bridge only — not required for PG-primary path | backfill (deferred) |
| **payment_pending** | `status=payment_pending`, `payment_status=waiting_payment` | ✓ | ensure promote |
| **payment_pending** | `guest_name`, `email` (required for Stripe) | ✓ | ensure promote |
| **payment_pending** | `hold_expires_at`, `assignment_status`, `availability_check_status` | should-have | ensure promote (gap to fix) |
| **conversation FK** | `conversations.current_hold_booking_id` → `bookings.id` | ✓ once booking is real | conversation hold upsert |

Fields tracked in session_state (not bookings, should be):

- `current_hold_booking_code` — already in session_state
- `hold_expires_at` — NOT currently surfaced in session_state

### 5.2.5 Staff query requirements (must be answerable from PG after Stage 5.2)

```sql
-- Who has active holds right now?
SELECT booking_code, phone, check_in, check_out, guest_count, package_code, hold_expires_at
FROM bookings WHERE client_id = ? AND status = 'hold' AND hold_expires_at > NOW();

-- Which holds are expired/stuck?
SELECT booking_code, phone, check_in, hold_expires_at, payment_status
FROM bookings WHERE client_id = ? AND status = 'hold' AND hold_expires_at < NOW();

-- Who is payment_pending?
SELECT booking_code, phone, check_in, guest_count, package_code
FROM bookings WHERE client_id = ? AND status = 'payment_pending';

-- Which holds have no payment record?
SELECT b.booking_code, b.phone, b.check_in
FROM bookings b
LEFT JOIN payments p ON p.booking_id = b.id
WHERE b.client_id = ? AND b.status IN ('hold','payment_pending') AND p.id IS NULL;
```

All four queries work against `001_init.sql` schema today **once real booking rows exist**. The gap is that dry-run stubs prevent any real rows from being created during test runs.

### 5.2.6 Implementation slices

#### 5.2a — Schema audit (static, no DB changes)
- Verify `bookings` has all required columns for the state contract above (it does — `hold_expires_at`, status/payment_status enums, `package_code`, `primary_room_code`, `room_preference`, `airtable_record_id`).
- Identify any missing: `confirmation_sent_at` (added in 006), `assignment_status`, `availability_check_status` — confirm all present.
- Confirm ensure-promote insert gap: `hold_expires_at` / `assignment_status` / `availability_check_status` not set on INSERT path.
- Document: no schema migration needed for 5.2a.

#### 5.2b — Decouple AT mirror from PG hold success gate (STATIC DONE 2026-05-30 — runtime pending)
- `Code - Summarize Holds` jsCode updated: `pgHold.booking_code` is now **first** in the `bookingCode` priority chain; `atHold.fields['Booking ID']` is fallback only. Also added `booking_id`, `hold_expires_at`, `dry_run`, `pg_hold_ok` to output. AT fields kept for room data fallback.
- New verifier `verifySummarizeHoldsPGPrimary(workflow)` (7 checks) wired into `runVerifyTargets`.
- Static checks: `--verify-targets` `Summarize Holds PG-primary verify (Stage 5.2b): OK`, payment/rooming contracts OK, active=false.
- AT mirror nodes (`Create Booking Hold`, `Backfill AT rec id`) kept in place; full AT branch decoupling deferred to 5.2d fixture runtime gate.
- `Code - Summarize Holds`: patch to prefer `PG booking_code` over AT Booking ID field, so payment path works when AT mirror is not run.
- `IF - PG Conversation OK` → `IF - DRY RUN? (Create Booking Hold)`: make AT mirror path a **soft branch** (alwaysOutputData=true) so hold success is not gated on AT record existing.
- `Postgres - Backfill Booking AT Record Id`: keep as optional bridge, not in critical success path.
- Static verifier: payment path can reach Stripe CPS using PG booking_code without AT rec id.

#### 5.2c — Patch ensure-promote insert defaults (STATIC DONE 2026-05-30 — runtime pending)
- `scripts/lib/main-ensure-booking-pg-sql.js`: ensure-promote INSERT path now sets `hold_expires_at = NOW() + interval '1 hour'`, `assignment_status = 'unassigned'`, `availability_check_status = 'available'`.
- New verifier `verifyEnsurePromoteInsertDefaults(workflow)` (7 checks) wired into `runVerifyTargets`; confirms protected tables (`payments`, `payment_events`, `booking_beds`) not referenced.
- Static checks: `--verify-targets` `Ensure promote INSERT defaults verify (Stage 5.2c): OK`, payment/rooming contracts OK, active=false.
- No schema migration required.

#### 5.2d — Fixture-scoped dry-run hold gate (runtime)
- Define a fixture dry-run gate that allows **real** `Postgres - Create Booking Hold` to fire for test booking codes (e.g. `DRY-52-…`) on isolated test phones.
- Proof: real `bookings` row created in PG; `bookings` count increments by 1 for test phone; `booking_beds` unchanged (assignment not triggered); conversation FK set.
- Cleanup: DELETE test booking row by `booking_code LIKE 'DRY-52-%'`.
- Constraint: `WHATSAPP_DRY_RUN=true`; no Stripe CPS fired; no AT writes.

#### 5.2e — Expired/stuck hold query (STATIC DONE 2026-05-30 — not runtime tested)

New module `scripts/lib/staff-booking-hold-queries.js` exports four read-only SQL helpers:

| Query | Function | What it answers |
|-------|----------|-----------------|
| A — Active holds | `getActiveHoldsQuery()` | `status='hold'` AND `hold_expires_at > NOW()`, ordered soonest-to-expire |
| B — Expired/stuck holds | `getExpiredHoldsQuery()` | `status='hold'` AND `hold_expires_at < NOW()`, includes `expired_minutes_ago` |
| C — payment_pending | `getPaymentPendingQuery()` | `status='payment_pending'` AND payment not complete |
| D — No payment record | `getNoPaymentRecordQuery()` | `status IN (hold, payment_pending)` LEFT JOIN `payments` WHERE no paid row |

All queries are parameterised by `$1 = client slug`, SELECT-only, reference `bookings`/`payments` (D). Verifier `scripts/verify-staff-booking-hold-queries.js` checks all four exports, client-scope, SELECT-only, no mutation keywords, `bookings` reference, `payments` reference for D. Verifier: 4/4 OK.

**Groundwork for Stage 6 staff assistant**: these queries answer the pilot-readiness questions defined in §5.2.5 once real booking rows exist (Stage 5.2d).

#### 5.2f — Pilot readiness gate
- Smoke test: create one hold (fixture), run ensure-promote, run stuck-hold query, confirm session_state has correct fields, cleanup.
- Written gate checklist (extends the Stage 4 gate discipline).

### 5.2.7 Safety rules (same discipline as Stage 5.1)
- `bookings` write is gated behind `IF - DRY RUN?` in all run modes.
- `payments`, `payment_events` remain write-protected (Stripe webhook is the only writer).
- `booking_beds` write is gated; no assignment in Stage 5.2.
- Test phones use `DRY-52-…` booking codes only.
- Cleanup SQL removes test rows by `booking_code` prefix.
- Protected count gates: bookings Δ=+1 exactly for test run, then Δ=0 after cleanup.

### 5.2.8 Recommended implementation order

| Step | Slice | Risk | Needs runtime |
|------|-------|------|---------------|
| 1 | 5.2a schema audit | Zero — read-only | No |
| 2 | 5.2b AT decoupling patch | Low — static wiring change | No |
| 3 | 5.2c ensure-promote insert defaults | Low — SQL only | No |
| 4 | 5.2e stuck-hold query | Zero — SQL only | No |
| 5 | 5.2d fixture dry-run hold gate | Medium — first real bookings write | Yes |
| 6 | 5.2f pilot readiness gate | Low — smoke test after 5.2d | Yes |

Steps 1–3 + 5.2e can be done in a single static implementation session. 5.2d requires a runtime gate similar to the Stage 5.1 conversation gates.
