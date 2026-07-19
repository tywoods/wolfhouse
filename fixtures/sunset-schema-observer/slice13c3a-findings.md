# FOUNDATION Slice 13C.3a — tenant_services SaaS catalog columns (DEC-004 / Phase C)

**Master basis:** `5158320585f0a894329d8ff017fa658d86d041bf`
**New forward migration:** `040_tenant_services_saas_catalog_columns.sql`
**canonical_lf_v1 hash:** `880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd`

## Verdict

Promoted the four approved `tenant_services` live-only columns into **one** reviewed canonical forward migration and proved it on **disposable PostgreSQL only**.

| Measure | Value |
|---------|------:|
| Forward count | **37 → 38** |
| Prior product fingerprint | `553d21d3…20f1` |
| New product fingerprint | `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18` |
| Mismatch trajectory (after 13C.2 azure norm) | **29 → 25** |
| Phase C tenant_services column keys resolved | **4** |
| Remaining `genuine_database_drift` | **25** |
| Observer outcome | still `match=false` / `product_schema_differs` |

**Do not claim** Sunset is repaired. CMT (035), notification indexes, surf-pack reconciliation, and Phase D `tenant_services` CHECKs remain pending. Zero live/Azure mutation in this slice.

## Field matrix (live-only tenant_services columns)

| Column | Live definition | Code owner / meaning | Type / default / null | Code requirement | Decision |
|--------|-----------------|----------------------|------------------------|------------------|----------|
| `weekdays` | `SMALLINT[] NOT NULL DEFAULT '{}'` | `tenant-services-writes.js` — recurring weekday filter (0–6) | `_int2` / `'{}'::smallint[]` / NOT NULL | Written on create/patch when provided; validated 0–6 | **promote** |
| `block_rooms_enabled` | `BOOLEAN NOT NULL DEFAULT false` | `tenant-services-writes.js` + `tenant-service-room-blocks.js` — enables camp room blocks | `bool` / `false` / NOT NULL | Required with dates + room codes when enabling blocks | **promote** |
| `blocked_room_codes` | `TEXT[] NOT NULL DEFAULT '{}'` | `tenant-service-room-blocks.js` `normalizeRoomCodes` | `_text` / `'{}'::text[]` / NOT NULL | Required non-empty when `block_rooms_enabled` | **promote** |
| `room_block_booking_ids` | `UUID[] NOT NULL DEFAULT '{}'` | `tenant-service-room-blocks.js` `syncServiceRoomBlocks` | `_uuid` / `'{}'::uuid[]` / NOT NULL | System-maintained backing operator booking IDs | **promote** |

Deferred/rejected in this slice: Phase D CHECKs (`tenant_services_date_window`, `tenant_services_price_unit`), CMT 035, notification/surf-pack, ledger bootstrap.

## Catalog fail-closed

Column promotion inspects `pg_attribute` / `pg_type` (`udt_name`, `attnotnull`, `pg_get_expr` default, `attgenerated`, `attidentity`). Absent → `ADD COLUMN IF NOT EXISTS`; exact compatible → preserve/no-op; incompatible type/default/nullability/generated/identity → `RAISE` and rollback.

**Locks:** brief `ACCESS EXCLUSIVE` on `ALTER TABLE tenant_services ADD COLUMN` (small catalog table).

## Explicitly excluded

- `tenant_services_date_window` / `tenant_services_price_unit` CHECK constraints (Phase D)
- `customer_message_templates` / migration 035
- `client_notification_*` indexes
- `tenant_surf_pack_rules` FK/trigger/index reconciliation
- `schema_migration_ledger` bootstrap

## Disposable proof

- **Path A:** full canonical chain including 040 → regenerated `expected-product-schema.json`; second apply no-op; observer self-match.
- **Path B:** prior 37 forwards + Staff ensure-DDL columns already present → apply 040 twice → same fingerprint as Path A; column `attnum` stable.
- **RED fail-closed:** incompatible column types/defaults/nullability; generated column; missing parent `tenant_services` table.

## Artifacts

- `database/migrations/040_tenant_services_saas_catalog_columns.sql`
- `fixtures/sunset-schema-observer/expected-product-schema.json` (migration-generated)
- `fixtures/sunset-schema-observer/slice13c3a-tenant-services-promotion-evidence.json`
- `fixtures/sunset-schema-observer/slice13c3a-mismatch-29-to-25-evidence.json`
- `scripts/prove-sunset-schema-slice13c3a-tenant-services-promotion.js`
- `scripts/verify-sunset-schema-slice13c3a.js`

## Confirmation

**Zero live mutation.** No Azure apply, no observer job start/redeploy, no image build/deploy.
