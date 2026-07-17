# Canonical migration inventory (FOUNDATION Slice 4)

Master tip: `4502fe3938dd907c14d2c7218e7252d19b3d985d`

Source of truth: `database/migrations/canonical-manifest.json`

## Intentional gap

| Number | Status |
|--------|--------|
| 015 | Intentionally unused (`015_INTENTIONALLY_UNUSED.md`). Phase 25 shipped as `016_staff_phone_access.sql`. |

## Duplicate-number decisions (filenames unchanged)

| Number | Forward order | Excluded |
|--------|---------------|----------|
| 024 | `024_booking_guests.sql` | `024_booking_guests_down.sql` (rollback), `024_sunset_conversation_location_id_PROPOSED.sql` (proposed) |
| 030 | `030_tenant_house_notes.sql` then `030_booking_service_records_slot_reservations.sql` | — |
| 033 | `033_tenant_private_lesson_rules.sql` then `033_staff_automated_notifications.sql` | — |

Fresh-DB dependency note: `001` → `003` → `002` (not numeric filename order). Documented in `database/migrations/README.md`.

## Classification summary

| Classification | Count |
|----------------|------:|
| canonical_forward (in chain) | 36 |
| proposed_not_executable | 4 |
| rollback_down | 1 |
| superseded | 0 |
| unresolved | 0 |
| **Total SQL files** | **41** |

Proposed (not in forward chain): `022_*_PROPOSED`, `023_*_PROPOSED`, `024_sunset_conversation_location_id_PROPOSED`, `025_*_PROPOSED`.
