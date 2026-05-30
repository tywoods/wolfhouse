# Stage 5 — Targeted Source-of-Truth Cleanup (Planning)

**Status:** **In progress** — Stage 5.1 PASS; Stage 5.2 **CLOSE WITH DEFERRALS** (`6306846`); Stage 5.3 next (2026-05-30)  
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

## Stage 5.2 — Bookings/Holds Source-of-Truth Cleanup (**CLOSE WITH DEFERRALS** 2026-05-30 — commit `6306846`)

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

#### 5.2d — Fixture-scoped dry-run hold gate (**RUNTIME PASS 2026-05-30** — exec 1230)

Fixture scenario: phone `+34600000152`, booking_code `WH-260530-8226` (WH- prefix, since `Code - Prepare Hold Records` always generates WH- format), check-in 2026-06-01, package malibu/shared.

**Guard design (Option B, revised):** Two-condition guard (booking_code prefix check removed — `Code - Prepare Hold Records` always generates `WH-YYMMDD-XXXX` format, not `DRY-52-`):
1. `STAGE52_FIXTURE_HOLD=true` (explicit opt-in env var — absent = normal stub behaviour)
2. `phone` in `['34600000152', '+34600000152']`

Both `n8n-main` and `n8n-worker` containers must have `STAGE52_FIXTURE_HOLD=true` (workers execute the queue; main only registers webhooks).

**Runtime proof (exec 1230):**
- `IF - DRY RUN? (Postgres - Create Booking Hold)` → TRUE (WHATSAPP_DRY_RUN) → stub
- `Code - DRY RUN Stub (Postgres - Create Booking Hold)` executed
- `IF - Stage52 Fixture?` evaluated TRUE (STAGE52_FIXTURE_HOLD=true + fixture phone)
- **Real `Postgres - Create Booking Hold` executed**
- `booking_code=WH-260530-8226`, `status=hold`, `hold_expires_at` set, `assignment_status=unassigned`, `availability_check_status=available`
- `conversations.current_hold_booking_id` = real booking UUID
- `Postgres - Upsert Conversation Hold` pg_ok=true, booking_id linked
- bookings: 41→42 (+1), payments/payment_events/booking_beds Δ=0

**Staff query proof (pre-cleanup):**
- Query A (active holds): 1 fixture row found ✓
- Query B (expired): 0 ✓
- Query C (payment_pending): 0 ✓
- Query D (no payment): 1 fixture row found ✓

**Cleanup proof:** `scripts/fixtures/stage5.2d-cleanup.sql` (updated to scope by phone, not DRY-52- prefix). bookings=41 restored, conversations=0 for fixture phone.

