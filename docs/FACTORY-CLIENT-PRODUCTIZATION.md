# FACTORY — Client productization (finite stages 1A–1E)

**Status:** Slice **1D delivered** (integration isolation + legacy-compatibility proofs). Slices **1A**, **1B**, and **1C** complete.

**Master basis (1D):** `210b3643793ad5569dc466977b8fe4421c22ef92`
**Master basis (1C):** `ce89a43ee1e2367a832255fec5ee4aefbfb4d2d8`
**Master basis (1B):** `86f4cb9daaefdecab75ad02a2e755e2e7503216d`
**Master basis (1A freeze parent):** `0ef5958ed8b81ca04b196062505bf4be7a403221`

**Owner artifacts:**
`config/archetypes/` · `fixtures/factory-client-productization/` · `scripts/lib/factory-slice1a-acceptance-contract.js` · `scripts/lib/factory-slice1a-inventory-discovery.js` · `scripts/lib/factory-slice1b-archetype-templates.js` · `scripts/lib/factory-slice1c-dry-run-generator.js` · `scripts/lib/factory-slice1d-integration-proof.js` · `scripts/onboard-client.js` · `scripts/verify-factory-slice1a-acceptance-contract.js` · `scripts/verify-factory-slice1b-archetype-templates.js` · `scripts/verify-factory-slice1c-dry-run-generator.js` · `scripts/verify-factory-slice1d-integration-proof.js`

Related: [`MULTICLIENT-ARCHITECTURE.md`](MULTICLIENT-ARCHITECTURE.md) · [`DEPLOYMENT-CONFIG.md`](DEPLOYMENT-CONFIG.md) · RADAR reopen `third_tenant_factory` in [`RADAR-OPERATIONS-GATE-LEDGER.md`](RADAR-OPERATIONS-GATE-LEDGER.md).

---

## Purpose

Freeze a **finite, source-only acceptance contract** before any client-productization implementation, then ship **reviewed static archetype templates** (1B) before a **deterministic dry-run generator** (1C), then **integration isolation + legacy-compat proofs** (1D). FACTORY turns the Wolfhouse + Sunset worked examples into two reusable archetypes without drifting into open-ended platform work.

## Finite stages (reject drift beyond these five)

| Stage | Title | Status |
|-------|-------|--------|
| **1A** | Source-only acceptance contract + inventory freeze | **Complete** — docs/fixtures/verifier |
| **1B** | Archetype schema + disabled-by-default templates | **Complete** — `config/archetypes/{surf_house,surf_school_shop}/` |
| **1C** | Deterministic generator (secret rejection, no live-target copy) | **Complete** — dry-run CLI `scripts/onboard-client.js` |
| **1D** | Tenant/location isolation + legacy-compatibility proofs | **Complete** — independent integration verifier |
| **1E** | Dry-run proof packaging + milestone closeout | Deferred |

**1A forbids:** templates, generator, runtime, IaC, DB, deploy, secrets, live calls.

**1B forbids:** generator, client instance materialization, runtime loading, IaC, DB, deploy, live calls.

**1C forbids:** apply path, disk materialization / `--output-dir`, registry edits, `config/clients` writes, runtime loading, IaC, DB, deploy, secret materialization, live network calls. Safe disk materialization is **unsupported** (not deferred proof).

**1D forbids:** product/runtime/template/generator behavior changes, apply path, registry/`config/clients` writes, runtime registration, client creation, IaC, DB, deploy, secret materialization, live network calls. Evidence is verifier-owned temp fixtures + fresh-process CLI only.

**Reject:** extra stages, renamed gates, or claiming third-tenant live/prod as current-stage evidence.

**1A tip scope (frozen at tip `86f4cb9d…`):** docs, fixtures, and verifier-support only, plus locked `verify:factory-slice1a-acceptance-contract` and pinned `acorn@8.14.1`.

**1B tip scope:** `config/archetypes/`, factory fixtures/docs, 1B verifier + lock module, 1A ledger evidence updates, and locked `verify:factory-slice1b-archetype-templates`.

**1C tip scope:** factory fixtures/docs, 1C library + CLI + verifier, 1A ledger evidence updates for 1C gates, and locked `verify:factory-slice1c-dry-run-generator`. Does **not** mutate `config/archetypes/`.

