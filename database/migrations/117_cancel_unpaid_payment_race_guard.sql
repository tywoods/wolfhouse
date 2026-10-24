-- 117_cancel_unpaid_payment_race_guard.sql
-- Prevent payment evidence from being appended after a booking has terminally cancelled.
BEGIN;

DO $ownership$
DECLARE marker text; trigger_marker text; trigger_function oid;
BEGIN
  IF to_regprocedure('public.reject_payment_for_cancelled_booking()') IS NOT NULL THEN
    SELECT obj_description(to_regprocedure('public.reject_payment_for_cancelled_booking()'),'pg_proc') INTO marker;
    IF marker IS DISTINCT FROM '117_cancel_unpaid_payment_race_guard v1' THEN
      RAISE EXCEPTION '117_refused: payment guard function is foreign/newer (comment=%)',marker;
    END IF;
  END IF;
  SELECT obj_description(oid,'pg_trigger'), tgfoid INTO trigger_marker, trigger_function
    FROM pg_trigger WHERE tgrelid='public.payments'::regclass
      AND tgname='payments_reject_cancelled_booking_117' AND NOT tgisinternal;
  IF FOUND AND (trigger_marker IS DISTINCT FROM '117_cancel_unpaid_payment_race_guard v1'
      OR trigger_function IS DISTINCT FROM to_regprocedure('public.reject_payment_for_cancelled_booking()')) THEN
    RAISE EXCEPTION '117_refused: payment guard trigger is foreign/newer (comment=%)',trigger_marker;
  END IF;
END $ownership$;

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
COMMENT ON TRIGGER payments_reject_cancelled_booking_117 ON payments IS '117_cancel_unpaid_payment_race_guard v1';

COMMIT;
