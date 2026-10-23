-- 117_cancel_unpaid_payment_race_guard.sql
-- Prevent payment evidence from being appended after a booking has terminally cancelled.
BEGIN;

CREATE OR REPLACE FUNCTION reject_payment_for_cancelled_booking()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE booking_state text;
BEGIN
  SELECT status::text INTO booking_state
    FROM bookings
   WHERE id=NEW.booking_id AND client_id=NEW.client_id
   FOR UPDATE;
  IF booking_state IS NULL THEN
    RAISE EXCEPTION 'payment_booking_not_found' USING ERRCODE='23503';
  END IF;
  IF booking_state='cancelled' THEN
    RAISE EXCEPTION 'payment_for_cancelled_booking' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$fn$;
COMMENT ON FUNCTION reject_payment_for_cancelled_booking() IS '117_cancel_unpaid_payment_race_guard v1';

DROP TRIGGER IF EXISTS payments_reject_cancelled_booking_117 ON payments;
CREATE TRIGGER payments_reject_cancelled_booking_117
BEFORE INSERT OR UPDATE OF booking_id,client_id ON payments
FOR EACH ROW EXECUTE FUNCTION reject_payment_for_cancelled_booking();

COMMIT;
