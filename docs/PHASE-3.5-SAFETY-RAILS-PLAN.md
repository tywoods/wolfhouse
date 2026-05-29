# Phase 3.5 — Safety Rails Before Reliability

**Status:** PLANNING (2026-05-29)  
**Stage 3 closeout commit:** `68703fd`  
**Purpose:** Pull forward the minimum safety seatbelts required before Stage 3y shadow/co-pilot mode or any live guest operation. Not full Stage 4 observability.

---

## Entry criteria

All must be true before any Stage 3.5 implementation begins:

| # | Criterion | Evidence |
|---|-----------|----------|
| E1 | Stage 3 closeout commit exists | `68703fd` ✓ |
| E2 | Working tree clean | `git status --short` empty ✓ |
| E3 | All local target workflows `active=false` | Confirmed Gate A + I4 teardown ✓ |
| E4 | Send Confirmation schedule `disabled=true` | Confirmed throughout Stage 3 ✓ |
| E5 | `WHATSAPP_DRY_RUN=true` in any runtime | Confirmed throughout Stage 3 ✓ |
| E6 | Airtable-coupling documented for Main/Reassign paths | §15.6–§15.7 + I5 deferral ✓ |
| E7 | No production/hosted n8n edits | Policy established ✓ |
| E8 | Payment-table writes require explicit per-gate approval | Policy established (I3 deferral reason) ✓ |
| E9 | Wrong-booking protection proven at L1+L2 | 3e.5 CLOSED ✓ |
| E10 | Core idempotency proven at Stage 3 bar | 3e.6 CLOSED (I1+I4+I6) ✓ |

---

## Exit criteria

All of the following must be met before Stage 3y shadow/co-pilot mode:

| # | Criterion |
|---|-----------|
| X1 | Each 3.5 sub-phase has PASS / DEFERRED (with reason) / BLOCKED status |
| X2 | `automation_errors` write path wired into at least one dangerous-action workflow |
| X3 | Safe staff-handoff fallback defined and documented for all dangerous actions |
| X4 | No silent bot failures: every runtime error has a capture path or hard stop |
| X5 | Idempotency gaps I2/I3/I5 either have runtime proof OR are correctly deferred with written reason |
| X6 | Double-booking overlap guard contract documented with pass/fail test criteria |
| X7 | Minimum execution logging fields defined; wire-in plan accepted |
| X8 | Real WhatsApp send remains off unless explicitly approved (separate gate) |
| X9 | Protected counts baseline confirmed unchanged after any 3.5 runtime gate |
| X10 | All dangerous workflows inactive after each 3.5 test gate |
| X11 | Project docs updated and committed |

---

## Sub-phase plan

### 3.5a — Safety-rail inventory and dangerous-action contracts

**Work type:** Docs/static only  
**Status:** REVIEWED / ACCEPTED (2026-05-29)

**Goal:** Enumerate every dangerous action the bot can take, its current owner, existing guards, and missing guards. This is the master inventory that drives all subsequent sub-phases.

**Dangerous actions inventory:**

| Action | Workflow(s) | Source-of-truth | Existing guard | Missing guard | 3.5 sub-phase |
|--------|-------------|-----------------|----------------|---------------|---------------|
| Hold creation | Main | Airtable (primary) + PG mirror | `existing_active_hold_found` dedup (Airtable query) + PG `booking_beds` free check | PG-only dedup after cutover; hold-expiry enforcement; `automation_errors` not wired on hold failure | 3.5b + cutover |
| Payment-link creation | Main + CPS | Airtable hold + Stripe | PG Ensure idempotency (`action=refreshed`); `payments_stripe_payment_intent_id_unique` partial index | No Airtable-level session reuse guard; `automation_errors` not wired on CPS failure | 3.5b + 3.5f (I2) |
| Stripe event processing | Stripe Webhook Handler | Postgres-primary | `payment_events.stripe_event_id TEXT UNIQUE` | `automation_errors` not wired on conflict; runtime proof deferred (I3) | 3.5b + 3.5f (I3) |
| Send Confirmation | Send Confirmation (local) | Postgres-primary | `WHERE confirmation_sent_at IS NULL` in SELECT + UPDATE (**I4 PASS**); `WHATSAPP_DRY_RUN` gate | **Two silent dead-ends** (see §3.5b design below); no `automation_errors` on WhatsApp failure; no workflow-level Error Trigger | **3.5b — first wire-in target** |
| Real WhatsApp send | Send Confirmation (Code - Send WhatsApp node) | Env flag (`WHATSAPP_DRY_RUN`) | Env flag prevents real send if `true` or token missing | No error recorded if send fails (`whatsapp_sent=false` → silent dead-end at `IF - WhatsApp Sent OK`) | **3.5b** |
| Bed assignment (assign) | Assign (local PG) | Postgres | `assign-booking-beds-plan.js` overlap detection | Overlap detected but not captured in `automation_errors`; no staff alert on conflict | 3.5b + 3.5d |
| Bed reassignment | Reassign → Assign | Airtable-coupled + PG | `resolved_count=1` guard in PG DELETE SQL | Airtable upstream gate; L3 runtime deferred; `automation_errors` not wired | 3.5b (after cutover for full L3) |
| Bed cancellation | Cancel (local PG) | Postgres | — | No overlap-aware cancel guard documented; `automation_errors` not wired; cancel idempotency (I6) undefined | 3.5b + 3.5c (I6) + 3.5d |
| Manual entry rooming | Manual Entries (local PG) | Postgres | `booking_source` guard; overlap detection | `automation_errors` not wired | 3.5b |
| Operator room release | Operator Room Release | Postgres | Operator block convention (3e.5 T6) | No explicit lock column; overlap-based only; `automation_errors` not wired | 3.5b + 3.5d |
| Guest handoff (all routes) | Main | Airtable session + LLM | `confidence < threshold` → handoff signal in route | Handoff not written to `automation_errors` or `workflow_events`; no evidence of handoff in PG | 3.5b |
| LLM error / bad parse | Main (Parser Node, Code - Parse Route) | n8n Code node | `route='unknown'` fallback; `confidence=0` | No `automation_errors` write on LLM error; no staff alert on parse failure | 3.5b |

**Inventory completeness verdict:** COMPLETE for current local forks. Additions vs. original plan:
- Real WhatsApp send and LLM error split out as separate rows.
- Cancel idempotency (I6) added.
- 3.5 sub-phase owner column added.

**Key finding (confirmed from schema + migrations):** `automation_errors` and `workflow_events` exist in migration 001 and were fully updated by migration 003 (see §Schema findings below). Both tables are ready to receive INSERTs. **Zero n8n workflow wire-ins exist today** — the primary gap for Stage 3.5b.

**Deliverable:** Update per-row status once 3.5b wire-in is implemented and tested.

---

---

## Schema findings (3.5a verification, 2026-05-29)

### automation_errors and workflow_events — migration status

**Finding: caveat in original plan was incorrect. Both tables are fully migrated.**

Migration 003 (`003_rename_hostel_to_client.sql`) explicitly lists `automation_errors` and `workflow_events` in its column rename loop:

```sql
FOREACH t IN ARRAY ARRAY[
  'packages', 'package_price_rules', ...,
  'automation_errors', 'workflow_events'
] LOOP
  ALTER TABLE %I RENAME COLUMN hostel_id TO client_id;
END LOOP;
```

`ALTER TABLE hostels RENAME TO clients` in the same migration renames the referenced table, so the FK `hostels(id)` → `clients(id)` is automatically updated. **No additional migration needed before wiring.**

**Current live table state:**

| Table | `hostel_id` column? | FK reference | Ready to INSERT? |
|-------|---------------------|--------------|-----------------|
| `automation_errors` | Renamed to `client_id` ✓ | `clients(id)` ✓ | **YES** |
| `workflow_events` | Renamed to `client_id` ✓ | `clients(id)` ✓ | **YES** |

### workflow_events field gap analysis

**Minimum logging fields (§3.5e) vs. available columns:**

| Required field | workflow_events column | Available? |
|---------------|------------------------|-----------|
| `client_id` | `client_id` (after migration 003) | ✓ direct column |
| `booking_id` | `booking_id UUID` | ✓ direct column |
| `booking_code` | — | ✗ store in `payload.booking_code` |
| `conversation_id` | `conversation_id UUID` | ✓ direct column |
| `wamid` / `whatsapp_message_id` | — | ✗ store in `payload.wamid` |
| `workflow_name` | `workflow_name TEXT` | ✓ direct column |
| `execution_id` | `execution_id TEXT` | ✓ direct column |
| `node_name` | `node_name TEXT` | ✓ direct column |
| `action` | — | ✗ store in `payload.action` |
| `idempotency_key` | — | ✗ store in `payload.idempotency_key` |
| `decision outcome` | `event_level` (info/warn/error) + message | ✓ via `message` + `payload.outcome` |
| `error/handoff reason` | `message TEXT` | ✓ direct column |
| `timestamp` | `created_at TIMESTAMPTZ` | ✓ direct column |
| `dry_run flag` | — | ✗ store in `payload.dry_run` |

**Verdict:** No new migration needed. All required context fits in the existing schema — direct columns for the key FKs and lookups; `payload JSONB` for operational metadata (`wamid`, `idempotency_key`, `booking_code`, `action`, `outcome`, `dry_run`). The `payload JSONB NOT NULL DEFAULT '{}'` column exists on both tables.

---

### 3.5b — Error capture and staff handoff fallback

**Work type:** Spec + workflow/code change + runtime gate  
**Status:** PLANNED — wire-in design ready for Send Confirmation (first target)

**Goal:** Wire the existing `automation_errors` / `workflow_events` Postgres tables into the n8n workflows for dangerous actions. Ensure no bot action fails silently.

**Schema already exists (migration 001):**

```sql
-- automation_errors: structured error capture per workflow execution
CREATE TABLE automation_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id UUID REFERENCES hostels(id) ON DELETE SET NULL,  -- renamed client_id in later migration
  workflow_name TEXT NOT NULL,
  node_name TEXT,
  execution_id TEXT,
  error_message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error',
  status automation_error_status NOT NULL DEFAULT 'open',
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  staff_alert_sent BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL DEFAULT '{}'
);

-- workflow_events: lightweight execution trace per dangerous action
CREATE TABLE workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name TEXT NOT NULL,
  execution_id TEXT,
  event_level workflow_event_level NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'
);
```

**Schema status (confirmed 2026-05-29):** Migration 003 already renamed `hostel_id` → `client_id` on both `automation_errors` and `workflow_events`, and `hostels` → `clients`. No additional migration required before wiring. See §Schema findings above.

**Minimum wire-in pattern per dangerous workflow:**

```
Workflow error handler path:
  n8n Error Trigger (or node-level catch)
  → Code: build error payload
      {workflow_name, node_name, execution_id, booking_id,
       conversation_id, error_message, severity, payload}
  → Postgres INSERT INTO automation_errors (...)
  → (future) WhatsApp staff alert via WHATSAPP_DRY_RUN gate
```

**Fallback contract for each dangerous action:**

| Action | Safe fallback on error |
|--------|------------------------|
| Payment-link creation fails | Do NOT send broken link; write error; send guest "our team will follow up" (dry-run or staff message) |
| Stripe webhook fails | Write `automation_errors`; do NOT mark booking paid; wait for organic Stripe retry |
| Send Confirmation fails | Write error; do NOT mark confirmed; re-eligible on next trigger |
| Bed assignment fails | Write error; leave `assignment_status=unassigned`; alert staff |
| Reassign fails | Write error; leave beds unchanged; alert staff |
| Cancel fails | Write error; leave beds assigned; alert staff |
| LLM error / low confidence | Route to handoff; write `workflow_events`; never write booking state from LLM output alone |

**Priority wiring order (least risky first):**
1. **Send Confirmation** (already Postgres-primary; add error handler + `automation_errors` INSERT) — **first target; design below**
2. Assign / Reassign / Cancel (Postgres bed-ops; add error handler)
3. Stripe Webhook Handler (Postgres-primary for payment truth; add error handler)
4. Main (mixed; add error handler for dangerous-action branches only, not conversation nodes)

**Runtime gate required:** Yes — each wired workflow needs a minimal activation + deliberate error injection test to confirm the `automation_errors` row is written. This is a low-risk runtime gate: force a parse error, confirm the INSERT, teardown. No payment or real send involved.

---

### 3.5b — First Wire-in Design: Send Confirmation Error Capture

**Target workflow:** `Wolfhouse - Send Confirmation (local)` (`gxivKRJexzTCw9x6`)  
**Build script:** `scripts/build-send-confirmation-local.js` (`npm run build:send-confirmation:local`) — **this is the source of truth; the JSON is generated, not hand-maintained**.

**3.5b wire-in status: IMPLEMENTED (2026-05-29) · Gap 2 runtime PASS (2026-05-29) · Gap 1 + Gap 3 runtime pending**

> Runtime evidence for the Gap 2 (WhatsApp send failure) path is recorded below under
> "3.5b Gap 2 runtime error-injection — PASS". Gap 1 (no-pending info event) and Gap 3
> (Error Trigger crash capture) are wired and statically verified but not yet runtime-tested.

Nodes added (all in `scripts/build-send-confirmation-local.js` and regenerated to `n8n/phase2/Wolfhouse - Send Confirmation (local).json`):