**Bugs fixed during gate:**
1. `IF - Stage52 Fixture?` TRUE branch was routing to `Code - Validate PG Hold` (real node's successor) instead of `Postgres - Create Booking Hold` itself — fixed in `applyStage52FixtureHoldGuard`.
2. Cleanup SQL scoped to `DRY-52-%` prefix but booking codes are `WH-` format — updated to scope by fixture phone.
3. `staff-booking-hold-queries.js` `getNoPaymentRecordQuery` referenced `p.amount_cents` (not in schema) — fixed to `p.amount_due_cents`.
4. Proof runner `verify-stage52d-hold-proof.js` filtered by `DRY-52-` prefix — updated to also match by fixture phone.

**Verifier:** `verifyStage52FixtureGuard(workflow)` updated to assert TRUE branch points to real `Postgres - Create Booking Hold` node (not its successor). Passes as `Stage52 fixture hold guard verify (Stage 5.2d): OK`.

**Cleanup SQL:** `scripts/fixtures/stage5.2d-cleanup.sql` — transaction-safe, scoped to wolfhouse-somo + fixture phone. Unlinks conversation FK, deletes fixture booking, deletes fixture conversation.

**Query proof runner:** `scripts/verify-stage52d-hold-proof.js` — updated to filter by fixture phone + DRY-52- prefix. Safe to run before/after gate.
- A1/A3/A4 use `DRY-STAGE4-*` booking codes; mixing with a real hold write would conflate Stage 4 dry-run stubs with Stage 5.2 first-real-write evidence.
- A dedicated scenario uses `DRY-52-*` booking codes and a reserved fake phone, making cleanup unambiguous.
- Scenario is a single-turn hold creation only (no Stripe CPS, no payment path), minimising surface area for first real write.

**Fixture parameters:**
```
phone:         34600000152   (fake test phone, reserved for Stage 5.2d)
booking_code:  DRY-52-20260601  (deterministic; check_in date suffix)
check_in:      2026-06-01
check_out:     2026-06-08
guest_count:   1
package_code:  malibu
requested_room_type: shared
client_slug:   wolfhouse-somo
```

##### Un-gate design

The current `IF - DRY RUN? (Postgres - Create Booking Hold)` gate fires when `WHATSAPP_DRY_RUN=true`, routing to the stub. Stage 5.2d needs a **secondary guard** inside the stub (or a second IF layer) that passes through to the real node only when all fixture conditions are met:

```
IF - DRY RUN? (Postgres - Create Booking Hold)
  TRUE (dry-run env) →
    Code - DRY RUN Stub (Postgres - Create Booking Hold)  [modified for 5.2d]
      IF env.STAGE52_FIXTURE_HOLD=true AND booking_code starts with 'DRY-52-' AND phone in fixture list:
        → pass to Postgres - Create Booking Hold (real node)
      ELSE:
        → return stub output (current behaviour, unchanged)
  FALSE (live) →
    Postgres - Create Booking Hold (real node)
```

Alternatively — and simpler — the stub can check the env flag and output a special `fixture_passthrough: true` marker, and a new downstream IF routes to the real node when that marker is set. The cleanest approach is:

**Option B (preferred):** Add a second `IF - Stage52 Fixture?` node on the stub TRUE branch. When `STAGE52_FIXTURE_HOLD=true`, route to real node. The real node's output is already shaped correctly. This preserves Stage 4 dry-run behaviour exactly when `STAGE52_FIXTURE_HOLD` is absent.

Guard requirements (all must be true to pass through):
1. `WHATSAPP_DRY_RUN=true` — still required; no live-mode holds allowed
2. `STAGE52_FIXTURE_HOLD=true` — explicit opt-in env var
3. booking_code starts with `DRY-52-` — enforced in guard expression (read from `Code - Prepare Hold Records`)
4. phone in `['34600000152', '+34600000152']` — enforced in guard expression
5. client_slug = `wolfhouse-somo` — enforced by SQL itself

##### Allowed mutations for 5.2d gate

| Table | Allowed | Notes |
|-------|---------|-------|
| `bookings` | Δ=+1 (fixture row only) | `booking_code LIKE 'DRY-52-%'`, test phone |
| `conversations` | Δ=0 or +1 update | FK `current_hold_booking_id` set to real `bookings.id` |
| `payments` | Δ=0 | Stripe CPS must not run |
| `payment_events` | Δ=0 | |
| `booking_beds` | Δ=0 | No assignment step |
| Airtable | 0 writes | AT mirror stubs remain active |
| WhatsApp | dry-run only | No real send |

##### Cleanup SQL

```sql
-- Stage 5.2d fixture cleanup
-- Run after gate completes (pass or fail)
BEGIN;

-- 1. Unlink conversations from fixture booking
UPDATE conversations
SET current_hold_booking_id = NULL, updated_at = NOW()
WHERE phone IN ('34600000152', '+34600000152')
  AND current_hold_booking_id IN (
    SELECT id FROM bookings
    WHERE booking_code LIKE 'DRY-52-%'
    AND phone IN ('34600000152', '+34600000152')
  );

-- 2. Delete fixture bookings row
DELETE FROM bookings
WHERE booking_code LIKE 'DRY-52-%'
  AND phone IN ('34600000152', '+34600000152')
  AND client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo');

-- 3. Delete fixture conversation rows
DELETE FROM conversations
WHERE phone IN ('34600000152', '+34600000152')
  AND client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo');

COMMIT;
```

Post-cleanup verification:
```sql
SELECT COUNT(*) FROM bookings WHERE booking_code LIKE 'DRY-52-%';              -- expect 0
SELECT COUNT(*) FROM conversations WHERE phone IN ('34600000152', '+34600000152'); -- expect 0
```

##### Staff query proof

After the fixture hold write (before cleanup), the staff queries should return:

| Query | Expected |
|-------|----------|
| A — `getActiveHoldsQuery()` | Returns fixture row: `booking_code=DRY-52-20260601`, `hold_expires_at > NOW()` |
| B — `getExpiredHoldsQuery()` | Returns 0 rows (hold is not yet expired) |
| C — `getPaymentPendingQuery()` | Returns 0 rows (status=hold, not payment_pending) |
| D — `getNoPaymentRecordQuery()` | Returns fixture row (hold, no payment record) |

##### Pass/fail criteria

**PASS** requires all of:
- `Postgres - Create Booking Hold` real node executes (not stub)
- `bookings` Δ=+1 during test; `booking_code` starts with `DRY-52-`
- `hold_expires_at` is set (≈ NOW() + 1 hour)
- `assignment_status = 'unassigned'`, `availability_check_status = 'available'`
- `conversations.current_hold_booking_id` set to real `bookings.id`
- Staff query A returns fixture row; query B returns 0; query D returns fixture row
- `payments` Δ=0, `payment_events` Δ=0, `booking_beds` Δ=0
- No Airtable writes (AT nodes stubbed)
- `WHATSAPP_DRY_RUN=true` (no real WhatsApp)
- Cleanup restores both fixture `bookings` and `conversations` rows to 0

**PARTIAL** if:
- Hold row created but `current_hold_booking_id` not linked in conversation
- Hold row created but `hold_expires_at` not set (ensure-promote INSERT defaults gap)

**FAIL** if:
- Real node runs but `pg_ok=false` or DB error
- Any protected table mutated
- AT mirror write occurs
- Real WhatsApp send occurs

##### Static implementation slices (for next session)

| Slice | File | Notes |
|-------|------|-------|
| Fixture guard node | `scripts/build-main-local-stripe.js` | `applyStage52FixtureHoldGuard(workflow)` — adds `IF - Stage52 Fixture?` after stub gate |
| Fixture env check | `IF - Stage52 Fixture?` expression | `STAGE52_FIXTURE_HOLD === 'true'` AND `booking_code starts with DRY-52-` |
| Cleanup SQL | `scripts/fixtures/stage5.2d-cleanup.sql` | New fixture SQL |
| Query proof runner | `scripts/verify-stage52d-hold-proof.js` | Runs four staff queries after gate, prints table |
| Docs updates | `PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md` | Mark static done when implemented |
| Runtime gate | runner or ad-hoc | Must set `STAGE52_FIXTURE_HOLD=true` explicitly |

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

### 5.2.9 Closeout review (2026-05-30 — HEAD `6306846`)

**Recommendation: Stage 5.2 CLOSE WITH DEFERRALS.** Core bookings/holds source-of-truth objectives are proven under controlled fixture conditions. Live guest holds, Airtable mirror removal, and full pilot readiness remain deferred.

#### Closeout matrix

| Slice | Status | Proof | Remaining caveat / deferral |
|-------|--------|-------|----------------------------|
| **5.2a** Schema audit / planning | **DONE (planning)** | §5.2.3–5.2.4 gap analysis; `001_init.sql` has required columns; no migration needed | Formal standalone audit commit not required; audit absorbed into 5.2 planning |
| **5.2b** Summarize Holds PG-primary | **STATIC PASS** | `verifySummarizeHoldsPGPrimary`; runtime exercised on hold path in exec 1230 | Airtable mirror nodes still present as fallback; not removed |
| **5.2c** ensure-promote INSERT defaults | **STATIC PASS** | `verifyEnsurePromoteInsertDefaults`; INSERT includes `hold_expires_at`, `assignment_status`, `availability_check_status` | ensure-promote **live** path not runtime-proven in 5.2d (hold-only fixture) |
| **5.2d** Fixture real hold write | **RUNTIME PASS** | Exec 1230: real `Postgres - Create Booking Hold` under `STAGE52_FIXTURE_HOLD`; booking `WH-260530-8226`; FK linked; bookings Δ=+1 then cleanup restored; protected Δ=0 | Guard uses env flag + fixture phone (not `DRY-52-` prefix — booking codes are `WH-*`); only fixture phone `34600000152` |
| **5.2e** Staff query helpers | **STATIC PASS + runtime smoke** | Four queries in `staff-booking-hold-queries.js`; verifier OK; `verify-stage52d-hold-proof.js` found fixture in Query A + D pre-cleanup, 0 post-cleanup | Queries not yet wired into staff UI (Stage 6); `hold_expires_at` not yet in session_state |
| **5.2f** Pilot readiness gate | **DEFERRED** | Checklist defined in §5.2f only | Full smoke (hold → ensure-promote → stuck-hold query → session_state audit) not run; defer to Stage 5.3 / pre-pilot gate |

#### Stage 5.2 exit criteria

| Criterion | Met? |
|-----------|------|
| PG hold result drives hold summary without requiring Airtable Booking ID | ✓ (5.2b static + 5.2d runtime hold path) |
| ensure-promote rows include hold/status defaults on INSERT | ✓ (5.2c static) |
| Controlled fixture real booking row write proven | ✓ (5.2d exec 1230) |
| Staff queries identify active hold and no-payment hold | ✓ (5.2e + 5.2d query proof) |
| Fixture cleanup restores baseline | ✓ (bookings=41, fixture conversations=0) |
| Protected payment/rooming tables unchanged | ✓ (payments/payment_events/booking_beds Δ=0) |
| Live holds still not approved | ✓ (`STAGE52_FIXTURE_HOLD` defaults false; `WHATSAPP_DRY_RUN=true` required) |

#### Deferrals (explicit)

- Real guest holds remain gated/unapproved — only fixture phone under explicit env flag
- Airtable mirror (`Create Booking Hold`, `Backfill AT Record Id`) still on workflow as fallback/bridge
- Full Airtable removal deferred to Stage 6 cutover / later Stage 5 slice
- ensure-promote and payment_pending **live** path proof deferred to **Stage 5.3**
- `hold_expires_at` in conversation session_state deferred (minor)
- Staff UI / staff assistant deferred to **Stage 6**
- Multi-client productization deferred to **Stage 7**
- **5.2f** pilot readiness smoke gate not complete — acceptable deferral; core hold SoT proven

#### Next recommended slice

**Stage 5.3 — Payments + balances source-of-truth cleanup** (see workstream §2 row 3): align `payments` / `payment_events` / `bookings.payment_status` with webhook truth; define `payment_balances` view; prove ensure-promote fixture path under dry-run guard.

---

## Stage 5.3 — Payments + Balances Source-of-Truth Cleanup (PLANNING 2026-05-30)

### Objective

Make `payments`, `payment_events`, and `bookings.payment_status` the authoritative, queryable record of payment state for the Wolfhouse pilot. Ensure staff can answer "who paid?", "who owes a balance?", and "which bookings need confirmation?" directly from Postgres — without Airtable, without live Stripe, and without reading WhatsApp logs.

### 5.3.1 Current payment path (traced from Main → Stripe Webhook → Send Confirmation)

```
Guest → payment_or_confirm_intent → holds_created + guest details provided
  → IF - Use Stripe Checkout (env USE_STRIPE_CHECKOUT=true)
    → Postgres - Ensure Booking In Postgres         [hold→payment_pending in DB]
         dry-run gate: IF - DRY RUN? (Postgres - Ensure Booking In Postgres)
         TRUE (dry-run) → Code - Stub (no DB write, returns booking_id="dry-run-ensure-fallback")
         FALSE (live)   → buildEnsurePromoteN8nSql() CTE:
                            UPDATE bookings SET status='payment_pending',
                              payment_status='waiting_payment'
                            OR INSERT new payment_pending row
    → IF - Booking ID Ready (booking_id NOT like 'dry-run-%')
    → Code - Call Create Payment Session
         dry-run inline branch: WHATSAPP_DRY_RUN=true → stub checkout_url
         live branch: POST to CPS workflow → creates payments row + Stripe checkout session
    → Send payment link to guest (via WhatsApp, dry-run gated)

Stripe → checkout.session.completed → Stripe Webhook Handler
  → Code - Verify Signature  (STRIPE_WEBHOOK_SKIP_VERIFY=true allowed locally)
  → Code - Parse Stripe Event  (checkout.session.completed only; needs metadata.booking_id)
  → Postgres - Apply Payment Success (single CTE):
       INSERT payment_events ON CONFLICT (stripe_event_id) DO NOTHING   ← idempotent
       UPDATE payments SET status='paid', amount_paid_cents, paid_at
       UPDATE bookings SET payment_status=('deposit_paid'|'paid'),
                           deposit_paid_cents, amount_paid_cents, balance_due_cents,
                           send_confirmation=TRUE
  → IF - New Payment Row? (idempotency gate — duplicate event → 200 acknowledged, no update)
  → Respond (processed or duplicate)

Send Confirmation workflow
  → Trigger: Schedule poll (3 min) OR Webhook /send-confirmation-local
  → Postgres: SELECT bookings WHERE
       send_confirmation=TRUE AND status='payment_pending'
       AND payment_status IN ('deposit_paid','paid')
       AND confirmation_sent_at IS NULL
  → LLM draft → Code - Send WhatsApp (WHATSAPP_DRY_RUN=true → stub)
  → IF - DRY RUN? (Mark Confirmed)
       TRUE  → stub (no DB write)
       FALSE → UPDATE bookings SET status='confirmed', send_confirmation=FALSE,
                  confirmation_sent_at=NOW()
```

**What is stubbed/gated in dry-run today:**

| Node | Gate | Stub behaviour |
|------|------|---------------|
| `Postgres - Ensure Booking In Postgres` | `IF - DRY RUN?` | Returns `booking_id="dry-run-ensure-fallback"`, no DB write |
| `Code - Call Create Payment Session` | Inline `WHATSAPP_DRY_RUN` | Returns stub `checkout_url`, no `payments` row created |
| Stripe Webhook Verify | `STRIPE_WEBHOOK_SKIP_VERIFY=true` | Bypasses HMAC; allows local replay |
| `Postgres - Apply Payment Success` | Not gated — requires real `payments` row | Event INSERT fails if no matching `payments` row for session_id |
| `Postgres - Mark Booking Confirmed` | `IF - DRY RUN? (Mark Confirmed)` | Stub return, no DB write |
| WhatsApp sends | Per-node `IF - DRY RUN?` | All 16 WA send nodes stubbed |

### 5.3.2 Stage 5.3 objective

Postgres is the authoritative payment ledger for the Wolfhouse pilot. Staff can answer each of the following directly from Postgres without Airtable or Stripe dashboard access:

| Staff question | Source table / field |
|---------------|---------------------|
| Who paid deposit? | `bookings.payment_status='deposit_paid'` |
| Who paid in full? | `bookings.payment_status='paid'` |
| Who still owes balance? | `balance_due_cents > 0 AND payment_status='deposit_paid'` |
| Who has payment_pending with no payment row? | `bookings.status='payment_pending'` LEFT JOIN `payments` WHERE none |
| Which paid bookings need confirmation? | `send_confirmation=TRUE AND confirmation_sent_at IS NULL` |
| Which bookings have a `payments` record vs not? | JOIN query |
| What is the payment timeline for booking X? | `payment_events WHERE booking_id=X` |

### 5.3.3 Payment/balance state contract

Fields that must be reliable at each stage:

| Stage | Field | Must-have | Writer |
|-------|-------|-----------|--------|
| **payment_pending** | `status`, `payment_status=waiting_payment` | ✓ | Ensure promote |
| **payment_pending** | `total_amount_cents`, `deposit_required_cents` | ✓ | CPS / config — currently NULL on stub path |
| **payment_pending** | `hold_expires_at`, `assignment_status`, `availability_check_status` | ✓ | Ensure INSERT (5.2c done) |
| **payment row created** | `payments.status=checkout_created`, `amount_due_cents`, `stripe_checkout_session_id` | ✓ | CPS workflow |
| **payment paid** | `payments.status=paid`, `amount_paid_cents`, `paid_at` | ✓ | Stripe webhook |
| **payment paid** | `bookings.payment_status` (`deposit_paid`\|`paid`) | ✓ | Stripe webhook |
| **payment paid** | `bookings.amount_paid_cents`, `balance_due_cents`, `deposit_paid_cents` | ✓ | Stripe webhook |
| **payment paid** | `bookings.send_confirmation=TRUE` | ✓ | Stripe webhook |
| **payment event** | `payment_events` row; `processed=TRUE`; idempotent on `stripe_event_id` | ✓ | Stripe webhook |
| **confirmed** | `bookings.status=confirmed`, `confirmation_sent_at` | ✓ | Send Confirmation |

**`payment_balances` view (to define):** Computed view joining `bookings` + `payments` + `payment_events` to expose balance-due, deposit-paid, and overpayment/duplicate detection for staff queries.

### 5.3.4 Gaps vs Stage 5.3 objective

| Gap | Impact | Fix scope |
|-----|--------|-----------|
| `payment_balances` view not defined | Staff cannot query "who owes?" in one query | 5.3b — SQL helper |
| `total_amount_cents`, `deposit_required_cents` NULL on ensure insert | Balance-due calculation unreliable until CPS fires | 5.3a/5.3d — must be sourced from config/CPS result |
| Ensure-promote **live** path not runtime-proven | `bookings.status` transition hold→payment_pending never run under test | 5.3d fixture gate |
| No `payments` row exists in dry-run (CPS stub skips creation) | Stripe webhook replay requires a `payments` row with matching `stripe_checkout_session_id` | 5.3d — fixture must INSERT payments row as part of setup SQL, or use existing Stage 4 gate 3 pattern |
| `Postgres - Apply Payment Success` not dry-run gated | A fixture-replayed webhook will write to `payments`/`payment_events`/`bookings` unconditionally | 5.3e — acceptable under fixture scope; must be scoped by fixture booking_id only |
| No staff payment query helpers | Cannot answer who paid / who owes from a script | 5.3c — new module |
| `send_confirmation` / `confirmation_sent_at` confirmation-needed query not a named helper | Confirmation backlog invisible to staff | 5.3f |
| Hold stub returns `payment_status: 'unpaid'` (not a valid enum) | Potential mismatch in query filters | Known non-issue (stub only; never hits DB) |
| `booking_code` uniqueness on ensure INSERT | If fixture hold (5.2d) created `WH-260530-XXXX` and cleanup ran, ensure can INSERT same code — fine; but code must not collide with live rows | 5.3d fixture must use reserved prefix |

### 5.3.5 Implementation slices

#### 5.3a — Schema/status audit (static, no DB changes) — DONE 2026-05-30

- Verify `bookings` columns for payment aggregates: `total_amount_cents`, `deposit_required_cents`, `deposit_paid_cents`, `amount_paid_cents`, `balance_due_cents` all present.
- Verify `payments` post-004 columns: `amount_due_cents`, `amount_paid_cents`, `payment_kind`.
- Confirm `payment_events.stripe_event_id` UNIQUE constraint (idempotency anchor).
- Note gap: `deposit_required_cents` / `total_amount_cents` not set on ensure INSERT — must come from CPS response (acceptable; document explicitly).
- No migration needed. Document: no 5.3 schema migration required.

#### 5.3b — `payment_balances` SQL helper/view (STATIC DONE 2026-05-30 — not runtime tested)

New module `scripts/lib/payment-balances-query.js` (or inline SQL helper) defining the staff balance view:

```sql
-- payment_balances (logical view — not a DB object yet; materialized as a function/query)
SELECT
  b.id::text          AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.package_code,
  b.check_in, b.check_out,
  b.status::text,
  b.payment_status::text,
  b.total_amount_cents,
  b.deposit_required_cents,
  b.amount_paid_cents,
  b.balance_due_cents,
  b.deposit_paid_cents,
  b.send_confirmation,
  b.confirmation_sent_at,
  p.id::text          AS payment_id,
  p.status::text      AS payment_record_status,
  p.payment_kind::text,
  p.amount_due_cents  AS payment_amount_due_cents,
  p.amount_paid_cents AS payment_amount_paid_cents,
  p.stripe_checkout_session_id,
  p.paid_at,
  (SELECT COUNT(*) FROM payment_events pe WHERE pe.booking_id = b.id) AS payment_event_count
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN payments p  ON p.booking_id = b.id
WHERE c.slug = $1
  AND b.status IN ('payment_pending','confirmed')
ORDER BY b.updated_at DESC;
```

Add static verifier: SELECT-only, references `bookings` + `payments` + `payment_events`, parameterised by `$1`.

#### 5.3c — Staff payment query helpers (STATIC DONE 2026-05-30 — not runtime tested)

New module `scripts/lib/staff-payment-queries.js` exports six read-only helpers:

| Function | What it answers |
|----------|-----------------|
| `getDepositPaidQuery()` | Who paid deposit but still owes balance? (`payment_status='deposit_paid'`) |
| `getFullyPaidQuery()` | Who paid in full? (`payment_status='paid'`) |
| `getBalanceDueQuery()` | Who owes remaining balance? (`deposit_paid` + `balance_due_cents > 0`; computed fallback included) |
| `getNoPaymentRecordQuery()` | `payment_pending` bookings with no `payments` row (CPS never ran) — proxy for "no link sent" |
| `getWaitingPaymentQuery()` | `payment_pending` + `waiting_payment` — link sent, Stripe not yet confirmed |
| `getConfirmationNeededQuery()` | `send_confirmation=TRUE` + `confirmation_sent_at IS NULL` + `deposit_paid`/`paid` |

All: SELECT-only, `$1` = client slug, `LEFT JOIN payments`, no mutation keywords.

**TODO (claimed-paid/no-record):** A query for "guest claimed they paid but no record exists" requires a claim marker (`conversations.metadata` or `staff_handoffs.reason='payment_claimed'`). Neither exists in the current schema. `getNoPaymentRecordQuery()` is the safe proxy until `staff_handoffs` is available in Stage 5.7. Documented inline in `staff-payment-queries.js`.

Verifier: `scripts/verify-staff-payment-queries.js` — checks all 7 exports (1 balance + 6 payment), SELECT-only, client-scoped, `bookings` reference, `payments` reference for applicable queries. All 7/7 OK.

#### 5.3d — Fixture ensure-promote + payment session proof (runtime gate)

Runtime gate proving the full live hold→payment_pending→payments-row path under controlled fixture guard.

**Fixture:**
- `STAGE53_FIXTURE_PAYMENT=true` env flag (analogous to `STAGE52_FIXTURE_HOLD`)
- fixture booking_code prefix: `WH-53-` (reserved, cleaned by cleanup SQL)
- fixture phone: `34600000153` (new reserved phone)
- Approach: reuse/extend `IF - Stage52 Fixture?` pattern or add new `IF - Stage53 Fixture?` node before `Postgres - Ensure Booking In Postgres` stub

**Allowed mutations:**
- `bookings` Δ=+1 (hold → payment_pending promote, or new insert) ← reverted after cleanup
- `payments` Δ=+1 (CPS creates row) ← reverted after cleanup
- `payment_events` Δ=0 (no Stripe webhook in this sub-gate)
- `booking_beds` Δ=0

**Proof:** `bookings.status=payment_pending`, `payment_status=waiting_payment`, `payments.status=checkout_created`, `amount_due_cents` set from stub CPS response.

#### 5.3e — Stripe webhook fixture replay proof (runtime gate)

Extends Stage 4 gate 3 pattern. Uses `STRIPE_WEBHOOK_SKIP_VERIFY=true` with a prepared fixture.

**Fixture:** Pre-insert `bookings` (payment_pending) + `payments` (checkout_created) rows for fixture phone; simulated `checkout.session.completed` payload with matching `stripe_checkout_session_id`.

**Proof:**
- `payment_events` Δ=+1, `stripe_event_id` unique, `processed=TRUE`
- `payments.status=paid`, `amount_paid_cents` set
- `bookings.payment_status=deposit_paid` (or `paid`)
- `bookings.send_confirmation=TRUE`
- Replay same event → `IF - New Payment Row?` FALSE → duplicate acknowledged (idempotency proof)

**Cleanup:** DELETE fixture `payment_events`, `payments`, `bookings` rows for fixture phone.

#### 5.3f — Confirmation-needed query proof (static + runtime smoke)

Static: `getConfirmationNeededQuery()` returns the correct eligibility set.
Runtime smoke: after 5.3e gate, run query to confirm fixture booking appears in confirmation-needed list; run cleanup; confirm query returns 0.

#### 5.3g — Payment/staff smoke gate (runtime, after 5.3d–5.3f)

Combined sanity check using `scripts/verify-stage53-payment-proof.js`:

- Run all `staff-payment-queries.js` helpers against wolfhouse-somo
- Print fixture rows in each result bucket
- Verify balance_due / amount_paid computations against known fixture values
- Confirm cleanup restores baseline

### 5.3.6 Proof criteria

| Criterion | Gate |
|-----------|------|
| Fixture booking moves hold→payment_pending with `waiting_payment` | 5.3d |
| `payments` row created with `amount_due_cents` and `stripe_checkout_session_id` | 5.3d |
| Stripe webhook sets `payment_status=deposit_paid`, `send_confirmation=TRUE` | 5.3e |
| `payment_events` idempotent (duplicate event → acknowledged, no extra row) | 5.3e |
| `balance_due_cents` computed correctly after partial payment | 5.3e |
| `getConfirmationNeededQuery()` returns fixture before cleanup, 0 after | 5.3f |
| `payment_balances` view returns correct balance for fixture | 5.3g |
| `booking_beds` unchanged throughout all gates | 5.3d–5.3g |
| No real Stripe, no real WhatsApp | All gates |
| Cleanup restores `bookings`, `payments`, `payment_events` baseline | All gates |

### 5.3.7 Deferrals

- Live Stripe checkout (real guest payments, real `checkout.session.completed`)
- Refunds / voucher automation
- Add-on payment records → Stage 5.5–5.6
- Multi-currency / multi-Stripe-account → Stage 7
- Staff UI / payment dashboard → Stage 6
- Multi-client payment config → Stage 7
- Balance-due automated follow-up / retry → future automation
- Full `payment_balances` as a DB VIEW (migration) — plan as SQL helper first; promote to VIEW in Stage 6 if needed

### 5.3.8 Recommended implementation order

| Step | Slice | Risk | Needs runtime |
|------|-------|------|---------------|
| 1 | 5.3a schema audit | Zero | No |
| 2 | 5.3b payment_balances SQL helper | Zero | No |
| 3 | 5.3c staff payment query helpers | Zero | No |
| 4 | 5.3d fixture ensure-promote + payment session | Medium — first real ensure-promote + payments write | Yes |
| 5 | 5.3e Stripe webhook fixture replay | Medium — first real payment_events + payments.paid write | Yes |
| 6 | 5.3f confirmation-needed query proof | Low | Yes (smoke) |
| 7 | 5.3g payment/staff smoke gate | Low | Yes |
