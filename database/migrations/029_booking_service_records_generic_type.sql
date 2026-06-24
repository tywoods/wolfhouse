-- v3 booking integration — Stage: Wolfhouse Services bookable (catalog → booking)
--
-- Purpose:
--   Let admin-created catalog services (tenant_services, migration 028) be added to
--   a booking as booking_service_records rows. Migration 010 pinned service_type to a
--   closed set of built-in operational types:
--       ('yoga','meal','surf_lesson','wetsuit','surfboard')
--   Catalog services don't map to those buckets, so we add a single generic bucket
--   'addon_service'. The specific catalog row is identified by metadata.service_id
--   (UUID into tenant_services); service_type stays a coarse operational category.
--
-- Idempotent runtime twin:
--   lunabox cannot reach staging Postgres to run migrations, so the same change is
--   applied lazily at runtime by ensureBookingServiceGenericType() in
--   scripts/lib/tenant-services-writes.js (check-first, same pattern as
--   ensureLessonTimeCapacityColumn / ensureServicesTable). This file is the record.
--
-- The inline CHECK from migration 010 is auto-named booking_service_records_service_type_check.

BEGIN;

ALTER TABLE booking_service_records
  DROP CONSTRAINT IF EXISTS booking_service_records_service_type_check;

ALTER TABLE booking_service_records
  ADD CONSTRAINT booking_service_records_service_type_check
  CHECK (service_type IN (
    'yoga', 'meal', 'surf_lesson', 'wetsuit', 'surfboard',
    'addon_service'
  ));

COMMENT ON COLUMN booking_service_records.service_type IS
  'Operational service category: yoga, meal, surf_lesson, wetsuit, surfboard, or addon_service (catalog service from tenant_services; metadata.service_id holds the UUID).';

COMMIT;
