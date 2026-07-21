# FACTORY — Client productization (finite stages 1A–1E)

**Status:** Slice **1A frozen** (source-only acceptance contract).

**Master basis:** `0ef5958ed8b81ca04b196062505bf4be7a403221`

**Owner artifacts:**
`fixtures/factory-client-productization/` · `scripts/lib/factory-slice1a-acceptance-contract.js` · `scripts/lib/factory-slice1a-inventory-discovery.js` · `scripts/verify-factory-slice1a-acceptance-contract.js`

Related: [`MULTICLIENT-ARCHITECTURE.md`](MULTICLIENT-ARCHITECTURE.md) · [`DEPLOYMENT-CONFIG.md`](DEPLOYMENT-CONFIG.md) · RADAR reopen `third_tenant_factory` in [`RADAR-OPERATIONS-GATE-LEDGER.md`](RADAR-OPERATIONS-GATE-LEDGER.md).

---

## Purpose

Freeze a **finite, source-only acceptance contract** before any client-productization implementation. FACTORY turns the Wolfhouse + Sunset worked examples into two reusable archetypes without drifting into open-ended platform work.

## Finite stages (reject drift beyond these five)

| Stage | Title | 1A status |
|-------|-------|-----------|
| **1A** | Source-only acceptance contract + inventory freeze | **Current — docs/fixtures/verifier only** |
| **1B** | Archetype schema + disabled-by-default templates | Deferred |
| **1C** | Deterministic generator (secret rejection, no live-target copy) | Deferred |
| **1D** | Tenant/location isolation + legacy-compatibility proofs | Deferred |
| **1E** | Dry-run proof packaging + milestone closeout | Deferred |

**1A forbids:** templates, generator, runtime, IaC, DB, deploy, secrets, live calls.

**Reject:** extra stages, renamed gates, or claiming third-tenant live/prod as current-stage evidence.

**Tip scope:** docs, fixtures, and verifier-support only. `package.json` may change solely for the locked script key `verify:factory-slice1a-acceptance-contract` (diff-validated).

## Archetypes

| FACTORY id | Reference client | Locations | Legacy vertical |
|------------|------------------|-----------|-----------------|
| `surf_house` | `wolfhouse` | `wolfhouse-somo` | `lodging_surf_house` |
| `surf_school_shop` | `sunset` | `sunset-somo`, `sunset-sardinero` | `surf_school_rentals` |

Crowsnest mock templates (`surf_house` / `surf_school`) are UI reference only until 1B+.

## Acceptance gates (nine)

1. **`G_ARCHETYPE_SURF_HOUSE`** — surf-house shape matches Wolfhouse lodging defaults.
2. **`G_ARCHETYPE_SURF_SCHOOL_SHOP`** — school+shop shape matches Sunset multi-location lessons/rentals.
3. **`G_DISABLED_BY_DEFAULT_GENERATION`** — generated clients stay `live_enabled=false` / channels disabled until an explicit later enablement gate.
4. **`G_SECRET_REJECTION`** — no live secrets in committed outputs; `secret:<key>` + example files only.
5. **`G_NO_LIVE_TARGET_COPYING`** — do not copy live Azure IDs, Meta phone_number_ids, Stripe live keys, or live hostnames.
6. **`G_TENANT_LOCATION_ISOLATION`** — unique `client_slug` / globally unique `location_id`; live isolation per multiclient architecture.
7. **`G_LEGACY_COMPATIBILITY`** — Wolfhouse + Sunset keep working on existing loaders without a forced FACTORY migration in 1A–1E.
8. **`G_DRY_RUN_PROOF`** — offline dry-run artifacts + verifiers; no live writes.
9. **`G_MILESTONE_CLOSEOUT`** — 1E only when all gates have stage-appropriate evidence and the stage fence holds.

## Inventory (source-derived)

Completeness method: **`source_derived_registration_read_site_inventory`**.

The independent verifier **discovers** registration/read sites from the tree and requires the fixture inventory to match with **exact bidirectional set equality**. Locked exclusions filter justified noise only; they are never the expected inventory. Categories:

- Client config files under `config/clients/`
- Registries (`clients.json`, staff-portal-access, channel-routing maps)
- Feature/env flag symbols read in source (`live_enabled`, tenant slug envs, Sunset admin / portal / admission flags)
- Config/clients acquisition sites (fs/path dynamic reads, direct filenames, directory enumeration, loader imports/aliases/wrappers) including `scripts/staff-query-api.js` and `scripts/check-i18n-guest-copy.js`
- Deployment overlays (Wolfhouse + Sunset staging Bicep entrypoints, compose, env example, access/routing overlays)
- Existing verifier registrations/files (multiclient gate pack + tenant-business-config + portal/readiness static)

Canonical freeze: `fixtures/factory-client-productization/slice1a-inventory.json`.

## Current-stage evidence vs third-tenant live/prod

**Required for 1A:** inventory + gate/stage freeze + independent completeness verifier + docs/fixtures/verifier delivery (plus the single locked `package.json` script registration).

**Out of scope for 1A–1E current-stage evidence:** third-tenant **live/prod** onboarding beyond the Wolfhouse + Sunset staging pair.

That work **triggers RADAR reopen** `third_tenant_factory`
(threshold: `tenant_count_gt_2_or_new_tenant_slug_beyond_wolfhouse_somo_and_sunset`).
Mirleft/La Wave registry rows remain inventory-only while `live_enabled=false`.

## Verification

```bash
npm run verify:factory-slice1a-acceptance-contract
```

Hard regressions spawned by the verifier: multiclient-isolation, no-client-hardcoding, tenant-resolution, meta-whatsapp-tenant-shadow.

**Retained master REDs** (not introduced by 1A; reported, not fail-closed here): `verify-staff-tenant-scope` H3; `verify-tenant-business-config` “DB prices used” merge behavior.

## What 1A does not authorize

Shipping templates/generators, mutating runtime/IaC/DB, deploying, materializing secrets, live network calls, raising RADAR gates, or treating a third live tenant as FACTORY closeout evidence.
