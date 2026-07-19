# FOUNDATION Slice 14T — NOT NULL observer representation normalization

**Status:** not_null_normalization_live_ok
**Master basis:** `9a6d45b0d0d880d43ed41749d95d2d289ace9917`
**Canonical fingerprint (unchanged):** `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18`
**Expected bytes (unchanged):** `cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5`

## What this slice does

Conservative `azure_flexible_server_v1` comparison normalization for cross-PostgreSQL-version
NOT NULL representation:

- Expected may encode NOT NULL as `pg_constraint` contype `n` objects
  (`type=n`, `definition=NOT NULL <col>`, `name=<table>_<col>_not_null`).
- Azure Flexible Server often encodes the same guarantee via `pg_attribute.attnotnull`
  (column `nullable=NO`) without a matching constraint object.
- Normalize only when expected column `nullable=NO` and live column exists with `nullable=NO`.
- Exclude only those redundant expected constraint objects from constraint compare.
- Never suppress real nullable mismatch (YES / missing / ambiguous / duplicate /
  unsupported shape / PK/FK/CHECK / non-Azure).

Migration 035 fixture (offline): **9** CMT NOT NULL artifacts normalize
only when column semantics match.

## Offline gates

- RED: 12 cases
- GREEN: 8 cases

## Live

application_name: `wh-sunset-not-null-normalization`
sameTarget: **true**
server version class: **postgresql_15**
mismatch before (identity only): **483**
mismatch after (identity + NOT NULL norm): **35**
NOT NULL artifacts normalized: **448**
before sections: {"constraints":473,"indexes":5,"functions":1,"triggers":1,"ownership":1,"acls":1,"extensions":1}
after sections: {"constraints":25,"indexes":5,"functions":1,"triggers":1,"ownership":1,"acls":1,"extensions":1}

Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.

## Do not claim

- Do **not** claim Sunset fully repaired unless observer mismatch is truly zero.
- Do **not** apply NOT NULL DDL in this slice.
- Do **not** run verify with `--live` (verify never re-runs live).
- Do **not** modify expected-product-schema bytes/fingerprint or migrations.

## Operator live command

```
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_NOT_NULL_NORMALIZATION=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:not-null-observer-normalization -- --prove-not-null-normalization --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## Artifacts

- `fixtures/sunset-schema-observer/slice14t-not-null-observer-normalization-evidence.json`
- `fixtures/sunset-schema-observer/slice14t-not-null-observer-normalization-contract.json`
- `fixtures/sunset-schema-observer/slice14t-findings.md`