**1D tip scope:** factory fixtures/docs, 1D lock + verifier, 1A ledger evidence updates for isolation/legacy gates, and locked `verify:factory-slice1d-integration-proof`. Does **not** mutate generator, CLI, or `config/archetypes/`.

## Archetypes

| FACTORY id | Reference client | Locations | Legacy vertical | Template root |
|------------|------------------|-----------|-----------------|---------------|
| `surf_house` | `wolfhouse` | `wolfhouse-somo` | `lodging_surf_house` | `config/archetypes/surf_house/` |
| `surf_school_shop` | `sunset` | `sunset-somo`, `sunset-sardinero` | `surf_school_rentals` | `config/archetypes/surf_school_shop/` |

Crowsnest mock templates (`surf_house` / `surf_school`) remain UI reference only; FACTORY templates under `config/archetypes/` are the productization source of truth starting 1B.

## Acceptance gates (nine)

1. **`G_ARCHETYPE_SURF_HOUSE`** — surf-house shape matches Wolfhouse lodging defaults. **1B evidence:** static disabled template.
2. **`G_ARCHETYPE_SURF_SCHOOL_SHOP`** — school+shop shape matches Sunset multi-location lessons/rentals. **1B evidence:** static disabled template.
3. **`G_DISABLED_BY_DEFAULT_GENERATION`** — generated clients stay `live_enabled=false` / channels disabled until an explicit later enablement gate. **1C evidence:** dry-run generator forces enablement off + byte-determinism.
4. **`G_SECRET_REJECTION`** — no live secrets in committed outputs; `secret:<key>` + example files only. **1C evidence:** generator rejects secret-shaped input/output.
5. **`G_NO_LIVE_TARGET_COPYING`** — do not copy live Azure IDs, Meta phone_number_ids, Stripe live keys, or live hostnames. **1C evidence:** generator rejects live-target shaped input/output.
6. **`G_TENANT_LOCATION_ISOLATION`** — unique `client_slug` / globally unique `location_id`; live isolation per multiclient architecture. **1D evidence:** fresh-process portable envelopes + cross-tenant substitution isolation.
7. **`G_LEGACY_COMPATIBILITY`** — Wolfhouse + Sunset keep working on existing loaders without a forced FACTORY migration in 1A–1E. **1D evidence:** pure consumer validators on verifier-owned temps + legacy Luna/multiclient gates.
8. **`G_DRY_RUN_PROOF`** — offline dry-run artifacts + verifiers; no live writes.
9. **`G_MILESTONE_CLOSEOUT`** — 1E only when all gates have stage-appropriate evidence and the stage fence holds.

## Inventory (source-derived)

Completeness method: **`source_derived_registration_read_site_inventory`**.

Discovery engine: pinned **Acorn ESTree** physical-site discovery plus local import graph (`scripts/lib/factory-slice1a-inventory-discovery.js`). Safe string/template/binary/`path.join`/`path.resolve` expressions are constant-folded; require/import aliases and local loader wrappers are resolved. Physical site keys are inventoried independently of fixture `site_policy`, then compared with **exact bidirectional set equality**. Locked exclusions filter justified noise only; they are never the expected inventory.

**Threat boundary:** every filesystem primitive inside the reachable config-loader acquisition graph must constant-fold to `{ value, complete }` or discovery fails closed. Incomplete or unfoldable paths emit `ambiguous_filesystem_path` before any partial-value or `config/clients` prefix inspection; only complete folds may classify config versus unrelated. Dynamic template interpolation, computed members, unresolved alias/destructuring, and unknown segments are incomplete. No `CLIENTS_DIR` textual/taint heuristic; filesystem calls outside the reachable graph are ignored.

Categories:

- Client config files under `config/clients/`
- Registries (`clients.json`, staff-portal-access, channel-routing maps)
- Feature/env flag symbols read in source (`live_enabled`, tenant slug envs, Sunset admin / portal / admission flags)
- Config/clients acquisition consumers derived from structural physical sites (FS + loader imports), including `scripts/staff-query-api.js` and `scripts/check-i18n-guest-copy.js`
- Physical site keys (`fs_*` / `loader_import`) + independent `site_policy`
- Deployment overlays (Wolfhouse + Sunset staging Bicep entrypoints, compose, env example, access/routing overlays)
- Existing verifier registrations/files (package.json paths normalize `scripts/...` and `./scripts/...`)

Canonical freeze: `fixtures/factory-client-productization/slice1a-inventory.json`.

