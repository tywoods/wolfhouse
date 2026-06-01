-- Stage 7.7k7 fixture seed — bed reassignment rollback/undo proof
--
-- Creates:
--   WH-77K7-UNDO-001     check range 2027-03-01 to 2027-03-08  (happy-path undo)
--   WH-77K7-CONFLICT-001 check range 2027-03-15 to 2027-03-22  (conflict-on-undo)
--
-- Both use assignment_type='automatic' so manual_operator_lock does NOT fire
-- on the first move. The proof script uses admin+override for subsequent moves.
--
-- Cleanup: scripts/fixtures/stage7.7k7-reassign-rollback-cleanup.sql

DO $$
DECLARE
  v_client_id    UUID;
  v_bed_id       UUID;
  v_bed_code     TEXT;
  v_room_code    TEXT;
  v_booking_id_a UUID;
  v_booking_id_b UUID;
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

  -- WH-77K7-UNDO-001 (happy-path undo fixture, 2027-03-01 to 2027-03-08)
  INSERT INTO bookings (
    client_id, booking_code, guest_name, phone, email,
    guest_count, package_code, check_in, check_out,
    status, payment_status, assignment_status,
    requested_room_type, room_preference, primary_room_code,
    needs_rooming_review, total_amount_cents,
    deposit_required_cents, amount_paid_cents, balance_due_cents
  ) VALUES (
    v_client_id, 'WH-77K7-UNDO-001', 'Fixture K7 Undo Guest',
    '+34600000301', 'fixture-k7-undo@example.com',
    1, 'SURF_7', '2027-03-01', '2027-03-08',
    'confirmed', 'deposit_paid', 'assigned',
    'shared_dorm', 'no preference', v_room_code,
    false, 84000, 21000, 21000, 63000
  )
  RETURNING id INTO v_booking_id_a;

  INSERT INTO booking_beds (
    booking_id, bed_id, client_id, room_code, bed_code,
    assignment_start_date, assignment_end_date,
    assignment_type, assignment_label, planning_row_label
  ) VALUES (
    v_booking_id_a, v_bed_id, v_client_id,
    v_room_code, v_bed_code,
    '2027-03-01', '2027-03-08',
    'automatic', 'K7-UNDO-001-fixture', 'WH-77K7-UNDO-001'
  );

  -- WH-77K7-CONFLICT-001 (conflict-on-undo fixture, 2027-03-15 to 2027-03-22)
  -- Note: different date range from UNDO-001 so both can occupy the same bed
  -- without half-open interval conflict.
  INSERT INTO bookings (
    client_id, booking_code, guest_name, phone, email,
    guest_count, package_code, check_in, check_out,
    status, payment_status, assignment_status,
    requested_room_type, room_preference, primary_room_code,
    needs_rooming_review, total_amount_cents,
    deposit_required_cents, amount_paid_cents, balance_due_cents
  ) VALUES (
    v_client_id, 'WH-77K7-CONFLICT-001', 'Fixture K7 Conflict Guest',
    '+34600000302', 'fixture-k7-conflict@example.com',
    1, 'SURF_7', '2027-03-15', '2027-03-22',
    'confirmed', 'deposit_paid', 'assigned',
    'shared_dorm', 'no preference', v_room_code,
    false, 84000, 21000, 21000, 63000
  )
  RETURNING id INTO v_booking_id_b;

  INSERT INTO booking_beds (
    booking_id, bed_id, client_id, room_code, bed_code,
    assignment_start_date, assignment_end_date,
    assignment_type, assignment_label, planning_row_label
  ) VALUES (
    v_booking_id_b, v_bed_id, v_client_id,
    v_room_code, v_bed_code,
    '2027-03-15', '2027-03-22',
    'automatic', 'K7-CONFLICT-001-fixture', 'WH-77K7-CONFLICT-001'
  );

  RAISE NOTICE 'Stage 7.7k7 fixtures seeded: undo=% conflict=% bed=%/%',
    v_booking_id_a, v_booking_id_b, v_room_code, v_bed_code;
END;
$$;
