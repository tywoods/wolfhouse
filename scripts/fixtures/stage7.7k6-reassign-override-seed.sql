-- Stage 7.7k6 fixture seed — admin override for manual/operator lock proof
-- Booking WH-77K6-OVERRIDE-001 assigned to the first active bed.
-- assignment_type is 'manual' to trigger manual_operator_lock blocker.
-- This fixture is designed to test that:
--   - operator cannot override (blocked 403)
--   - admin can override (success 200)
-- Cleanup: scripts/fixtures/stage7.7k6-reassign-override-cleanup.sql

DO $$
DECLARE
  v_client_id  UUID;
  v_booking_id UUID;
  v_bed_id     UUID;
  v_bed_code   TEXT;
  v_room_code  TEXT;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE slug = 'wolfhouse-somo' LIMIT 1;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Client wolfhouse-somo not found';
  END IF;

  SELECT b.id, b.bed_code, r.room_code
  INTO v_bed_id, v_bed_code, v_room_code
  FROM beds b INNER JOIN rooms r ON r.id = b.room_id
  WHERE b.client_id = v_client_id AND b.active = TRUE AND b.sellable = TRUE AND r.active = TRUE
  ORDER BY r.room_code, b.bed_code LIMIT 1;
  IF v_bed_id IS NULL THEN
    RAISE EXCEPTION 'No active bed found for wolfhouse-somo';
  END IF;

  INSERT INTO bookings (
    client_id, booking_code, guest_name, phone, email,
    guest_count, package_code, check_in, check_out,
    status, payment_status, assignment_status,
    requested_room_type, room_preference, primary_room_code,
    needs_rooming_review, total_amount_cents,
    deposit_required_cents, amount_paid_cents, balance_due_cents
  ) VALUES (
    v_client_id, 'WH-77K6-OVERRIDE-001', 'Fixture K6 Override Guest',
    '+34600000197', 'fixture-k6@example.com',
    1, 'SURF_7', '2026-12-01', '2026-12-08',
    'confirmed', 'deposit_paid', 'assigned',
    'shared_dorm', 'no preference', v_room_code,
    false, 84000, 21000, 21000, 63000
  )
  RETURNING id INTO v_booking_id;

  INSERT INTO booking_beds (
    booking_id, bed_id, client_id, room_code, bed_code,
    assignment_start_date, assignment_end_date,
    assignment_type, assignment_label, planning_row_label
  ) VALUES (
    v_booking_id, v_bed_id, v_client_id,
    v_room_code, v_bed_code,
    '2026-12-01', '2026-12-08',
    'manual', 'Manually assigned by staff', 'WH-77K6-OVERRIDE-001'
  );

  RAISE NOTICE 'Stage 7.7k6 fixture seeded: booking=%, bed=%/%', v_booking_id, v_room_code, v_bed_code;
END;
$$;
