-- Phase 3b.5a — local Operator Room Release impact report fixture (UP)
-- Idempotent. Touches only booking_code WH-OPER-LOCAL-RELEASE-2027 and its booking_beds.
-- No payments, payment_events, or operator_room_release_requests rows.

BEGIN;

DO $$
DECLARE
  v_client_id UUID;
  v_room_id   UUID;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE slug = 'wolfhouse-somo';
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Fixture up failed: client slug wolfhouse-somo not found';
  END IF;

  SELECT id INTO v_room_id
  FROM rooms
  WHERE client_id = v_client_id AND upper(trim(room_code)) = 'R7';

  IF v_room_id IS NULL THEN
    RAISE EXCEPTION 'Fixture up failed: room R7 not found for wolfhouse-somo';
  END IF;
END $$;

INSERT INTO bookings (
  client_id,
  booking_code,
  guest_name,
  operator_name,
  booking_source,
  block_type,
  status,
  payment_status,
  assignment_status,
  availability_check_status,
  check_in,
  check_out,
  guest_count,
  primary_room_code,
  room_to_block_id,
  staff_notes,
  deposit_required_cents,
  deposit_paid_cents,
  balance_due_cents,
  total_amount_cents,
  amount_paid_cents
)
SELECT
  c.id,
  'WH-OPER-LOCAL-RELEASE-2027',
  'OPER-LOCAL-RELEASE-TEST',
  'OPER-LOCAL-RELEASE-TEST',
  'operator',
  'whole_room',
  'confirmed',
  'not_requested',
  'assigned',
  'unknown',
  DATE '2027-05-01',
  DATE '2027-05-31',
  1,
  'R7',
  r.id,
  '3b.5a operator room release fixture',
  0,
  0,
  0,
  0,
  0
FROM clients c
INNER JOIN rooms r ON r.client_id = c.id AND upper(trim(r.room_code)) = 'R7'
WHERE c.slug = 'wolfhouse-somo'
ON CONFLICT (client_id, booking_code) DO UPDATE SET
  guest_name = EXCLUDED.guest_name,
  operator_name = EXCLUDED.operator_name,
  booking_source = EXCLUDED.booking_source,
  block_type = EXCLUDED.block_type,
  status = EXCLUDED.status,
  payment_status = EXCLUDED.payment_status,
  assignment_status = EXCLUDED.assignment_status,
  availability_check_status = EXCLUDED.availability_check_status,
  check_in = EXCLUDED.check_in,
  check_out = EXCLUDED.check_out,
  guest_count = EXCLUDED.guest_count,
  primary_room_code = EXCLUDED.primary_room_code,
  room_to_block_id = EXCLUDED.room_to_block_id,
  staff_notes = EXCLUDED.staff_notes,
  deposit_required_cents = EXCLUDED.deposit_required_cents,
  deposit_paid_cents = EXCLUDED.deposit_paid_cents,
  balance_due_cents = EXCLUDED.balance_due_cents,
  total_amount_cents = EXCLUDED.total_amount_cents,
  amount_paid_cents = EXCLUDED.amount_paid_cents,
  updated_at = NOW();

INSERT INTO booking_beds (
  client_id,
  booking_id,
  bed_id,
  assignment_type,
  assignment_notes,
  assignment_start_date,
  assignment_end_date,
  guest_name,
  room_code,
  bed_code
)
SELECT
  b.client_id,
  b.id,
  bed.id,
  'manual_staff',
  '3b.5a fixture',
  b.check_in,
  b.check_out,
  b.guest_name,
  r.room_code,
  bed.bed_code
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id AND c.slug = 'wolfhouse-somo'
INNER JOIN beds bed ON bed.client_id = b.client_id AND bed.sellable = TRUE
INNER JOIN rooms r ON r.id = bed.room_id AND upper(trim(r.room_code)) = 'R7'
WHERE b.booking_code = 'WH-OPER-LOCAL-RELEASE-2027'
  AND upper(trim(bed.bed_code)) IN ('R7-B1', 'R7-B2', 'R7-B3', 'R7-B4')
  AND NOT EXISTS (
    SELECT 1
    FROM booking_beds bb
    WHERE bb.booking_id = b.id AND bb.bed_id = bed.id
  );

DO $$
DECLARE
  v_beds INT;
  v_payments INT;
BEGIN
  SELECT COUNT(*)::int INTO v_beds
  FROM booking_beds bb
  INNER JOIN bookings b ON b.id = bb.booking_id
  INNER JOIN clients c ON c.id = b.client_id AND c.slug = 'wolfhouse-somo'
  WHERE b.booking_code = 'WH-OPER-LOCAL-RELEASE-2027';

  SELECT COUNT(*)::int INTO v_payments
  FROM payments p
  INNER JOIN bookings b ON b.id = p.booking_id
  INNER JOIN clients c ON c.id = b.client_id AND c.slug = 'wolfhouse-somo'
  WHERE b.booking_code = 'WH-OPER-LOCAL-RELEASE-2027';

  IF v_beds < 4 THEN
    RAISE EXCEPTION 'Fixture up failed: expected 4 booking_beds, found %', v_beds;
  END IF;

  IF v_payments > 0 THEN
    RAISE EXCEPTION 'Fixture up failed: unexpected payments rows on fixture booking';
  END IF;

  RAISE NOTICE 'operator-room-release-3b5a-up: booking WH-OPER-LOCAL-RELEASE-2027, % booking_beds, 0 payments', v_beds;
END $$;

COMMIT;
