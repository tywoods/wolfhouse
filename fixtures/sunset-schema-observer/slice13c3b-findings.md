# FOUNDATION Slice 13C.3b — migration 035 customer_message_templates rehearsal

**Master basis:** `b3b2cede917f588d3a7d6e322b28a7f377b8cd96`
**Migration:** `035_customer_message_templates.sql` (existing; **byte-identical**)
**canonical_lf_v1 hash:** `924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565`

## Verdict

Rehearsed the **exact committed** migration 035 against a disposable Phase-C drift pre-state (38-forward canonical semantics with only 035 effects omitted). Proved safe additive convergence and idempotency via a **disabled-by-default disposable-only harness** that does **not** claim canonical-runner / ledger provenance.

| Measure | Value |
|---------|------:|
| Forward count | **38 (unchanged)** |
| New forward migration | **none** |
| Product fingerprint | `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18` (**unchanged**) |
| Manifest hash | `427206aeeed1890c3a1fa2f666d11b66411333811b071fb1af5986126d8d12eb` (**unchanged**) |
| Mismatch trajectory | **25 → 8** |
| 035-owned keys resolved | **17** |
| Remaining `genuine_database_drift` | **8** |
| Observer outcome | still `match=false` / `product_schema_differs` |

**Do not claim** Sunset is repaired. Notification indexes, surf-pack reconciliation, and Phase D `tenant_services` CHECKs remain. Zero live/Azure mutation in this slice.

## 035-owned key map (17)

See `slice13c3b-migration-035-owned-key-map.json`. Actions are additive CREATE / structural defaults from CREATE TABLE — no ownership/ACL mutation beyond what 035 already defines.

## Catalog preflight (wrapper; 035 file immutable)

Harness inspects `pg_attribute`/`pg_type` (udt, nullability, default, generated/identity), PK/FK via `pg_constraint`, index via `pg_get_indexdef`, RLS flags/policies, and rejects unexpected triggers. Absent → execute immutable 035; exact compatible → preserve/no-op; incompatible → RAISE and rollback before/without partial rewrite.

## Disposable proof

- **Path A:** 38-forward + DROP CMT → harness apply 035 → exact CMT cluster; second apply preserve/no-op; canonical runner does not recreate CMT out of sequence.
- **Path B:** exact compatible pre-seed → harness preserve/no-op; attnum stable; second apply no-op.
- **RED:** incompatible column type/default/nullability/generated/extra; incompatible PK/FK/index; RLS enabled; missing `clients`; non-disposable DSN rejected; harness disabled without flag.

## Artifacts

- `scripts/lib/rehearse-migration-035-disposable.js`
- `scripts/prove-sunset-schema-slice13c3b-migration-035-rehearsal.js`
- `scripts/verify-sunset-schema-slice13c3b.js`
- `fixtures/sunset-schema-observer/slice13c3b-migration-035-rehearsal-evidence.json`
- `fixtures/sunset-schema-observer/slice13c3b-mismatch-25-to-8-evidence.json`
- `fixtures/sunset-schema-observer/slice13c3b-migration-035-owned-key-map.json`
- `fixtures/sunset-schema-observer/slice13c3b-findings.md`

## Confirmation

**Zero live mutation.** No Azure apply, no observer job start/redeploy, no image build/deploy, no regeneration of `expected-product-schema.json`.
