-- Phase 3.5d / D1 — Assign overlap blocked (UP)
-- Proves that PG_ASSIGN_SQL overlap guard blocks assignment when a bed is occupied.
-- Bed used: R1-B1 (b98698b0-4a0c-495f-ab2d-24f5fd1c5a9d)
-- Client: wolfhouse-somo (a0000000-0000-4000-8000-000000000001)
--
-- Booking A (WH-35D-D1-OCCUPIED-A): occupies R1-B1 for 2027-04-10 to 2027-04-15
-- Booking B (WH-35D-D1-GUEST-B): guest candidate, no beds yet, wants R1-B1 for 2027-04-12 to 2027-04-14
--
-- Do NOT insert payments, payment_events, or booking_beds for Booking B.
-- Run phase35d-d1-overlap-down.sql to reverse.

-- Booking A: confirmed, occupies R1-B1
INSERT INTO bookings (
  id,
  client_id,
  booking_code,
  guest_name,
  phone,
  status,
  payment_status,
  check_in,
  check_out,
  guest_count,
  booking_source,
  send_confirmation
) VALUES (
  'b35d0000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'WH-35D-D1-OCCUPIED-A',
  'D1 Overlap Test Occupant',
  '+10000000351',
  'confirmed',
  'not_requested',
  '2027-04-10',
  '2027-04-15',
  1,
  'whatsapp',
  FALSE
);

-- Booking A bed row: R1-B1 from 2027-04-10 to 2027-04-15
INSERT INTO booking_beds (
  id,
  client_id,
  booking_id,
  bed_id,
  bed_code,
  room_code,
  assignment_start_date,
  assignment_end_date,
  assignment_type,
  assignment_notes,
  guest_name
) VALUES (
  'c35d0000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'b35d0000-0000-4000-8000-000000000001',
  'b98698b0-4a0c-495f-ab2d-24f5fd1c5a9d',
  'R1-B1',
  'R1',
  '2027-04-10',
  '2027-04-15',
  'Manual',
  'D1 overlap guard fixture',
  'D1 Overlap Test Occupant'
);

-- Booking B: guest candidate, wants same bed, no booking_beds row
INSERT INTO bookings (
  id,
  client_id,
  booking_code,
  guest_name,
  phone,
  status,
  payment_status,
  check_in,
  check_out,
  guest_count,
  booking_source,
  send_confirmation
) VALUES (
  'b35d0000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000001',
  'WH-35D-D1-GUEST-B',
  'D1 Overlap Test Guest',
  '+10000000352',
  'confirmed',
  'not_requested',
  '2027-04-12',
  '2027-04-14',
  1,
  'whatsapp',
  FALSE
);
-- No booking_beds, payments, or payment_events for Booking B.
