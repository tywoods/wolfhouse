# FOUNDATION Slice 14AB — Azure PG15 pgcrypto compatibility normalization

**Status:** pgcrypto_compatibility_normalization_live_ok_zero_drift
**Master basis:** `51578961029ae7c7b53582542f049d53f2952b98`
**Canonical fingerprint (unchanged):** `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18`
**Expected bytes (unchanged):** `cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5`
**Manifest hash (unchanged):** `99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e`
**Generated:** 2026-07-19T23:55:45.021Z

## What this slice does

Conservative `azure_flexible_server_v1` + `postgresql_15` presentation normalization for
exactly the final **4** Azure pgcrypto/fips_mode residuals (default OFF):

- application_name: `wh-sunset-pgcrypto-compatibility`
- rule: `azure_pg15_pgcrypto_compatibility`
- locked version pair: expected **1.4** → live **1.3** (Azure PG15 default ceiling)
- strips expected-only `public.fips_mode()` function + ownership + ACL
- maps expected `pgcrypto` extension version presentation 1.4 → 1.3
- does **not** ALTER/UPDATE EXTENSION or privileges

## Offline gates

- RED: 17 cases
- GREEN: 10 cases

## Live

application_name: `wh-sunset-pgcrypto-compatibility`
sameTarget: **true**
server version class: **postgresql_15**
baseline mismatch (14T+14V+14W+14X on; pgcrypto off): **4**
pgcrypto compatibilities normalized: **4**
remaining mismatch: **0**
remaining keys: []
accounting: baseline === normalized + remaining → **true**

### Expected / live extension tuples

- expected: `{name:pgcrypto, version:1.4, schema:public, owner:$db_owner, relocatable:true}`
- live installed: {"extversion":"1.3","schema":"public","owner":"azuresu","relocatable":true}
- available/default ceiling: {"name":"pgcrypto","default_version":"1.3","installed_version":"1.3"}
- fips_mode present: **false**
- capability membership: {"gen_random_uuid":{"identity":"public.gen_random_uuid()","returnType":"uuid","language":"c","extname":"pgcrypto"}}

Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.

## Do not claim

- Do **not** ALTER/UPDATE EXTENSION or mutate privileges.
- Do **not** run verify with `--live` (verify never re-runs live).
- Do **not** modify expected-product-schema bytes/fingerprint or migrations.

## Operator live command

```
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_PGCRYPTO_COMPATIBILITY_NORMALIZATION=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:pgcrypto-compatibility-normalization -- --prove-pgcrypto-compatibility-normalization --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## Artifacts

- `fixtures/sunset-schema-observer/slice14ab-azure-pgcrypto-compat-normalization-evidence.json`
- `fixtures/sunset-schema-observer/slice14ab-azure-pgcrypto-compat-normalization-contract.json`
- `fixtures/sunset-schema-observer/slice14ab-findings.md`
