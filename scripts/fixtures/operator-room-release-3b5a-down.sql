-- Phase 3b.5a — local Operator Room Release impact report fixture (DOWN)
-- Removes only booking_code WH-OPER-LOCAL-RELEASE-2027 and its booking_beds.
-- Skips booking DELETE if payments or payment_events exist.

BEGIN;

DELETE FROM booking_beds bb
USING bookings b
INNER JOIN clients c ON c.id = b.client_id AND c.slug = 'wolfhouse-somo'
WHERE bb.booking_id = b.id
  AND b.booking_code = 'WH-OPER-LOCAL-RELEASE-2027';

DO $$
DECLARE
  v_booking_id UUID;
  v_payments   INT;
  v_events     INT;
  v_deleted    INT;
BEGIN
  SELECT b.id INTO v_booking_id
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id AND c.slug = 'wolfhouse-somo'
  WHERE b.booking_code = 'WH-OPER-LOCAL-RELEASE-2027';

  IF v_booking_id IS NULL THEN
    RAISE NOTICE 'operator-room-release-3b5a-down: fixture booking already absent';
    RETURN;
  END IF;

  SELECT COUNT(*)::int INTO v_payments FROM payments WHERE booking_id = v_booking_id;
  SELECT COUNT(*)::int INTO v_events
  FROM payment_events pe
  INNER JOIN payments p ON p.id = pe.payment_id
  WHERE p.booking_id = v_booking_id;

  IF v_payments > 0 OR v_events > 0 THEN
    RAISE EXCEPTION
      'Fixture down blocked: booking WH-OPER-LOCAL-RELEASE-2027 has payments=% payment_events=%',
      v_payments, v_events;
  END IF;

  DELETE FROM bookings WHERE id = v_booking_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RAISE NOTICE 'operator-room-release-3b5a-down: removed booking (rows=%)', v_deleted;
END $$;

COMMIT;