| Node name | Type | ID | Purpose |
|-----------|------|-----|---------|
| `Code - Build WA Send Error` | Code | `2d010017-0017-...` | Build normalized error payload from WhatsApp send failure |
| `Postgres - Write automation_errors (send fail)` | Postgres | `2d010018-0018-...` | INSERT into `automation_errors` (send fail, `severity='error'`) |
| `Postgres - Write workflow_events (send fail)` | Postgres | `2d010019-0019-...` | INSERT into `workflow_events` (`event_level='error'`) |
| `Postgres - Write workflow_events (no pending booking)` | Postgres | `2d010020-0020-...` | INSERT info log when no eligible booking found |
| `Error Trigger - Send Confirmation` | Error Trigger | `2d010021-0021-...` | Catch any unhandled workflow crash |
| `Code - Build Workflow Error Payload` | Code | `2d010022-0022-...` | Build normalized payload from n8n error context |
| `Postgres - Write automation_errors (crash)` | Postgres | `2d010023-0023-...` | INSERT into `automation_errors` (`severity='critical'`) |

**Static verification (2026-05-29):**
- Total nodes: 23 (16 original + 7 new) ✓
- All 7 new node IDs found in generated JSON ✓
- `IF - WhatsApp Sent OK` main[1] → `Code - Build WA Send Error` ✓
- `IF - Pending Booking Found` main[1] → `Postgres - Write workflow_events (no pending booking)` ✓
- `Error Trigger - Send Confirmation` → `Code - Build Workflow Error Payload` → `Postgres - Write automation_errors (crash)` ✓
- `Code - Build WA Send Error` → `Postgres - Write automation_errors (send fail)` → `Postgres - Write workflow_events (send fail)` ✓
- No `payments` or `payment_events` INSERT/UPDATE in any Postgres node ✓
- Hosted `n8n/Wolfhouse - Send Confirmation.json` unchanged (12 nodes) ✓
- `active: false` in generated JSON ✓

#### Current node flow (confirmed from JSON)

```
[Schedule - Poll Postgres] (disabled)
         ↓
[Postgres - List Pending Confirmations]
                                          ↘
[Webhook - Send Confirmation Local]         [IF - Pending Booking Found]
  → [Code - Parse Webhook Filter]           ├── true →  [Code - Format Booking For LLM]
  → [Postgres - List Pending (Webhook)]  ↗ │                → [Search Conversation - Confirmation] (Airtable, alwaysOutputData)
                                            │                → [Search Booking Beds - Confirmation] (Airtable, alwaysOutputData)
                                            │                → [Code - Summarize Assigned Rooms]
                                            │                → [Send confirmation reply] (LLM)
                                            │                → [Code - Send WhatsApp]
                                            │                   → [IF - WhatsApp Sent OK]
                                            │                     ├── true → [Postgres - Mark Booking Confirmed]
                                            │                     └── false → ⚠️ SILENT DEAD END
                                            └── false → ⚠️ SILENT DEAD END
```

**No workflow-level Error Trigger node exists.**

#### Silent failure points (two gaps)

| Gap | Location | Current behavior | Risk |
|-----|----------|-----------------|------|
| **Gap 1** | `IF - Pending Booking Found` false branch (`main[1]`) | Empty `[]` — no response, no log | **Low** — valid no-eligible-booking case; but should log for observability |
| **Gap 2** | `IF - WhatsApp Sent OK` false branch (`main[1]`) | Empty `[]` — no response, no error log, no staff alert | **HIGH** — WhatsApp send failed; guest not notified; booking NOT confirmed; staff has no idea |
| **Gap 3** | Workflow-level n8n error | No `Error Trigger` node | **HIGH** — any Postgres/Airtable/LLM node crash is invisible |

#### Wire-in design

Three additions are needed:

**Addition A: Gap 2 — WhatsApp failure error capture path**

New nodes (insert on `IF - WhatsApp Sent OK` false branch):

```
[IF - WhatsApp Sent OK] false →
  [Code - Build WA Send Error]
    → [Postgres - Write automation_errors]
    → [Postgres - Write workflow_events (error)]
```

**`Code - Build WA Send Error` payload:**
```javascript
const sendResult = $('Code - Send WhatsApp').first().json;
const booking    = $('Code - Format Booking For LLM').first().json;
const clientId   = '<resolved from booking query — join on clients.slug>';

return [{
  json: {
    client_id:     null,  // resolved in INSERT via subquery on wolfhouse-somo slug
    workflow_name: 'Wolfhouse - Send Confirmation (local)',
    node_name:     'Code - Send WhatsApp',
    execution_id:  String($execution?.id || ''),
    error_message: sendResult.whatsapp_error || 'WhatsApp send failed (unknown)',
    severity:      'error',
    status:        'open',
    booking_id:    booking.booking_id || null,
    payload: {
      booking_code:      booking.booking_code,
      whatsapp_sent:     sendResult.whatsapp_sent,
      whatsapp_error:    sendResult.whatsapp_error,
      dry_run:           String($env.WHATSAPP_DRY_RUN || 'true').toLowerCase() === 'true',
      action:            'send_confirmation',
      outcome:           'whatsapp_send_failed',
    },
  },
}];
```

**`Postgres - Write automation_errors` INSERT:**
```sql
INSERT INTO automation_errors (
  client_id, workflow_name, node_name, execution_id,
  error_message, severity, status,
  booking_id, payload
)
SELECT
  c.id,
  $1, $2, $3,
  $4, $5::text, 'open'::automation_error_status,
  $6::uuid, $7::jsonb
FROM clients c
WHERE c.slug = 'wolfhouse-somo'
RETURNING id;
```
Parameters: `[workflow_name, node_name, execution_id, error_message, severity, booking_id, payload_json_string]`

**`Postgres - Write workflow_events (error)`** (optional companion):
```sql
INSERT INTO workflow_events (
  client_id, workflow_name, node_name, execution_id,
  event_level, message,
  booking_id, payload
)
SELECT
  c.id,
  $1, $2, $3,
  'error'::workflow_event_level, $4,
  $5::uuid, $6::jsonb
FROM clients c
WHERE c.slug = 'wolfhouse-somo';
```

**Addition B: Gap 1 — No-eligible-booking info log**

New nodes (insert on `IF - Pending Booking Found` false branch):

```
[IF - Pending Booking Found] false →
  [Postgres - Write workflow_events (no booking)]
```

This is informational (`event_level='info'`), not an error. No `automation_errors` row needed. Useful for diagnosing "why didn't the confirmation run?" questions.

```sql
INSERT INTO workflow_events (
  client_id, workflow_name, execution_id,
  event_level, message, payload
)
SELECT c.id, $1, $2, 'info'::workflow_event_level, $3, $4::jsonb
FROM clients c WHERE c.slug = 'wolfhouse-somo';
```
Message: `'send_confirmation: no eligible bookings found for this trigger'`

**Addition C: Gap 3 — Workflow-level Error Trigger**

Add an `n8n-nodes-base.errorTrigger` node as a parallel workflow entry point. When any node crashes (Postgres disconnect, Airtable 429, LLM timeout), n8n fires this trigger with `$json.execution.error`.

```
[Error Trigger] →
  [Code - Build Workflow Error Payload]
    → [Postgres - Write automation_errors (crash)]
```

**`Code - Build Workflow Error Payload`:**
```javascript
const err = $json.execution?.error || {};
return [{
  json: {
    workflow_name: 'Wolfhouse - Send Confirmation (local)',
    node_name:     err.node?.name || 'unknown',
    execution_id:  String($json.execution?.id || ''),
    error_message: err.message || 'Unhandled workflow error',
    error_stack:   err.stack || null,
    severity:      'critical',
    payload: {
      action:  'send_confirmation',
      outcome: 'workflow_crash',
      error:   err,
    },
  },
}];
```

#### Data contract summary

**`automation_errors` insert — required fields:**

| Field | Value source | Notes |
|-------|-------------|-------|
| `client_id` | Subquery `SELECT id FROM clients WHERE slug='wolfhouse-somo'` | Stable; no hardcoded UUID |
| `workflow_name` | Literal string | `'Wolfhouse - Send Confirmation (local)'` |
| `node_name` | From error context or literal | e.g. `'Code - Send WhatsApp'` |
| `execution_id` | `$execution?.id` | n8n execution id |
| `error_message` | `sendResult.whatsapp_error` or `err.message` | Non-null TEXT |
| `severity` | `'error'` (send fail) or `'critical'` (crash) | TEXT enum |
| `status` | `'open'` | Default; staff resolves |
| `booking_id` | `booking.booking_id` | UUID or NULL |
| `payload` | JSON object | `booking_code`, `action`, `outcome`, `dry_run`, `whatsapp_error` |
| `staff_alert_sent` | `false` (default) | Future: set true after WhatsApp staff alert |

#### Runtime test design for 3.5b gate

**Preconditions:**
- Working tree clean (or only expected 3.5 docs changes).
- `WHATSAPP_DRY_RUN=true`.
- All workflows inactive.
- Protected counts confirmed: payments=25, payment_events=5, booking_beds=15.

**Fixture:**
- `WH-35B-TEST-1` booking: `send_confirmation=true`, `status='payment_pending'`, `payment_status='deposit_paid'`, `confirmation_sent_at NULL`.
- No payment writes.
- Reversible `-down.sql`.

**Injected error for Gap 2:**
- Temporarily force `Code - Send WhatsApp` to return `{ whatsapp_sent: false, whatsapp_error: 'test_inject_3.5b' }`.
- Simplest approach: set `WHATSAPP_DRY_RUN=false` and provide a deliberately invalid `WHATSAPP_ACCESS_TOKEN` value (e.g. `invalid_token_35b_test`) — the send will fail with an auth error, triggering the false branch.
- The booking is **not** confirmed (correct — WhatsApp failed); an `automation_errors` row is written.

**Activation boundary:** Send Confirmation `gxivKRJexzTCw9x6` only.

**Expected after trigger:**
- `automation_errors` count: +1 (new row with `booking_id=WH-35B-TEST-1`, `error_message` contains send failure reason, `status='open'`).
- `workflow_events` count: +1 (error event).
- Booking state: still `payment_pending`, `send_confirmation=true`, `confirmation_sent_at NULL` (not confirmed — correct).
- Protected counts: payments=25, payment_events=5, booking_beds=15 unchanged.

**Teardown:**
```sql
DELETE FROM automation_errors WHERE booking_id = (SELECT id FROM bookings WHERE booking_code='WH-35B-TEST-1');
DELETE FROM workflow_events WHERE booking_id = (SELECT id FROM bookings WHERE booking_code='WH-35B-TEST-1');
DELETE FROM bookings WHERE booking_code = 'WH-35B-TEST-1';
```
Verify: 0 rows with `WH-35B-TEST-1`; protected counts at baseline.

**Hard stops:**
- `payments` count changes.
- `payment_events` count changes.
- Booking moves to `confirmed` (it must NOT confirm when WhatsApp fails).
- Real WhatsApp send occurs (confirm `WHATSAPP_DRY_RUN` was in correct state before injecting error).
- Any other workflow activates unexpectedly.

#### 3.5b Gap 2 runtime error-injection — **PASS (2026-05-29)**

**Result:** PASS. The `IF - WhatsApp Sent OK` false-branch wire-in writes both an
`automation_errors` row and a `workflow_events` row on WhatsApp send failure,
without confirming the booking or touching protected payment tables.

**Injection correction (important):** §3.5b's original recipe (DRY_RUN=false + invalid
token) is **insufficient on its own**. `Code - Send WhatsApp` short-circuits to a
dry-run *success* when `!phoneNumberId`:
`if (dryRun || !token || !phoneNumberId) { return whatsapp_sent:true }`. To reach the
failure catch branch, **all three** must be set: `WHATSAPP_DRY_RUN=false`,
`WHATSAPP_ACCESS_TOKEN` non-empty, **and `WHATSAPP_PHONE_NUMBER_ID` non-empty**. The gate
set `WHATSAPP_PHONE_NUMBER_ID=100000000000035` (fake) so the real Graph API call executes
and is rejected (401). Without this, the booking would have falsely confirmed (a hard stop).

**Environment mechanics:** n8n runs in **queue mode** (`n8n-main` + `n8n-worker`); the
worker executes. `.env` changes require `docker compose up -d n8n n8n-worker` (recreate),
**not** `docker restart` (which keeps stale env). Both containers were verified to carry
the failure-mode env before triggering, and the restored baseline env afterward.

**Evidence:**

| Item | Value |
|------|-------|
| Fixture | `WH-35B-TEST-1` (`b35b0000-0000-4000-8000-000000000001`), `payment_pending` / `deposit_paid` / `send_confirmation=true` / `confirmation_sent_at NULL` |
| Trigger | `POST /webhook/send-confirmation-local` `{"booking_id":"b35b0000-…01"}` |
| Execution id | **1089** (`status=success`, finished) |
| Failure injected | `WHATSAPP_DRY_RUN=false`, `WHATSAPP_ACCESS_TOKEN=invalid_token_35b_test`, `WHATSAPP_PHONE_NUMBER_ID=100000000000035` |
| WhatsApp result | `whatsapp_sent=false`, `error_message="Request failed with status code 401"` (Graph API rejected invalid token — **no real send**) |
| `automation_errors` | **+1** (0→1): `node_name=Code - Send WhatsApp`, `execution_id=1089`, `severity=error`, `status=open`, `staff_alert_sent=false`, `booking_id=b35b…01`, payload keys: action/dry_run/outcome/booking_code/whatsapp_sent/whatsapp_error |
| `workflow_events` | **+1** (24→25): `event_level=error`, `node_name=Code - Send WhatsApp`, `execution_id=1089`, full payload (`outcome=whatsapp_send_failed`, `dry_run=false`) |
| Booking after | `status=payment_pending`, `send_confirmation=true`, `confirmation_sent_at NULL` — **NOT confirmed** (correct) |
| Protected counts | payments=25, payment_events=5, booking_beds=15 — **unchanged** throughout |
| Other workflows | Max exec ids unchanged: Main=1082, Reassign=1083, Assign=1084, Stripe=1086, CPS=1065, CPS stub=1037, Cancel=305 |
| Activation boundary | Send Confirmation `gxivKRJexzTCw9x6` only; all others stayed inactive |
| Teardown | `WH-35B-TEST-1` rows deleted; counts back to 25/5/15/0/24 |
| Env restored | DRY_RUN=true, token EMPTY, phone EMPTY in both `n8n-main` + `n8n-worker` |
| Final state | All workflows `active=false`; schedule node `disabled=true` |

