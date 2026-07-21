# FACTORY Slice 1A findings

**Progress class:** `source_only_acceptance_contract_freeze`

**Master basis:** `0ef5958ed8b81ca04b196062505bf4be7a403221`

**Branch:** `factory/slice-1a-contract`

**Delivery:** docs / fixtures / independent verifier only — **not** templates, generator, runtime, IaC, DB, deploy, secrets, or live calls. `package.json` may change only for the locked script key `verify:factory-slice1a-acceptance-contract`.

## Verdict

FACTORY client productization is fenced to **five finite stages (1A–1E)**. Slice **1A** freezes the acceptance contract, inventories real Wolfhouse/Sunset registration and read sites, and locks nine gates. Completeness is **source-derived** by `scripts/lib/factory-slice1a-inventory-discovery.js` (exact bidirectional set equality; locked exclusions are justified noise filters only). Third-tenant live/prod work stays **out of scope** and triggers RADAR reopen `third_tenant_factory`.

## Reference pair (discovered)

| Archetype | Client | Locations | Legacy vertical | `live_enabled` |
|-----------|--------|-----------|-----------------|----------------|
| `surf_house` | `wolfhouse` | `wolfhouse-somo` | `lodging_surf_house` | false |
| `surf_school_shop` | `sunset` | `sunset-somo`, `sunset-sardinero` | `surf_school_rentals` | false |

Additional `clients.json` sample rows (beyond Wolfhouse + Sunset) remain inventory-only while `live_enabled=false` — **not** current-stage third-tenant live evidence.

## Inventory method

`completeness_method = source_derived_registration_read_site_inventory`

Categories covered bidirectionally (discovery ↔ fixture):

1. `client_config_files` — all `config/clients/*.json`
2. `registries` — registry-class files under `config/clients/` plus source-referenced registry basenames
3. `feature_flag_symbols` — `live_enabled` and classifier-matched env flag reads across scripts/infra/docker/config
4. `pricing_services_schedule_profile_consumers` — config/clients acquisition sites (fs/path dynamic reads, direct filenames, directory enumeration, loader imports/aliases/wrappers), including `scripts/staff-query-api.js` and `scripts/check-i18n-guest-copy.js`
5. `deployment_overlays` — tenant staging Bicep entrypoints, compose/env overlays, access/routing overlay JSON
6. `existing_verifiers` — package.json multiclient/tenant gate registrations plus portal-slice1 / live-readiness static verifiers

Adversarial temporary-source REDs prove discovery catches aliased/wrapped/dynamic consumers and newly added registry, overlay, verifier, and flag sites absent from fixtures.

## Nine gates (frozen; proof deferred per `proof_stage`)

| ID | Proof stage | 1A evidence |
|----|-------------|-------------|
| `G_ARCHETYPE_SURF_HOUSE` | 1B+ | inventory + contract freeze |
| `G_ARCHETYPE_SURF_SCHOOL_SHOP` | 1B+ | inventory + contract freeze |
| `G_DISABLED_BY_DEFAULT_GENERATION` | 1C+ | gate text only |
| `G_SECRET_REJECTION` | 1C+ | gate text only |
| `G_NO_LIVE_TARGET_COPYING` | 1C+ | gate text only |
| `G_TENANT_LOCATION_ISOLATION` | 1D+ | existing multiclient verifiers retained |
| `G_LEGACY_COMPATIBILITY` | 1D+ | legacy verticals mapped in inventory |
| `G_DRY_RUN_PROOF` | 1E | gate text only |
| `G_MILESTONE_CLOSEOUT` | 1E | deferred to 1E |

## Stage fence

Allowed stage IDs: **1A, 1B, 1C, 1D, 1E** only. Extra stages, gate renames, or treating third-tenant live/prod as current-stage evidence are **rejected**.

## Required current-stage evidence vs out of scope

**Required now:** source inventory, finite stage fence, nine-gate freeze, independent completeness verifier, docs/fixtures/verifier delivery, locked `package.json` script registration.

**Out of scope (1A):** templates, generator, runtime productization, IaC/DB/deploy mutation, secret materialization, live network calls, third-tenant live/prod onboarding.

**Third-tenant live/prod:** `status=out_of_scope`, `effect=triggers_RADAR_reopen`, trigger id `third_tenant_factory`, threshold `tenant_count_gt_2_or_new_tenant_slug_beyond_wolfhouse_somo_and_sunset`.

## What this tip does / does not prove

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| 1A contract + discovery verifier | Gate/stage fence; inventory completeness vs real read sites; Wolfhouse/Sunset reference pair | Generator correctness; live isolation of a new tenant; production readiness |
| Existing hard multiclient subset | isolation / no-hardcoding / tenant-resolution / meta-shadow still green | Full `npm run verify:multiclient` (staff-tenant-scope H3) or tenant-business-config DB-prices merge — pre-existing master REDs retained |

## Closeout

1A is complete when `npm run verify:factory-slice1a-acceptance-contract` passes and existing multiclient/config regressions remain green. Productization work starts at **1B** under this frozen contract — no gate/scope drift.
