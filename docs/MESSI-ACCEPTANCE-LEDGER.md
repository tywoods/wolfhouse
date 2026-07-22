# MESSI — Acceptance ledger (Slice 1A)

**Status:** Slice **1A delivered** — read-only acceptance ledger + independent verifier.
**Master basis:** `14facf5d54be8767cf9aca4d69a880f28ea3dc2e`
**Branch:** `messi/slice-1a-acceptance-ledger`
**Outcome:** `1A_messi_acceptance_ledger`

**Owner artifacts:**
`docs/MESSI-ACCEPTANCE-LEDGER.md` · `fixtures/messi-acceptance/` · `scripts/lib/messi-slice1a-acceptance-ledger.js` · `scripts/verify-messi-slice1a-acceptance-ledger.js`

Related parents:
[`PHASE` / Sunset schema FOUNDATION 14AE](../fixtures/sunset-schema-observer/slice14ae-findings.md) ·
[`FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md`](FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md) ·
[`RADAR-OPERATIONS-GATE-LEDGER.md`](RADAR-OPERATIONS-GATE-LEDGER.md) ·
[`FACTORY-CLIENT-PRODUCTIZATION.md`](FACTORY-CLIENT-PRODUCTIZATION.md)

---

## Purpose

MESSI is the **integration gate above FOUNDATION, FORTRESS, RADAR, and FACTORY**.
Slice 1A freezes a deterministic, repository-evidence-only acceptance ledger that:

1. Inventories each parent's canonical closeout / evidence / verifier
2. Binds exact committed file paths + sha256 hashes
3. Binds each parent's **canonical tip** + **candidate SHA** and cryptographically verifies tip blobs + ancestry
4. Runs each parent's real retained offline gate(s)
5. Classifies every MESSI gate `complete` / `partial` / `absent` with explicit missing proof
6. Preserves RADAR formal truth **proven=0 / partial=9 / absent=0**
7. Distinguishes finite staging/offline workstream closeouts from production readiness

## Parent SHA provenance (hard)

Parent tip/candidate SHAs are **not** declarative-only. The lock + ledger bind:

| Parent | Canonical tip | Candidate SHA |
|--------|---------------|---------------|
| FOUNDATION | `32b44930685450cb27ac519d052332be7b18150d` | same (identity) |
| FORTRESS | `28a30a688baa637e1bcb549d9b585cb5917942d1` | same (identity) |
| RADAR | `7e56a99a2d69e13bf1a764090e4033195e189641` | `7870a9fb818bbd94d33b291c8782851276e2715e` |
| FACTORY | `14facf5d54be8767cf9aca4d69a880f28ea3dc2e` | same (identity) |

Verifier enforces: exact tip identity (reject stale-but-valid ancestors), candidate ⊂ tip ⊂ MESSI base/tip, tip-blob sha256 == bound hashes == working tree for `provenance_bound_files`, missing refs fail closed. FACTORY tip-scope allowlist mutations are disclosed separately and are **not** parent-tip provenance.

## Completion policy (hard)

Do **not** mark a parent milestone complete from labels, summaries, or self-authored booleans.
The sole classifier lives in `scripts/lib/messi-slice1a-acceptance-ledger.js` (`classifyMessiGates`).

## Frozen MESSI score (1A)

| proven | partial | absent | total |
|-------:|--------:|-------:|------:|
| **0** | **4** | **2** | **6** |

MESSI is **not** complete. Production readiness is **absent**.

## Parent inventory (canonical)

| Parent | Tip | Candidate | Retained npm gate(s) | Workstream class | Production |
|--------|-----|-----------|----------------------|------------------|------------|
| FOUNDATION | 14AE @ `32b44930` | identity | `verify:sunset-schema-slice14ae` | tip_retained_staging_schema_noop | absent |
| FORTRESS | 15A+15L @ `28a30a68` | identity | `verify:fortress-tenant-identity-boundary-matrix` + `verify:fortress-slice15l-meta-signature-fail-closed` | tip_retained_security_remediation_plus_audit_matrix | absent |
| RADAR | 16AP tip `7e56a99a` | `7870a9fb` | `verify:radar-slice16ap-finite-closeout` | finite_milestone_closeout_staging_readiness_only | absent |
| FACTORY | 1E @ `14facf5d` | identity | `verify:factory-slice1e-finite-closeout` | finite_offline_dry_run_packaging_closeout | absent |

## MESSI gates

| ID | Verdict | Missing proof (summary) |
|----|---------|-------------------------|
| `G_FOUNDATION_PARENT` | partial | finite closeout disposition; production schema readiness |
| `G_FORTRESS_PARENT` | partial | matrix unproven/vulnerable; 15L live activation; finite closeout |
| `G_RADAR_PARENT` | partial | formal gates remain 0/9/0; production unknowns |
| `G_FACTORY_PARENT` | partial | live/prod third tenant; apply path; RADAR reopen clearance |
| `G_CROSS_PARENT_INTEGRATION` | absent | committed cross-parent integration proof |
| `G_MESSI_MILESTONE_CLOSEOUT` | absent | all parent gates complete + production readiness |

## Verify

```bash
npm run verify:messi-slice1a-acceptance-ledger
```

Offline only. Spawns parent retained verifiers; does not deploy, mutate DB/cloud, or access production.

## Scope fence (1A)

**Allows:** docs, fixtures, verifier, parent inventory, hash binding, parent tip/candidate SHA provenance, retained offline gate execution, deterministic classification, package.json script registration.

**Forbids:** product/runtime/template behavior, deploy, DB/cloud mutation, network live action, production access, raising RADAR formal gates, label/summary/self-authored parent completion.

**Tip-scope forward-compat:** FACTORY 1B–1E `ALLOWED_TIP_PATH_PREFIXES` gain MESSI docs/fixtures/verifier paths only (no generator/template/runtime behavior), matching the 1E→1B/1C/1D allowlist pattern.