**Fixtures:** [`scripts/fixtures/phase35b-send-fail-up.sql`](../scripts/fixtures/phase35b-send-fail-up.sql) / [`phase35b-send-fail-down.sql`](../scripts/fixtures/phase35b-send-fail-down.sql) (reversible).

**Still pending (not tested this gate):**
- **Gap 3 / Error Trigger** crash-capture runtime (Addition C) — wired + statically verified, not runtime-tested.
- **Gap 1 / no-pending-booking** info event (Addition B) — wired, not runtime-tested.

---

### 3.5c — Idempotency enforcement beyond schema

**Work type:** Spec + code/workflow changes + runtime gates  
**Status:** I3 RUNTIME PASS (2026-05-29) — guard implemented, Gates A–F all PASS; I2 deferred

**Goal:** Convert Stage 3e.6 learnings into explicit guard contracts. Distinguish what is already enforced at DB level from what needs an application-layer guard.

**Idempotency contract matrix:**

| # | Concern | DB guard (schema) | Application guard | Runtime proof | Status |
|---|---------|-------------------|-------------------|---------------|--------|
| I1 | Duplicate wamid | `UNIQUE (client_id, whatsapp_message_id)` on `messages` | No explicit check before INSERT; DB rejects duplicate | L2 schema PASS; full-path L3 deferred (Airtable-coupled Main) | **L2 PASS — Stage 3 bar** |
| I2 | Duplicate payment-link request | `payments_stripe_payment_intent_id_unique` (partial UNIQUE) | PG Ensure returns `action=refreshed` on 2nd call | Deferred — Airtable + Stripe coupling | **DEFERRED — manual-pay gate** |
| I3 | Duplicate Stripe event id | `payment_events.stripe_event_id TEXT UNIQUE` + `ON CONFLICT DO NOTHING` in CTE | **DB guard + HTTP guard both PROVEN** (2026-05-29): execs 1093 (processed) + 1094 (duplicate acknowledged). No double-payment, no double-promotion. | **RUNTIME PASS (execs 1093/1094, 2026-05-29)** | **PASS** |
| I4 | Duplicate Send Confirmation | `confirmation_sent_at IS NULL` in SELECT + UPDATE WHERE clause | Proven: 2nd execution is a no-op at SELECT layer | **RUNTIME PASS (I4, exec 1087→1088)** | **PASS** |
| I5 | Duplicate reassign | `resolved_count=1` guard in PG DELETE SQL | Airtable gate blocks PG path | Deferred — Airtable-coupled | **DEFERRED — cutover gate** |
| I6 | Duplicate cancellation | No explicit idempotency key on cancel | TBD | Not yet planned | **PLAN NEEDED** |
| I7 | Duplicate hold creation | Airtable: `existing_active_hold_found` dedup query | PG Ensure `action=refreshed` on same booking | Partial — Airtable-driven dedup | **Partially proven; needs PG-path runtime** |

**Required additions for Stage 3.5:**

- **I3 runtime gate:** DB guard is confirmed present (ON CONFLICT DO NOTHING). Before runtime, add a "duplicate acknowledged" HTTP response path to `Wolfhouse - Stripe Webhook Handler.json` so 2nd POST returns 200 cleanly instead of hanging. Then activate Stripe Webhook Handler only. One `payments` fixture row required — needs explicit payment-table write approval. Full spec in §3.5f.
- **I6 cancel idempotency:** Define whether cancelling an already-cancelled booking is safe or an error. Document guard. Simple DB-level: `WHERE assignment_status != 'cancelled'` or check before DELETE.

---

### 3.5d — Double-booking / overlap guard hardening

**Work type:** Docs/static + fixture/report + reversible DB write + runtime gate  
**Status:** PLANNING COMPLETE (2026-05-29) / IMPLEMENTATION NOT STARTED

**Goal:** Formalize and harden the overlap guard contract for all bed-assignment paths.

---

#### Overlap-sensitive path inventory (inspected 2026-05-29)

| Path | Owner workflow/script | SoT today | Creates booking_beds | Deletes booking_beds | Moves booking_beds | Current overlap guard | manual_staff/operator protection | Idempotency guard | Error capture/logging | Missing guard | Recommended proof level |
|------|----------------------|-----------|----------------------|----------------------|---------------------|----------------------|----------------------------------|-------------------|-----------------------|---------------|------------------------|
| Guest auto-assign (PG) | `Assign (local PG)` via `PG_ASSIGN_SQL` | Postgres | YES | NO | NO | `overlap_beds` CTE: any non-cancelled booking on same bed+dates blocked (`can_mutate=false`). `pg_ok=false` routes to response. | manual_staff/operator bookings are protected via the same overlap guard — no source-based bypass. No dedicated lock column. | `existing_skip` CTE: natural-key already-exists → skipped (idempotent). | **NONE** — `IF - PG Assign OK` false branch goes directly to response. No `workflow_events`, no `automation_errors`, no PG booking status update on conflict. | Wire `workflow_events (warn)` + `bookings.assignment_status=needs_review` PG mirror on conflict path | **L2 now (fixture + report); L3 after wire-in** |
| Guest auto-assign (Airtable path, upstream) | `Assign (local PG)` via Airtable `IF - Bed Assignment Conflict` | Airtable | YES (Airtable first, then PG mirror) | NO | NO | Airtable checks for conflicting records; if conflict → `Postgres - Mirror Assignment Conflict` (mirrors conflict status to PG) + Airtable update | Same overlap-based protection | N/A — Airtable handles separately | Writes PG `assignment_status=needs_review` via `Postgres - Mirror Assignment Conflict` ✓. No `workflow_events` or `automation_errors`. | Add `workflow_events (warn)` on Airtable conflict path | **L3 deferred (Airtable-coupled)** |
| Reassign (delete step) | `Reassign (local PG)` via `PG_REASSIGN_DELETE_SQL` | Mixed — Airtable upstream + PG DELETE | NO | YES — all `booking_beds` for target booking | NO | `resolved_count=1` guard: if booking resolution is ambiguous (0 or 2+ rows), DELETE is blocked. | No source-based protection on DELETE — deletes all beds for target regardless of source. | `beds_before_count` field shows deleted count; no natural-key idempotency. | **NONE** — no `workflow_events`, no `automation_errors` on guard failure. | Wire `workflow_events` on `resolved_count≠1`; document that DELETE is scoped to single booking_id | **L2 now (scope proof); L3 deferred (Airtable upstream)** |
| Reassign (new assign step) | Calls Assign after PG delete | Postgres | YES | NO | NO | Same as Assign PG overlap guard above | Same | Same | Same | Same as Assign PG gap | **L2/L3 deferred with Assign** |
| Cancel | `Cancel (local PG)` via `cancel-booking-beds-postgres.js` | Postgres | NO | YES — all `booking_beds` for target booking | NO | Scoped DELETE: `WHERE client_id=$1 AND booking_id=$2`. No overlap re-check needed (releasing beds is always safe). Guards: booking_not_found, booking_ambiguous. | N/A — cancel always safe to release any source. | `idempotent: deleteRes.rowCount === 0` logged. Explicit payment guard: throws if payments count changes. | **NONE** — no `workflow_events`, no `automation_errors`. | Wire `workflow_events (info)` on cancel success; add I6 cancel idempotency doc | **L2 (cancel scope proof already evidenced by existing cancel-impact reports)** |
| Manual/staff assignment | `Manual Entries (local PG)` | Postgres | YES (via `manual-entry-pg-sql.js`) | NO | NO | Overlap detection from `manual-entry-impact-plan.js`; conflict flagged in plan output. | manual_staff source is protected from guest overwrite by the same overlap guard. | Natural-key based skip in plan | **NONE** in n8n | Wire `workflow_events` on conflict | **L2 now (manual-entry-impact report); L3 deferred** |
| Operator room release | `Operator Room Release (local PG)` | Mixed | Creates 0–2 NEW operator block bookings; no `booking_beds` directly in release workflow | Removes original operator booking's beds (in 3b.5b PG mirror, proposed DELETE) | NO | `loadOverlapConflicts` in plan script checks for guest bookings in release window. `match_count=1` guard prevents action on ambiguous operator booking. | New block bookings use `booking_source='operator'` — protected by overlap guard downstream. | N/A | **NONE** — plan script has overlap check but n8n runtime has no capture | Wire `workflow_events` on overlap in release window; document that new blocks trigger downstream Assign | **L2 now (operator-room-release-impact report); L3 deferred** |
| Main rooming auto-assign call | `Main (local Stripe)` → calls Assign webhook | Airtable-primary | Delegates to Assign | NO | NO | Delegate to Assign guard above | Delegate | Delegate | Delegate | None in Main itself beyond delegate | **Covered by Assign L2/L3** |

---

#### Assign workflow overlap guard — detailed findings (inspected 2026-05-29)

**File:** `scripts/lib/assign-booking-beds-plan.js` (plan / impact report)  
**SQL:** `scripts/lib/assign-booking-beds-pg-sql.js` (`PG_ASSIGN_SQL`)  
**Workflow:** `n8n/phase3b/Wolfhouse - Bed Assignment (local PG).json` (generated by `scripts/build-assign-beds-local.js`)

**What `PG_ASSIGN_SQL` guards correctly:**

| Guard | CTE | Behavior |
|-------|-----|----------|
| Date overlap — any non-cancelled booking on same bed+dates | `overlap_beds` | `can_mutate=false`; INSERT blocked; `pg_conflict_count>0` in RETURNING |
| Unknown bed codes | `unknown_beds` | `can_mutate=false` |
| Ambiguous booking (2+ rows) | `resolved_count` | `can_mutate=false` |
| Cancelled/expired booking status | `can_mutate` WHERE clause | `can_mutate=false` |
| Same-booking natural-key already-exists (idempotent rerun) | `existing_skip` | `pg_skipped_count>0`; no duplicate INSERT |
| Payment count invariant | `payments_before` / `payments_after` | Returned in RETURNING for audit |

**What `PG_ASSIGN_SQL` does NOT guard:**

- No booking_source filter — manual_staff/operator overlap is caught by the same date-overlap guard, not a source-specific check. The natural convention (manual_staff/operator bookings exist in `booking_beds`) provides protection, but it's not enforced as a separate rule.
- No `automation_errors` or `workflow_events` write on conflict.
- `allowConflict` flag exists in the plan script but is NOT passed from the n8n workflow — the n8n path always uses `can_mutate` strictly.

**n8n conflict routing (confirmed by workflow inspection):**

```
Postgres - Assign Beds In Postgres (PG_ASSIGN_SQL, has overlap guard)
  → Code - Validate PG Assign
  → IF - PG Assign OK
       true  → Create Booking Bed Assignment (Airtable) → ... → success path
       false → Code - Build Assign Response → Respond to Webhook   ← SILENT FAIL (no PG audit trace)
```

The `Postgres - Mirror Assignment Conflict` node is on the **Airtable conflict branch** (`IF - Bed Assignment Conflict` → `Postgres - Mirror Assignment Conflict`), NOT on the PG conflict branch. When PG detects an overlap (`pg_ok=false`), the workflow responds but:
1. Does NOT call `Postgres - Mirror Assignment Conflict`
2. Does NOT update `bookings.assignment_status` via PG
3. Does NOT write `workflow_events` or `automation_errors`
4. Staff receives no proactive signal — they must check the webhook response log

**This is the primary gap for 3.5d.**

---

#### Reassign delete scope guard — detailed findings

**SQL:** `scripts/lib/reassign-booking-beds-pg-sql.js` (`PG_REASSIGN_DELETE_SQL`)

| Guard | Behavior |
|-------|----------|
| `resolved_count=1` | If 0 or 2+ bookings match the input, the DELETE CTE is blocked via `WHERE (SELECT c FROM resolved_count) = 1` |
| Scoped DELETE | `DELETE FROM booking_beds ... WHERE bb.booking_id = r.id AND bb.client_id = r.client_id` — only deletes for the single resolved booking |
| Payment invariant | `payments_count` field returned for audit |

**Gaps:**
- No `workflow_events` or `automation_errors` on `resolved_count≠1`
- The Airtable upstream (`Get Booking To Reassign`) must succeed before the PG delete runs; if Airtable is unavailable, the PG delete never runs — this is a safety property but also an Airtable-coupling risk
- No overlap re-check BEFORE the delete (the delete always succeeds for the target booking if `resolved_count=1`)

---

#### Cancel scope guard — detailed findings

**Script:** `scripts/cancel-booking-beds-postgres.js`

| Guard | Behavior |
|-------|----------|
| Scoped DELETE | `WHERE client_id=$1 AND booking_id=$2` — cannot touch other bookings |
| Payment invariant | Explicit transaction: throws + ROLLBACK if `payments_count_before ≠ payments_count_after` |
| `paid_like_warning` | Warns if `payment_status IN (deposit_paid, paid)` — beds still released |
| `idempotent` flag | `deleteRes.rowCount === 0` when no beds exist (no-op) |

