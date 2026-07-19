# FOUNDATION Slice 13B — Sunset schema reconciliation design (design only)

**Master basis:** `5dc43550d0197efacbb59dab4657960d2aaa36eb`
**Canonical fingerprint:** `daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52`
**Live fingerprint:** `fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd`
**Current observer:** exit 4, mismatchCount=88

## Verdict

Approved **forward-only** reconciliation direction for Sunset schema drift and absent migration ledger. **Design only** — no repair implementation, rehearsal execution, or live mutation in this slice.

Do **not** bless live as canonical. Do **not** mutate ownership to match local role names. Do **not** invent ledger execution history from numbering.

## DEC recommendations (summary)

| ID | Direction | Status |
|----|-----------|--------|
| DEC-001 | Observer-only Azure identity normalization; no DB ownership mutation | approved_direction_observer_normalization |
| DEC-002 | Promote location_id / *_loc (+ capacity) into canonical forward later; do not revert live | approved_direction_promote_location_model |
| DEC-003 | Additive apply 035 later; no seed | approved_direction_additive_035 |
| DEC-004 | Promote live tenant_services columns; add CHECKs after violation-count preflight | approved_direction_promote_columns_then_constraints |
| DEC-005 | Fail-closed ledger bootstrap with verified_structural_baseline vs executed_by_canonical_runner | approved_direction_fail_closed_ledger_bootstrap |
| DEC-006 | Keep 018/019/020 blocked until exact metadata checks pass | fail_closed_blocked_until_metadata_checks |
| DEC-007 | Already resolved in Slice 13A.1 (`canonical_lf_v1`) | resolved_by_slice_13a1 |

## Mismatch totals by phase

| Phase | Keys | Role |
|-------|-----:|------|
| A | 42 | Observer Azure normalization (no DB mutation) |
| B | 17 | Promote location-aware canonical model |
| C | 27 | Additive schema (035, tenant_services columns, indexes/FK/trigger) |
| D | 2 | CHECK constraints after preflight counts |
| E | 0 | Ledger bootstrap (governance) |
| F | 0 | Canonical observer verification |
| **Sum A–D** | **88** | Every mismatch key maps exactly once |

Expected trajectory: 88 → 46 → 29 → 2 → 0 (then ledger + verify remain at 0).

## Artifacts

- `slice13b-decision-record.json`
- `slice13b-phased-reconciliation-design.json`
- `slice13b-mismatch-to-phase-map.json`
- `slice13b-ledger-bootstrap-spec.json`
- `slice13b-slice13c-rehearsal-contract.json`
- This findings note

## Forbidden (honored)

No Azure/PostgreSQL/schema/data/ledger/role/credential/image/job mutation. No observer job start. No executable live-apply tooling or repair SQL. No product-row reads. No canonical migration/hash/manifest/fixture changes in 13B.
