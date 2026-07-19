# FOUNDATION Slice 14Y — Apply five residual indexes

**Status:** five_index_apply_live_ok_observer_reduced
**Master basis:** `ea1e6971a19f57da0ded41eb0d1d28aa165786be`
**Canonical fingerprint (unchanged):** `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18`
**Expected bytes (unchanged):** `cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5`
**Manifest hash (unchanged):** `99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e`
**Generated:** 2026-07-19T23:27:48.215Z

## Five indexes (owner + hash + CREATE sha256)

- `idx_tenant_surf_pack_client_loc` on `tenant_surf_pack_rules` — owner `026_tenant_surf_pack_rules` (`8923551f385bda87e649b567fd47153ed94014029ac5138176beff7e58512496`) createSha=`b832bfd1db8a4ecd8f1195facf0e0c6c2653626c8a7b3009bcdc206da07af671`
- `idx_client_notification_events_client_created` on `client_notification_events` — owner `032_client_notification_settings` (`b3788bd58ce6c6e158857dd56237fa5ff3be0fe4d1afe0f1e5f5c1acdbc4995d`) createSha=`779136efe4d82cea17b808ab92cdcc76fc64923138ff129b34a05da05e6a6387`
- `idx_client_notification_events_conversation` on `client_notification_events` — owner `032_client_notification_settings` (`b3788bd58ce6c6e158857dd56237fa5ff3be0fe4d1afe0f1e5f5c1acdbc4995d`) createSha=`99670a6b79936008d803055e54bceb2d3821b817adb9ae2b7d25007d13cd264b`
- `idx_client_notification_settings_client` on `client_notification_settings` — owner `032_client_notification_settings` (`b3788bd58ce6c6e158857dd56237fa5ff3be0fe4d1afe0f1e5f5c1acdbc4995d`) createSha=`d68979a53470a6f3a283d64939f80e4bbd508f55b7890c51403e9188fef6c1a8`
- `idx_customer_message_templates_client_active` on `customer_message_templates` — owner `035_customer_message_templates` (`924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565`) createSha=`8f0c7d88b3b55dfb1396dd1a7146d8d0a5cc9fc95e07c80f08067d7df735e134`

## Offline gates

- RED: 14 cases
- GREEN: 7 cases
- Authorized sequence length: **43**
- Row count bounds locked: client_notification_events=0, client_notification_settings=0, customer_message_templates=0, tenant_surf_pack_rules=36

## Live before/after observer

apply application_name: `wh-sunset-five-index-apply`
observer application_name: `wh-sunset-schema-observer`
sameTarget: **true**
mismatch before: **11**
mismatch after: **6**
reduced by exactly 5: **true**
five index keys absent from remaining: **true**
remaining keys: ["function:public.fips_mode()","function:public.fips_mode()","pgcrypto","public.fips_mode()","tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at","tenant_surf_pack_rules.tenant_surf_pack_rules_updated_by_fkey.FOREIGN KEY"]

## Row preservation

preserved: **true**
rowCounts: {"tenant_surf_pack_rules":36,"client_notification_events":0,"client_notification_settings":0,"customer_message_templates":0}

Mutation flags: schemaMutation=true; dataMutation=false; ledgerWritten=false.

## Do not claim

- Do **not** claim zero remaining drift / database matches canonical / Sunset fully repaired.
- Do **not** run verify with `--live` (verify never re-runs live / never calls executePhaseDFiveIndexApply live).
- Do **not** modify expected-product-schema bytes/fingerprint or migrations.
- Do **not** retry after partial CREATE INDEX failure (ROLLBACK once).

## Operator live command

```
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_FIVE_INDEX_APPLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:five-index-apply -- --apply-five-indexes --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## Artifacts

- `fixtures/sunset-schema-observer/slice14y-five-index-apply-evidence.json`
- `fixtures/sunset-schema-observer/slice14y-five-index-apply-contract.json`
- `fixtures/sunset-schema-observer/slice14y-findings.md`