**Gaps:**
- No `workflow_events` or `automation_errors` (CLI only; n8n workflow cancels via Airtable path in hosted, or the `Cancel (local PG)` n8n workflow)
- No I6 cancel idempotency formal doc
- Need to confirm Cancel n8n workflow behavior

---

#### Stage 3.5d test matrix

| Test | Purpose | Fixture needed | Level | Expected allowed changes | Expected non-changes | Evidence command | Hard stops | Teardown |
|------|---------|----------------|-------|--------------------------|---------------------|-----------------|------------|---------|
| **D1** Assign blocks overlapping occupied bed ✅ **L2 PASS (2026-05-29)** | Prove `PG_ASSIGN_SQL` returns `pg_ok=false` when a non-cancelled booking already occupies same bed+dates | `scripts/fixtures/phase35d-d1-overlap-up.sql` / `down.sql`. Booking A (`WH-35D-D1-OCCUPIED-A`, R1-B1, 2027-04-10→15, confirmed). Booking B (`WH-35D-D1-GUEST-B`, no beds, wants R1-B1, 2027-04-12→14) | **L2** — `report-assign-impact` | `postgres_overlap_conflicts_count: 1`; `would_overlap: true` on R1-B1; `assignment_status.would_be: needs_review`; report exits 2 (actionable: postgres_overlap_conflicts) | `booking_beds` count unchanged (report is read-only; no_insert=true); `payments=25`, `payment_events=5`, `automation_errors=0`, `workflow_events=24` unchanged | `node scripts/report-assign-impact.js --booking-code=WH-35D-D1-GUEST-B --beds=R1-B1 --check-in=2027-04-12 --check-out=2027-04-14` | — | `phase35d-d1-overlap-down.sql` → counts restored: bookings=41, booking_beds=15 |
| **D2** Assign blocks manual_staff booking overlap ✅ **L2 PASS (2026-05-29)** | Prove manual_staff bookings in `booking_beds` trigger the same overlap guard (no source bypass) | `scripts/fixtures/phase35d-d2-manual-staff-overlap-up.sql` / `down.sql`. Booking A (`WH-35D-D2-MANUAL-A`, manual_staff, R1-B2, 2027-04-20→25). Booking B (`WH-35D-D2-GUEST-B`, whatsapp, wants R1-B2, 2027-04-22→24) | **L2** — `report-assign-impact` | `postgres_overlap_conflicts_count=1`; conflicting=`WH-35D-D2-MANUAL-A`; `assignment_status.would_be=needs_review`; `availability_check_status.would_be=conflict`; exit 2 | payments=25, payment_events=5, automation_errors=0, workflow_events=24 unchanged; `no_insert=true` | `node scripts/report-assign-impact.js --booking-code=WH-35D-D2-GUEST-B --beds=R1-B2 --check-in=2027-04-22 --check-out=2027-04-24` | Overlap not detected for manual_staff source | `phase35d-d2-manual-staff-overlap-down.sql` → counts restored: bookings=41, booking_beds=15 |
| **D3** Assign blocks operator booking overlap ✅ **L2 PASS (2026-05-29)** | Prove operator bookings in `booking_beds` block guest assign (no source bypass) | `scripts/fixtures/phase35d-d3-operator-overlap-up.sql` / `down.sql`. Booking A (`WH-35D-D3-OPERATOR-A`, operator, R1-B3, 2027-05-01→06). Booking B (`WH-35D-D3-GUEST-B`, whatsapp, wants R1-B3, 2027-05-03→05) | **L2** — `report-assign-impact` | `postgres_overlap_conflicts_count=1`; conflicting=`WH-35D-D3-OPERATOR-A`; `assignment_status.would_be=needs_review`; `availability_check_status.would_be=conflict`; exit 2 | payments=25, payment_events=5, automation_errors=0, workflow_events=24 unchanged; `no_insert=true` | `node scripts/report-assign-impact.js --booking-code=WH-35D-D3-GUEST-B --beds=R1-B3 --check-in=2027-05-03 --check-out=2027-05-05` | Overlap not detected for operator source | `phase35d-d3-operator-overlap-down.sql` → counts restored: bookings=41, booking_beds=15 |
| **D4** Assign idempotent rerun | Prove a 2nd assign for the same bed+dates is a no-op (`pg_skipped_count>0`, no duplicate insert) | Booking with existing `booking_beds` row (exact bed+dates already assigned) | **L2** — `report-assign-impact` | `wouldSkip` populated; `wouldInsert=[]` | `booking_beds` count unchanged | `node scripts/report-assign-impact.js -- --booking-code=WH-D4-IDEMPOTENT` | Duplicate `booking_beds` insert | None needed |
| **D5** Reassign scope — only deletes target rows | Prove `PG_REASSIGN_DELETE_SQL` deletes only the target booking's beds, not adjacent bookings | Booking T (target, has 2 beds), Booking D (decoy on same dates, different beds) | **L2** — `report-reassign-impact` | Plan shows only target booking's bed count; decoy booking's beds not listed | Decoy `booking_beds` count unchanged | `node scripts/report-reassign-impact.js -- --booking-code=WH-D5-TARGET` | Decoy booking_beds count changes | DELETE fixture rows |
| **D6** Reassign target → occupied bed blocked | Prove the new assign step after reassign blocks on overlap (delegates to Assign guard) | Booking T (reassigned, wants new bed), Booking O (occupying new bed already) | **L3 deferred** — Airtable-coupled reassign upstream; Postgres path after delete is covered by D1 | — | — | Covered by D1 for the assign step | — | — |
| **D7** Cancel scope | Prove cancel only removes target booking's beds | Booking T (target, 2 beds), Booking D (adjacent, different beds) | **L2** — existing `cancel-impact` reports already evidence this | `booking_beds_to_delete` counts only target; plan shows only target beds | Decoy `booking_beds` unchanged | `node scripts/report-cancel-impact.js -- --booking-code=WH-D7-CANCEL` | Adjacent booking_beds impacted | DELETE fixture rows |
| **D8** Overlap log wire-in for Assign conflict ⚠️ **L3 BLOCKED (2026-05-29)** — wire-in IMPLEMENTED + static PASS; runtime deferred (Airtable-coupled upstream) | Prove that after 3.5d wire-in, `workflow_events` gains a warn row when Assign is blocked by overlap | Same as D1 fixture | **L3** — deferred to cutover | `workflow_events +1 warn/bed_assignment_blocked_overlap` | `booking_beds` count unchanged; `automation_errors=0` | `SELECT * FROM workflow_events WHERE message='bed_assignment_blocked_overlap'` | webhook path runs Airtable upstream before PG branch | DELETE fixture + `workflow_events` row |
| **D9** Main rooming call delegates to Assign guard | Prove Main's assign call path reaches the same PG guard | Airtable-coupled upstream | **L3 deferred** | — | — | Covered by D8 for PG path | — | — |
| **D10** Protected payment counts unchanged | Prove payment/payment_events/booking_beds counts are unchanged for all D1–D7 tests | Part of each D1–D7 fixture | **L2** (invariant) | Only `booking_beds` changes as intended per test | `payments`, `payment_events` counts unchanged | `SELECT COUNT(*) FROM payments; SELECT COUNT(*) FROM payment_events;` | Any payment count change | Part of each test teardown |

---

#### D1 L2 evidence (2026-05-29)

**Command:** `node scripts/report-assign-impact.js --booking-code=WH-35D-D1-GUEST-B --beds=R1-B1 --check-in=2027-04-12 --check-out=2027-04-14`  
**Exit code:** 2 (actionable: `postgres_overlap_conflicts`)  
**Report:** `reports/assign-impact-WH-35D-D1-GUEST-B-2026-05-29T13-59-06.json`

Key fields from report JSON:
```json
"summary": {
  "existing_booking_beds_count": 0,
  "would_insert_count": 1,
  "postgres_overlap_conflicts_count": 1,
  "payments_rows": 0
},
"postgres_overlap_conflicts": [{
  "proposed_bed_code": "R1-B1",
  "proposed_dates": { "start": "2027-04-12", "end": "2027-04-14" },
  "conflicting_booking_code": "WH-35D-D1-OCCUPIED-A",
  "conflicting_dates": { "start": "2027-04-10", "end": "2027-04-15" },
  "conflicting_booking_status": "confirmed"
}],
"booking_fields_would_update_if_assign_ran": {
  "assignment_status": { "would_be": "needs_review" },
  "availability_check_status": { "would_be": "conflict" }
},
"read_only": true, "no_mutations": true, "no_insert": true
```

**Design note on `would_insert_count: 1`:** The impact report includes overlapping beds in `wouldInsert` with `would_overlap: true` for visibility. The actual execution block lives in `PG_ASSIGN_SQL`'s `can_mutate=false` CTE (when `overlap_count > 0`). The impact report is a planning tool; it does not perform the INSERT. `no_insert: true` confirms no mutation occurred.

**Pre/post/teardown counts:**

| Metric | Pre-seed | After seed | After report | After teardown |
|--------|----------|-----------|--------------|----------------|
| bookings | 41 | 43 | 43 | **41** ✓ |
| booking_beds | 15 | 16 | 16 | **15** ✓ |
| payments | 25 | 25 | 25 | **25** ✓ |
| payment_events | 5 | 5 | 5 | **5** ✓ |
| automation_errors | 0 | 0 | 0 | **0** ✓ |
| workflow_events | 24 | 24 | 24 | **24** ✓ |

**Gap confirmed:** When the real Assign n8n workflow detects a PG overlap (`IF - PG Assign OK` false branch), it routes directly to response with no `workflow_events` write and no `bookings.assignment_status` PG update. D8 (wire-in) will fix this.

---

#### D2 L2 evidence (2026-05-29)

**Command:** `node scripts/report-assign-impact.js --booking-code=WH-35D-D2-GUEST-B --beds=R1-B2 --check-in=2027-04-22 --check-out=2027-04-24`  
**Exit code:** 2 (actionable: `postgres_overlap_conflicts`)  
**Report:** `reports/assign-impact-WH-35D-D2-GUEST-B-2026-05-29T16-09-27.json`

Key findings:
- `postgres_overlap_conflicts_count: 1`
- Conflicting booking: `WH-35D-D2-MANUAL-A` (`manual_staff` source) on R1-B2, `2027-04-20→2027-04-25`
- `assignment_status.would_be: needs_review`; `availability_check_status.would_be: conflict`
- `read_only: true`, `no_insert: true`, `payments_rows: 0`

**Proof:** `manual_staff` booking source does NOT bypass the overlap guard. The overlap query filters only on `b.status NOT IN ('cancelled', 'expired')` — source is irrelevant.

**Count proof (D2):**

| Metric | Pre-seed | After seed | After report | After teardown |
|--------|----------|-----------|--------------|----------------|
| bookings | 41 | 43 | 43 | **41** ✓ |
| booking_beds | 15 | 16 | 16 | **15** ✓ |
| payments | 25 | 25 | 25 | **25** ✓ |
| payment_events | 5 | 5 | 5 | **5** ✓ |
| automation_errors | 0 | 0 | 0 | **0** ✓ |
| workflow_events | 24 | 24 | 24 | **24** ✓ |

---

#### D3 L2 evidence (2026-05-29)

**Command:** `node scripts/report-assign-impact.js --booking-code=WH-35D-D3-GUEST-B --beds=R1-B3 --check-in=2027-05-03 --check-out=2027-05-05`  
**Exit code:** 2 (actionable: `postgres_overlap_conflicts`)  
**Report:** `reports/assign-impact-WH-35D-D3-GUEST-B-2026-05-29T16-10-04.json`

Key findings:
- `postgres_overlap_conflicts_count: 1`
- Conflicting booking: `WH-35D-D3-OPERATOR-A` (`operator` source) on R1-B3, `2027-05-01→2027-05-06`
- `assignment_status.would_be: needs_review`; `availability_check_status.would_be: conflict`
- `read_only: true`, `no_insert: true`, `payments_rows: 0`

**Proof:** `operator` booking source does NOT bypass the overlap guard. Same filter logic as D2 — source is irrelevant.

**Count proof (D3):**

| Metric | Pre-seed | After seed | After report | After teardown |
|--------|----------|-----------|--------------|----------------|
| bookings | 41 | 43 | 43 | **41** ✓ |
| booking_beds | 15 | 16 | 16 | **15** ✓ |
| payments | 25 | 25 | 25 | **25** ✓ |
| payment_events | 5 | 5 | 5 | **5** ✓ |
| automation_errors | 0 | 0 | 0 | **0** ✓ |
| workflow_events | 24 | 24 | 24 | **24** ✓ |

**D1–D3 combined conclusion:** The PG overlap guard in `assign-booking-beds-plan.js` / `PG_ASSIGN_SQL` blocks ALL non-cancelled bookings regardless of `booking_source`. `whatsapp`, `manual_staff`, and `operator` sources are all treated identically — there is no source bypass. The gap remains: when the n8n workflow detects a PG overlap (`IF - PG Assign OK` false), it is silent — no `workflow_events`, no `automation_errors`, no PG `assignment_status` update. This is the target of D8 (wire-in).

---

#### Recommended first implementation target

**3.5d.1 — L2 fixture proof for D1 (Assign overlap blocked). ✅ COMPLETE**

**Why first:**
1. `report-assign-impact.js` already exists and is read-only — no activation, no runtime.
2. A simple two-booking fixture (one occupying, one guest) can prove the overlap guard in a single report run.
3. This establishes the proof pattern for D2 and D3 (manual_staff, operator) without any additional tooling.
4. The L2 proof is required before the 3.5d wire-in (D8) to confirm the guard works correctly before adding logging on top.

