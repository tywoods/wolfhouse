# MESSI Slice 1A findings — acceptance ledger

**Status:** acceptance ledger + independent verifier delivered (docs/fixtures/verifier only)
**Master basis:** `14facf5d54be8767cf9aca4d69a880f28ea3dc2e`
**Branch:** `messi/slice-1a-acceptance-ledger`
**Outcome:** `1A_messi_acceptance_ledger`
**Progress class:** `acceptance_ledger_inventory_and_verifier_only`

## Definition

MESSI is the **integration gate above FOUNDATION, FORTRESS, RADAR, and FACTORY**.
It does not replace parent workstreams. It inventories their canonical closeout/evidence/verifiers,
binds exact file hashes, runs retained offline gates, and classifies MESSI gates as
`complete` / `partial` / `absent` with explicit missing proof.

## Completion policy

Parent milestones are **never** marked complete from labels, summaries, or self-authored booleans.
Classification requires:

1. Parent inventory of canonical evidence/docs/verifier
2. Exact sha256 binding of committed files
3. Cryptographic parent tip/candidate SHA provenance (tip blobs + ancestry)
4. Real retained gate execution (exit 0)
5. Deterministic classifier output with explicit `missing_proof`

## Ledger score (frozen)

| proven | partial | absent | total |
|-------:|--------:|-------:|------:|
| 0 | 4 | 2 | 6 |

## Gate classifications

| Gate | Verdict | Notes |
|------|---------|-------|
| `G_FOUNDATION_PARENT` | partial | 14AE offline gate + hashes; missing finite closeout disposition + production |
| `G_FORTRESS_PARENT` | partial | 15A matrix + 15L gates; matrix still 3 unproven / 4 vulnerable; activation open |
| `G_RADAR_PARENT` | partial | 16AP passes; **formal score frozen 0 proven / 9 partial / 0 absent** |
| `G_FACTORY_PARENT` | partial | 1E finite offline closeout passes; live/prod third-tenant still missing |
| `G_CROSS_PARENT_INTEGRATION` | absent | No committed cross-parent integration proof |
| `G_MESSI_MILESTONE_CLOSEOUT` | absent | MESSI not complete |

## Finite vs production

| Parent | Workstream class | Production readiness |
|--------|------------------|----------------------|
| FOUNDATION | tip_retained_staging_schema_noop | absent |
| FORTRESS | tip_retained_security_remediation_plus_audit_matrix | absent |
| RADAR | finite_milestone_closeout_staging_readiness_only | absent |
| FACTORY | finite_offline_dry_run_packaging_closeout | absent |

Finite staging/offline closeouts are **not** production readiness.

## What 1A proves / does not prove

**Proves:** deterministic parent inventory, hash binding, cryptographic parent tip/candidate provenance, retained offline gate execution, honest MESSI score 0/4/2, RADAR formal 0/9/0 preserved.

**Does not prove:** MESSI complete, production ready, cross-parent integration, raising any RADAR formal gate, clearing FORTRESS matrix gaps, FOUNDATION finite closeout analog, live/prod FACTORY third tenant.

## Parent SHA provenance

| Parent | Canonical tip | Candidate |
|--------|---------------|-----------|
| FOUNDATION | `32b44930685450cb27ac519d052332be7b18150d` | identity |
| FORTRESS | `28a30a688baa637e1bcb549d9b585cb5917942d1` | identity |
| RADAR | `7e56a99a2d69e13bf1a764090e4033195e189641` | `7870a9fb818bbd94d33b291c8782851276e2715e` |
| FACTORY | `14facf5d54be8767cf9aca4d69a880f28ea3dc2e` | identity |

Hostile REDs cover stale-but-valid ancestors (real SHAs), repinned current-tree hashes, mismatched candidate/tip pairs, missing refs, and altered parent files.

## Out of scope

Product/runtime/template behavior, deploy, DB, cloud, network live action, production access.

## Tip-scope note

FACTORY 1B–1E lock modules received **forward-compatible tip-allowlist path entries only**
(MESSI docs/fixtures/verifier paths) so retained FACTORY gates remain runnable after MESSI lands —
same pattern 1E used for its own paths. No generator/template/runtime behavior change.
