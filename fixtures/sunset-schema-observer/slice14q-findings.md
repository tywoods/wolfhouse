# FOUNDATION Slice 14Q — Active DB target authority

**Status:** complete (offline RED/GREEN + live authority path; **zero mutation**)
**Master basis:** `85ad38b16146bcc9cbc2abbca8a77fa1471bf3df`
**Outcome:** `phase_d_target_authority_live_preserved`

## What this slice proves

Read-only proof that the active Sunset-staging Staff API Container App
(`luna-sunset-staging-staff-api`) and the Key Vault admin secret
(`luna-sunset-staging-kv/sunset-database-url`) resolve to the
**same exact** PostgreSQL server/database/credential authority locked for Phase D.
Then classify live observer drift (`expected_only` mass) enough to choose a safe
reconciliation path (`genuinely_sparse_active_runtime_db` vs `wrong_target` vs
`observation_defect` vs `schema_divergence`).

## Offline gates

- RED: 14 cases (default refuse, missing prove flag/env, wrong targets,
  forbidden argv, MI dual flags, mismatched app/KV, ambiguous secretRef, multiple
  revisions, missing DB env, malformed DSN, secret leakage, non-read-only session,
  observer counts shape)
- GREEN: 7 cases (KV URL ref authority, value compare, CLI gates,
  locks, global apply false, classifyDrift unit checks)

## Live

Live target-authority **sameTarget=true** (activeRevision=luna-sunset-staging-staff-api--0000266, dbEnv=WOLFHOUSE_DATABASE_URL, secretRef=sunset-database-url, drift=schema_divergence).

Mutation flags (all must remain false): liveMutation / schemaMutation / dataMutation /
ledgerWritten / kvMutation = **false**.

## Do not claim

- Do **not** claim Sunset repaired or schema reconciled.
- Do **not** run verify with `--live` (verify never re-runs live).
- Do **not** persist DSN, passwords, tokens, or secret versions.

## Artifacts

- `fixtures/sunset-schema-observer/slice14q-active-db-target-authority-evidence.json`
- `fixtures/sunset-schema-observer/slice14q-active-db-target-authority-contract.json`
- `fixtures/sunset-schema-observer/slice14q-findings.md`