**What to do:** Create `scripts/fixtures/phase35d-d1-overlap-up.sql` / `down.sql` with two bookings sharing a bed on overlapping dates. Run `node scripts/report-assign-impact.js` against the guest booking. Confirm `hasOverlaps=true`, `wouldInsert=[]`, `overlapConflicts` shows the occupying booking.

**Why not D8 (wire-in) first:** The wire-in requires editing the generated `build-assign-beds-local.js` to add nodes to the false branch of `IF - PG Assign OK`. Before modifying the workflow, we should have L2 evidence that the overlap guard itself is working correctly as a baseline.

---

#### Assign overlap logging wire-in — IMPLEMENTED (2026-05-29) / NOT RUNTIME TESTED

**Files changed:**
- `scripts/build-assign-beds-local.js` — added `WE_OVERLAP_CONFLICT_SQL` constant, `BUILD_PG_OVERLAP_EVENT_JS` constant, 3 new nodes, rewired `IF - PG Assign OK` false branch
- `n8n/phase3b/Wolfhouse - Bed Assignment (local PG).json` — regenerated (24 → 27 nodes)
- `n8n/phase3b/Wolfhouse - Bed Assignment (local PG).n8n-import.json` — regenerated

**Static verification results (2026-05-29):**
- Node count: 27 ✓ (was 24)
- `active: false` ✓
- `workflow id: B3c2AssignLocalPg01` ✓
- All 3 new nodes present ✓
- `IF - PG Assign OK` false → `Code - Build PG Overlap Event` ✓
- Chain: `Code - Build PG Overlap Event` → `Postgres - Write workflow_events (overlap conflict)` → `Postgres - Mirror PG Assignment Conflict` → `Code - Build Assign Response` ✓
- True branch unchanged (`Create Booking Bed Assignment`) ✓
- Airtable conflict path unchanged (`IF - Bed Assignment Conflict` → `Postgres - Mirror Assignment Conflict` → `Update Booking Assignment Status - Conflict`) ✓
- No new payment writer nodes ✓
- `WE_OVERLAP_CONFLICT_SQL` uses `'warn'::workflow_event_level`, `NULLIF(...booking_id...)::uuid`, `clients c WHERE c.slug = 'wolfhouse-somo'` ✓
- `Postgres - Mirror PG Assignment Conflict` uses `PG_CONFLICT_MIRROR_SQL` (contains `needs_review`, `conflict`, `assignment_status`) ✓
- Hosted `n8n/Wolfhouse - Bed Assignment.json` unchanged ✓

**D8 runtime test: BLOCKED (2026-05-29) — deferred to Airtable/PG cutover.**

**Pre-flight blocker (caught during static analysis; no DB/workflow mutation performed):**

The wire-in is correct and statically verified, but the D8 runtime as designed (seed PG fixture → activate Assign → POST webhook) **cannot faithfully reach the new overlap conflict branch** because the Assign workflow's bed-selection path is **Airtable-coupled upstream** of the PG assign node. The webhook chain is:

```
Webhook → Parse → IF Parse OK
  → Get Booking                     (Airtable read, by airtable_record_id)
  → IF Needs Bed Assignment
  → Update Booking - Mark Assigning (Airtable WRITE)
  → Search Active Beds              (Airtable)
  → Search Existing Bed Assignments (Airtable)
  → Search Rooms                    (Airtable)
  → Code - Choose Beds              (builds beds from the Airtable results)
  → IF - Bed Assignment Conflict
  → Code - Build PG Beds JSON       (reads ONLY from Code - Choose Beds)
  → Postgres - Assign Beds In Postgres
  → Code - Validate PG Assign
  → IF - PG Assign OK  false → [new 3.5d overlap chain]
```

Four independent reasons the PG-only fixture cannot exercise the branch:

1. **`Get Booking` is Airtable.** For `WH-35D-D1-GUEST-B`, the Parse node maps `booking_code` → `airtable_record_id=''` (stripping `WH-` yields `35D-D1-GUEST-B`, which is not a `rec…` id). `Get Booking` receives an empty id and fails/returns nothing — the chain never reaches PG.
2. **`Update Booking - Mark Assigning` is an Airtable WRITE** sitting upstream of the PG assign. Reaching the PG branch requires this Airtable write to execute, which violates the D8 non-negotiable "No real Airtable writes / Airtable write path executes unexpectedly = hard stop."
3. **The webhook `beds` field is never read.** `Code - Build PG Beds JSON` builds `beds_json` exclusively from `Code - Choose Beds` (Airtable-derived). The plan's POST body `"beds":"R1-B1"` is ignored.
4. **Empty beds → success path, not conflict path.** Even if Airtable returned the booking but chose no beds, `PG_ASSIGN_SQL` would compute `overlap_count=0` → `can_mutate=true` → `pg_ok=true` → the workflow takes the TRUE/success branch and never the overlap false branch.

This is the same Airtable coupling that caused rooming L3 runtime to be deferred to cutover (see 3e.5 L3 deferral). It is consistent with the D6/D9 deferral rationale already in this matrix.

**What IS proven for the Assign overlap guard:**
- **L2 (D1/D2/D3 PASS):** `PG_ASSIGN_SQL`/`assign-booking-beds-plan.js` correctly blocks overlapping assignments for `whatsapp`, `manual_staff`, and `operator` sources — no source bypass.
- **Static (wire-in PASS):** the false branch is correctly rewired to `Code - Build PG Overlap Event` → `Postgres - Write workflow_events (overlap conflict)` → `Postgres - Mirror PG Assignment Conflict` → `Code - Build Assign Response`, with `warn`-level logging and `PG_CONFLICT_MIRROR_SQL` status mirror, and no new payment writers.

**Baseline at block time (read-only; nothing seeded/activated/posted):**
- All 8 target workflows `active=false` (Assign `B3c2AssignLocalPg01` included).
- No `WH-35D-*` leftovers in `bookings`.

**Remediation options for a future faithful D8 runtime (no implementation done here):**
- **Option 1 — PG-only local trigger path (recommended, aligns with north-star):** add a local-only entry to the Assign workflow that resolves the booking from Postgres and builds `beds_json` from the webhook body, bypassing the Airtable `Get Booking`/`Search`/`Choose Beds` upstream. This lets the PG overlap branch (and the new wire-in) be exercised without Airtable. Implementation task `3.5d.8b`.
- **Option 2 — Defer to Airtable/PG cutover:** keep D8 deferred alongside D6/D9; rely on D1–D3 L2 + static wire-in verification until the Airtable upstream is removed at cutover. The wire-in then gets its first real runtime as part of cutover validation.

#### Assign overlap logging wire-in design (3.5d — IMPLEMENTED)

**Target:** `scripts/build-assign-beds-local.js` (generated workflow; edits go to the build script, not the JSON directly)

**Current false-branch termination:**
```
IF - PG Assign OK false → Code - Build Assign Response → Respond to Webhook
```

**Proposed false-branch after wire-in:**
```
IF - PG Assign OK false → Code - Build PG Overlap Event
                             → Postgres - Write workflow_events (overlap conflict)
                             → Postgres - Mirror PG Assignment Conflict   (new PG booking status update)
                             → Code - Build Assign Response
                             → Respond to Webhook
```

**Why `workflow_events` (warn), not `automation_errors`:**
- Overlap conflict is an expected operational event (bed already occupied), not an application crash or silent failure.
- Staff needs to review and resolve, but it's a planned outcome, not an unhandled error.
- `automation_errors` should be reserved for unexpected crashes (the Error Trigger pattern from 3.5b).
- Using `event_level='warn'` in `workflow_events` provides an audit trail without polluting the error table.

**Node designs:**

1. `Code - Build PG Overlap Event` (Code node)
   ```javascript
   const pgResult = $json; // from Postgres - Assign Beds In Postgres via IF - PG Assign OK
   const parsed = $('Code - Parse Assign Webhook').first().json;
   const bookingId = $('Code - Build PG Beds JSON').first().json.booking_id || null;
   const execId = String($execution.id);
   return [{
     json: {
       workflow_name: 'Wolfhouse - Bed Assignment (local PG)',
       execution_id: execId,
       event_level: 'warn',
       message: 'bed_assignment_blocked_overlap',
       booking_id: bookingId,
       conversation_id: null,
       payload: {
         booking_code: pgResult.booking_code || parsed.booking_code,
         pg_conflict_count: pgResult.pg_conflict_count,
         pg_unknown_count: pgResult.pg_unknown_count,
         pg_ok: pgResult.pg_ok,
         can_mutate: pgResult.can_mutate,
         beds_requested_count: pgResult.beds_requested_count,
         outcome: 'blocked_overlap',
       }
     }
   }];
   ```

2. `Postgres - Write workflow_events (overlap conflict)` (Postgres `executeQuery`, SQL):
   ```sql
   INSERT INTO workflow_events (workflow_name, execution_id, event_level, message, booking_id, conversation_id, payload)
   VALUES ($1, $2, $3, $4, $5::uuid, $6, $7::jsonb)
   ```

3. `Postgres - Mirror PG Assignment Conflict` (NEW — mirrors the `PG_CONFLICT_MIRROR_SQL` already used on the Airtable conflict path):
   - This updates `bookings.assignment_status = 'needs_review'` and `availability_check_status = 'conflict'` for the target booking via PG.
   - **Note:** The Airtable path already calls `Postgres - Mirror Assignment Conflict` for Airtable-detected conflicts. The PG path should call the same SQL to keep state consistent.

**Runtime test idea:**
- Create fixture: Booking A (occupying bed), Booking B (guest wants same bed)
- Seed both into DB; no `booking_beds` for Booking B yet
- Activate Assign workflow only
- POST Assign webhook for Booking B targeting the occupied bed
- Expected: HTTP response shows conflict; `workflow_events +1 warn/bed_assignment_blocked_overlap`; `booking_beds` count unchanged; `bookings.assignment_status for B = needs_review`
- Teardown: DELETE fixture rows + `workflow_events` row

**Belongs before or after L2 fixture proof:**
- L2 fixture proof FIRST (D1) — confirm the guard works before adding logging on top.
- Wire-in implementation SECOND (D8) — after L2 evidence.

---

#### 3.5d closeout criteria

All of the following before Stage 3.5d is complete:
- D1 L2 fixture PASS (Assign overlap blocked — report evidence)
- D2 L2 fixture PASS (manual_staff overlap blocked — report evidence)
- D3 L2 fixture PASS (operator overlap blocked — report evidence)
- D4 L2 fixture PASS (idempotent rerun — plan shows wouldSkip)
- D5 L2 fixture PASS (reassign scope — decoy protected)
- D7 L2 PASS (cancel scope — already evidenced by prior cancel-impact reports; re-confirm)
- D8 L3 runtime PASS (Assign overlap logs `workflow_events warn` + PG mirror — requires wire-in first)
- D6, D9 deferred to cutover (Airtable-coupled) — documented with written reason

---

### 3.5e — Basic execution logging and incident trace

**Work type:** Schema already exists; wire-in is workflow/code change  
**Status:** IMPLEMENTED (Send Confirmation success path) / NOT RUNTIME TESTED (2026-05-29)

**Send Confirmation success-path wire-in (2026-05-29):**

Two nodes added to `scripts/build-send-confirmation-local.js` (regenerated to `n8n/phase2/Wolfhouse - Send Confirmation (local).json`):

| Node | Type | ID | Wired from |
|------|------|----|------------|
| `Code - Build Confirmation Success Event` | Code | `2d010024-0024-…` | `Postgres - Mark Booking Confirmed` output |
| `Postgres - Write workflow_events (confirmation success)` | Postgres | `2d010025-0025-…` | `Code - Build Confirmation Success Event` |

**Success path chain (complete):**
```
IF - WhatsApp Sent OK true →
  Postgres - Mark Booking Confirmed →
  Code - Build Confirmation Success Event →
  Postgres - Write workflow_events (confirmation success)   ← NEW (terminal)
```

**Payload logged:** `action=send_confirmation`, `outcome=confirmation_sent`, `booking_code`, `dry_run`, `whatsapp_sent`, `confirmation_sent_at`, `source_node=Postgres - Mark Booking Confirmed`.

**Static verification (2026-05-29):** Total nodes 25 (was 23 after 3.5b → 24 err: now 25); all 25 node names confirmed; success chain wired; all 3.5b paths intact; no `payments`/`payment_events` writes; hosted export unchanged (12 nodes); `active:false`.

#### 3.5e Send Confirmation success-path runtime — **PASS (2026-05-29)**

**Result:** PASS. A successful dry-run confirmation writes exactly one `info`-level
`workflow_events` row with `outcome=confirmation_sent`, the booking is marked confirmed,
and no protected payment tables are touched.

**Evidence:**

| Item | Value |
|------|-------|
| Fixture | `WH-35E-TEST-1` (`b35e0000-0000-4000-8000-000000000001`), `payment_pending` / `deposit_paid` / `send_confirmation=true` / `confirmation_sent_at NULL` |
| Trigger | `POST /webhook/send-confirmation-local` `{"booking_id":"b35e0000-…01"}` |
| Execution id | **1090** (`status=success`, finished) |
| Env | `WHATSAPP_DRY_RUN=true`, token EMPTY, phone EMPTY (dry-run; no real send) |
| Booking after | `status=confirmed`, `send_confirmation=false`, `confirmation_sent_at=2026-05-29 12:50:49.41116+00` — confirmed (correct) |
| `workflow_events` | **+1** (24→25): `event_level=info`, `node_name=Postgres - Mark Booking Confirmed`, `execution_id=1090`, `booking_id=b35e…01`, `message="Send Confirmation marked booking confirmed"`, payload `{action=send_confirmation, outcome=confirmation_sent, dry_run=true, whatsapp_sent=true, booking_code=WH-35E-TEST-1, source_node=Postgres - Mark Booking Confirmed, confirmation_sent_at=...}` |
| `automation_errors` for fixture | **0** (correct — success path, no error) |
| Protected counts | payments=25, payment_events=5, booking_beds=15 — unchanged throughout |
| Other workflows | Max exec ids unchanged: Main=1082, Reassign=1083, Assign=1084, Stripe=1086, CPS=1065, CPS stub=1037, Cancel=305 |
| Activation boundary | Send Confirmation `gxivKRJexzTCw9x6` only |
| Teardown | `WH-35E-TEST-1` rows deleted; counts back to 25/5/15/0/24 |
| Env verified | DRY_RUN=true throughout (never changed); both `n8n-main` + `n8n-worker` |
| Final state | All workflows `active=false`; schedule node `disabled=true` |

