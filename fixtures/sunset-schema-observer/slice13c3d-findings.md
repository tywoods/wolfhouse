# FOUNDATION Slice 13C.3d — integrated Phase C disposable proof

**Master basis:** `d68d03500f4449185c4247a2ddec126c54c13d9c`
**Sequence:** `040` → immutable `035` (disabled disposable harness) → `041`
**New forward migration:** none

## Verdict

Integrated disposable proof that the reviewed Phase C sequence transforms the exact **29-key** post-13C.2 drift prestate into exactly the **two** Phase D `tenant_services` CHECK mismatches. Multi-transaction checkpoints recorded honestly (**not** all-three atomic). Fail-stop + safe idempotent resume proven. Still `product_schema_differs`.

**Do not claim** Sunset is repaired. Phase D CHECKs remain unimplemented. Zero live/Azure mutation.

| Measure | Value |
|---------|------:|
| Forward count | **39 (unchanged)** |
| Product fingerprint | `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18` (**unchanged**) |
| Manifest hash | `99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e` (**unchanged**) |
| Expected schema bytes | `cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5` (**unchanged**) |
| 035 hash | `924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565` |
| 040 hash | `880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd` |
| 041 hash | `3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09` |
| Trajectory | **29 → 25 → 8 → 2** |
| Final remaining | **2** (Phase D CHECKs only) |

## Checkpoints

See `slice13c3d-checkpoint-key-sets.json`. Column keys use `expected_only` against current expected (columns omitted in disposable prestate); historical 13C.2 labels were `live_only` for the same four objects.

## Fail-stop / resume

- Injected incompatible 035 preflight → 035/041 do not complete; checkpoint `040` remains; conflict removed → resume 035 deterministic.
- Injected 041 index conflict after 040+035 → 041 rolls back its own partial work; checkpoints `040`+`035` remain exact; conflict removed → resume 041 → 2.
- Second full sequence no-op (OID/attnum preserved).

## Safety

Disabled by default; rejects non-loopback/non-`wh_mig_*` DSN before connect; rejects wrong base hashes; rejects missing/extra prestate keys; rejects sequence reorder; no ledger writes for sequence steps; no live/apply flags.

## Artifacts

- `scripts/lib/phase-c-integrated-disposable.js`
- `scripts/prove-sunset-schema-slice13c3d-integrated-phase-c.js`
- `scripts/verify-sunset-schema-slice13c3d.js`
- `fixtures/sunset-schema-observer/slice13c3d-*`

## Confirmation

**Zero live mutation.** No Azure apply, no observer job start/redeploy, no image build/deploy.
