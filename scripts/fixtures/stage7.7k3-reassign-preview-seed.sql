-- Stage 7.7k3 fixture seed — bed reassignment preview proof
-- Creates booking WH-77K3-PREVIEW-001 with two booking_beds rows:
--   Case A (main): booking on bed A; target is free bed B → blocked=confirm_not_set
--   Case B (opt):  separate booking on bed B in same range → proves overlap block
-- Cleanup: scripts/fixtures/stage7.7k3-reassign-preview-cleanup.sql
--
-- Safety: only inserts into bookings, booking_beds.
-- Does NOT touch: payments, payment_events, staff_handoffs, conversations.

DO $$
DECLARE
  v_client_id   UUID;
  v_booking_id  UUID;
  v_booking_b_id UUID;
  v_bed_a_id    UUID;
  v_bed_b_id    UUID;
  v_room_a_code TEXT;
  v_room_b_code TEXT;
  v_bed_a_code  TEXT;
  v_bed_b_code  TEXT;
  v_room_a_id   UUID;
  v_room_b_id   UUID;
BEGIN
  -- Resolve client
  SELECT id INTO v_client_id
  FROM clients
  WHERE slug = 'wolfhouse-somo'
  LIMIT 1;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Client wolfhouse-somo not found — cannot seed fixture';
  END IF;

  -- Find bed A: first active, sellable bed
  SELECT b.id, b.bed_code, r.id, r.room_code
  INTO v_bed_a_id, v_bed_a_code, v_room_a_id, v_room_a_code
  FROM beds b
  INNER JOIN rooms r ON r.id = b.room_id
  WHERE b.client_id  = v_client_id
    AND b.active     = TRUE
    AND b.sellable   = TRUE
    AND r.active     = TRUE
  ORDER BY r.room_code, b.bed_code
  LIMIT 1;
  IF v_bed_a_id IS NULL THEN
    RAISE EXCEPTION 'No active/sellable bed A found for wolfhouse-somo — cannot seed fixture';
  END IF;

  -- Find bed B: second active, sellable bed different from bed A
  SELECT b.id, b.bed_code, r.id, r.room_code
  INTO v_bed_b_id, v_bed_b_code, v_room_b_id, v_room_b_code
  FROM beds b
  INNER JOIN rooms r ON r.id = b.room_id
  WHERE b.client_id  = v_client_id
    AND b.active     = TRUE
    AND b.sellable   = TRUE
    AND r.active     = TRUE
    AND b.id        != v_bed_a_id
  ORDER BY r.room_code, b.bed_code
  LIMIT 1;
  IF v_bed_b_id IS NULL THEN
    RAISE EXCEPTION 'No second active/sellable bed B found for wolfhouse-somo — need at least 2 beds';
  END IF;

  -- ── Case A: booking on bed A; target bed B is free ──────────────────────
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
    'WH-77K3-PREVIEW-001',
    'Fixture Preview Guest',
    '+34600000194',
    'fixture-preview@example.com',
    1,
    'SURF_7',
    '2026-09-10',
    '2026-09-17',
    'confirmed',
    'deposit_paid',
    'assigned',
    'shared_dorm',
    'no preference',
    v_room_a_code,
    false,
    84000,
    21000,
    21000,
    63000
  )
  RETURNING id INTO v_booking_id;

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
    v_bed_a_id,
    v_client_id,
    v_room_a_code,
    v_bed_a_code,
    '2026-09-10',
    '2026-09-17',
    'automatic',
    'Auto-assigned',
    'WH-77K3-PREVIEW-001'
  );

  -- ── Case B (optional): second booking already on bed B in overlapping range ─
  -- This lets the proof verify the overlap/conflict block if desired.
  -- Uses a non-overlapping range (Sept 12–19) — overlaps with Sept 10–17.
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
    'WH-77K3-BLOCKER-001',
    'Fixture Blocker Guest',
    '+34600000195',
    'fixture-blocker@example.com',
    1,
    'SURF_7',
    '2026-09-12',
    '2026-09-19',
    'confirmed',
    'deposit_paid',
    'assigned',
    'shared_dorm',
    'no preference',
    v_room_b_code,
    false,
    84000,
    21000,
    21000,
    63000
  )
  RETURNING id INTO v_booking_b_id;

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
    v_booking_b_id,
    v_bed_b_id,
    v_client_id,
    v_room_b_code,
    v_bed_b_code,
    '2026-09-12',
    '2026-09-19',
    'automatic',
    'Auto-assigned (blocker)',
    'WH-77K3-BLOCKER-001'
  );

  RAISE NOTICE 'Stage 7.7k3 fixture seeded OK';
  RAISE NOTICE '  booking_id_A=% bed_A=% (code WH-77K3-PREVIEW-001)', v_booking_id, v_bed_a_code;
  RAISE NOTICE '  booking_id_B=% bed_B=% (code WH-77K3-BLOCKER-001)', v_booking_b_id, v_bed_b_code;
  RAISE NOTICE '  target for preview: bed_B (%) -- should be FREE for main case (different range)', v_bed_b_code;
END;
$$;
