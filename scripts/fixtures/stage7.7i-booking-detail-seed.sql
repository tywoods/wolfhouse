-- Stage 7.7i fixture seed — booking detail drawer proof
-- Creates booking WH-77I-DETAIL-001 with a booking_beds row,
-- a payment row, and a staff_handoff row for the proof.
-- Cleanup: scripts/fixtures/stage7.7i-booking-detail-cleanup.sql

DO $$
DECLARE
  v_client_id   UUID;
  v_booking_id  UUID;
  v_payment_id  UUID;
  v_bed_id      UUID;
  v_room_id     UUID;
  v_room_code   TEXT;
  v_bed_code    TEXT;
BEGIN
  -- Resolve client
  SELECT id INTO v_client_id
  FROM clients
  WHERE slug = 'wolfhouse-somo'
  LIMIT 1;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Client wolfhouse-somo not found';
  END IF;

  -- Find an active bed for the fixture
  SELECT b.id, b.bed_code, r.id, r.room_code
  INTO v_bed_id, v_bed_code, v_room_id, v_room_code
  FROM beds b
  INNER JOIN rooms r ON r.id = b.room_id
  WHERE b.client_id = v_client_id
    AND b.active = TRUE
    AND r.active = TRUE
  ORDER BY r.room_code, b.bed_code
  LIMIT 1;
  IF v_bed_id IS NULL THEN
    RAISE EXCEPTION 'No active bed found for wolfhouse-somo';
  END IF;

  -- Insert booking
  INSERT INTO bookings (
    client_id,
    booking_code,
    guest_name,
    phone,
    email,
    guest_count,
    package_code,
    check_in,
    check_out,
    status,
    payment_status,
    assignment_status,
    requested_room_type,
    room_preference,
    primary_room_code,
    needs_rooming_review,
    total_amount_cents,
    deposit_required_cents,
    amount_paid_cents,
    balance_due_cents
  ) VALUES (
    v_client_id,
    'WH-77I-DETAIL-001',
    'Fixture Detail Guest',
    '+34600000193',
    'fixture-detail@example.com',
    1,
    'SURF_7',
    '2026-08-01',
    '2026-08-08',
    'confirmed',
    'deposit_paid',
    'assigned',
    'shared_dorm',
    'any quiet bed',
    v_room_code,
    false,
    84000,
    21000,
    21000,
    63000
  )
  RETURNING id INTO v_booking_id;

  -- Insert booking_beds row
  INSERT INTO booking_beds (
    booking_id,
    bed_id,
    client_id,
    room_code,
    bed_code,
    assignment_start_date,
    assignment_end_date,
    assignment_type,
    assignment_label,
    planning_row_label
  ) VALUES (
    v_booking_id,
    v_bed_id,
    v_client_id,
    v_room_code,
    v_bed_code,
    '2026-08-01',
    '2026-08-08',
    'automatic',
    'Auto-assigned',
    'WH-77I-DETAIL-001'
  );

  -- Insert payment row
  INSERT INTO payments (
    booking_id,
    client_id,
    status,
    amount_due_cents,
    amount_paid_cents,
    paid_at
  ) VALUES (
    v_booking_id,
    v_client_id,
    'paid',
    21000,
    21000,
    NOW()
  )
  RETURNING id INTO v_payment_id;

  -- Insert open staff handoff
  INSERT INTO staff_handoffs (
    client_id,
    phone,
    reason_code,
    summary,
    priority,
    status,
    assigned_staff,
    opened_at
  ) VALUES (
    v_client_id,
    '+34600000193',
    'booking_review',
    'Fixture handoff for stage7.7i proof',
    'normal',
    'open',
    NULL,
    NOW()
  );

  RAISE NOTICE 'Stage 7.7i fixture seeded: booking_id=%, bed=%, payment=%',
    v_booking_id, v_bed_code, v_payment_id;
END;
$$;
