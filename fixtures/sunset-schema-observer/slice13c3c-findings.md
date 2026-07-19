# FOUNDATION Slice 13C.3c — notification / surf-pack convergence

**Master basis:** `a90e91812eadcb0ad799fbddfc4333ba5821a9df`
**Migration:** `041_notification_surfpack_convergence.sql` (new forward)
**canonical_lf_v1 hash:** `3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09`

## Verdict

Added one fail-closed additive forward migration that converges exactly the six remaining Phase C notification/surf-pack objects. Disposable dual-path proof only. Offline mismatch trajectory **8 → 2** (six Phase C keys resolved; two Phase D `tenant_services` CHECKs remain). Product fingerprint **unchanged** (`120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18`) because the six objects were already canonical expected via 026/032. Still `product_schema_differs`.

**Do not claim** Sunset is repaired. Phase D `tenant_services` CHECKs remain. Zero live/Azure mutation in this slice.

| Measure | Value |
|---------|------:|
| Forward count | **38 → 39** |
| Migration checksum | `3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09` |
| Manifest hash | `427206aeeed1890c3a1fa2f666d11b66411333811b071fb1af5986126d8d12eb` → `99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e` |
| Product fingerprint | `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18` (**unchanged**) |
| Mismatch trajectory | **8 → 2** |
| Keys resolved | **6** |
| Remaining `genuine_database_drift` | **2** (Phase D CHECKs) |

## Six-key map

See `slice13c3c-six-key-map.json`. Historical owners: 032 (three notification indexes), 026 (surf-pack index/FK/trigger).

## Catalog contract

Indexes: schema/table/unique/access method/ordered keys-expressions/predicate/INCLUDE/constraint ownership.
FK: source+target columns/actions/match/validation/deferrability.
Trigger: relation/timing/events/row-vs-statement/enabled/function identity+definition/args.
Prerequisite `public.set_updated_at()`: return=trigger, language=plpgsql, SECURITY INVOKER (`prosecdef=false`), VOLATILE (`provolatile=v`), empty `proconfig`, non-STRICT, non-LEAKPROOF, PARALLEL UNSAFE (`proparallel=u`), plus exact `prosrc` body from 001 / expected-product-schema. Function is never mutated; drift fails closed and rolls back.
Prerequisites validated; exact objects preserve/no-op; absent creates; conflict RAISE + rollback.

## Disposable proof

- **Path A:** 39-forward self-match; second 041 no-op/OID-stable; fingerprint unchanged; exact canonical `set_updated_at` preserves.
- **Path B:** strip six objects + Phase D CHECKs → exactly 8 keys; 041 resolves six → 2; second 041 no-op/OID-stable.
- **RED:** wrong index table/order/predicate/unique/INCLUDE/constraint-owned; missing FK prerequisite; wrong FK target/action/deferrability; incompatible trigger function/timing/events/enabled/args; `set_updated_at` SECURITY DEFINER / STABLE / IMMUTABLE / nonempty proconfig / STRICT / PARALLEL SAFE (leakproof when disposable role permits); partial conflict rolls back earlier creates; missing notification tables; non-disposable DSN rejected.

## Artifacts

- `database/migrations/041_notification_surfpack_convergence.sql`
- `scripts/prove-sunset-schema-slice13c3c-notification-surfpack.js`
- `scripts/verify-sunset-schema-slice13c3c.js`
- `fixtures/sunset-schema-observer/slice13c3c-notification-surfpack-evidence.json`
- `fixtures/sunset-schema-observer/slice13c3c-mismatch-8-to-2-evidence.json`
- `fixtures/sunset-schema-observer/slice13c3c-six-key-map.json`
- `fixtures/sunset-schema-observer/slice13c3c-findings.md`

## Confirmation

**Zero live mutation.** No Azure apply, no observer job start/redeploy, no image build/deploy.
