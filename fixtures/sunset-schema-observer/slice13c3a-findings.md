# FOUNDATION Slice 13C.3a — tenant_services catalog columns (DEC-004 Phase C partial)

**Master basis:** `5158320585f0a894329d8ff017fa658d86d041bf`
**New forward migration:** `040_tenant_services_catalog_columns.sql`
**canonical_lf_v1 hash:** `2f1a24bed1eabf281bda2cb7f89f6184c602513c4a7ce68634eccc39c4323c48`

## Verdict

Promoted only the four approved live `tenant_services` columns into one canonical forward migration and proved them on disposable PostgreSQL.

| Measure | Value |
|---------|------:|
| Forward count | **37 → 38** |
| Prior product fingerprint | `553d21d3…20f1` |
| New product fingerprint | `2ecbb8ca…0828` |
| Mismatch trajectory (after 13C.2) | **29 → 25** |
| Phase C TS column keys resolved | **4** |
| Remaining `genuine_database_drift` | **25** |
| Observer outcome | still `match=false` / `product_schema_differs` |

**Do not claim** Sunset is repaired. Remaining Phase C (035/CMT/notification/surf-pack) and Phase D CHECKs are still pending. Zero live/Azure mutation.

## Columns promoted

- `weekdays` SMALLINT[] NOT NULL DEFAULT '{}'
- `block_rooms_enabled` BOOLEAN NOT NULL DEFAULT false
- `blocked_room_codes` TEXT[] NOT NULL DEFAULT '{}'
- `room_block_booking_ids` UUID[] NOT NULL DEFAULT '{}'

## Explicitly excluded

- Phase D CHECKs `tenant_services_date_window` / `tenant_services_price_unit`
- migration 035 / CMT
- notification indexes / surf-pack objects
- ledger bootstrap

## Disposable proof

- Path A: full chain incl. 040 → regenerated expected contract; second apply no-op
- Path B: prior 37 + Staff-like columns present → 040 preserves attnums; converges; idempotent
- RED: incompatible type / nullability / default / generated; missing parent table

## Confirmation

**Zero live mutation.**