**Fixtures:** [`scripts/fixtures/phase35e-confirm-success-up.sql`](../scripts/fixtures/phase35e-confirm-success-up.sql) / [`phase35e-confirm-success-down.sql`](../scripts/fixtures/phase35e-confirm-success-down.sql) (reversible).

**Send Confirmation now has full execution-trace coverage:** success (`info`/`confirmation_sent`), WhatsApp failure (`error` + `automation_errors`, Gap 2 PASS), no-pending (`info`, untested), workflow crash (`automation_errors`, untested).

**Goal:** Ensure every execution of a dangerous workflow emits a `workflow_events` row with sufficient fields to reconstruct what happened during a live incident.

**Schema already exists (migration 001):**

`workflow_events` fields: `workflow_name`, `execution_id`, `event_level`, `message`, `booking_id`, `conversation_id`, `payload` (JSONB).

**Minimum log record per dangerous-workflow execution:**

```json
{
  "workflow_name": "Wolfhouse Booking Assistant - Main (local Stripe)",
  "execution_id": "1087",
  "event_level": "info",
  "message": "send_confirmation: payment_pending → confirmed (dry-run)",
  "booking_id": "b3e60000-0000-4000-8000-000000000001",
  "conversation_id": null,
  "payload": {
    "wamid": "wamid.PHASE...",
    "resolved_route": "send_confirmation",
    "confidence": 0.95,
    "action": "mark_confirmed",
    "idempotency_key": "send_confirmation:b3e60000-0000-4000-8000-000000000001",
    "dry_run": true,
    "outcome": "confirmed"
  }
}
```

**Required fields (minimum for Stage 3.5):**

| Field | Source | Notes |
|-------|--------|-------|
| `workflow_name` | n8n env/node | Always available |
| `execution_id` | n8n `$execution.id` | Always available |
| `booking_id` | Workflow context | NULL if not resolved |
| `conversation_id` | Workflow context | NULL if not available |
| `message` | Code node | Human-readable action summary |
| `payload.resolved_route` | `Code - Parse Route` output | |
| `payload.action` | Code node | `mark_confirmed` / `assign_beds` / `reassign_beds` / etc. |
| `payload.outcome` | Code node | `completed` / `no_op` / `deferred` / `error` |
| `payload.dry_run` | Env flag | `WHATSAPP_DRY_RUN` value at time of execution |

**Wire-in priority:** Same as 3.5b — Send Confirmation first (simplest Postgres path), then bed-ops, then Stripe Webhook, then Main dangerous-action branches.

**This is not:** Full observability dashboards (Stage 4). It is a lightweight INSERT at the end of each dangerous-action branch, even a `Code` node calling a Postgres INSERT.

---

### 3.5f — Stripe/payment duplicate gates

**Work type:** Protected payment-table gate (requires explicit approval per write)  
**Status:** PLANNED — I3 BLOCKED pending implementation guard; runtime DEFERRED until guard implemented + payment-table write explicitly approved

**Goal:** Complete deferred idempotency runtime proofs I2 and I3 from Stage 3e.6.

---

#### I3 — Duplicate Stripe event id runtime

**Status: RUNTIME PASS (2026-05-29) — guard IMPLEMENTED / Gate A PASS / Gates B–F PASS**

---

##### A. Schema-level guard (confirmed 2026-05-29)

- **`payment_events.stripe_event_id TEXT UNIQUE`** — present in `database/migrations/001_init.sql` line 458 and confirmed in running DB.
- Migration 003 renamed `hostel_id` → `client_id` in both `payments` and `payment_events` tables. The Stripe Webhook Handler JSON already uses `client_id` in its CTE insert.
- `payment_record_status` enum values: `{draft, checkout_created, pending, paid, expired, cancelled, failed}`
- `payment_kind` enum values: `{deposit_only, full_amount}`

**`payments` columns (running DB, post-migration 003):**

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | UUID PK | NO | `gen_random_uuid()` |
| `client_id` | UUID FK → clients | NO | required in fixture |
| `booking_id` | UUID FK → bookings | NO | required in fixture |
| `status` | `payment_record_status` | NO | DEFAULT `'draft'`; fixture uses `'checkout_created'` |
| `payment_kind` | `payment_kind` | NO | DEFAULT `'deposit_only'` |
| `currency` | CHAR(3) | NO | DEFAULT `'EUR'` |
| `amount_due_cents` | INTEGER | NO | required (no default) |
| `stripe_checkout_session_id` | TEXT UNIQUE | YES | **must match event `session.id`** |
| `stripe_payment_intent_id` | TEXT | YES | partial UNIQUE if NOT NULL |
| `checkout_url` | TEXT | YES | |
| `paid_at` | TIMESTAMPTZ | YES | set by webhook CTE UPDATE |
| `expires_at` | TIMESTAMPTZ | YES | |
| `metadata` | JSONB | NO | DEFAULT `'{}'` |
| `amount_paid_cents` | INTEGER | NO | DEFAULT `0` |

**`payment_events` columns (running DB, post-migration 003):**

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | UUID PK | NO | |
| `client_id` | UUID FK → clients | NO | populated from `payments.client_id` in CTE |
| `payment_id` | UUID FK → payments | YES | `ON DELETE SET NULL` |
| `booking_id` | UUID FK → bookings | YES | `ON DELETE SET NULL` |
| `stripe_event_id` | TEXT **UNIQUE** | YES | **the idempotency guard** |
| `event_type` | TEXT | NO | |
| `payload` | JSONB | NO | |
| `processed` | BOOLEAN | NO | DEFAULT `false` |
| `processing_error` | TEXT | YES | |
| `created_at` | TIMESTAMPTZ | NO | DEFAULT `now()` |

---

##### B. Stripe Webhook Handler workflow (inspected 2026-05-29)

- **File:** `n8n/phase2/Wolfhouse - Stripe Webhook Handler.json`
- **n8n workflow ID:** `KZUQvwR6SPWpvaZ5` (confirmed in n8n DB — 6 rows exist with this name; `KZUQvwR6SPWpvaZ5` is the local gate workflow from prior Phase 3d evidence)
- **Type:** **Direct JSON** — no build script. Edits go directly to the JSON file (not generated).
- **Node count:** 8 nodes (7 logic + 1 sticky note)

**Node flow:**

```
Webhook - Stripe (POST /webhook/stripe-webhook)
  → Code - Verify Signature          [verifies HMAC or skips if STRIPE_WEBHOOK_SKIP_VERIFY=true]
  → Code - Parse Stripe Event         [extracts stripe_event_id, session_id, booking_id, amount, etc.]
  → IF - Payment Event?               [skip=false → true branch; skip=true → false branch]
       true  → Postgres - Apply Payment Success   [single CTE: ev + pay + bookings UPDATE]
                 → Respond - Payment Applied       [200: {received:true, processed:true, booking_id, ...}]
       false → Respond - Ignored Event            [200: {received:true, processed:false}]
```

**Event parsing (`Code - Parse Stripe Event`):**

Only `checkout.session.completed` events proceed to the payment CTE. All other event types go to `Respond - Ignored Event`. Required fields from event:

| Field extracted | Source path |
|----------------|-------------|
| `stripe_event_id` | `event.id` |
| `event_type` | `event.type` |
| `session_id` | `event.data.object.id` |
| `payment_intent_id` | `event.data.object.payment_intent` (string or `{id}`) |
| `booking_id` | `event.data.object.metadata.booking_id` ← **REQUIRED; throws if missing** |
| `client_id` | `event.data.object.metadata.client_id` (optional) |
| `payment_kind` | `event.data.object.metadata.payment_kind` (defaults to `'deposit_only'` if not `'full_amount'`) |
| `amount_paid_cents` | `event.data.object.amount_total ?? 0` |

**CTE in `Postgres - Apply Payment Success`** (single transaction):

```sql
WITH ev AS (
  INSERT INTO payment_events (client_id, payment_id, booking_id, stripe_event_id, event_type, payload, processed)
  SELECT p.client_id, p.id, p.booking_id, $1, $2, $3::jsonb, true
  FROM payments p
  WHERE p.stripe_checkout_session_id = $4
  ON CONFLICT (stripe_event_id) DO NOTHING          -- ← idempotency guard
  RETURNING payment_id, booking_id, client_id
),
pay AS (
  UPDATE payments p SET status='paid', amount_paid_cents=$5,
    stripe_payment_intent_id=COALESCE($6, p.stripe_payment_intent_id), paid_at=NOW()
  FROM ev
  WHERE p.stripe_checkout_session_id = $4 AND ev.payment_id = p.id
  RETURNING p.booking_id, p.payment_kind, p.amount_due_cents, p.id AS payment_id
)
UPDATE bookings b SET
  payment_status = CASE WHEN pay.payment_kind='full_amount' THEN 'paid' ELSE 'deposit_paid' END,
  deposit_paid_cents = CASE WHEN pay.payment_kind='deposit_only' THEN COALESCE(b.deposit_paid_cents,0)+$5 ELSE b.deposit_paid_cents END,
  amount_paid_cents = COALESCE(b.amount_paid_cents,0) + $5,
  balance_due_cents = GREATEST(COALESCE(b.total_amount_cents,0)-(COALESCE(b.amount_paid_cents,0)+$5),0),
  send_confirmation = TRUE
FROM pay WHERE b.id = pay.booking_id
RETURNING b.id AS booking_id, b.payment_status, b.deposit_paid_cents, b.amount_paid_cents,
          b.balance_due_cents, b.send_confirmation, pay.payment_kind, pay.payment_id;
```

- `$1` = `stripe_event_id`, `$2` = `event_type`, `$3` = `JSON.stringify(payload)`, `$4` = `session_id`, `$5` = `amount_paid_cents`, `$6` = `payment_intent_id`
- The CTE lookup for `payments` uses `stripe_checkout_session_id = $4` — the fixture payment row MUST have `stripe_checkout_session_id` set to the crafted session id.
- The CTE does NOT set `bookings.status`; it only sets `bookings.payment_status` and `bookings.send_confirmation`.

---

##### C. Critical finding: duplicate event HTTP behavior

**DB level (SAFE):**

On 2nd POST with the same `stripe_event_id`:
1. `ev` CTE: `ON CONFLICT (stripe_event_id) DO NOTHING` → 0 rows inserted → 0 rows RETURNING
2. `pay` CTE: `FROM ev` empty → WHERE clause never matches → 0 rows
3. Final UPDATE: `FROM pay` empty → WHERE clause never matches → 0 rows
4. Overall CTE returns **0 rows**

Result: no double-insert into `payment_events`, no duplicate `payments` update, no duplicate `bookings` promotion. **DB is idempotent.**

**HTTP level (UNSAFE — implementation guard required):**

The `Postgres - Apply Payment Success` node does NOT have `alwaysOutputData: true`. When the CTE returns 0 rows, the Postgres node outputs **0 items**. `Respond - Payment Applied` has no items to process and **does not fire**.

The webhook is in `responseMode: responseNode`. When the respond node does not fire, n8n waits for it until the webhook execution timeout. The HTTP response is a **timeout or 502 error** (no `200` returned to the caller).

**Consequence in production:** Stripe interprets non-200 as a delivery failure and **retries the event** (typically up to 3 days, with exponential backoff). Each retry triggers another 0-row CTE no-op + timeout. This creates an endless retry loop that:
- Clogs n8n execution history
- May result in Stripe suspending the webhook endpoint
- Is NOT a data-safety issue (DB is protected), but IS an operational issue

**This is the implementation guard required before runtime.**

---

##### D. Implementation guard design

**Option A — Minimal (not recommended):**
Add `"alwaysOutputData": true` to `Postgres - Apply Payment Success` node. The Respond node fires with `{booking_id: undefined, ...}`. 200 returned but response is misleading.

**Option B — Recommended:**
After `Postgres - Apply Payment Success`, add a branching path to handle the 0-row case:

```
Postgres - Apply Payment Success
  [has booking_id row] → Respond - Payment Applied      (existing node)
  [no rows / duplicate] → Respond - Duplicate Acknowledged  (NEW node)
     response: { received: true, processed: false, reason: "duplicate_event", stripe_event_id: "..." }
```

Implementation approach:
1. Add `"alwaysOutputData": true` to `Postgres - Apply Payment Success` so it always emits at least one item.
2. Add an `IF - New Payment Row?` node: `$json.booking_id` is not empty → true branch (existing respond); false → new respond.
3. Add `Respond - Duplicate Acknowledged` node (200, JSON body with `duplicate_event` reason).
4. Update `connections` in the JSON to wire correctly.

This edit is to `n8n/phase2/Wolfhouse - Stripe Webhook Handler.json` (direct JSON, not generated).

**Status of guard:** IMPLEMENTED (2026-05-29) — NOT YET RUNTIME TESTED.

**Nodes added to `n8n/phase2/Wolfhouse - Stripe Webhook Handler.json`:**

