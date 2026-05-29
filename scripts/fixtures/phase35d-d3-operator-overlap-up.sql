-- Phase 3.5d / D3 — operator overlap blocked (UP)
-- Proves that an operator booking in booking_beds triggers the same overlap guard as
-- any other source — no booking_source bypass in the overlap query.
-- Bed used: R1-B3 (1fdc0459-4e61-4c29-a4ee-81a5ea8acccd)
-- Client: wolfhouse-somo (a0000000-0000-4000-8000-000000000001)
--
-- Booking A (WH-35D-D3-OPERATOR-A): operator, occupies R1-B3 for 2027-05-01 to 2027-05-06
-- Booking B (WH-35D-D3-GUEST-B): whatsapp guest candidate, no beds, wants R1-B3 for 2027-05-03 to 2027-05-05
--
-- Do NOT insert payments, payment_events, or booking_beds for Booking B.
-- Run phase35d-d3-operator-overlap-down.sql to reverse.

-- Booking A: operator, confirmed, occupies R1-B3
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
  'b35d0000-0000-4000-8000-000000000005',
  'a0000000-0000-4000-8000-000000000001',
  'WH-35D-D3-OPERATOR-A',
  'D3 Operator Occupant',
  '+10000000355',
  'confirmed',
  'not_requested',
  '2027-05-01',
  '2027-05-06',
  1,
  'operator',
  FALSE
);

-- Booking A bed row: R1-B3 from 2027-05-01 to 2027-05-06
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
  'c35d0000-0000-4000-8000-000000000003',
  'a0000000-0000-4000-8000-000000000001',
  'b35d0000-0000-4000-8000-000000000005',
  '1fdc0459-4e61-4c29-a4ee-81a5ea8acccd',
  'R1-B3',
  'R1',
  '2027-05-01',
  '2027-05-06',
  'Manual',
  'D3 operator overlap guard fixture',
  'D3 Operator Occupant'
);

-- Booking B: whatsapp guest candidate, no booking_beds row
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
  'b35d0000-0000-4000-8000-000000000006',
  'a0000000-0000-4000-8000-000000000001',
  'WH-35D-D3-GUEST-B',
  'D3 Overlap Test Guest',
  '+10000000356',
  'confirmed',
  'not_requested',
  '2027-05-03',
  '2027-05-05',
  1,
  'whatsapp',
  FALSE
);
-- No booking_beds, payments, or payment_events for Booking B.
