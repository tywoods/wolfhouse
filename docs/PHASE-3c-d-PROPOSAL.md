# Phase 3c.d — Conversation / message / current-hold state (proposal)

**Status:** Discovery / plan only — **no implementation**, workflow JSON, Postgres writes, or commits until approved.  
**Parents:** [`PHASE-3c-PROPOSAL.md`](PHASE-3c-PROPOSAL.md) §2.7, §3c.d · [`PHASE-3c-c.md`](PHASE-3c-c.md) · [`PROJECT-STATE.md`](PROJECT-STATE.md) · [`CURSOR.md`](../CURSOR.md)

**Prerequisite (done):** 3c.c hold + Ensure Booking promote CLIs (`8abfd4d`) — `bookings` rows can exist in PG before any conversation wiring.

**Why before 3c.e:** Main workflow injection must know **where** `booking_id` / `booking_code` flow after PG hold create, how **Current Hold ID** is set, and how **Booking State Resolver** + router read active hold. Wiring hold SQL without this plan risks stale holds, wrong routes, and AT/PG disagreement.

---

## 1. Current Main state model (evidence)

Source: `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json`, `scripts/build-main-local-stripe.js` (2f resolver), `node scripts/build-main-local-stripe.js --inventory` (May 2026).

### 1.1 Inbound path (pre-router)

| Step | Node | Role |
|------|------|------|
| Normalize | `Normalize Incoming Message` | `phone`, `guest_message`, `whatsapp_message_id`, `source` |
| Persist inbound | `Create Inbound Message` | AT **Messages** create |
| Link | `Update Inbound Message - Link Conversation` | Sets conversation link on message |
| Lookup | `Search Conversation` | AT **Conversations** by `{Phone}=…` |
| Memory | `Search Messages - Recent Conversation` → `Code - Build Conversation Memory` | Last N AT messages → `conversation_memory` string for LLMs |
| Summary | `AI - Update Conversation Summary` → `Update Conversation Summary` | AT **Conversation Summary** |
| Append | `Update Conversation - Append Guest Message` | AT conversation patch |
| Create | `Create Conversation` / `IF Conversation Exists?` | First-time conversation |
| Active booking | `Code - Prepare Active Booking Search` → `Search Active Booking - Current Hold ID` + `Search Active Booking - Phone` → `Code - Pick Active Booking` | See §1.4 |
| Route | `Router - Classify Message` → `Code - Parse Route` → **`Code - Booking State Resolver`** → `Switch` on `resolved_route` |

**Session keys (early):** `Merge Session State` reads AT `Session State` JSON + AT **`Current Hold ID`**; merges `Parser Node` JSON into `session`; exposes `current_hold_id` in item json.

### 1.2 Airtable Conversations — operations (21 nodes in inventory)

| Operation | Example nodes | Typical `resolved_route` / timing |
|-----------|---------------|-----------------------------------|
| **search** | `Search Conversation` | Every inbound (pre-switch) |
| **create** | `Create Conversation` | Pre-switch, new phone |
| **update** | `Update Conversation Summary`, `Update Conversation - Append Guest Message`, `Update Conversation - Guest Details`, `Update Conversation - Human Handoff`, `Update Conversation - Unknown`, … | Pre-switch or branch |
| **upsert** | `Create or update Conversation`, `Create or update Conversation - Payment Details`, `Create/update Conversation - Payment Pending`, `Update Conversation After Reply`, route-specific upserts (modify/cancel/status/payment claim) | Per branch |

**Fields written/read (recurring in node mappings):**

| Airtable field | Usage |
|----------------|--------|
| **Phone** | Primary lookup key (`Search Conversation` formula) |
| **Session State** | JSON blob: dates, guest_count, room_type, `current_hold_id`, `active_booking_*`, intent, `needs_human`, etc. |
| **Current Hold ID** | **`booking_code`** string (`WH-YYMMDD-####`), **not** AT record id — set on hold/payment paths, e.g. `Create/update Conversation - Payment Pending` |
| **Conversation Stage** | Stage string: `booking_flow`, `payment_pending`, `existing_booking`, `existing_booking_modify`, … |
| **Pending Action** | e.g. `rooming_info_needed` — read by router + resolver |
| **Conversation Summary** | LLM-maintained text for prompts |
| **Last Bot Reply** | Fed to parser |
| **Language** | Guest language |
| **Bot Mode** / handoff | `Update Conversation - Human Handoff`, `needs_human` in session |
| **Guest display** | Name/email sometimes mirrored on conversation |

**Dual storage of hold identity:** Same hold is referenced as:

- AT column **`Current Hold ID`** (booking_code)
- **`Session State`** keys: `current_hold_id`, `hold_booking_id`, `booking_id`, `active_booking_id` (see `Code - Pick Active Booking`, `Merge Session State`, resolver)

### 1.3 Airtable Messages — operations (18 writes in inventory)

| Operation | Nodes | Role |
|-----------|-------|------|
| **create** | `Create Inbound Message`, many `Create Outbound Message*` variants | Audit trail + staff visibility |
| **search** | `Search Messages - Recent Conversation` | LLM memory (not full history DB) |
| **update** | `Update Inbound Message - Link Conversation` | Link to conversation record |

**Fields:** `Message Text`, `Direction` (inbound/outbound), `Message Type`, `Conversation Phone`, `WhatsApp Message ID`, `Source`, link to conversation.

**WhatsApp:** Outbound paths call Meta Graph API (`Send WhatsApp Reply*`) **after** AT message create — PG migration must preserve send order (message row → send → update conversation).

### 1.4 Active booking / hold discovery

| Node | Logic |
|------|--------|
| **`Code - Prepare Active Booking Search`** | Builds `active_booking_search_hold_id` from AT `Current Hold ID` or session `current_hold_id` / `hold_booking_id` / `booking_id`; phone from normalize/inbound |
| **`Search Active Booking - Current Hold ID`** | AT Bookings search by **Booking ID** = hold id |
| **`Search Active Booking - Phone`** | AT Bookings: phone + status in `Hold`, `Payment_Pending`, `Confirmed`, `Needs_Review` + date overlap |
| **`Code - Pick Active Booking`** | Prefer hold-id search, else phone; outputs `active_booking_found`, `active_booking_id` (**booking_code**), `active_booking_record_id` (**AT rec…**), `active_booking_status`, merges into **session** |
| **`Code - Check Existing Hold`** | Overlap filter on AT bookings for same phone + `hold` status (booking_flow) |
| **`Search Hold With Guest Details`** | 2f payment path — search hold by phone for guest contact |

**Resolver (`Code - Booking State Resolver`, v2f.4):** Reads `Search Conversation`, `Code - Pick Active Booking`, `Code - Parse Route`. Key outputs:

- `booking_state.phase`: `hold_active` vs `pre_hold`
- `hold_lookup.should_search_hold`, `search_current_hold_id`
- `getConversationHoldHint()`: true if `Current Hold ID` or session hold keys start with `WH-`
- `isHoldUsable()`: AT status `Hold` or `Payment_Pending`
- Overrides router when payment details without hold, full booking in one message, rooming without hold, etc.

**Gap for 3c:** Active booking searches are **100% Airtable Bookings**. After PG hold-only path, AT may lag → resolver sees no hold → wrong `resolved_route`.

### 1.5 Booking hold create (AT today, PG in 3c.c CLI only)

| Node | Today |
|------|--------|
| `Code - Prepare Hold Records` | Generates `hold_booking_id` = `WH-YYMMDD-####` |
| `Create Booking Hold` | AT Bookings **create** (`Status=Hold`, etc.) |
| Conversation updates | `Create or update Conversation`, `Update Conversation After Reply` set **`Current Hold ID`** to booking_code |
| PG (3c.c CLI, not wired) | `db:main-hold:postgres` → `bookings.id` UUID + `booking_code` |

**Ensure path (Stripe):** `Postgres - Ensure Booking In Postgres` + promote CLI — expects `booking_code`; does **not** update conversation.

### 1.6 LLM / memory dependencies on conversation state

| Consumer | Inputs from conversation layer |
|----------|-------------------------------|
| `Parser Node` | `Session State`, `Last Bot Reply`, summary |
| `Router - Classify Message` | summary, session, **Pick Active Booking**, Pending Action, stage |
| `Generate Next Reply` / branch LLMs | `conversation_memory`, summary, `session_state` |
| `Code - Build Conversation Memory` | Recent AT messages only (bounded window) |

---

## 2. Desired Postgres state model

Schema already exists in `database/migrations/001_init.sql` — **no migration required for MVP plan** unless gaps found in 3c.d.2.

### 2.1 `conversations` (authority target)

