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
**Status:** PLANNED

**Goal:** Convert Stage 3e.6 learnings into explicit guard contracts. Distinguish what is already enforced at DB level from what needs an application-layer guard.

**Idempotency contract matrix:**

| # | Concern | DB guard (schema) | Application guard | Runtime proof | Status |
|---|---------|-------------------|-------------------|---------------|--------|
| I1 | Duplicate wamid | `UNIQUE (client_id, whatsapp_message_id)` on `messages` | No explicit check before INSERT; DB rejects duplicate | L2 schema PASS; full-path L3 deferred (Airtable-coupled Main) | **L2 PASS — Stage 3 bar** |
| I2 | Duplicate payment-link request | `payments_stripe_payment_intent_id_unique` (partial UNIQUE) | PG Ensure returns `action=refreshed` on 2nd call | Deferred — Airtable + Stripe coupling | **DEFERRED — manual-pay gate** |
| I3 | Duplicate Stripe event id | `payment_events.stripe_event_id TEXT UNIQUE` | Webhook Handler should catch INSERT conflict | Deferred — requires `payments` fixture write | **DEFERRED — Stage 3.5 gate (needs approval)** |
| I4 | Duplicate Send Confirmation | `confirmation_sent_at IS NULL` in SELECT + UPDATE WHERE clause | Proven: 2nd execution is a no-op at SELECT layer | **RUNTIME PASS (I4, exec 1087→1088)** | **PASS** |
| I5 | Duplicate reassign | `resolved_count=1` guard in PG DELETE SQL | Airtable gate blocks PG path | Deferred — Airtable-coupled | **DEFERRED — cutover gate** |
| I6 | Duplicate cancellation | No explicit idempotency key on cancel | TBD | Not yet planned | **PLAN NEEDED** |
| I7 | Duplicate hold creation | Airtable: `existing_active_hold_found` dedup query | PG Ensure `action=refreshed` on same booking | Partial — Airtable-driven dedup | **Partially proven; needs PG-path runtime** |

**Required additions for Stage 3.5:**

- **I3 runtime gate:** Wire `automation_errors` INSERT on Stripe event conflict (catches the UNIQUE violation before it surfaces as an unhandled n8n error). Activate Stripe Webhook Handler only. One `payments` fixture row required — needs explicit payment-table write approval.
- **I6 cancel idempotency:** Define whether cancelling an already-cancelled booking is safe or an error. Document guard. Simple DB-level: `WHERE assignment_status != 'cancelled'` or check before DELETE.

---

### 3.5d — Double-booking / overlap guard hardening

**Work type:** Docs/static + fixture/report + reversible DB write + runtime gate  
**Status:** PLANNED

**Goal:** Formalize and harden the overlap guard contract for all bed-assignment paths.

**Current state (from 3e.5 T6 and schema inspection):**

- `assign-booking-beds-plan.js` runs overlap detection before INSERT (detects conflicting non-cancelled bookings in `booking_beds`).
- No dedicated `is_manual_lock` column — manual/staff protection is overlap-based (`bookings.booking_source IN ('manual_staff', 'operator')`).
- Overlap detection produces a conflict report but does not write to `automation_errors`.
- The `resolved_count=1` guard in `reassign-booking-beds-pg-sql.js` prevents mass delete on ambiguous resolve.

**Overlap guard contract (define for each path):**

| Path | Current guard | Gap | 3.5 action |
|------|--------------|-----|------------|
| Guest auto-assign | `assign-booking-beds-plan.js` overlap detection | Conflict not captured in `automation_errors`; no staff alert | Wire error capture on conflict |
| Reassign | `resolved_count=1` PG guard | Airtable upstream; conflict not captured | Wire error on resolve failure; defer runtime to cutover |
| Cancel | Removes `booking_beds` rows | No overlap re-check on cancel (downstream) | Document; add cancel idempotency (I6) |
| Manual/staff/operator | Overlap detection blocks guest overwrite | No dedicated lock column; rely on source convention | Document convention; add L2 fixture test confirming block |
| Operator room release | Operator block convention | Not explicitly tested in 3e.5 | Add L2 test |

**Pass/fail tests needed:**

- L1: `assign-booking-beds-plan.js` unit test: overlap for two bookings on same bed same date → `overlap=true`.
- L2: fixture with manual_staff booking + guest candidate → report shows conflict, no overwrite.
- L2: fixture with operator booking + guest candidate → same.
- L3 runtime: Assign workflow with deliberate overlap → confirm `automation_errors` row written, no `booking_beds` mutation on blocked guest. (Requires wiring from 3.5b first.)

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
**Status:** PLANNED — runtime DEFERRED until payment-table write explicitly approved

**Goal:** Complete deferred idempotency runtime proofs I2 and I3 from Stage 3e.6.

#### I3 — Duplicate Stripe event id runtime

**Pre-conditions:**
- Stripe Webhook Handler `KZUQvwR6SPWpvaZ5` must be the only active workflow.
- `STRIPE_WEBHOOK_SKIP_VERIFY=true` in environment.
- Fixture: one disposable booking + one `payments` row in `checkout_created` state — **protected-table write; requires explicit approval**.
- No real Stripe checkout or charge.

**Duplicate action:** POST same crafted event id (`evt_test_idemp_i3_001`) twice to `http://localhost:5678/webhook/stripe-webhook`.

**Expected result:**
- 1st POST: `payment_events` count +1; booking promoted per webhook handler logic.
- 2nd POST: INSERT into `payment_events` fails on `stripe_event_id UNIQUE`; either caught cleanly (0-row no-op) or produces a handled conflict. Booking state unchanged.

**Evidence:**
```sql
SELECT COUNT(*) FROM payment_events WHERE stripe_event_id = 'evt_test_idemp_i3_001';
-- Must be 1 after both POSTs.
SELECT status, payment_status FROM bookings WHERE booking_code = 'WH-IDEMP-I3';
-- State stable; not double-promoted.
```

**Hard stops:** `payment_events` count for event id > 1; any unrelated payment mutation; `booking_beds` change.

**Teardown:** DELETE fixture booking + payments + payment_events rows; verify counts at baseline.

**Approval required:** YES — one `payments` table INSERT is needed for the fixture. Must be explicitly approved before execution.

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
