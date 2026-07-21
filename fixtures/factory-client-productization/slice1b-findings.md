# FACTORY Slice 1B findings

**Progress class:** `archetype_schema_disabled_static_templates`
**Master basis:** `86f4cb9daaefdecab75ad02a2e755e2e7503216d`
**Branch:** `factory/slice-1b-archetype-templates`
**Delivery:** reviewed static templates under `config/archetypes/` + independent verifier + 1A ledger evidence update — **not** generator, client instance, runtime loading, IaC, DB, deploy, or live calls.

## Verdict

Slice **1B** delivers exactly two disabled-by-default archetype templates derived from the Wolfhouse and Sunset reference shapes frozen in 1A:

| Archetype | Reference | Vertical | Portal default | Locations |
|-----------|-----------|----------|----------------|-----------|
| `surf_house` | wolfhouse / wolfhouse-somo | `lodging_surf_house` | `bed-calendar` | single primary placeholder |
| `surf_school_shop` | sunset / sunset-somo+sunset-sardinero | `surf_school_rentals` | `portal-home` | multi-location placeholders (≥2) |

`surf_house` pricing companion is derived from actual `wolfhouse-quote-calculator` reads: `add_ons`, `deposits.tiers`, `room_supplements`, `rounding`, `hold`, numeric `month_numbers`, and `packages[].seasonal_prices`. Invented `addons` / `deposit` shapes are rejected.

Required pricing / services / schedule / profile / features fields come from the 1A physical-site inventory category `pricing_services_schedule_profile_consumers` and the actual baseline consumers. Compatibility JSON maps those fields to consumer paths without runtime wiring. Deep validation covers package seasonal matrices, Sunset offering `prices_eur`, schedule/profile/features fields, unique location IDs, and exact baseline↔compatibility placeholder references.

## Safety defaults

- `live_enabled=false`
- `deployment.enabled=false`
- channels/sends/payment enablement off (`confirmation_send_mode` ∈ {`dry_run`,`staff_approval`})
- placeholders only (`{{TOKEN}}`) for instance identity
- no secret-shaped values, Meta phone_number_ids, live hostnames, Azure IDs, DB/Stripe/staff credentials, or copied live targets
- Wolfhouse/Sunset reference bytes unchanged (working-tree `git hash-object` vs pinned master blobs — not HEAD)

## Verification

```bash
npm run verify:factory-slice1b-archetype-templates
```

Adversarial REDs cover secret-shaped values, live hostnames, Meta IDs, Azure IDs, missing required fields, default-enable flips, copied live client/location ids, location-placeholder collision, DB credential URLs, live send modes, seasonal_prices/prices_eur/schedule deletions, duplicated location IDs, baseline↔compat placeholder drift, invented addons/deposit/lesson-tier shapes, working-tree reference mutation, coordinated lock/compat drift, extra archetype files, and package cross-ref drift.

File-set GREEN enumerates actual archetype directories/JSON files on disk (not lock length alone).

## Ledger

1A gate ledger evidence for `G_ARCHETYPE_SURF_HOUSE` and `G_ARCHETYPE_SURF_SCHOOL_SHOP` is `1B_static_disabled_archetype_templates` **only when** the independent 1B validator passes (`completion_requires: verify:factory-slice1b-archetype-templates`). Stages 1A and 1B are marked `complete` under that gate. Generator work remains **1C**.
