-- PROPOSED ONLY — DO NOT RUN without explicit approval.
-- Smallest additive schema for first-class Sunset school/location IDs.
-- Until applied, location_id lives in bookings.metadata and booking_service_records.metadata.

BEGIN;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS location_id TEXT;

ALTER TABLE booking_service_records
  ADD COLUMN IF NOT EXISTS location_id TEXT;

-- Backfill Sunset tenant rows missing location to default school.
UPDATE bookings b
   SET location_id = 'sunset-somo'
  FROM clients c
 WHERE c.id = b.client_id
   AND c.slug = 'sunset'
   AND (b.location_id IS NULL OR b.location_id = '');

UPDATE booking_service_records sr
   SET location_id = 'sunset-somo'
 WHERE sr.client_slug = 'sunset'
   AND (sr.location_id IS NULL OR sr.location_id = '');

COMMIT;
