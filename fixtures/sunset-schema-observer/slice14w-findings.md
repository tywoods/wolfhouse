# FOUNDATION Slice 14W — final NOT NULL rename-provenance normalization

**Status:** final_rename_normalization_live_ok
**Master basis:** `c0efa35ae818cb3c723dc81f79eee57e3041af70`
**Canonical fingerprint (unchanged):** `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18`
**Expected bytes (unchanged):** `cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5`
**Migration 002 sha256 (locked):** `3caa9c743252bd058c7eb8cb9bdbd39686b3970249c9d5c051e6971ebf476748`
**Migration 003 sha256 (locked):** `f79826262081050f68c7f8014136d90730dc4dedffe37549aad2ff998f340257`
**Migration 004 sha256 (locked):** `c82718b6417ffa8c594227bb8873b8d89d65d567caf4489e108f1b86485f22c1`

## What this slice does

Conservative `azure_flexible_server_v1` + `postgresql_15` comparison normalization for
exact rename-provenance NOT NULL legacy-name artifacts (extends 14T/14V; default OFF):

- application_name: `wh-sunset-final-rename-normalization`

- Migration **003** table rename `hostels→clients`: only `clients.hostels_<column>_not_null`
  with definition `NOT NULL <same column>` for the exact nine approved columns;
  expected/live `clients.<column>` nullable=NO; live `hostels` table absent.
- Migration **002** column rename `price_per_person_per_night_cents→price_per_person_per_week_cents`:
  only that exact residual legacy name/definition/current column (`RENAME COLUMN price_per_person_per_night_cents TO price_per_person_per_week_cents`).
- Migration **004** `kind→payment_kind` and `amount_cents→amount_due_cents`: only those two residuals.
- Does **not** broaden 14T `parseCanonicalNotNullConstraint` or 14V hostel_id alias rules.
- Truncated names, unapproved columns, wrong definition, old+new coexistence, nullable YES,
  non-Azure, non-PG15, or migration hash changes retain/fail.

Offline exact-12 fixture: **9** hostels table-rename + **1** night→week + **2** payments.

## Offline gates

- RED: 18 cases
- GREEN: 11 cases
- Provenance tuples: **4**
- Positive artifacts: **12**

## Live

application_name: `wh-sunset-final-rename-normalization`
sameTarget: **true**
server version class: **postgresql_15**
baseline mismatch (identity + 14T + 14V; final rename off): **23**
final renames normalized: **11**
remaining mismatch: **12**
remaining keys: ["client_notification_events.idx_client_notification_events_client_created","client_notification_events.idx_client_notification_events_conversation","client_notification_settings.idx_client_notification_settings_client","customer_message_templates.idx_customer_message_templates_client_active","function:public.fips_mode()","function:public.fips_mode()","package_price_rules.package_price_rules_double_supplement_per_person_per_n_not_null.n","pgcrypto","public.fips_mode()","tenant_surf_pack_rules.idx_tenant_surf_pack_client_loc","tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at","tenant_surf_pack_rules.tenant_surf_pack_rules_updated_by_fkey.FOREIGN KEY"]
accounting: baseline === normalized + remaining (reported; not forced to a constant final count)

Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.

## Do not claim

- Do **not** claim Sunset fully repaired / database matches canonical.
- Do **not** apply rename/NOT NULL DDL in this slice.
- Do **not** run verify with `--live` (verify never re-runs live).
- Do **not** modify expected-product-schema bytes/fingerprint or migrations.
- Do **not** broaden 14T exact-name parsing or weaken 14V.

## Operator live command

```
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_FINAL_RENAME_NORMALIZATION=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:final-rename-normalization -- --prove-final-rename-normalization --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## Artifacts

- `fixtures/sunset-schema-observer/slice14w-final-rename-normalization-evidence.json`
- `fixtures/sunset-schema-observer/slice14w-final-rename-normalization-contract.json`
- `fixtures/sunset-schema-observer/slice14w-findings.md`

