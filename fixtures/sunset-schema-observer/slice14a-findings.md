# FOUNDATION Slice 14A — Phase D CHECK aggregate preflight

**Status:** complete (source-only / disposable proof)  
**Master basis:** `935d278b01c49344ed6e6ef729ac36de5b7d5400`  
**Generated:** 2026-07-19T18:42:41.357Z

## Outcome

Created a **source-only, default-disabled, read-only** aggregate preflight for the two Phase D constraints already owned by immutable migration `028_tenant_services.sql`:

- `tenant_services_date_window` — `(end_date IS NULL OR start_date IS NULL OR end_date >= start_date)`
- `tenant_services_price_unit` — `(price_unit IN ('per_day', 'per_week', 'per_stay', 'one_off'))`

Returns **only** `total_rows`, `date_window_violations`, `price_unit_violations`. Never row values, identifiers, guest data, or arbitrary SQL.

## Exact aggregate contract

```sql
SELECT
  count(*)::bigint AS total_rows,
  count(*) FILTER (WHERE NOT (end_date IS NULL OR start_date IS NULL OR end_date >= start_date))::bigint AS date_window_violations,
  count(*) FILTER (WHERE NOT (price_unit IN ('per_day', 'per_week', 'per_stay', 'one_off')))::bigint AS price_unit_violations
FROM public.tenant_services
```

Schema/type validation of `start_date` (date, nullable), `end_date` (date, nullable), and `price_unit` (text, not null) runs **before** counting. Fail-closed on missing table / wrong type / nullability drift.

## Disposable proof matrix

| Case | Result |
|------|--------|
| Zero violations | GREEN |
| date_window violation class | GREEN (count=1) |
| price_unit violation class | GREEN (count=1) |
| NULL date semantics (CHECK-pass) | GREEN (violations=0) |
| NULL price_unit CHECK-pass + schema gate | GREEN (aggregate 0; nullability fail-closed) |
| Mixed rows | GREEN (dw=2, pu=2) |
| Wrong schema/type | RED fail-closed |
| Read-only transaction/session | GREEN |
| Exact aggregate query authorization | GREEN |
| No data leakage in output/errors | GREEN |
| Non-loopback / default-disabled | RED reject |

## Unchanged hashes (byte-identical)

| Artifact | Hash |
|----------|------|
| Migration 028 | `f9972026a236b21c87442429e1b34e6951adca3e81cc84a88e82d538fa62e240` |
| Migration 035 | `924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565` |
| Migration 040 | `880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd` |
| Migration 041 | `3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09` |
| Manifest | `99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e` |
| Product fingerprint | `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18` |
| expected-product-schema.json bytes | `cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5` |
| Forward count | **39** (unchanged) |

## Non-claims

**Do not claim** Sunset is repaired. Phase D `ADD CONSTRAINT` is **not** implemented in 14A. Zero live/Azure mutation. No firewall, ledger, migration, or apply flag.

## Commands

```bash
npm run prove:sunset-schema-slice14a-phase-d-preflight
npm run verify:sunset-schema-slice14a
```
