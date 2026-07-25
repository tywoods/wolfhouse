# MESSI SaaS Stage 2E — durable real-client staging apply

Offline owner for **durable** staging (not temporary messiproof). Wraps Stage **2D1** (names / subscription) and **2D2** (canonical failure rollback). No Azure/DB/network writes in this slice.

| Temporary 2D2 drill | Durable 2E |
|---------------------|------------|
| `--ttl-hours` + `temporaryDrill` tags | **Rejected** |
| Cost-cap approval flags | `--human-approval-token APPROVE_DURABLE_STAGING_MIRLEFT` |
| Destroy / rollback after success | **Never** |
| Any synthetic slug | Allowlist: **`mirleft` only** |
| Rollback / expiry teardown | Rollback **only** on failed partial creation → D2 |

Exact binding: client + `luna-mirleft-staging-rg` + fixed staging subscription + deploy SHA + plan digest. Tags: `stage=saas-2e-durable-staging`, `owner=messi-stage2e`, `durableStaging=true` (no TTL keys).

**Fail-closed readiness (current Mirleft):** apply refuses before any Azure mutation while inventory is provisional (`TODO_provisional_placeholder_until_real_inventory`), prices are `unverified_seed`, or channels/WhatsApp are unprovisioned. Does **not** flip `live_enabled`, publish registry, wire WhatsApp/Stripe, or redesign FACTORY.

```bash
node scripts/messi-saas-stage2e-mirleft-durable-staging.js status --slug mirleft
node scripts/messi-saas-stage2e-mirleft-durable-staging.js apply \
  --slug mirleft --human-approval-token APPROVE_DURABLE_STAGING_MIRLEFT
npm run verify:messi-saas-stage2e-durable-staging
```
