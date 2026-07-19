# FOUNDATION Slice 14Z — Apply tenant_surf_pack_rules_updated_by_fkey

**Status:** surf_pack_fk_apply_live_ok_observer_reduced
**Master basis:** `da67cf2c229f80d0cf118f7e361d95902cb6d32d`
**Canonical fingerprint (unchanged):** `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18`
**Expected bytes (unchanged):** `cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5`
**Manifest hash (unchanged):** `99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e`
**Generated:** 2026-07-19T23:35:49.124Z

## FK (owner + hash + ALTER sha256)

- `tenant_surf_pack_rules_updated_by_fkey` on `tenant_surf_pack_rules` → `staff_users(id)` — owner `026_tenant_surf_pack_rules` (`8923551f385bda87e649b567fd47153ed94014029ac5138176beff7e58512496`)
- addNotValidSha=`f3754b8cd96e47b9f8b89169c8147588e2722743dd98c8d58e8bcb762b3f7e35` validateSha=`585624cd76d3b1d088cd33c9e291176753bff81e73fa27a54a3dbeb8c288a9b6` directAddSha=`964301d35d2bac4f0df0582be7d059ed3f549dacf8f58dac1e74b2a754819c1a`

## Offline gates

- RED: 13 cases
- GREEN: 9 cases
- Authorized sequence length: **21**
- Advisory locks: WHPZ (0x5748505A) / SPFK (0x5350464B)
- Row count bound: tenant_surf_pack_rules=36 (capture if live differs)

## Live before/after observer

apply application_name: `wh-sunset-surf-pack-fk-apply`
observer application_name: `wh-sunset-schema-observer`
sameTarget: **true**
mismatch before: **6**
mismatch after: **5**
reduced by exactly 1: **true**
FK key absent from remaining: **true**
remaining keys: ["function:public.fips_mode()","function:public.fips_mode()","pgcrypto","public.fips_mode()","tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at"]

## Row preservation

preserved: **true**
rowCounts: {"tenant_surf_pack_rules":36}

Mutation flags: schemaMutation=true; dataMutation=false; ledgerWritten=false.

## Do not claim

- Do **not** claim zero remaining drift / database matches canonical / Sunset fully repaired.
- Do **not** run verify with `--live` (verify never re-runs live / never calls executePhaseDSurfPackFkApply live).
- Do **not** modify expected-product-schema bytes/fingerprint or migrations.
- Do **not** retry after partial FK failure (ROLLBACK once).

## Operator live command

```
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_SURF_PACK_FK_APPLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:surf-pack-fk-apply -- --apply-surf-pack-fk --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## Artifacts

- `fixtures/sunset-schema-observer/slice14z-surf-pack-fk-apply-evidence.json`
- `fixtures/sunset-schema-observer/slice14z-surf-pack-fk-apply-contract.json`
- `fixtures/sunset-schema-observer/slice14z-findings.md`

