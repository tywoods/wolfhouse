# FOUNDATION Slice 14S — Phase B additive reconcile

**Status:** phase_b_additive_ok_observer_drift
**Master basis:** `691025bd4e92ee6d0ea5a6cd214ea10e92ca7d4e`
**Outcome:** `phase_b_additive_ok_observer_drift`

## What this slice does

Phase B **additive only** on Sunset staging: create missing
`public.customer_message_templates` from byte-locked migration 035
CREATE TABLE SQL (thereby adding its exact 9 columns).

- CREATE TABLE sha256: `826046e1d5810c28b74945041a02a8c48c84dcc38bec60a98f86a8c67331763b`
- Migration 035 sha256: `924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565`
- application_name: `wh-sunset-phase-b-additive`
- Observer before claim mismatch total: **499**

## Offline gates

- RED: 13 cases
- GREEN: 8 cases

## Live

Target authority **sameTarget=true**.
Firewall prestate **ok**.
Credential preflight **ok**.
Live Phase B additive **ok** (CREATE TABLE customer_message_templates, committed=true, queryCalls=14, schemaMutation=true, dataMutation=false, indexAbsent=true).
Observer **drift or blocked** (mismatchCountBeforeClaim=499, mismatchCountAfter=483, phaseBTableColumnKeysCleared=true). **Do not claim Sunset fully repaired.**

Mutation flags: schemaMutation=true; dataMutation=false; ledgerWritten=false.

## Do not claim

- Do **not** claim Sunset fully repaired unless observer mismatch is truly zero.
- Do **not** CREATE INDEX / COMMENT / Phase C–G in this slice.
- Do **not** run verify with `--live` (verify never re-runs live).
- Do **not** persist DSN, passwords, tokens, or secret versions.

## Operator apply command

```
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_PHASE_B_ADDITIVE=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:phase-b-additive-reconcile -- --apply-phase-b-additive --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## Artifacts

- `fixtures/sunset-schema-observer/slice14s-phase-b-additive-reconcile-evidence.json`
- `fixtures/sunset-schema-observer/slice14s-phase-b-additive-reconcile-contract.json`
- `fixtures/sunset-schema-observer/slice14s-findings.md`