| PG column | Maps from AT / workflow | Notes |
|-----------|-------------------------|--------|
| `id` | — | UUID primary key for FKs |
| `hostel_id` | implicit client | `wolfhouse-somo` → hostel row |
| `phone` | `Phone` | **UNIQUE (hostel_id, phone)** — canonical session key |
| `guest_id` | optional | Link when guest known |
| `airtable_record_id` | AT record id | Mirror only; set when AT upsert succeeds |
| `display_name` | guest name fields | Optional |
| `email` | | Optional |
| `language` | `Language` | |
| `session_state` | `Session State` JSONB | Same merge semantics as today |
| `conversation_summary` | `Conversation Summary` | |
| `last_message_preview` | | Short text |
| `last_bot_reply` | `Last Bot Reply` | |
| `needs_human` | session / handoff | BOOLEAN |
| `status` | enum `open`/`closed`/`on_hold` | Not same as AT “Conversation Stage” |
| `conversation_stage` | **`Conversation Stage`** | `booking_flow`, `payment_pending`, … |
| `bot_mode` | `bot`/`staff`/`paused` | Handoff |
| **`current_hold_booking_id`** | **`Current Hold ID`** | **UUID → `bookings.id`**, not booking_code string |
| `pending_action` | `Pending Action` | |
| `metadata` | extensibility | resolver snapshot optional |

**Derived / redundant by design:** Keep `booking_code` reachable via join `bookings.booking_code` from `current_hold_booking_id`. Session JSON may still cache `current_hold_id` (code) for LLM prompts until Code nodes read PG.

### 2.2 `messages`

| PG column | Maps from AT |
|-----------|--------------|
| `conversation_id` | link |
| `direction` | `inbound` / `outbound` |
| `message_text` | `Message Text` |
| `message_type` | `Message Type` |
| `language` | |
| `route` | `resolved_route` at send time (recommended) |
| `whatsapp_message_id` | dedupe index |
| `conversation_stage` | snapshot at message time |
| `chat_line` / `chat_display` | optional UI |

### 2.3 Identity rules (target)

| Concept | Canonical in PG |
|---------|-----------------|
| Guest session key | `(hostel_id, phone)` |
| Active hold pointer | `conversations.current_hold_booking_id` → `bookings.id` |
| Human-facing booking ref | `bookings.booking_code` (`WH-…`) |
| Payment / Ensure | `booking_code` + `bookings.id` (already in 3c.c.4) |
| AT mirror | `airtable_record_id` on both tables when dual-write |

### 2.4 Resolver / session snapshot (design choice for 3c.d.2)

Option A (minimal): Resolver keeps reading AT until 3c.e hybrid; PG populated in parallel for reports.  
Option B (3c.e): New **`Code - Pick Active Booking (PG)`** or extend resolver inputs from a single **conversation state** object loaded from PG first, AT fallback.

**Recommendation:** Document **Option B** as 3c.e target; 3c.d delivers field map + read-only PG report proving `current_hold_booking_id` aligns with `bookings` row.

---

## 3. Minimal 3c.d MVP (recommended)

**Scope:** Plan + read-only verification only — **no workflow wiring, no execute CLI, no AT writes.**

| Step | Deliverable | Mutations |
|------|-------------|-----------|
| **3c.d.1** | Conversation/message **field inventory** (extend 3c.a or new report): node × AT field × route × read/write | None |
| **3c.d.2** | **`db:report:main-conversation-state`** (SELECT-only): by phone, show PG `conversations` + linked `bookings` + recent `messages`; compare to optional AT export fields in report JSON | None |
| **3c.d.3** | (Deferred) PG conversation upsert CLI — only if 3c.d.2 proves schema sufficient | `conversations`/`messages` only |
| **3c.d.4** | Sign-off section in [`PHASE-3c-d.md`](PHASE-3c-d.md) + update [`PROJECT-STATE.md`](PROJECT-STATE.md) | Docs |

**Not in 3c.d MVP:** Fixtures that write conversations (unless later substep explicitly approved), resolver code changes, Main JSON regeneration.

---

## 4. Relationship to 3c.c and 3c.e

### 4.1 After PG hold create (3c.c → future 3c.e)

```text
db:main-hold:postgres --execute
  → returns booking_id (UUID), booking_code (WH-…)

Required conversation updates (design for 3c.e, not implemented in 3c.d):
  1. UPSERT conversations by (hostel_id, phone)
  2. SET current_hold_booking_id = booking_id
  3. SET conversation_stage = 'booking_flow' (or keep existing if existing_booking route)
  4. MERGE session_state JSON (dates, guest_count, room_type from session)
  5. OPTIONAL: mirror AT Current Hold ID = booking_code after PG success
```

### 4.2 After Ensure promote (3c.c.4 → 3c.e)

