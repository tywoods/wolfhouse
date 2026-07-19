# FOUNDATION Slice 14X — NOT NULL identifier truncation normalization

**Status:** identifier_truncation_normalization_live_ok
**Master basis:** `a093f0ddbc3ed84bc57c04b5175f7385c9775171`
**Canonical fingerprint (unchanged):** `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18`
**Expected bytes (unchanged):** `cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5`
**Migration 002 sha256 (locked):** `3caa9c743252bd058c7eb8cb9bdbd39686b3970249c9d5c051e6971ebf476748`

## What this slice does

Conservative `azure_flexible_server_v1` + `postgresql_15` comparison normalization for
exactly **one** PostgreSQL auto-generated NOT NULL identifier truncation artifact
(extends 14T/14V/14W; default OFF):

- application_name: `wh-sunset-identifier-truncation-normalization`

- Locked tuple: `package_price_rules.package_price_rules_double_supplement_per_person_per_n_not_null`
  (exact 63-byte NAMEDATALEN identifier), type=`n`,
  definition=`NOT NULL double_supplement_per_person_per_night_cents`,
  expected/live column nullable=NO; owner migration **002** hash-locked.
- Derives observed name via PostgreSQL `makeObjectName(table_column, NULL, "not_null")`
  label-preserving truncation; rejects every other truncated/near-collision name.
- Does **not** implement fuzzy/general prefix matching.
- Does **not** broaden 14T/14V/14W rules.

## Offline gates

- RED: 19 cases
- GREEN: 12 cases
- Provenance tuples: **1**
- Positive artifacts: **1**

## Live

application_name: `wh-sunset-identifier-truncation-normalization`
sameTarget: **true**
server version class: **postgresql_15**
baseline mismatch (identity + 14T + 14V + 14W; truncation off): **12**
identifier truncations normalized: **1**
remaining mismatch: **11**
remaining keys: ["client_notification_events.idx_client_notification_events_client_created","client_notification_events.idx_client_notification_events_conversation","client_notification_settings.idx_client_notification_settings_client","customer_message_templates.idx_customer_message_templates_client_active","function:public.fips_mode()","function:public.fips_mode()","pgcrypto","public.fips_mode()","tenant_surf_pack_rules.idx_tenant_surf_pack_client_loc","tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at","tenant_surf_pack_rules.tenant_surf_pack_rules_updated_by_fkey.FOREIGN KEY"]
accounting: baseline === normalized + remaining (reported; not forced to a constant final count)

Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.

## Do not claim

- Do **not** claim Sunset fully repaired / database matches canonical.
- Do **not** apply rename/NOT NULL DDL in this slice.
- Do **not** run verify with `--live` (verify never re-runs live).
- Do **not** modify expected-product-schema bytes/fingerprint or migrations.
- Do **not** broaden 14T/14V/14W or add fuzzy prefix matching.

## Operator live command

```
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_IDENTIFIER_TRUNCATION_NORMALIZATION=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:identifier-truncation-normalization -- --prove-identifier-truncation-normalization --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## Artifacts

- `fixtures/sunset-schema-observer/slice14x-identifier-truncation-normalization-evidence.json`
- `fixtures/sunset-schema-observer/slice14x-identifier-truncation-normalization-contract.json`
- `fixtures/sunset-schema-observer/slice14x-findings.md`