1B templates under `config/archetypes/` are **outside** the `config/clients/` acquisition graph and are not runtime-loaded. The 1C generator reads them for dry-run preview only and never writes into `config/clients/` or registries.

## Dry-run generator (1C)

```bash
node scripts/onboard-client.js \
  --archetype surf_house \
  --substitutions fixtures/factory-client-productization/slice1c-substitutions-surf_house.json \
  [--stdout]
```

- Mode: `dry-run` only (`--apply` rejected)
- Emission: **stdout only** (default; `--stdout` optional) — one canonical JSON envelope with exact preview files + manifest (hashes). **Zero writes.**
- **Safe disk materialization is unsupported** — `--output-dir` and all materialization/write flags reject. No `writeDryRunPreview`, no mv publish subprocess, no fd/procfs hooks, and no filesystem publish path. Generation gates are satisfied by zero-write in-memory preview, not by disk publication.
- Independent golden rendered-byte fixtures (`slice1c-golden/`, `slice1c-golden-lock.json`) lock output set + hashes; verifier compares generator bytes to fixtures without importing generator expectation helpers
- Validates slugs, required substitutions, unresolved placeholders, path traversal/collisions, existing tenant/location conflicts, secret/live-target shaped values, and all enablement false
- Still no apply/network/DB/cloud/runtime

## Integration proof (1D)

```bash
npm run verify:factory-slice1d-integration-proof
```

- Independent fresh-process CLI matrix (cwd / TZ / locale / irrelevant env) requires **byte-identical** canonical envelopes and golden hashes for both archetypes
- Consumer validation of baseline/pricing/catalog/schedule/profile/features through pure validators/calculators on **verifier-owned temp fixtures only**
- Cross-tenant/location substitution isolation; no Wolfhouse/Sunset live identity fields; no secrets/live targets; enablement remains disabled
- Reference Wolfhouse/Sunset blobs unchanged; no process/env/module-cache leakage
- Full legacy `verify:luna-all` + multiclient hard gates; retained master REDs classified honestly

## Current-stage evidence vs third-tenant live/prod

**Required for 1A:** inventory + gate/stage freeze + independent completeness verifier + docs/fixtures/verifier delivery (plus the single locked `package.json` script registration).

**Required for 1B:** exactly two static archetype template trees; placeholders only; all enablement off; independent schema/cross-ref/isolation verifier with adversarial REDs; working-tree reference bytes vs master blobs; 1A ledger evidence update for archetype gates **only when** the independent 1B validator passes.

**Required for 1C:** pure dry-run library + CLI; byte-determinism; template immutability; exact output set; stdout zero-write; disk materialization unsupported (static/runtime REDs); adversarial rejection; 1A ledger evidence update for generation/safety gates **only when** the independent 1C verifier passes.

**Required for 1D:** independent integration verifier proving portable determinism, consumer compatibility on verifier-owned temps, tenant/location isolation, legacy gates + retained RED classification; 1A ledger evidence update for isolation/legacy gates **only when** the independent 1D verifier passes. No generator/template/product behavior changes.

**Out of scope for 1A–1E current-stage evidence:** third-tenant **live/prod** onboarding beyond the Wolfhouse + Sunset staging pair.

That work **triggers RADAR reopen** `third_tenant_factory`
(threshold: `tenant_count_gt_2_or_new_tenant_slug_beyond_wolfhouse_somo_and_sunset`).
Mirleft/La Wave registry rows remain inventory-only while `live_enabled=false`.

## Verification

```bash
npm run verify:factory-slice1a-acceptance-contract
npm run verify:factory-slice1b-archetype-templates
npm run verify:factory-slice1c-dry-run-generator
npm run verify:factory-slice1d-integration-proof
```

Hard regressions spawned by the verifiers: multiclient-isolation, no-client-hardcoding, tenant-resolution, meta-whatsapp-tenant-shadow.

**Retained master REDs** (not introduced by 1A/1B/1C/1D; reported, not fail-closed here): `verify-staff-tenant-scope` H3; `verify-tenant-business-config` “DB prices used” merge behavior.

## What 1D does not authorize

Product/runtime/template/generator behavior changes, apply or materialize preview bytes to disk, write client instances into `config/clients/` or registries, runtime registration of generated previews, client creation, mutating IaC/DB, deploying, materializing secrets, live network calls, raising RADAR gates, or treating a third live tenant as FACTORY closeout evidence.
