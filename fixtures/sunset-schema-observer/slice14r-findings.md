# FOUNDATION Slice 14R — Live reconcile decision

**Status:** complete (offline RED/GREEN + live path; **zero mutation**)
**Master basis:** `7862b67ffa5c8ef2df63c15e231dcc9d266b369f`
**Outcome:** `phase_d_reconcile_decision_live_preserved`

## What this slice proves

Read-only occupancy aggregates + observer drift grouping on the confirmed active
Sunset staging DB (`sunset_staging` via `luna-sunset-staging-staff-api`),
then a **deterministic** recommendation: `clean_canonical_rebuild_cutover` vs
`in_place_targeted_repair` / `controlled_export_import` (design-only plans; execute none).

In-place plan uses ordered design-only phases **A–G** (`execute=false` throughout):
A normalize/target → B missing tables/columns → C NOT NULL preflight/bounded apply →
D indexes then PK/FK → E functions/triggers/RLS/ownership/ACL/extensions →
F ledger bootstrap after schema match → G observer zero-drift + idempotent rerun.
Live CHECK mismatches are **already_cleared** when count=0; NOT_NULL > 0 blocks completion.

## Offline gates

- RED: 16 cases (default refuse, gates, wrong target, hidden data, count ambiguity,
  overflow, unsafe rebuild rejection, secret leakage, non-read-only session,
  omitted NOT_NULL/non-table section, unsafe phase ordering)
- GREEN: 8 cases (empty→clean rebuild, nonempty→in-place, CLI gates, locks,
  global apply false, deterministic decision criteria, complete A–G coverage)

## Live

Live reconcile-decision **ok** (recommendation=in_place_targeted_repair, sameTarget=true).

Mutation flags (all must remain false): liveMutation / schemaMutation / dataMutation /
ledgerWritten / kvMutation = **false**.

## Do not claim

- Do **not** execute rebuild, repair, or ledger writes from this slice.
- Do **not** run verify with `--live` (verify never re-runs live).
- Do **not** persist DSN, passwords, tokens, or secret versions.
- Do **not** recommend reconcile completion while NOT_NULL count > 0.

## Artifacts

- `fixtures/sunset-schema-observer/slice14r-live-reconcile-decision-evidence.json`
- `fixtures/sunset-schema-observer/slice14r-live-reconcile-decision-contract.json`
- `fixtures/sunset-schema-observer/slice14r-findings.md`
