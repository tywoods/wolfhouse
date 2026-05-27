# Phase 3c.a — Main workflow inventory (read-only)

**Status:** Implemented (inventory tooling). **No workflow or Postgres changes.**

**Parents:** [`PHASE-3c-PROPOSAL.md`](PHASE-3c-PROPOSAL.md), [`PHASE-2c.md`](PHASE-2c.md), [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md)

---

## Run inventory

From repo root (Docker tools profile — no `node` on host required):

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools node scripts/build-main-local-stripe.js --inventory
```

Or with local Node:

```powershell
node scripts/build-main-local-stripe.js --inventory
```

**Reads only:**

- `n8n/Wolfhouse Booking Assistant  - Main.json` (hosted export)
- `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` (local fork, if present)

**Does not:** write workflow JSON, call Airtable/Sheets/Postgres, activate workflows, or run webhooks.

---

## What it reports

1. Workflow name/id and node counts (hosted vs local)
2. Webhook, schedule, and manual triggers
3. `Switch` **resolved_route** branches (purpose, entry nodes, downstream size)
4. All Airtable nodes (table, operation, prod base hits, heuristic route tags)
5. All Postgres nodes (SELECT/INSERT/UPDATE/DELETE, payment-write scan)
6. HTTP calls (Create Payment Session, Reassign, etc.)
7. Booking-critical groups (Bookings, Booking Beds, Conversations, Messages, availability)
8. First PG replacement targets (recommendations only)

---

## Implementation

| File | Role |
|------|------|
| [`scripts/lib/main-workflow-inventory.js`](../scripts/lib/main-workflow-inventory.js) | Analysis logic |
| [`scripts/build-main-local-stripe.js`](../scripts/build-main-local-stripe.js) | `--inventory` entrypoint |

---

## Next step

**3c.b** — read-only PG availability/overlap module (reuse 3b patterns), using inventory route map as scope guide.
