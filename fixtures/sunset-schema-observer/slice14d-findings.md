# FOUNDATION Slice 14D — Phase D live read-only activation

**Status:** complete (CONNECT_ENABLED activated; CLI default-disabled; offline injected-Client proof; no live query)
**Master basis:** `6edd63762ea5a28cec764428c176da2118032729`
**Generated:** 2026-07-19T19:14:01.308Z

## Outcome

Activated the merged Slice **14C** live read-only PostgreSQL adapter behind its exact Slice **14B** target/credential/query gates. Real `pg` Client wiring occurs only after:

1. dual flags (`SUNSET_PHASE_D_LIVE_READONLY=1` + `SUNSET_PHASE_D_LIVE_PREFLIGHT=1`)
2. exact `AZURE_SUBSCRIPTION_ID`
3. protected admin env (`SUNSET_STAGING_PG_ADMIN_USER` / `SUNSET_STAGING_PG_ADMIN_PASSWORD`)
4. explicit count-only execution gate (`SUNSET_PHASE_D_LIVE_EXECUTE_COUNT_ONLY=1` + `--execute-count-only`)
5. exact CLI confirmation of subscription / resource group / postgres server / database

No DSN / host / query argv. Default/missing/wrong inputs instantiate **zero** Clients.

Activated path (offline injected Client) executes only:

`BEGIN READ ONLY` → `SHOW transaction_read_only` → locked catalogs → exact aggregate → `COMMIT`

closes exactly once, returns only counts/safe metadata; failures sanitize secrets and `ROLLBACK`/close.

## Operator command (default-disabled)

```bash
# refuse (default)
node scripts/run-phase-d-live-readonly-count-only.js

# live path (NOT executed in this slice)
SUNSET_PHASE_D_LIVE_READONLY=1 \
SUNSET_PHASE_D_LIVE_PREFLIGHT=1 \
SUNSET_PHASE_D_LIVE_EXECUTE_COUNT_ONLY=1 \
AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
SUNSET_STAGING_PG_ADMIN_USER=... \
SUNSET_STAGING_PG_ADMIN_PASSWORD=... \
  node scripts/run-phase-d-live-readonly-count-only.js \
    --execute-count-only \
    --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
    --resource-group luna-sunset-staging-rg \
    --postgres-server luna-sunset-staging-pg-app \
    --database sunset_staging
```

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero Clients; execute gate missing; CLI forbidden DSN/host/query; wrong exact target; CLI default refuse; connect/query failure sanitize + rollback/close |
| GREEN | activated exact sequence count-only; CLI gates pass; boundary ready with zero connect |

## Non-goals / still open

- **No** live CLI run, Azure connect/query, Key Vault load
- **No** DDL/apply/ledger, migration, or predicate changes
- Still `product_schema_differs`
- Phase D CHECK ADD remains a later slice
- **Do not claim Sunset repaired.**

## Zero live/Azure mutation

Offline injected fake `pg` Client only. No Azure CLI, no live PostgreSQL, no Key Vault credential load, no network/firewall mutation.