| Node | ID | Type | Position | Change |
|------|----|------|----------|--------|
| `IF - New Payment Row?` | `2b102010-0010-4000-8000-000000000010` | `n8n-nodes-base.if` | [1200, 0] | NEW |
| `Respond - Duplicate Acknowledged` | `2b102011-0011-4000-8000-000000000011` | `n8n-nodes-base.respondToWebhook` | [1440, 120] | NEW |
| `Postgres - Apply Payment Success` | `2b102007-0007-4000-8000-000000000007` | (existing) | [960, 120] | `alwaysOutputData: true` added to `options` |

**Updated wiring:**

```
Postgres - Apply Payment Success → IF - New Payment Row?
IF - New Payment Row? true  (booking_id not empty) → Respond - Payment Applied   (HTTP 200, processed:true)
IF - New Payment Row? false (booking_id empty/null) → Respond - Duplicate Acknowledged (HTTP 200, processed:false)
```

**IF condition:** `$json.booking_id` `notEmpty` (loose type validation — `undefined` coerces to `""`, evaluated as empty → false branch for duplicate).

**Respond - Duplicate Acknowledged body:**
```json
{
  "received": true,
  "processed": false,
  "reason": "duplicate_event",
  "stripe_event_id": "{{ $('Code - Parse Stripe Event').item.json.stripe_event_id }}"
}
```

**No new `payments` or `payment_events` write nodes added.** Total Postgres nodes: 1 (unchanged CTE logic).

**Node count:** 8 → 10 (+ `IF - New Payment Row?` + `Respond - Duplicate Acknowledged`; sticky note updated).

---

##### E. I3 fixture design (planning only — DO NOT seed without explicit approval)

**⚠ PROTECTED TABLE WRITE: the fixture inserts one row into `payments`. Requires explicit approval before execution.**

**Fixture booking:**

```sql
INSERT INTO bookings (
  id, client_id, booking_code, guest_name, phone, email,
  status, payment_status, check_in, check_out, guest_count,
  send_confirmation, booking_source, total_amount_cents, deposit_required_cents
) VALUES (
  'b35c0000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'WH-35C-I3-TEST-1',
  'I3 Idemp Test Guest',
  '+10000000035',
  'i3test@example.invalid',
  'payment_pending',
  'not_requested',
  CURRENT_DATE + INTERVAL '60 days',
  CURRENT_DATE + INTERVAL '63 days',
  1,
  FALSE,
  'whatsapp',
  20000,
  10000
);
```

**Fixture payment row (PROTECTED TABLE):**

```sql
INSERT INTO payments (
  id, client_id, booking_id, status, payment_kind,
  amount_due_cents, stripe_checkout_session_id, currency
) VALUES (
  'a35c0000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'b35c0000-0000-4000-8000-000000000001',
  'checkout_created',
  'deposit_only',
  10000,
  'cs_test_i3_idemp_001',
  'EUR'
);
```

No `booking_beds` row required. No `payment_events` row initially.

**Reversible teardown plan (down.sql):**

```sql
DELETE FROM payment_events WHERE stripe_event_id = 'evt_test_idemp_i3_001';
DELETE FROM payments WHERE id = 'a35c0000-0000-4000-8000-000000000001';
DELETE FROM bookings WHERE booking_code = 'WH-35C-I3-TEST-1';
-- Verify:
SELECT COUNT(*) FROM payments WHERE id = 'a35c0000-0000-4000-8000-000000000001'; -- must be 0
SELECT COUNT(*) FROM bookings WHERE booking_code = 'WH-35C-I3-TEST-1'; -- must be 0
```

**Fixture requirements checklist:**
- [ ] `payments` INSERT explicitly approved by user before execution
- [ ] No `booking_beds` row (not needed by webhook CTE)
- [ ] No initial `payment_events` row (created by 1st POST)
- [ ] `stripe_checkout_session_id = 'cs_test_i3_idemp_001'` must exactly match event's `data.object.id`
- [ ] `client_id = 'a0000000-0000-4000-8000-000000000001'` — confirmed from running `SELECT id FROM clients LIMIT 1`

---

##### F. Crafted duplicate event design

