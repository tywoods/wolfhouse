# FACTORY Slice 1A findings

**Progress class:** `source_only_acceptance_contract_freeze`

**Master basis:** `0ef5958ed8b81ca04b196062505bf4be7a403221`

**Branch:** `factory/slice-1a-contract`

**Delivery:** docs / fixtures / independent verifier only — **not** templates, generator, runtime, IaC, DB, deploy, secrets, or live calls. `package.json` may change only for the locked script key `verify:factory-slice1a-acceptance-contract` plus the pinned `acorn@8.14.1` dependency (diff-validated with `package-lock.json`).

## Verdict

FACTORY client productization is fenced to **five finite stages (1A–1E)**. Slice **1A** freezes the acceptance contract, inventories real Wolfhouse/Sunset registration and read sites, and locks nine gates. Completeness method remains `source_derived_registration_read_site_inventory`, implemented by pinned **Acorn ESTree physical-site discovery** plus a local import graph (`scripts/lib/factory-slice1a-inventory-discovery.js`). Physical site keys are inventoried independently of fixture `site_policy`, then compared with exact bidirectional set equality. Locked exclusions are justified noise filters only. Third-tenant live/prod work stays **out of scope** and triggers RADAR reopen `third_tenant_factory`.

## Threat boundary

Every filesystem primitive inside the reachable config-loader acquisition graph must constant-fold to `{ value, complete }` or discovery **fails closed**. Incomplete or unfoldable paths emit `ambiguous_filesystem_path` **before** any partial-value or `config/clients` prefix inspection; **only complete folds** may classify config versus unrelated. Dynamic template interpolation, computed members, unresolved alias/destructuring, and unknown segments are **incomplete**. No `CLIENTS_DIR` textual/taint heuristic and no silent unresolved call. Filesystem calls outside the reachable graph are ignored.

## Reference pair (discovered)

| Archetype | Client | Locations | Legacy vertical | `live_enabled` |
|-----------|--------|-----------|-----------------|----------------|
| `surf_house` | `wolfhouse` | `wolfhouse-somo` | `lodging_surf_house` | false |
| `surf_school_shop` | `sunset` | `sunset-somo`, `sunset-sardinero` | `surf_school_rentals` | false |

Additional `clients.json` sample rows (beyond Wolfhouse + Sunset) remain inventory-only while `live_enabled=false` — **not** current-stage third-tenant live evidence.

## Inventory method

`completeness_method = source_derived_registration_read_site_inventory`

`discovery_engine = pinned_acorn_estree_physical_site_plus_local_import_graph`

Categories covered bidirectionally (discovery ↔ fixture):

1. `client_config_files` — all `config/clients/*.json`
2. `registries` — registry-class files under `config/clients/` plus source-referenced registry basenames
3. `feature_flag_symbols` — `live_enabled` and classifier-matched env flag reads across scripts/infra/docker/config
4. `pricing_services_schedule_profile_consumers` — files owning structural physical sites (FS + loader imports)
5. `physical_site_keys` — Acorn-derived structural site keys (`fs_*` / `loader_import`)
6. `deployment_overlays` — tenant staging Bicep entrypoints, compose/env overlays, access/routing overlay JSON
7. `existing_verifiers` — package.json multiclient/tenant gate registrations (normalizes `scripts/...` and `./scripts/...`) plus portal-slice1 / live-readiness static verifiers

Independent `site_policy.physical_site_keys` must match discovered keys bidirectionally.

Adversarial temporary-source REDs prove discovery catches split-string `path.resolve`, aliased wrappers, `./` verifier registration, stale/missing site policy, coordinated fixture edits, fail-closed computed/dynamic import or unresolved dynamic path cases, reachable non-seed `path.join(portal.CLIENTS_DIR, dynamicName)` incomplete FS, computed-member / aliased-destructuring / dynamic-template / aliased-template FS incompleteness, `path.join(__dirname,'..','config','clients',dynamicName)` plus binary/spread/call/conditional nested-wrapper forms (each fail-closed before config/clients classify), fully resolved unrelated in-graph FS allowed, and outside-graph dynamic FS noise ignored. Required consumers include `scripts/staff-query-api.js` and `scripts/check-i18n-guest-copy.js`.

