# FOUNDATION Slice 14K — Key Vault DSN sslmode=verify-full apply activation (offline)

**Status:** complete (14J adapter activated behind gated apply CLI; live HTTP transport present; offline injected proof only; rollback hard-disabled; zero live IMDS/KV/PG)
**Master basis:** `4cfb610e069bb382f83160064963fd86572ffecb`
**Generated:** 2026-07-19T20:26:45.146Z

## Outcome

Activated the merged Slice **14J** metadata-preserving sslmode-only Key Vault mutation adapter behind a dedicated exact operator command. Real Node `http`/`https` transport is restricted to locked IMDS GET, exact current-secret GET, exactly one same-secret PUT, and exact verification GET — redirects, DNS/host/path/method/body deviations, and retries are rejected.

Live path requires:

1. `SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_APPLY=1`
2. exact `AZURE_SUBSCRIPTION_ID`
3. `--apply-verify-full`
4. exact subscription / RG / VM RG / VM name / managed identity / vault / secret / postgres server / database

Default / missing / wrong gates → **zero HTTP / zero writes**. Rollback remains separately hard-disabled. This slice does **not** execute live IMDS/Key Vault/PostgreSQL.

| Lock | Value |
|------|-------|
| Vault / secret | `luna-sunset-staging-kv` / `sunset-database-url` |
| Identity / VM | `wh-staging-identity` / `lunabox` in `wh-staging-rg` |
| PG host / database | `luna-sunset-staging-pg-app.postgres.database.azure.com` / `sunset_staging` |
| Mutation | `sslmode` only → `verify-full` (metadata preserved) |
| PUT count | exactly 1 (no retries) |

## Operator command (default-disabled; NOT executed live in this slice)

```bash
SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_APPLY=1 \
AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
npm run phase-d:kv-dsn-verify-full-apply -- \
  --apply-verify-full \
  --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
  --resource-group luna-sunset-staging-rg \
  --vm-resource-group wh-staging-rg \
  --vm-name lunabox \
  --managed-identity wh-staging-identity \
  --key-vault luna-sunset-staging-kv \
  --secret-name sunset-database-url \
  --postgres-server luna-sunset-staging-pg-app \
  --database sunset_staging
```

## RED / GREEN (injected transport + child CLI)

| Class | Cases |
|-------|-------|
| RED | default/missing env/flag; wrong targets; forbidden DSN/url/token/file argv; bare adapter zero writes; sanitized transport/PUT/verify failures; rollback hard-disabled; live transport rejects host/method/body deviations |
| GREEN | live HTTP activated + rollback disabled; exact gates; fake HTTP **IMDS GET + KV GET + KV PUT + verify GET** (4 calls, 1 PUT, metadata preserved); CLI default refuse; CLI missing-env refuse; live transport present; hashes preserved; no pg Client |

**Mutation success call counts:** httpRequestCount=4, imdsRequestCount=1, keyVaultGetCount=2, keyVaultPutCount=1.

## Non-goals / still open

- **No** live IMDS / Key Vault / PostgreSQL call in this slice
- **No** RBAC / network / PG / DB / DDL / ledger / migration change
- Still `product_schema_differs`
- **Do not claim** Sunset repaired.

## Zero live mutation

Offline injected-HTTP proof + child CLI gate refuses only. Default/wrong args → zero HTTP/writes. Rollback flag remains `false`. No live apply executed.
