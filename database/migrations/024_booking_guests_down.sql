-- Reverse 024_booking_guests.sql (apply manually when rolling back Slice A)

BEGIN;

DROP INDEX IF EXISTS idx_payments_booking_guest;

ALTER TABLE payments
  DROP COLUMN IF EXISTS booking_guest_id;

DROP TRIGGER IF EXISTS booking_guests_updated_at ON booking_guests;
DROP INDEX IF EXISTS idx_booking_guests_client_booking;
DROP INDEX IF EXISTS idx_booking_guests_booking;
DROP TABLE IF EXISTS booking_guests;

COMMIT;
