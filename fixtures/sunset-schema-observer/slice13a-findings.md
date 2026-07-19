# FOUNDATION Slice 13A — Sunset schema drift classification (investigation only)

**Master basis:** `3c27d4ee3dd9b5678c63037d3ccc524c21907332`
**Canonical fingerprint:** `daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52`
**Live fingerprint:** `fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd`
**mismatchCount:** 88 (expected_only=31, live_only=15, definition_mismatch=42)

## Verdict

- Runtime observer image is already repaired (Slice 12). This slice classifies **why** live still differs.
- **Do not bless live as canonical. Do not apply migrations or mutate ownership from this report.**
- `schema_migration_ledger` is **absent** live → applied-set is inferred from catalog signatures only.
- **migration_integrity_blocker:** `canonical-manifest.json` sha256 values do **not** equal current Git blob hashes for 34/36 forward migrations (deterministic CRLF working-tree hashing at Slice 4). Executable SQL (LF-normalized) is unchanged since manifest creation. **Do not claim byte-verified hashes or reliable historical application from this manifest.**

## Classification totals

| Classification | Count |
|----------------|------:|
| genuine_database_drift | 29 |
| observer_normalization_difference | 42 |
| canonical_manifest_question | 17 |
| unresolved | 0 |

## Manifest byte provenance

| Measure | Count |
|---------|------:|
| bytesMatchManifest (git blob) | 2 |
| bytesMismatchManifest (git blob) | 34 |

Root cause: manifest recorded Windows CRLF working-tree hashes (`core.autocrlf=true`); Git stores LF for most files. See `slice13a-manifest-byte-provenance-report.json`. Existing `validateManifestIntegrity` hashes working-tree bytes and can pass on Windows while raw git-blob comparison fails.

## Ownership / ACL / extensions

Live owners for pgcrypto/plpgsql functions and extensions are `azuresu`; public schema owner/ACL grantor is `azure_pg_admin`. Canonical expected uses `$db_owner` / `pg_database_owner` after local generation.

**Interpretation:** Azure Flexible Server environment identities, not tenant privilege drift. Observer `normalizeOwnerName` only rewrites `datdba` → `$db_owner` — **normalization defect candidate**. **Do not recommend ownership mutation merely to match role names.**

## Migration provenance totals (catalog signatures only)

| Inferred state | Count |
|----------------|------:|
| fully_applied | 27 |
| ambiguous | 3 |
| superseded | 1 |
| partially_applied | 4 |
| absent | 1 |

Structural states are **not** byte-manifest-verified apply proofs while the integrity blocker is present.

## Migration 035 (`035_customer_message_templates`)

- Expected objects present in canonical fixture; **absent live** (no partial remnants observed).
- Appears **safely additive** (`CREATE TABLE IF NOT EXISTS` + index); **no mandatory seed/backfill**.
- **Not applied in Slice 13A.**

## Artifacts

- `fixtures/sunset-schema-observer/slice13a-mismatch-classification-report.json`
- `fixtures/sunset-schema-observer/slice13a-migration-provenance-matrix.json`
- `fixtures/sunset-schema-observer/slice13a-manifest-byte-provenance-report.json`
- `fixtures/sunset-schema-observer/slice13a-operator-decision-list.json`
- This findings note

## Forbidden (honored)

No live DDL/DML, ledger, role, credential, image, job, Staff API, Luna, firewall/network, Wolfhouse, or production mutation. No executable repair tooling. No observer job start. No product-row reads. No blind manifest regeneration.
