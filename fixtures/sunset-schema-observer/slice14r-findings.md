# FOUNDATION Slice 14R — Live reconcile decision

**Status:** complete (offline RED/GREEN + live path; **zero mutation**)
**Master basis:** `7862b67ffa5c8ef2df63c15e231dcc9d266b369f`
**Outcome:** `phase_d_reconcile_decision_live_preserved`

## What this slice proves

Read-only occupancy aggregates + observer drift grouping on the confirmed active
Sunset staging DB (`sunset_staging` via `luna-sunset-staging-staff-api`),
then a **deterministic** recommendation: `clean_canonical_rebuild_cutover` vs
`in_place_targeted_repair` / `controlled_export_import` (design-only plans; execute none).

## Offline gates

- RED: 14 cases (default refuse, gates, wrong target, hidden data, count ambiguity,
  overflow, unsafe rebuild rejection, secret leakage, non-read-only session)
- GREEN: 7 cases (empty→clean rebuild, nonempty→in-place, CLI gates, locks,
  global apply false, deterministic decision criteria)

## Live

Live reconcile-decision **ok** (recommendation=in_place_targeted_repair, sameTarget=true).

Mutation flags (all must remain false): liveMutation / schemaMutation / dataMutation /
ledgerWritten / kvMutation = **false**.

## Do not claim

- Do **not** execute rebuild, repair, or ledger writes from this slice.
- Do **not** run verify with `--live` (verify never re-runs live).
- Do **not** persist DSN, passwords, tokens, or secret versions.

## Artifacts

- `fixtures/sunset-schema-observer/slice14r-live-reconcile-decision-evidence.json`
- `fixtures/sunset-schema-observer/slice14r-live-reconcile-decision-contract.json`
- `fixtures/sunset-schema-observer/slice14r-findings.md`
