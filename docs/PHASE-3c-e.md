# Phase 3c.e — Main local fork PG injection

**Status:** **3c.e.3** complete (PG availability gate in fork). Hold/conversation **not** wired yet.

## Build script

| Command | Purpose |
|---------|---------|
| `node scripts/build-main-local-stripe.js` | Regenerate fork; neutralize prod Airtable base; `active=false`; run verify |
| `node scripts/build-main-local-stripe.js --inventory` | Read-only node/route inventory |
| `node scripts/build-main-local-stripe.js --verify-targets` | Safety checks on generated JSON (no write) |
| `node scripts/build-main-local-stripe.js --print-target-map` | Print `PHASE_3CE_PG_TARGETS` (no write) |

## Neutralization

- **Hosted source** `n8n/Wolfhouse Booking Assistant  - Main.json` is never modified.
- Generated output replaces `appOCWIN47Bui9CSS` → `appiyO4FmkKsyHZdK` (test base, same table ids).
- `workflow.active` is forced **false**.

## verify-targets

| Check | Fail if |
|-------|---------|
| `active` | not `false` |
| Prod Airtable base | any `appOCWIN47Bui9CSS` in workflow JSON |
| Airtable nodes | base id ≠ test base |
| Payment SQL | `INSERT/UPDATE/DELETE` on `payments` or `payment_events` |
| Workflow identity | wrong id/name or missing `booking-assistant` webhook |

**Warnings (non-blocking):** HTTP nodes still calling `tywoods.app.n8n.cloud/webhook/reassign-booking-beds` until remapped to local 3b fork.

## Ladder (after 3c.e.1)

| Step | Work |
|------|------|
| 3c.e.2 | Ensure promote SQL in `Postgres - Ensure Booking In Postgres` | Done (`c89890a`) |
| 3c.e.3 | PG availability gate (`Postgres - Main Availability` + map) | **Done** (uncommitted) |
| 3c.e.4 | PG hold + AT mirror + `airtable_record_id` backfill |
| 3c.e.5 | PG conversation upsert |
| 3c.e.6+ | Regenerate, import inactive, E2E later (3c.g) |

Target map lives in `scripts/build-main-local-stripe.js` as `PHASE_3CE_PG_TARGETS`.
