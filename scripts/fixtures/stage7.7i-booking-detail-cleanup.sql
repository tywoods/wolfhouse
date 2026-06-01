-- Stage 7.7i fixture cleanup
-- Removes all rows seeded by stage7.7i-booking-detail-seed.sql.
-- Protected tables return to baseline after this runs.

DO $$
DECLARE
  v_booking_id UUID;
BEGIN
  SELECT id INTO v_booking_id
  FROM bookings
  WHERE booking_code = 'WH-77I-DETAIL-001'
  LIMIT 1;

  IF v_booking_id IS NULL THEN
    RAISE NOTICE 'Booking WH-77I-DETAIL-001 not found — nothing to clean up';
    RETURN;
  END IF;

  -- Remove booking_beds
  DELETE FROM booking_beds WHERE booking_id = v_booking_id;

  -- Remove payments
  DELETE FROM payments WHERE booking_id = v_booking_id;

  -- Remove staff handoffs linked by phone
  DELETE FROM staff_handoffs
  WHERE phone = '+34600000193'
    AND summary = 'Fixture handoff for stage7.7i proof';

  -- Remove booking
  DELETE FROM bookings WHERE id = v_booking_id;

  RAISE NOTICE 'Stage 7.7i fixture cleaned up: booking_id=%', v_booking_id;
END;
$$;
