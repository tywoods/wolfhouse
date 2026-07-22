# FACTORY Slice 1D findings

**Progress class:** `1C_typed_substitution_correction + 1D_integration_isolation_legacy_compat_proof`
**Master basis:** `210b3643793ad5569dc466977b8fe4421c22ef92`
**Branch:** `factory/slice-1d-integration-proof`
**Delivery:** 1C compatibility correction (typed whole-token substitution + regenerated goldens) **and** independent 1D integration evidence/verifier. Not apply, registry edits, `config/clients` writes, runtime registration, client creation, IaC, DB, deploy, secret materialization, or live network. Archetype templates under `config/archetypes/` unchanged.

## Verdict

Slice **1D** (with upstream **1C** correction) proves the stdout-only dry-run generator is **deterministic, isolated, portable, typed-consumer-compatible, and backward-compatible** for both archetypes:

| Archetype | Portable CLI envelope | Golden hashes | Consumer proof |
|-----------|----------------------|---------------|----------------|
| `surf_house` | byte-identical across fresh processes / cwd / TZ / locale / irrelevant env | matches regenerated `slice1c-golden-lock.json` | quote + addon fields from generated pricing; schedule/catalog surfaces; flatten N/A |
| `surf_school_shop` | same | same | flatten nonzero typed prices + schedule; wolfhouse quote/addon N/A |

Emission remains stdout / in-memory only. The verifier never asks the generator to write disk; consumer checks use **verifier-owned temp fixtures** only, feeding **byte-preserved generated JSON** directly to actual consumers.

## 1C correction exposed by 1D

Prior 1C goldens/fixtures supplied digit strings for consumer-facing scalars. Whole-token substitution now preserves typed fixture values (`number` / `boolean` / `null` / `string`); embedded tokens remain strings. CLI/`loadSubstitutionsFile` validates scalars safely (rejects objects/arrays). **Safe-integer boundary:** integer-valued JSON numbers must satisfy `Number.isSafeInteger` (`substitution_value_unsafe_integer:<key>`); finite decimals remain allowed under the IEEE-754 JSON-number contract; money/duration fields cannot receive unsafe integers. Independently authored 1C goldens/locks were regenerated; Sunset numeric prices flatten nonzero.

## Independent integration truth

1. **Portability matrix** — fresh `node scripts/onboard-client.js` processes with perturbed `cwd`, `TZ`, `LANG`/`LC_ALL`, and irrelevant env must emit **byte-identical** canonical JSON envelopes.
2. **Golden hashes** — envelope file SHA-256 values match independently locked `slice1c-golden/` bytes without importing generator expectation helpers.
3. **Consumer validation (honest)** — rendered baseline/pricing/catalog/schedule/profile/features exercised through pure consumers **without** coercion, renaming, hard-coded pricing/records, or surrogate clones:
   - `wolfhouse-quote-calculator.calculateWolfhouseQuote` consumes generated package codes + numeric prices + add_on fields (surf_house)
   - `guest-addon-pricing.loadWolfhousePricingConfig` loads temp generated pricing
   - Combo promo path classified **N/A** (requires booking service records factory does not emit)
   - `tenant-business-config.flattenOfferingPrices` consumes generated nonzero numbers (surf_school_shop); **N/A** for surf_house
   - `loadLessonTimesFromConfig` / schedule + catalog surfaces
   - `staff-portal-clients.isSurfVertical` for profile/vertical derivation
4. **Cross-tenant/location isolation** — house vs school and alternate probe tenants keep distinct `client_slug` / `location_id`; no cross-leak after sequential generation or module-cache reload.
5. **No Wolfhouse/Sunset live identity** as substituted tenant/location values; no secret/live-target patterns; enablement remains forced false.
6. **Reference blobs unchanged** — Wolfhouse/Sunset baseline+pricing bytes still match pinned master SHAs; archetype templates + `config/clients` tree immutable during the proof.
7. **Recursion** — 1D invokes full 1B + 1C + every legacy gate and **does not** invoke 1A. No `FACTORY_*` skip/probe env may reduce checks or produce PASS.
8. **Legacy gates** — `verify:luna-all` + hard multiclient subset green; retained pre-existing REDs (`verify-staff-tenant-scope` H3, `verify-tenant-business-config` DB prices merge) classified honestly, not fail-closed as 1D regressions.

## What 1D does not authorize

Apply path, safe disk materialization, registry/`config/clients` writes, runtime registration, client creation, archetype template edits, IaC/DB/deploy, secrets, live calls, or third-tenant live/prod onboarding.

## Ledger

1A gate ledger evidence for `G_TENANT_LOCATION_ISOLATION` and `G_LEGACY_COMPATIBILITY` is `1D_integration_isolation_legacy_compat_proof` **only when** the independent 1D validator passes (`completion_requires: verify:factory-slice1d-integration-proof`). Stage **1D** is marked `complete` under that gate via integration proof evidence. Dry-run packaging closeout remains **1E**.
