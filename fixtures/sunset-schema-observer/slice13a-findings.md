# FOUNDATION Slice 13A — Sunset schema drift classification (investigation only)

**Master basis:** `3c27d4ee3dd9b5678c63037d3ccc524c21907332`
**Canonical fingerprint:** `daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52`
**Live fingerprint:** `fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd`
**mismatchCount:** 88 (expected_only=31, live_only=15, definition_mismatch=42)

## Verdict

- Runtime observer image is already repaired (Slice 12). This slice classifies **why** live still differs.
- **Do not bless live as canonical. Do not apply migrations or mutate ownership from this report.**
- `schema_migration_ledger` is **absent** live → applied-set is inferred from catalog signatures only.

## Classification totals

| Classification | Count |
|----------------|------:|
| genuine_database_drift | 29 |
| observer_normalization_difference | 42 |
| canonical_manifest_question | 17 |
| unresolved | 0 |

## Ownership / ACL / extensions

Live owners for pgcrypto/plpgsql functions and extensions are `azuresu`; public schema owner/ACL grantor is `azure_pg_admin`. Canonical expected uses `$db_owner` / `pg_database_owner` after local generation.

**Interpretation:** Azure Flexible Server environment identities, not tenant privilege drift. Observer `normalizeOwnerName` only rewrites `datdba` → `$db_owner` — **normalization defect candidate**. **Do not recommend ownership mutation merely to match role names.**

## Migration provenance totals

| Inferred state | Count |
|----------------|------:|
| fully_applied | 27 |
| ambiguous | 3 |
| superseded | 1 |
| partially_applied | 4 |
| absent | 1 |

## Migration 035 (`035_customer_message_templates`)

- Expected objects present in canonical fixture; **absent live** (no partial remnants observed).
- Appears **safely additive** (`CREATE TABLE IF NOT EXISTS` + index); **no mandatory seed/backfill**.
- **Not applied in Slice 13A.**

## Artifacts

- `fixtures/sunset-schema-observer/slice13a-mismatch-classification-report.json`
- `fixtures/sunset-schema-observer/slice13a-migration-provenance-matrix.json`
- `fixtures/sunset-schema-observer/slice13a-operator-decision-list.json`
- This findings note

## Forbidden (honored)

No live DDL/DML, ledger, role, credential, image, job, Staff API, Luna, firewall/network, Wolfhouse, or production mutation. No executable repair tooling. No observer job start. No product-row reads.
