-- 030_booking_service_records_slot_reservations.sql
-- Store scheduled catalog lesson slot reservations on booking_service_records.
-- Runtime Staff API code should also ensure these columns before reservation writes.

BEGIN;

ALTER TABLE booking_service_records
  ADD COLUMN IF NOT EXISTS service_time_local TEXT,
  ADD COLUMN IF NOT EXISTS service_time_local_end TEXT,
  ADD COLUMN IF NOT EXISTS service_slot_id TEXT;

CREATE INDEX IF NOT EXISTS idx_booking_service_records_service_slot
  ON booking_service_records (client_slug, service_date, service_slot_id)
  WHERE service_slot_id IS NOT NULL
    AND status NOT IN ('cancelled');

COMMIT;