**Event JSON (POST #1 and POST #2 are identical):**

```json
{
  "id": "evt_test_idemp_i3_001",
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "cs_test_i3_idemp_001",
      "payment_intent": "pi_test_i3_idemp_001",
      "amount_total": 10000,
      "metadata": {
        "booking_id": "b35c0000-0000-4000-8000-000000000001",
        "client_id": "a0000000-0000-4000-8000-000000000001",
        "payment_kind": "deposit_only"
      }
    }
  }
}
```

**POST target:** `http://localhost:5678/webhook/stripe-webhook`

**Required env:** `STRIPE_WEBHOOK_SKIP_VERIFY=true` (already works — set in Code - Verify Signature: `const skipVerify = String($env.STRIPE_WEBHOOK_SKIP_VERIFY || 'false').toLowerCase() === 'true'`)

**Required header:** `Content-Type: application/json`

**No real Stripe checkout, no Stripe API calls.** The workflow does not make outbound Stripe API calls — it only processes the inbound webhook JSON. No Stripe session creation needed.

**Trigger command (for Gate D, after guard implemented and fixture seeded):**
```powershell
# Write payload to file to avoid PowerShell quoting issues
'{"id":"evt_test_idemp_i3_001","type":"checkout.session.completed","data":{"object":{"id":"cs_test_i3_idemp_001","payment_intent":"pi_test_i3_idemp_001","amount_total":10000,"metadata":{"booking_id":"b35c0000-0000-4000-8000-000000000001","client_id":"a0000000-0000-4000-8000-000000000001","payment_kind":"deposit_only"}}}}' | Set-Content _35c-trigger.json -Encoding utf8
curl -s -X POST http://localhost:5678/webhook/stripe-webhook -H "Content-Type: application/json" --data "@scripts/_35c-trigger.json"
```

---

##### G. Expected behavior per POST

**POST #1 (first event, new `stripe_event_id`):**

| Check | Expected |
|-------|----------|
| HTTP response | `200 { received: true, processed: true, booking_id: "b35c...", payment_status: "deposit_paid", ... }` |
| `payment_events` count WHERE `stripe_event_id='evt_test_idemp_i3_001'` | **1** |
| `payments.status` WHERE `id='a35c...'` | **`'paid'`** |
| `payments.amount_paid_cents` WHERE `id='a35c...'` | **10000** |
| `bookings.payment_status` WHERE `booking_code='WH-35C-I3-TEST-1'` | **`'deposit_paid'`** |
| `bookings.send_confirmation` WHERE `booking_code='WH-35C-I3-TEST-1'` | **`TRUE`** |
| `bookings.status` | **unchanged** (`payment_pending`) — webhook does NOT set `status` |
| `booking_beds` count | **unchanged** |
| Send Confirmation workflow | **must not execute** (must remain inactive) |

**POST #2 (duplicate — same `stripe_event_id`, after guard implementation):**

| Check | Expected (after guard) |
|-------|------------------------|
| HTTP response | `200 { received: true, processed: false, reason: "duplicate_event", stripe_event_id: "evt_test_idemp_i3_001" }` |
| `payment_events` count WHERE `stripe_event_id='evt_test_idemp_i3_001'` | **still 1** (no duplicate insert) |
| `payments.status` | **still `'paid'`** (no second update) |
| `bookings.payment_status` | **still `'deposit_paid'`** (no double promotion) |
| `bookings.send_confirmation` | **still `TRUE`** (stable) |
| `bookings.deposit_paid_cents` | **unchanged** (no second `+ $5`) |
| `booking_beds` count | **unchanged** |

**POST #2 (duplicate — BEFORE guard implementation):**

| Check | Current behavior (unguarded) |
|-------|------------------------------|
| HTTP response | **TIMEOUT / 502** — `Respond - Payment Applied` does not fire |
| `payment_events` count | **still 1** (DB is safe) |
| Stripe behavior | **retries the event** (non-200 response treated as delivery failure) |

---

##### H. Runtime gate plan (after guard implementation + approval)

**Gate A — Preflight only (no activation, no writes)**

- Run static contracts: `node scripts/report-main-payment-contract.js`, `report-stripe-contract.js`
- Confirm all workflows inactive in n8n DB
- Baseline counts:
  - `SELECT COUNT(*) FROM payments` → record N_payments_baseline
  - `SELECT COUNT(*) FROM payment_events` → record N_payment_events_baseline
  - `SELECT COUNT(*) FROM booking_beds` → record N_booking_beds_baseline
  - `SELECT COUNT(*) FROM bookings WHERE booking_code = 'WH-35C-I3-TEST-1'` → must be 0
  - `SELECT COUNT(*) FROM payment_events WHERE stripe_event_id = 'evt_test_idemp_i3_001'` → must be 0
- Max exec id: `SELECT MAX(id) FROM execution_entity` → record MAX_EXEC_BASELINE
- Hard stop: any leftovers from prior WH-35C-I3 run

**Gate B — Fixture seed (REQUIRES EXPLICIT PAYMENT TABLE APPROVAL)**

- Seed `phase35c-i3-up.sql` (booking + payment rows)
- Verify:
  - `SELECT COUNT(*) FROM payments` → N_payments_baseline + 1
  - `SELECT id, status, stripe_checkout_session_id FROM payments WHERE id = 'a35c0000-0000-4000-8000-000000000001'` → 1 row, `checkout_created`, `cs_test_i3_idemp_001`
  - `SELECT id, status, payment_status, send_confirmation FROM bookings WHERE booking_code = 'WH-35C-I3-TEST-1'` → 1 row, `payment_pending`, `not_requested`, `FALSE`
- Hard stop: payment row not found; booking row not found

**Gate C — Activate only Stripe Webhook Handler**

- Activate ONLY `KZUQvwR6SPWpvaZ5` via n8n API or CLI
- Confirm all other workflows (Send Confirmation, Main, Assign, Reassign, Cancel) are INACTIVE
- Hard stop: Send Confirmation active; Main active; any rooming workflow active

**Gate D — POST crafted event #1**

- POST `_35c-trigger.json` to `http://localhost:5678/webhook/stripe-webhook`
- Capture response JSON and exec id
- Verify:
  - HTTP status 200, `processed: true`
  - `payment_events` count = N_payment_events_baseline + 1
  - `payments.status = 'paid'` for fixture row
  - `bookings.payment_status = 'deposit_paid'` for fixture booking
  - `bookings.send_confirmation = TRUE`
  - `booking_beds` count = N_booking_beds_baseline (unchanged)
  - Send Confirmation execution count unchanged (no spurious trigger)
- Hard stop: HTTP non-200 (before guard = expected; after guard = test failure); `payment_events` not +1; `booking_beds` changed

**Gate E — POST duplicate event #2 (same payload, same `stripe_event_id`)**

- POST the same `_35c-trigger.json` again
- Capture response JSON and exec id
- Verify:
  - HTTP status 200, `processed: false`, `reason: "duplicate_event"` (requires guard)
  - `payment_events` count = N_payment_events_baseline + 1 (NOT + 2)
  - `payments.status` still `'paid'`
  - `bookings.payment_status` still `'deposit_paid'`
  - `bookings.deposit_paid_cents` NOT double-incremented
  - `booking_beds` count = N_booking_beds_baseline (unchanged)
- Hard stop: `payment_events` count = N + 2; `payments.amount_paid_cents` doubled; `bookings.deposit_paid_cents` doubled; any additional booking promotion

**Gate F — Deactivate, teardown, count restore**

- Deactivate `KZUQvwR6SPWpvaZ5`
- Run `phase35c-i3-down.sql`
- Verify:
  - `SELECT COUNT(*) FROM payments` → N_payments_baseline (restored)
  - `SELECT COUNT(*) FROM payment_events` → N_payment_events_baseline (restored)
  - `SELECT COUNT(*) FROM booking_beds` → N_booking_beds_baseline (unchanged throughout)
  - `SELECT COUNT(*) FROM bookings WHERE booking_code = 'WH-35C-I3-TEST-1'` → 0
  - `SELECT COUNT(*) FROM payment_events WHERE stripe_event_id = 'evt_test_idemp_i3_001'` → 0
- Hard stop: teardown fails; counts not restored; WH-35C-I3-TEST-1 booking persists

**Hard stops (all gates):**

- Any real Stripe session creation or Stripe API call
- Send Confirmation workflow executes during the test
- Main / Reassign / Assign / Cancel executes during the test
- `payments` count unexpectedly changes
- `payment_events` count > N_payment_events_baseline + 1 at any point after Gate D
- `booking_beds` count changes at any point
- Duplicate event causes second booking promotion (`deposit_paid_cents` doubled or `payment_status` re-set to something else)
- `payment_events` count does not decrease to baseline after teardown
- HTTP timeout/502 on Gate E (means guard was not implemented — stop and implement guard first)

---

---

##### I. Gate A preflight evidence (2026-05-29) — PASS

**Status: PASS**

**1. Repo state:**
- HEAD: `d64b50a`
- Modified files: `docs/PHASE-3.5-SAFETY-RAILS-PLAN.md`, `docs/PROJECT-STATE.md`, `n8n/phase2/Wolfhouse - Stripe Webhook Handler.json` — exactly expected 3 files; no fixtures, no infra/.env, no secrets.

**2. Static guard verification:**

| Check | Result |
|-------|--------|
| JSON parses | ✓ |
| Node count | ✓ 10 |
| `active` field | ✓ not present (imports inactive) |
| `alwaysOutputData: true` on Postgres node | ✓ |
| `Postgres → IF - New Payment Row?` | ✓ |
| `IF true → Respond - Payment Applied` | ✓ |
| `IF false → Respond - Duplicate Acknowledged` | ✓ |
| `Respond - Duplicate Acknowledged` HTTP 200 | ✓ |
| Body: `received:true` | ✓ |
| Body: `processed:false` | ✓ |
| Body: `duplicate_event` | ✓ |
| Body: `stripe_event_id` | ✓ |
| Only 1 Postgres node | ✓ |
| CTE SQL unchanged (`ON CONFLICT DO NOTHING`, `send_confirmation=TRUE`, `RETURNING`) | ✓ |
| `IF` condition: `notEmpty` / `loose` type validation | ✓ |
| No other workflow files modified | ✓ |

**Note (UUID correction):** The planned fixture payment UUID `p35c0000-0000-4000-8000-000000000001` was invalid (contains `p`, not valid hex). Corrected to `a35c0000-0000-4000-8000-000000000001` throughout fixture design in this document.

**3. Contract reports:**
- `node scripts/report-main-payment-contract.js` → **Overall OK: true** (0 payment write hits, CPS contract present, Ensure node present)
- `node scripts/report-stripe-contract.js` → **Overall OK: true** (Webhook Handler present, signature handling visible, `checkout.session.completed` handling present, 0 payment write hits in Main)

**4. Workflow active states:**

| Workflow | ID | active |
|----------|----|--------|
| Main (local Stripe) | `RBfGNtVgrAkvhBHJ` | **f** ✓ |
| Reassign (local PG) | `B3c3ReassignLocal01` | **f** ✓ |
| Assign (local PG) | `B3c2AssignLocalPg01` | **f** ✓ |
| Send Confirmation (local) | `gxivKRJexzTCw9x6` | **f** ✓ |
| Stripe Webhook Handler | `KZUQvwR6SPWpvaZ5` | **f** ✓ |
| Create Payment Session | `esuDIT96iPT63OaQ` | **f** ✓ |
| CPS stub local | `whCreatePaymentStubLocal01` | **f** ✓ |
| Cancel (local PG) | `KchhRC9b3MIdkzPT` | **f** ✓ |

All 6 Stripe Webhook Handler copies (`8tT8puElc3PcqXMy`, `AEDgqe9LHNM5Vy53`, `KZUQvwR6SPWpvaZ5`, `WbSfOXfNdtrEPeFs`, `hBepzLXL32L6Scli`, `zfcoPmGICvGspf7g`): all **active=f** ✓

**5. Baseline counts (wolfhouse-postgres, 2026-05-29):**

| Table | Count |
|-------|-------|
| `bookings` | **41** |
| `payments` | **25** |
| `payment_events` | **5** |
| `booking_beds` | **15** |
| `automation_errors` | **0** |
| `workflow_events` | **24** |

**6. Max execution id baselines (n8n execution_entity):**

| Workflow | ID | max_exec_id | exec_count |
|----------|----|-------------|------------|
| Main | `RBfGNtVgrAkvhBHJ` | **1082** | 32 |
| Reassign | `B3c3ReassignLocal01` | **1083** | 10 |
| Assign | `B3c2AssignLocalPg01` | **1084** | 16 |
| Send Confirmation | `gxivKRJexzTCw9x6` | **1090** | 756 |
| Stripe Webhook Handler | `KZUQvwR6SPWpvaZ5` | **1092** | 85 |
| Create Payment Session | `esuDIT96iPT63OaQ` | **1065** | 25 |
| CPS stub | `whCreatePaymentStubLocal01` | **1037** | 6 |
| Cancel | `KchhRC9b3MIdkzPT` | **305** | 10 |

**7. No I3 leftovers:**

| Check | Result |
|-------|--------|
| `bookings` WHERE `booking_code LIKE 'WH-35C-I3-%'` | **0** ✓ |
| `payments` via `WH-35C-I3-*` booking JOIN | **0** ✓ |
| `payment_events` WHERE `stripe_event_id='evt_test_idemp_i3_001'` | **0** ✓ |
| `booking_beds` via `WH-35C-I3-*` booking JOIN | **0** ✓ |

**8. Environment readiness:**

| Check | Result |
|-------|--------|
| `STRIPE_WEBHOOK_SKIP_VERIFY` on `n8n-main` | **`true`** ✓ (skip verify active for local testing) |
| `STRIPE_WEBHOOK_SKIP_VERIFY` on `n8n-worker` | **`true`** ✓ |
| `STRIPE_WEBHOOK_SECRET` present | **yes** (value not printed) ✓ |

No env changes made or needed. `STRIPE_WEBHOOK_SKIP_VERIFY=true` already set — no env modification required for I3 runtime.

**Gate A verdict: PASS — all preflight checks green. Ready for Gate B with explicit approval.**

**Gate B requires explicit approval:** inserts one row into the protected `payments` table and one row into `bookings`. Both must be torn down after the test. Approval phrase: "I approve the I3 Gate B fixture write into payments."

---

##### J. Gates B–F runtime evidence (2026-05-29) — PASS

**Overall verdict: PASS**

**Activation notes (n8n 2.21.7 internals):** Direct DB activation requires three steps beyond `active=true`:
1. Insert row into `webhook_entity` (path, method, node, workflowId)
2. Set `activeVersionId = versionId` in `workflow_entity`
3. Force-recreate n8n containers (`docker compose up -d --force-recreate`) to re-register webhook routes

**Gate B — fixture seeded:**

| Row | Key | Value |
|-----|-----|-------|
| Booking | `booking_code` | `WH-35C-I3-TEST-1` |
| Booking | `status` / `payment_status` | `payment_pending` / `not_requested` |
| Booking | `send_confirmation` | `FALSE` |
| Payment | `id` | `a35c0000-0000-4000-8000-000000000001` |
| Payment | `status` | `checkout_created` |
| Payment | `stripe_checkout_session_id` | `cs_test_i3_idemp_001` |
| Counts | bookings / payments / payment_events | 42 / 26 / 5 |

**Gate C — Stripe Webhook Handler only activated:**  
All 8 target workflows: Stripe Handler `active=t`, rest `active=f`. ✓

**Gate D — POST #1 result:**

| Check | Result |
|-------|--------|
| HTTP status | **200** |
| Response body | `{"received":true,"processed":true,"booking_id":"b35c0000-0000-4000-8000-000000000001","payment_status":"deposit_paid","send_confirmation":true,"payment_kind":"deposit_only"}` |
| Execution ID | **1093** (baseline was 1092) |
| `payment_events` row | stripe_event_id=`evt_test_idemp_i3_001`, processed=true, payment_id + booking_id FKs correct |
| `payments.status` | `paid` |
| `payments.amount_paid_cents` | `10000` |
| `bookings.payment_status` | `deposit_paid` |
| `bookings.send_confirmation` | `TRUE` |
| `bookings.deposit_paid_cents` | `10000` |
| `booking_beds` | **15** (unchanged) ✓ |
| Send Confirmation exec | **unchanged at 1090** ✓ |
| All other workflows | **unchanged** ✓ |

**Gate E — POST #2 (duplicate) result:**

| Check | Result |
|-------|--------|
| HTTP status | **200** |
| Response body | `{"received":true,"processed":false,"reason":"duplicate_event","stripe_event_id":"evt_test_idemp_i3_001"}` |
| Execution ID | **1094** (2nd execution processed cleanly) |
| `payment_events` for `evt_test_idemp_i3_001` | **1** (not 2) ✓ |
| `bookings.payment_status` | `deposit_paid` (stable, not re-promoted) ✓ |
| `bookings.deposit_paid_cents` | `10000` (not doubled) ✓ |
| `bookings.amount_paid_cents` | `10000` (not doubled) ✓ |
| `payments.status` | `paid` (stable) ✓ |
| `payments.amount_paid_cents` | `10000` (not doubled) ✓ |
| `booking_beds` | **15** (unchanged) ✓ |
| `total payment_events` | **6** (baseline 5 +1; no second row) ✓ |
| `automation_errors` | **0** ✓ |
| `workflow_events` | **24** (unchanged) ✓ |

**Gate F — deactivated:**  
All 8 workflows `active=f`. Only `KZUQvwR6SPWpvaZ5` exec count changed: 1092 → **1094** (+2). All other workflows: unchanged.

**Teardown:**

| Check | Result |
|-------|--------|
| `bookings` WHERE `WH-35C-I3-*` | **0** ✓ |
| `payments` WHERE `a35c...` | **0** ✓ |
| `payment_events` WHERE `evt_test_idemp_i3_001` | **0** ✓ |
| bookings count | **41** (restored to baseline) ✓ |
| payments count | **25** (restored to baseline) ✓ |
| payment_events count | **5** (restored to baseline) ✓ |
| booking_beds count | **15** (unchanged throughout) ✓ |
| automation_errors | **0** ✓ |
| workflow_events | **24** ✓ |

**Idempotency proof:** Two identical POSTs with `stripe_event_id=evt_test_idemp_i3_001`:
- POST #1: DB mutated once (1 `payment_events` row, payment paid, booking deposit_paid, send_confirmation=TRUE). HTTP 200 `processed:true`.
- POST #2: DB unchanged (0-row CTE via ON CONFLICT DO NOTHING). HTTP 200 `processed:false, reason:duplicate_event`. No double-promotion.

**I3 idempotency: PROVEN at runtime.**

---

#### I2 — Duplicate payment-link request

**Pre-conditions:** Airtable test-base fixture tooling OR Postgres source-of-truth cutover.

**Why deferred:** Main's hold selection is Airtable-primary. A PG-only fixture cannot create a faithful "payment_details_provided" context for Main to re-process. Even if CPS is active, the upstream hold selection produces a new session rather than reusing an existing one if the Airtable record is not present.

**Defer to:** Postgres source-of-truth cutover phase or separately-approved Airtable test-base fixture tooling.

---

### 3.5g — Stage 3.5 closeout checklist

Before Stage 3y shadow/co-pilot mode can begin, ALL of the following must be confirmed:

| # | Item | Status |
|---|------|--------|
| G1 | 3.5a dangerous-action inventory complete and accepted | PLANNED |
| G2 | `automation_errors` wired into ≥1 dangerous workflow | PLANNED |
| G3 | Safe staff-handoff fallback written for each dangerous action | PLANNED |
| G4 | No silent bot failures: every dangerous-action error has a capture path | PLANNED |
| G5 | I3 Stripe event dedup runtime complete OR deferred with written reason | PLANNED (deferred — needs `payments` write approval) |
| G6 | I2 payment-link duplicate deferred with written reason | PLANNED (deferred — Airtable-coupled) |
| G7 | Double-booking overlap guard contract documented with L1/L2 test evidence | PLANNED |
| G8 | Minimum `workflow_events` logging wired into ≥1 dangerous workflow | PLANNED |
| G9 | `WHATSAPP_DRY_RUN=true` for all remaining 3.5 runtime gates | CONFIRMED ✓ |
| G10 | Real WhatsApp send remains off — separate approval required | CONFIRMED ✓ |
| G11 | All dangerous workflows inactive after each 3.5 test gate | Confirmed policy ✓ |
| G12 | Protected counts (payments/payment_events/booking_beds) confirmed at baseline post-teardown | Confirmed policy ✓ |
| G13 | Project docs updated and committed | PLANNED |

---

## Work-type classification

| Sub-phase | Work type |
|-----------|-----------|
| **3.5a** — Danger inventory + contracts | Docs/static only |
| **3.5b** — Error capture + staff fallback | Spec (docs) + workflow/code change + runtime gate (error-injection, no payment) |
| **3.5c** — Idempotency enforcement | Docs/static + I3 protected payment-table runtime gate |
| **3.5d** — Overlap guard hardening | Docs/static + L1 unit + L2 fixture/report + L3 runtime (after 3.5b wire-in) |
| **3.5e** — Execution logging | Schema exists; wire-in is workflow/code change |
| **3.5f** — Stripe/payment duplicate gates | Protected payment-table gate; I2 deferred to cutover |
| **3.5g** — Closeout checklist | Docs only; runs last |

---

## Recommended first implementation step

**3.5a — dangerous-action inventory (docs-only, no activation).**

This is already partially drafted in this doc. The first step is to validate and accept the dangerous-action inventory table in §3.5a with the repo owner, noting the key finding that `automation_errors` and `workflow_events` tables exist in the schema but are not wired. Once accepted, 3.5b (wire-in) can proceed with a clear scope: start with Send Confirmation, the simplest Postgres-primary dangerous workflow.

**Why not 3.5b first?** 3.5b requires workflow JSON changes to add n8n Error Trigger nodes and Postgres INSERT code nodes. That scope should be entered only after the inventory is reviewed and the wire-in design is accepted.

---

## Key schema finding

`automation_errors` and `workflow_events` tables were defined in migration 001 (initial schema) but have **zero rows** in the current DB and **zero references** in any n8n workflow node. This means:

- The infrastructure for error capture is already in place at the database layer.
- Stage 3.5b is a pure wire-in task: add n8n Error Trigger nodes + Postgres INSERT Code nodes to each dangerous workflow.
- No new migrations are needed for the basic wire-in.
- The `hostel_id` FK in `automation_errors` may need to reference `clients` after the hostel→client rename migration — verify before first INSERT.

---

## Related docs

- [`ROADMAP.md § Stage 3.5`](ROADMAP.md#stage-35--safety-rails-before-reliability) — requirements table
- [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) §15–§16 — wrong-booking + idempotency plans
- [`PHASE-3e-IDEMPOTENCY-PLAN.md`](PHASE-3e-IDEMPOTENCY-PLAN.md) — I1–I7 classification and I3/I4 detail
- [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) — Stage 3.5 prerequisites and LLM safety requirements
- [`PROJECT-STATE.md`](PROJECT-STATE.md) — current stage snapshot
