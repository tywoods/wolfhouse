# FOUNDATION Slice 14U — Residual drift classify + preflight

**Status:** residual_drift_preflight_live_ok
**Master basis:** `e0db8af748a7d3cc93cb84fc6b09c199dc4fb5e8`
**Canonical fingerprint (unchanged):** `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18`
**Expected bytes (unchanged):** `cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5`
**Manifest hash (unchanged):** `99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e`

## What this slice does

Read-only classify + preflight of the exact **35** residual drifts remaining after
Slice 14T NOT NULL observer normalization under `azure_flexible_server_v1`:

- Baseline gate: mismatchCount === 35 with sections
  constraints=25, indexes=5, functions=1, triggers=1, ownership=1, acls=1, extensions=1
- Canonical key inventory (secret-free) with migration ownership + sha256CanonicalLfV1
- Constraint aggregates: NOT NULL null_count, PK/UNIQUE duplicates, FK orphans, CHECK violations
- Index support proof (columns exist; no duplicate semantic index; safe COUNT(*) only)
- Non-table classify: normalization_only / additive / privilege_mutation / extension_policy / blocker
- Deterministic mutation batches with `execute:false` always — zero mutation

**Do not** invent or carry forward the historical **448** NOT NULL normalized count as
residual inventory. Residual inventory is **35 only**.

## Offline gates

- RED: 12 cases
- GREEN: 12 cases

## Live

application_name: `wh-sunset-residual-drift-preflight`
sameTarget: **true**
server version class: **postgresql_15**
baseline mismatchCount: **35**
inventory count: **35**
coverage: **coverage_complete** (unowned=0, duplicate=0)
after sections: {"constraints":25,"indexes":5,"functions":1,"triggers":1,"ownership":1,"acls":1,"extensions":1}

### Grouped residual classification

| Group | Count | Notes |
|-------|------:|-------|
| indexes / exact_additive | 5 | supporting columns OK; no duplicate semantic index; row totals 0/0/0/0/36 |
| constraints / FOREIGN_KEY | 1 | `tenant_surf_pack_rules_updated_by_fkey` orphans=**0** |
| constraints / unsupported (contype n, name_shape_mismatch) | 24 | hostel→client rename leftovers + truncated names; **not** true NOT NULL-shaped; no null aggregates |
| triggers / exact_additive | 1 | `tenant_surf_pack_rules_updated_at` |
| functions+ownership+acls / normalization_only | 3 | `fips_mode` pgcrypto Azure presentation |
| extensions / extension_policy | 1 | `pgcrypto` definition_mismatch |

True NOT NULL-shaped residuals: **0**. Safe violation counts: FK orphans=**0**; no PK/UNIQUE/CHECK residuals in the 35.

### Ordered future mutation batches (execute=false)

1. `batch_01_indexes_additive` (5) — exact_additive_canonical_apply
2. `batch_04_fk_safe` (1) — exact_additive_canonical_apply; stop if orphan_count≠0
3. `batch_06_functions_triggers_additive` (1) — trigger only
4. `batch_06b_normalization_only` (3) — fips_mode trio; do not CREATE
5. `batch_08_extensions` (1) — pgcrypto extension_policy
6. `batch_08b_unsupported_definitions` (24) — blocker; rename/name-shape leftovers

Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.
All mutation batches: execute=false. Zero mutation.

## Do not claim

- Do **not** claim Sunset fully repaired unless observer mismatch is truly zero.
- Do **not** apply residual DDL/DML in this slice.
- Do **not** run verify with `--live` (verify never re-runs live).
- Do **not** modify expected-product-schema bytes/fingerprint or migrations.
- Do **not** treat 448 as residual inventory size.

## Operator live command

```
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_RESIDUAL_DRIFT_PREFLIGHT=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:residual-drift-preflight -- --prove-residual-drift-preflight --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## Artifacts

- `fixtures/sunset-schema-observer/slice14u-residual-drift-preflight-evidence.json`
- `fixtures/sunset-schema-observer/slice14u-residual-drift-preflight-contract.json`
- `fixtures/sunset-schema-observer/slice14u-findings.md`
