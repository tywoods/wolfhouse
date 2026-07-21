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

Required pricing / services / schedule / profile / features fields come from the 1A physical-site inventory category `pricing_services_schedule_profile_consumers` and the actual baseline consumers (`tenant-business-config`, `staff-portal-clients`, quote/catalog/rental/lesson lookups, etc.). Compatibility JSON maps those fields to consumer paths without runtime wiring.

## Safety defaults

- `live_enabled=false`
- `deployment.enabled=false`
- channels/sends/payment enablement off (`confirmation_send_mode` ∈ {`dry_run`,`staff_approval`})
- placeholders only (`{{TOKEN}}`) for instance identity
- no secret-shaped values, Meta phone_number_ids, live hostnames, Azure IDs, DB/Stripe/staff credentials, or copied live targets
- Wolfhouse/Sunset reference bytes unchanged (blob SHA pins in verifier)

## Verification

```bash
npm run verify:factory-slice1b-archetype-templates
```

Adversarial REDs cover secret-shaped values, live hostnames, Meta IDs, Azure IDs, missing required fields, default-enable flips, copied live client/location ids, location-placeholder collision, DB credential URLs, and live send modes.

## Ledger

1A gate ledger evidence for `G_ARCHETYPE_SURF_HOUSE` and `G_ARCHETYPE_SURF_SCHOOL_SHOP` is updated to `1B_static_disabled_archetype_templates`. Stages 1A and 1B are marked `complete`. Generator work remains **1C**.