## Nine gates (frozen; proof deferred per `proof_stage`)

| ID | Proof stage | Ledger evidence |
|----|-------------|-----------------|
| `G_ARCHETYPE_SURF_HOUSE` | 1B+ | **1B complete** — `config/archetypes/surf_house/` static disabled templates (`1B_static_disabled_archetype_templates`) |
| `G_ARCHETYPE_SURF_SCHOOL_SHOP` | 1B+ | **1B complete** — `config/archetypes/surf_school_shop/` static disabled templates (`1B_static_disabled_archetype_templates`) |
| `G_DISABLED_BY_DEFAULT_GENERATION` | 1C+ | **1C complete** — dry-run generator forces enablement off (`1C_deterministic_disabled_dry_run_generator`) |
| `G_SECRET_REJECTION` | 1C+ | **1C complete** — generator rejects secret-shaped input/output (`1C_deterministic_disabled_dry_run_generator`) |
| `G_NO_LIVE_TARGET_COPYING` | 1C+ | **1C complete** — generator rejects live-target shaped input/output (`1C_deterministic_disabled_dry_run_generator`) |
| `G_TENANT_LOCATION_ISOLATION` | 1D+ | **1D complete** — integration isolation proof (`1D_integration_isolation_legacy_compat_proof`) |
| `G_LEGACY_COMPATIBILITY` | 1D+ | **1D complete** — legacy consumer compatibility on verifier-owned temps (`1D_integration_isolation_legacy_compat_proof`) |
| `G_DRY_RUN_PROOF` | 1E | **1E complete** — synthetic stdout artifact + closeout verifier (`1E_dry_run_proof_packaging_milestone_closeout`) |
| `G_MILESTONE_CLOSEOUT` | 1E | **1E complete** — finite milestone closeout (`1E_dry_run_proof_packaging_milestone_closeout`) |

## Stage fence

Allowed stage IDs: **1A, 1B, 1C, 1D, 1E** only. Extra stages, gate renames, or treating third-tenant live/prod as current-stage evidence are **rejected**.

## Required current-stage evidence vs out of scope

**Required now:** source inventory, finite stage fence, nine-gate freeze, independent completeness verifier, docs/fixtures/verifier delivery, locked `package.json` script registration + Acorn pin.

**Out of scope (1A):** templates, generator, runtime productization, IaC/DB/deploy mutation, secret materialization, live network calls, third-tenant live/prod onboarding.

**Third-tenant live/prod:** `status=out_of_scope`, `effect=triggers_RADAR_reopen`, trigger id `third_tenant_factory`, threshold `tenant_count_gt_2_or_new_tenant_slug_beyond_wolfhouse_somo_and_sunset`.

## What this tip does / does not prove

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| 1A contract + Acorn discovery verifier | Gate/stage fence; inventory completeness vs structural read sites; Wolfhouse/Sunset reference pair | Generator correctness; live isolation of a new tenant; production readiness |
| Existing hard multiclient subset | isolation / no-hardcoding / tenant-resolution / meta-shadow still green | Full `npm run verify:multiclient` (staff-tenant-scope H3) or tenant-business-config DB-prices merge — pre-existing master REDs retained |

## Closeout

1A is complete when `npm run verify:factory-slice1a-acceptance-contract` passes and existing multiclient/config regressions remain green. **1B is complete** under this ledger only when the independent validator `npm run verify:factory-slice1b-archetype-templates` passes (`completion_requires`); static disabled archetype templates live at `config/archetypes/{surf_house,surf_school_shop}/`. **1C is complete** only when `npm run verify:factory-slice1c-dry-run-generator` passes (`completion_requires`); dry-run CLI is `scripts/onboard-client.js`. **1D is complete** only when `npm run verify:factory-slice1d-integration-proof` passes (`completion_requires`). **1E is complete** only when `npm run verify:factory-slice1e-finite-closeout` passes (`completion_requires`); synthetic third-tenant dry-run packaging + milestone closeout. Finite FACTORY **1A–1E** is closed under that gate — no gate/scope drift; third-tenant live/prod remains out of scope pending RADAR reopen `third_tenant_factory`.
