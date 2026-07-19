# FOUNDATION Slice 14V — hostel_id→client_id rename-alias normalization

**Status:** rename_alias_normalization_live_ok
**Master basis:** `7b54b17ff1071349c82344277971df75a87ed499`
**Canonical fingerprint (unchanged):** `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18`
**Expected bytes (unchanged):** `cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5`
**Migration 003 sha256 (locked):** `f79826262081050f68c7f8014136d90730dc4dedffe37549aad2ff998f340257`

## What this slice does

Conservative `azure_flexible_server_v1` + `postgresql_15` comparison normalization for
migration 003 hostel_id→client_id NOT NULL **constraint-name aliases**:

- Expected may still encode `{table}_hostel_id_not_null` with definition `NOT NULL client_id`
  for tables in the migration 003 FOREACH rename loop (15 tables; provenance hash-locked).
- Live Azure PG15 encodes the guarantee via `attnotnull` on `client_id` with `hostel_id` absent
  and no matching type-n constraint object.
- Normalize (exclude from compare) only those proven aliases when live `client_id` is `nullable=NO`
  and `hostel_id` is absent.
- Does **not** broaden Slice 14T `parseCanonicalNotNullConstraint` (exact-name rule still rejects
  `beds_hostel_id_not_null` / `NOT NULL client_id` as `name_shape_mismatch`).
- Soft-skips when PG15 versionClass is absent (14T/14U keep working).
- Never suppresses hostels_* leftovers, truncated names, amount_cents/kind mismatches,
  nullable YES, missing columns, live hostel_id present, duplicates, wrong definition,
  arbitrary names, or non-approved tables.

Offline 24-key name_shape fixture: **24** residuals; **12**
positive hostel_id aliases normalize when columns match; **12** negatives retain.

## Offline gates

- RED: 16 cases
- GREEN: 10 cases
- Provenance tables: **15**
- Positive aliases: **12**

## Live

application_name: `wh-sunset-rename-alias-normalization`
sameTarget: **true**
server version class: **postgresql_15**
baseline mismatch (identity + 14T; rename alias off): **35**
rename aliases normalized: **12**
remaining mismatch: **23**
before sections: {"constraints":25,"indexes":5,"functions":1,"triggers":1,"ownership":1,"acls":1,"extensions":1}
after sections: {"constraints":13,"indexes":5,"functions":1,"triggers":1,"ownership":1,"acls":1,"extensions":1}
accounting: baseline === aliases + remaining (reported; not forced to a constant final count)

Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.

## Do not claim

- Do **not** claim Sunset fully repaired / database matches canonical.
- Do **not** apply rename/NOT NULL DDL in this slice.
- Do **not** run verify with `--live` (verify never re-runs live).
- Do **not** modify expected-product-schema bytes/fingerprint or migrations.
- Do **not** broaden 14T exact-name parsing.

## Operator live command

```
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_RENAME_ALIAS_NORMALIZATION=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:rename-alias-normalization -- --prove-rename-alias-normalization --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## Artifacts

- `fixtures/sunset-schema-observer/slice14v-rename-alias-normalization-evidence.json`
- `fixtures/sunset-schema-observer/slice14v-rename-alias-normalization-contract.json`
- `fixtures/sunset-schema-observer/slice14v-findings.md`
