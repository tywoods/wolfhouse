# FOUNDATION Slice 13C.1 — Azure Flexible Server identity normalization (DEC-001)

**Master basis:** `896b8220dd8586ce8ca6a416eeeefcb819c2a9b5`  
**Canonical fingerprint (unchanged):** `daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52`  
**Live fingerprint (unchanged):** `fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd`

## Verdict

Implemented observer-only normalization profile **`azure_flexible_server_v1`**.

| Measure | Count |
|---------|------:|
| Original canonical/live mismatches | **88** |
| Normalized away (ownership/ACL/extension presentation) | **42** |
| Remaining substantive mismatches | **46** |
| Trajectory | **88 → 46** |

After this slice the product schema still **differs** (`product_schema_differs`, exit 4 if observed) with **46 substantive** mismatches remaining. **Do not claim** the database matches canonical.

## Profile mappings (exact allowlist)

1. `azuresu` → `$db_owner` for **extension** and **function** owners only.  
2. `azure_pg_admin` ↔ `pg_database_owner` for **`public` schema owner** and **`public` schema ACL** role tokens (privilege letters unchanged).  
3. Existing connected-database-owner → `$db_owner` rewrite preserved; not expanded to arbitrary roles.

Fail closed on unknown profile, non-Azure target, custom/app roles, wrong object class, extra ACL grantees/privileges, grant-option / PUBLIC broadenings.

## Remaining 46 by classification

| Classification | Count |
|----------------|------:|
| genuine_database_drift | 29 |
| canonical_manifest_question | 17 |

No `genuine_database_drift` or `canonical_manifest_question` key disappears under this profile.

## Artifacts

- `slice13c1-azure-identity-normalization-evidence.json`
- This findings note
- Updated `slice13b-slice13c-rehearsal-contract.json` (Phase A complete offline; B–E pending)

```bash
npm run build:sunset-schema-slice13c1-normalization-evidence
npm run verify:sunset-schema-slice13c1
```

## Forbidden (honored)

No Azure/live PostgreSQL mutation. No observer job start/redeploy. No image build. No schema/data/ledger/role/credential changes. No canonical migration/manifest/fixture/product-model changes. No location_id / 035 / tenant_services / CHECK / ledger repair. No live-apply path.
