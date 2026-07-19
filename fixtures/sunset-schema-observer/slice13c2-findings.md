# FOUNDATION Slice 13C.2 — location-aware admin model promotion (DEC-002 / Phase B)

**Master basis:** `e3764ae3823200a4817edd8a60beb53775a010b6`
**New forward migration:** `039_sunset_admin_location_aware_rules.sql`
**canonical_lf_v1 hash:** `b34d8886bc832db61e8fc67e333a655ab5976d35d1817f2b62ddfaf61682c2a3`

## Verdict

Promoted the approved Sunset location-aware admin-rule model into **one** reviewed canonical forward migration and proved it on **disposable PostgreSQL only**.

| Measure | Value |
|---------|------:|
| Forward count | **36 → 37** |
| Prior product fingerprint | `daeec81c…ba52` |
| New product fingerprint | `553d21d3…20f1` |
| Mismatch trajectory (after 13C.1 azure norm) | **46 → 29** |
| Phase B keys resolved | **17** |
| Remaining `genuine_database_drift` | **29** |
| Observer outcome | still `match=false` / `product_schema_differs` |

**Do not claim** Sunset is repaired. Phases C–E (tenant_services / CMT / CHECKs / ledger) remain pending. Zero live/Azure mutation in this slice.

## Catalog fail-closed (PR correction)

Index/CHECK promotion inspects `pg_class` / `pg_index` / `pg_am` / `pg_constraint` (schema/table, unique, access method, ordered key expressions, normalized predicate, INCLUDE absence, constraint-ownership). Superseded indexes: absent OK; exact old def may DROP; else RAISE. Target `*_loc`: absent CREATE; exact approved preserve/no-op; incompatible RAISE (never silent drop/replace). Capacity CHECK: absent add; exact preserve; incompatible RAISE.

## Objects promoted

- `tenant_price_rules.location_id`
- `tenant_lesson_capacity_rules.location_id`
- `tenant_lesson_time_rules.location_id`
- `tenant_lesson_time_rules.capacity` + `tenant_lesson_time_rules_capacity_check`
- location-scoped unique indexes (`*_loc`) replacing superseded tenant-only uniques

## Explicitly excluded

- `conversations.location_id` / proposed `024` conversation-location DDL
- `tenant_services`, `customer_message_templates`, ledger bootstrap
- Invented DB location parent table / FK (locations remain app-validated TEXT, matching proposed 023 + live)

Historical `023` / `025` / `024` PROPOSED files remain `proposed_not_executable`.

## Disposable proof

- **Path A:** full canonical chain including 039 → regenerated `expected-product-schema.json`; second apply no-op; observer self-match.
- **Path B:** prior 36 forwards + structural effects of proposed 023/025 → apply 039 twice → same fingerprint as Path A.
- **RED fail-closed:** incompatible `location_id`/`capacity` types; missing admin parent tables; duplicate rows blocking `*_loc` unique; incompatible unique constraint name; conflicting FK on `location_id`.

## Artifacts

- `database/migrations/039_sunset_admin_location_aware_rules.sql`
- `fixtures/sunset-schema-observer/expected-product-schema.json` (migration-generated)
- `fixtures/sunset-schema-observer/slice13c2-location-promotion-evidence.json`
- `fixtures/sunset-schema-observer/slice13c2-mismatch-46-to-29-evidence.json`
- `scripts/prove-sunset-schema-slice13c2-location-promotion.js`
- `scripts/verify-sunset-schema-slice13c2.js`

## Confirmation

**Zero live mutation.** No Azure apply, no observer job start/redeploy, no image build/deploy.
