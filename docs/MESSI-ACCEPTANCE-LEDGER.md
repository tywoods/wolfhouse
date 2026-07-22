# MESSI — Acceptance ledger (Slice 1G)

**Status:** Slice **1G delivered** — FACTORY 1E finite offline dry-run closeout wired into the canonical ledger.
**Master basis:** `94be40ba9ffc2a9c55030ebf50f711aaa6f6a594`
**Branch:** `messi/slice-1g-factory-wiring`
**Outcome:** `1G_factory_finite_closeout_ledger_wiring`

**Owner artifacts:**
`docs/MESSI-ACCEPTANCE-LEDGER.md` · `fixtures/messi-acceptance/` · `scripts/lib/messi-slice1a-acceptance-ledger.js` · `scripts/verify-messi-slice1a-acceptance-ledger.js`

Related parents:
[`FOUNDATION-FINITE-CLOSEOUT.md`](FOUNDATION-FINITE-CLOSEOUT.md) (1B) ·
[`FORTRESS-FINITE-CLOSEOUT.md`](FORTRESS-FINITE-CLOSEOUT.md) (1D) ·
[`FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md`](FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md) ·
[`RADAR-OPERATIONS-GATE-LEDGER.md`](RADAR-OPERATIONS-GATE-LEDGER.md) ·
[`FACTORY-CLIENT-PRODUCTIZATION.md`](FACTORY-CLIENT-PRODUCTIZATION.md)

---

## Purpose

MESSI is the **integration gate above FOUNDATION, FORTRESS, RADAR, and FACTORY**.
The canonical acceptance ledger:

1. Inventories each parent's canonical closeout / evidence / verifier
2. Binds exact committed file paths + sha256 hashes
3. Binds each parent's **canonical tip** + **candidate SHA** and cryptographically verifies tip blobs + ancestry (or same-tree / path-filtered squash)
4. Runs each parent's real retained offline gate(s)
5. Classifies every MESSI gate `complete` / `partial` / `absent` with explicit missing proof
6. Preserves RADAR formal truth **proven=0 / partial=9 / absent=0**
7. Distinguishes finite staging/offline/audit workstream closeouts from production readiness

Slice **1G** integrates the reviewed FACTORY 1E finite offline closeout: reuse candidate/canonical
tip `14facf5d` provenance and durable evidence refs, execute
`verify:factory-slice1e-finite-closeout`, expose finite offline dry-run workstream
completion, and keep `G_FACTORY_PARENT` **partial** while production apply/materialization,
operated onboarding, secrets/live targets, and production readiness remain absent.
No certificate changes.

## Parent SHA provenance (hard)

Parent tip/candidate SHAs are **not** declarative-only. The lock + ledger bind:

| Parent | Canonical tip | Candidate SHA |
|--------|---------------|---------------|
| FOUNDATION | `98202775a57e64597e0e606a6e58933bb8ba7250` (1B merge) | `4a550b44bb7669a860557f0ec211260d7b76250c` (same tree) |
| FORTRESS | `ff285598ac2cfec980e8316e772924a9c79a6a7e` (1D merge) | `fa2c5d71ad6c662b4c4f60b08ede409064acf2fe` (path-filtered squash) |
| RADAR | `7e56a99a2d69e13bf1a764090e4033195e189641` | `7870a9fb818bbd94d33b291c8782851276e2715e` |
| FACTORY | `14facf5d54be8767cf9aca4d69a880f28ea3dc2e` | same (identity) |

Verifier enforces: exact tip identity (reject stale-but-valid ancestors), candidate ⊂ tip ⊂ MESSI base/tip **or** same-tree / provenance-bound-file blob equivalence, tip-blob sha256 == bound hashes == working tree for `provenance_bound_files`, missing refs fail closed. Tip scope uses immutable reviewed-candidate blob certificates — **not** path allowlists or base-to-HEAD scope.

## Completion policy (hard)

Do **not** mark a parent milestone complete from labels, summaries, or self-authored booleans.
The sole classifier lives in `scripts/lib/messi-slice1a-acceptance-ledger.js` (`classifyMessiGates`).

Finite offline dry-run workstream completion for FACTORY is exposed as
`finite_offline_dry_run_workstream_complete=true` on `G_FACTORY_PARENT` when the 1E gate passes.
That flag does **not** raise the parent verdict to complete, does **not** set
`production_ready` / `messi_complete`, and is **not** FACTORY production readiness.
It is **FACTORY-only** — the five unrelated gate objects (`G_FOUNDATION_PARENT`,
`G_FORTRESS_PARENT`, `G_RADAR_PARENT`, `G_CROSS_PARENT_INTEGRATION`,
`G_MESSI_MILESTONE_CLOSEOUT`) remain byte-identical to master basis `94be40ba`.

## Frozen MESSI score (unchanged)

| proven | partial | absent | total |
|-------:|--------:|-------:|------:|
| **0** | **4** | **2** | **6** |

MESSI is **not** complete. Production readiness is **absent**. RADAR formal remains **0/9/0**.

## Parent inventory (canonical)

| Parent | Tip | Candidate | Retained npm gate(s) | Workstream class | Production |
|--------|-----|-----------|----------------------|------------------|------------|
| FOUNDATION | MESSI-1B @ `98202775` | `4a550b44` (same tree) | `verify:messi-slice1b-foundation-closeout` | finite_staging_schema_migration_recovery_closeout | absent |
| FORTRESS | MESSI-1D @ `ff285598` | `fa2c5d71` | `verify:messi-slice1d-fortress-closeout` | finite_fortress_audit_workstream_closeout | absent |
| RADAR | 16AP tip `7e56a99a` | `7870a9fb` | `verify:radar-slice16ap-finite-closeout` | finite_milestone_closeout_staging_readiness_only | absent |
| FACTORY | 1E @ `14facf5d` | identity | `verify:factory-slice1e-finite-closeout` | finite_offline_dry_run_packaging_closeout | absent |

## MESSI gates

| ID | Verdict | Missing proof (summary) |
|----|---------|-------------------------|
| `G_FOUNDATION_PARENT` | partial | Docker fresh-db; production schema; live restore/drill; operated readiness |
| `G_FORTRESS_PARENT` | partial | matrix 3 unproven / 4 vulnerable; live KV/deploy; production security; drills; operated |
| `G_RADAR_PARENT` | partial | formal gates remain 0/9/0; production unknowns; full G06 / production_ready forbidden by 16AP |
| `G_FACTORY_PARENT` | partial | live/prod third tenant; apply path; RADAR reopen clearance; production readiness |
| `G_CROSS_PARENT_INTEGRATION` | absent | committed cross-parent integration proof |
| `G_MESSI_MILESTONE_CLOSEOUT` | absent | all parent gates complete + production readiness |

## Verify

```bash
npm run verify:messi-slice1a-acceptance-ledger
# alias:
npm run verify:messi-slice1g-factory-wiring
```

Offline only. Spawns parent retained verifiers; does not deploy, mutate DB/cloud, or access production.

## Scope fence (1G)

**Allows:** docs, fixtures, verifier, parent inventory, hash binding, parent tip/candidate SHA provenance, retained offline gate execution, deterministic classification, package.json script registration, reuse of existing Git-anchored reviewed-candidate blob certificates / squash-proof (no certificate changes).

**Forbids:** product/runtime/template behavior, deploy, DB/cloud mutation, network live action, production access, raising RADAR formal gates, moving unrelated parent/MESSI gates, labeling finite offline dry-run closeout as FACTORY complete / production completion, certificate architecture changes, path allowlists / base-to-HEAD tip scope, self-authored score/parent completion.
