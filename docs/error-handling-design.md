# Central Error Handling Design

## Objectives

- One place to capture failures across 10+ workflows
- Enough context for you to debug without opening every n8n execution
- Staff-friendly alerts for Ale/Cami (non-technical)
- Retry/review workflow for ops

## `automation_errors` table

Already defined in `database/migrations/001_init.sql`.

| Column | Source |
|--------|--------|
| `workflow_name` | `$workflow.name` |
| `node_name` | failing node |
| `execution_id` | n8n execution ID |
| `execution_url` | `${N8N_BASE_URL}/workflow/${id}/executions/${executionId}` |
| `error_message` | `error.message` |
| `booking_id` / `conversation_id` / `manual_entry_id` | parsed from execution JSON |
| `status` | `open` → `retrying` → `resolved` / `ignored` |
| `severity` | `warn`, `error`, `critical` |
| `staff_alert_sent` | bool |

## Central n8n error workflow (to implement)

**Name:** `Wolfhouse - Automation Error Handler`

| Item | Detail |
|------|--------|
| Trigger | Error Trigger (global) OR per-workflow Error Workflow setting |
| Steps | Normalize payload → Postgres insert → IF severity ≥ error → staff alert → optional retry queue |

### Error Trigger payload (normalize in Code node)

```javascript
return [{
  json: {
    workflow_name: $workflow.name,
    node_name: $input.first().json.node?.name || 'unknown',
    execution_id: $execution.id,
    execution_url: `${$env.N8N_EDITOR_BASE_URL}/workflow/${$workflow.id}/executions/${$execution.id}`,
    error_message: $input.first().json.error?.message || 'Unknown error',
    error_stack: $input.first().json.error?.stack || null,
    severity: 'error',
    payload: $input.first().json
  }
}];
```

### Postgres insert node

`INSERT INTO automation_errors (...) VALUES (...)`

Use `WOLFHOUSE_DATABASE_URL` credential.

### Correlation helpers

Extract from common patterns:

| Pattern | Field |
|---------|-------|
| `$('Get Booking').first().json.id` | `booking_id` map via airtable_record_id during migration |
| Webhook `body.record_id` | lookup booking |
| Manual entry `manual_entry_id` | `manual_entries` table |

## `workflow_events` (non-fatal audit)

Use for:

- Bed assignment plan score selected
- Stripe session created
- Manual entry picked from queue
- LLM parser confidence < 0.5

Insert via shared sub-workflow `Wolfhouse - Log Workflow Event` to avoid cluttering errors table.

## Retry / review status

| Status | Meaning | Action |
|--------|---------|--------|
| `open` | New failure | Engineer reviews |
| `retrying` | Safe retry in progress | n8n retry execution |
| `resolved` | Fixed or benign | hide from dashboard |
| `ignored` | Known flake | document reason |

**Safe to retry:** Google Sheets rate limit, transient Airtable 503, Stripe timeout.

**Never auto-retry:** double booking insert, duplicate Stripe webhook (use idempotency on `stripe_event_id`).

## Staff alert recommendations

| Severity | Channel | Message template |
|----------|---------|------------------|
| `critical` | WhatsApp group (owners) + email | “Booking system needs attention: {short reason}. Guests can still message us — staff use phone backup.” |
| `error` | Email to ops only | Include booking code + link to execution |
| `warn` | Daily digest | Sheet sync delayed |

**Do not** send raw stack traces to Ale/Cami.

### Suggested alert rules

1. Manual Entries failed → “Press Wolfhouse → Sync Manual Entries Now”
2. Planning sync failed → “Calendar may be outdated — refresh in 30 min”
3. Stripe webhook failed → “Payments may not confirm automatically”
4. Main assistant down → “WhatsApp bot not responding — use manual sheet”

## Per-workflow fragile areas (prioritize error wrapping)

| Workflow | Watch |
|----------|-------|
| Main | LLM JSON parse, hold expiry, payment session |
| Bed Assignment | `throw` on no beds — needs graceful guest message path |
| Manual Entries | missing bed IDs, sheet row mismatch |
| Sync Planning | batchUpdate size limits |
| Send Confirmation | missing phone on booking |
| Stripe webhook | signature failure = 400 + alert |

## Implementation order

1. Create Error Handler workflow + Postgres credentials
2. Attach as **Error Workflow** on: Manual Entries, Bed Assignment, Stripe (first)
3. Add `workflow_events` logging to Bed Assignment and Stripe
4. Build simple Airtable/Google Data Studio or Retool board on `automation_errors` — later

## Feature flag

`ERROR_HANDLER_ENABLED=true` env — when false, n8n default error behavior (staging debug).
