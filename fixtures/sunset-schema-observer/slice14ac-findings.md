# FOUNDATION Slice 14AC — Ledger bootstrap eligibility matrix

**Status:** ledger_eligibility_matrix_live_ok_zero_drift
**Master basis:** `0b92b7eff718f928ccb590d287830d4d104c37c4`
**Canonical fingerprint (unchanged):** `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18`
**Expected bytes (unchanged):** `cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5`
**Manifest hash (unchanged):** `99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e`
**Generated:** 2026-07-20T00:11:26.615Z

## What this slice does

Read-only proof of the **39** canonical_forward migration ledger bootstrap eligibility matrix.
Never writes `schema_migration_ledger` or labels rows `executed_by_canonical_runner`.

- application_name: `wh-sunset-ledger-eligibility`
- Observer must reach `remainingMismatchCount === 0` under merged 14AB normalizations
- `schema_migration_ledger` must be absent before bootstrap
- DEC-006 targeted SELECT evidence for migrations 018–020
- Contiguous prefix algorithm; first offline blocker likely **020** at prefix **18** (aggregate 0)

## Offline gates

- RED: 16 cases
- GREEN: 11 cases

## Offline matrix (fixture)

- forwardCount: **39**
- maxPrefixCount: **18**
- firstBlocker: {"id":"020_wolfhouse_room_gender_metadata","apply_order":19,"blockedReason":"unproven_dml_zero_aggregate"}
- proposedLedgerRows: **18**

## Live

application_name: `wh-sunset-ledger-eligibility`
sameTarget: **true**
sessionReadOnly: **true**
remaining mismatch: **0**
ledger absent: **true**
matrix forwardCount: **39**
maxPrefixCount: **18**

Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.

## Do not claim

- Do **not** INSERT into `schema_migration_ledger` or claim `executed_by_canonical_runner`.
- Do **not** run verify with `--live` (verify never re-runs live).
- Do **not** modify expected-product-schema bytes/fingerprint or migrations.

## Operator live command

```
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_LEDGER_ELIGIBILITY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:ledger-eligibility -- --prove-ledger-eligibility-matrix --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## Artifacts

- `fixtures/sunset-schema-observer/slice14ac-ledger-eligibility-matrix-evidence.json`
- `fixtures/sunset-schema-observer/slice14ac-ledger-eligibility-matrix-contract.json`
- `fixtures/sunset-schema-observer/slice14ac-findings.md`