```text
db:main-ensure-booking:postgres --execute
  → same booking_id, status payment_pending

Conversation updates (3c.e):
  SET conversation_stage = 'payment_pending'
  KEEP current_hold_booking_id (same UUID)
  Refresh session/contact fields; do not clear hold pointer
```

### 4.3 What 3c.e must have from 3c.d before wiring

| # | Decision |
|---|----------|
| 1 | Which conversation fields are **PG-authoritative** vs AT mirror |
| 2 | **Order of writes:** PG booking → PG conversation → AT mirror (if dual) |
| 3 | How **`Code - Booking State Resolver`** gets `active_booking` when PG has hold but AT does not |
| 4 | Whether **`Current Hold ID`** in AT remains `booking_code` (recommended yes for staff UI) |
| 5 | Inbound message: PG insert timing vs `Create Inbound Message` |
| 6 | Single helper module name (e.g. `main-conversation-pg-sql.js`) and parameter contract |

---

## 5. Risks and blockers

| Risk | Description | Mitigation in ladder |
|------|-------------|----------------------|
| **Stale Current Hold ID** | AT/PG conversation points to old `WH-…` after new hold | Upsert clears pointer only when new hold PG-success; resolver prefers PG UUID lookup |
| **Duplicate holds** | New hold while conversation still references old code | Reuse 3c.c **active_hold_guard** + conversation-level check before create |
| **Resolver wrong route** | `Pick Active Booking` misses PG-only hold | PG-first pick in 3c.e; 2f `hold_lookup` uses `current_hold_booking_id` |
| **booking_code vs UUID confusion** | AT uses code; PG FK uses UUID | 3c.d.2 report shows both; never store code in `current_hold_booking_id` column |
| **Human handoff lost** | `needs_human` / `bot_mode` not mirrored | Explicit field map in 3c.d.1; test fixture for handoff route |
| **Message memory drift** | LLM reads AT messages but booking in PG | Dual-write messages or PG-only memory builder in later substep |
| **AT record_id dependency** | Nodes expect `active_booking_record_id` for updates | Mirror after PG; or pass `booking_code` only paths until AT retired |
| **Conversation vs booking disagree** | Stage `payment_pending` but booking still `hold` | Single transaction or ordered promote then conversation update |
| **Session JSON fork** | Merge Session State vs Pick Active Booking both write session | Define precedence in 3c.d doc; one PG `session_state` merge function |
| **Prod base in fork** | 64 AT nodes still hit prod | `--verify-targets` remains gate for 3c.e |

**Blocker:** Cannot safely inject PG hold in Main until **active booking lookup** has a defined PG path (even if AT mirror remains).

---

## 6. Recommended implementation ladder

| Substep | Deliverable | Exit criteria |
|---------|-------------|---------------|
| **3c.d.1** | Extend inventory: `Conversations`/`Messages` field matrix per node (CSV/JSON report) | Every write node lists AT columns; mapped to PG column |
| **3c.d.2** | `scripts/lib/main-conversation-pg-sql.js` (SELECT only) + `db:report:main-conversation-state` | By phone: PG conversation + hold booking + message count; exit 0 |
| **3c.d.3** | (Optional, post-sign-off) PG conversation upsert CLI: set `current_hold_booking_id`, stage, session merge | Fixture test; no workflow |
| **3c.d.4** | Docs sign-off; update PROJECT-STATE | Owner approves plan for 3c.e |

Aligns with [`PHASE-3c-PROPOSAL.md`](PHASE-3c-PROPOSAL.md) §3c.d but defers execute until 3c.d.2 proves read path.

---

## 7. Recommended next implementation prompt (one step)

> **Phase 3c.d.1 — Add conversation/message field inventory report.**  
> Extend `scripts/lib/main-workflow-inventory.js` (or add `scripts/report-main-conversation-inventory.js`) to emit a structured report: for each Conversations/Messages Airtable node in the local Main fork, list operation, node name, `resolved_route` tag, and every AT field name written or read. Output JSON under `reports/` and document run command in `docs/PHASE-3c-d.md`. Read-only; no workflow JSON changes; no Postgres writes.

---

## References

| Artifact | Path |
|----------|------|
| PG schema | `database/migrations/001_init.sql` (`conversations`, `messages`) |
| Inventory | `scripts/lib/main-workflow-inventory.js`, `npm run build:main:local-stripe -- --inventory` |
| Hold CLI | `scripts/lib/main-booking-hold-pg-sql.js` |
| Ensure CLI | `scripts/lib/main-ensure-booking-pg-sql.js` |
| 2f resolver | `scripts/build-main-local-stripe.js`, node `Code - Booking State Resolver` |
