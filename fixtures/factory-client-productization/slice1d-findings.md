# FACTORY Slice 1D findings

**Progress class:** `integration_isolation_legacy_compat_proof`
**Master basis:** `210b3643793ad5569dc466977b8fe4421c22ef92`
**Branch:** `factory/slice-1d-integration-proof`
**Delivery:** independent integration evidence/verifier only — **not** product, runtime, template, or generator behavior changes; **not** apply, registry edits, `config/clients` writes, runtime registration, client creation, IaC, DB, deploy, secret materialization, or live network.

## Verdict

Slice **1D** proves the reviewed stdout-only 1C dry-run generator is **deterministic, isolated, portable, and backward-compatible** for both archetypes:

| Archetype | Portable CLI envelope | Golden hashes |
|-----------|----------------------|---------------|
| `surf_house` | byte-identical across fresh processes / cwd / TZ / locale / irrelevant env | matches `slice1c-golden-lock.json` |
| `surf_school_shop` | same | same |

Emission remains stdout / in-memory only. The verifier never asks the generator to write disk; consumer checks use **verifier-owned temp fixtures** only.

## Independent integration truth

1. **Portability matrix** — fresh `node scripts/onboard-client.js` processes with perturbed `cwd`, `TZ`, `LANG`/`LC_ALL`, and irrelevant env (`HTTP_PROXY`, noise tokens, etc.) must emit **byte-identical** canonical JSON envelopes.
2. **Golden hashes** — envelope file SHA-256 values match independently locked `slice1c-golden/` bytes without importing generator expectation helpers.
3. **Consumer validation (where feasible)** — rendered baseline/pricing/catalog/schedule/profile/features exercised through pure consumers:
   - `wolfhouse-quote-calculator.calculateWolfhouseQuote` (temp pricing path + coerced numeric clone for math)
   - `guest-addon-pricing.loadWolfhousePricingConfig` / `resolveGuestAddonComboPricing`
   - `tenant-business-config.flattenOfferingPrices` / `loadLessonTimesFromConfig`
   - `staff-portal-clients.isSurfVertical` for profile/vertical derivation
4. **Cross-tenant/location isolation** — house vs school and alternate probe tenants keep distinct `client_slug` / `location_id`; no cross-leak after sequential generation or module-cache reload.
5. **No Wolfhouse/Sunset live identity** as substituted tenant/location values; no secret/live-target patterns; enablement remains forced false.
6. **Reference blobs unchanged** — Wolfhouse/Sunset baseline+pricing bytes still match pinned master SHAs; archetype templates + `config/clients` tree immutable during the proof.
7. **Legacy gates** — `verify:luna-all` + hard multiclient subset green; retained pre-existing REDs (`verify-staff-tenant-scope` H3, `verify-tenant-business-config` DB prices merge) classified honestly, not fail-closed as 1D regressions.

## What 1D does not authorize

Apply path, safe disk materialization, registry/`config/clients` writes, runtime registration, client creation, generator/template edits, IaC/DB/deploy, secrets, live calls, or third-tenant live/prod onboarding.

## Ledger

1A gate ledger evidence for `G_TENANT_LOCATION_ISOLATION` and `G_LEGACY_COMPATIBILITY` is `1D_integration_isolation_legacy_compat_proof` **only when** the independent 1D validator passes (`completion_requires: verify:factory-slice1d-integration-proof`). Stage **1D** is marked `complete` under that gate via integration proof evidence. Dry-run packaging closeout remains **1E**.
