# FOUNDATION Slice 14J — Key Vault DSN sslmode=verify-full normalize plan (offline)

**Status:** complete (plan + offline injected-HTTP proof; live mutate/rollback hard-disabled; zero live KV read/write)
**Master basis:** `ec6a5e9589026db1675a82f4d0b05ddc4a62320e`
**Generated:** 2026-07-19T20:18:01.125Z

## Outcome

Built and offline-proven a locked, recoverable operator plan to normalize **only** the existing Key Vault secret `luna-sunset-staging-kv/sunset-database-url` from a TLS-deficient PostgreSQL DSN to the same exact host, port, database, username and password with `sslmode=verify-full` — **without** reading or mutating the live secret in this slice.

| Lock | Value |
|------|-------|
| Vault / secret | `luna-sunset-staging-kv` / `sunset-database-url` |
| Identity | `wh-staging-identity` / `0dd41fa2-52c8-4e04-bc23-8aa462938c19` |
| PG host / port / database | `luna-sunset-staging-pg-app.postgres.database.azure.com` / `5432` / `sunset_staging` |
| Mutation | `sslmode` only → `verify-full` |
| Metadata | preserve exact contentType/tags/enabled/nbf/exp |
| PUT count | exactly 1 (no retries) |
| Rollback | immediately previous version only (adjacency proven), separate approval |

## Mutation / rollback contract

**Mutation (future live adapter):** IMDS GET → KV GET → capture supported user metadata in memory → parse+require exact host/port/database → retain user/password in memory → modify only `sslmode` → PUT one new secret version with value **and** preserved metadata → verification GET proves DSN + metadata equality (only system version id/timestamps may differ) → zero private refs. Prior version safe ID retained for rollback.

**Rollback:** separate approval (default disabled). Before any PUT: GET current + LIST versions (pagination rejected) → require `versions[0]===current` and `versions[1]===caller prior` with `created[0]>created[1]` → GET prior → validate exact target → PUT prior value+preserved metadata → verify. Nonadjacent/stale/paginated → **zero writes**.

## Operator command (plan-only; default refuse)

```bash
SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_PLAN=1 \
AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
npm run phase-d:kv-dsn-verify-full-plan -- \
  --plan-only \
  --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
  --resource-group luna-sunset-staging-rg \
  --key-vault luna-sunset-staging-kv \
  --secret-name sunset-database-url \
  --managed-identity wh-staging-identity \
  --postgres-server luna-sunset-staging-pg-app \
  --database sunset_staging
```

## RED / GREEN (fake HTTP)

| Class | Cases |
|-------|-------|
| RED | default/missing env/flag; wrong targets; forbidden value/DSN/url/token/version/file argv; host/tags/delete/retries/arbitrary-version; adapter without inject; already verify-full (zero PUT); PUT failure keeps prior-version safe ID; rollback without approval; unsupported metadata; metadata mismatch; nonadjacent/stale version; list pagination |
| GREEN | locked mutation+rollback plans; CLI safe IDs; CLI rollback prior-version safe ID; fake HTTP **IMDS GET + KV GET + KV PUT + verify GET** (4 calls, 1 PUT); metadata preservation; exact rollback sequence (6 calls, adjacency+metadata); live disabled + hashes preserved + no pg Client |

**Mutation success call counts:** httpRequestCount=4, imdsRequestCount=1, keyVaultGetCount=2, keyVaultPutCount=1.
**Rollback success call counts:** httpRequestCount=6, imdsRequestCount=1, keyVaultGetCount=3, keyVaultListCount=1, keyVaultPutCount=1.

## Non-goals / still open

- **No** live Key Vault read or write in this slice
- **No** RBAC / identity / network / PG / DB / DDL / ledger / migration
- Still `product_schema_differs`
- **Do not claim** Sunset repaired.

## Zero live mutation

Plan-only offline emission + injected-HTTP proof. Default/wrong args → zero KV writes. Live mutate and live rollback flags remain `false`.
