-- Phase 3.5d / D2 — manual_staff overlap blocked (UP)
-- Proves that a manual_staff booking in booking_beds triggers the same overlap guard as
-- any other source — no booking_source bypass in the overlap query.
-- Bed used: R1-B2 (33bbcf01-63bc-48d5-8763-8565cd5bc411)
-- Client: wolfhouse-somo (a0000000-0000-4000-8000-000000000001)
--
-- Booking A (WH-35D-D2-MANUAL-A): manual_staff, occupies R1-B2 for 2027-04-20 to 2027-04-25
-- Booking B (WH-35D-D2-GUEST-B): whatsapp guest candidate, no beds, wants R1-B2 for 2027-04-22 to 2027-04-24
--
-- Do NOT insert payments, payment_events, or booking_beds for Booking B.
-- Run phase35d-d2-manual-staff-overlap-down.sql to reverse.

-- Booking A: manual_staff, confirmed, occupies R1-B2
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
  'b35d0000-0000-4000-8000-000000000003',
  'a0000000-0000-4000-8000-000000000001',
  'WH-35D-D2-MANUAL-A',
  'D2 Manual Staff Occupant',
  '+10000000353',
  'confirmed',
  'not_requested',
  '2027-04-20',
  '2027-04-25',
  1,
  'manual_staff',
  FALSE
);

-- Booking A bed row: R1-B2 from 2027-04-20 to 2027-04-25
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
  'c35d0000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000001',
  'b35d0000-0000-4000-8000-000000000003',
  '33bbcf01-63bc-48d5-8763-8565cd5bc411',
  'R1-B2',
  'R1',
  '2027-04-20',
  '2027-04-25',
  'Manual',
  'D2 manual_staff overlap guard fixture',
  'D2 Manual Staff Occupant'
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
  'b35d0000-0000-4000-8000-000000000004',
  'a0000000-0000-4000-8000-000000000001',
  'WH-35D-D2-GUEST-B',
  'D2 Overlap Test Guest',
  '+10000000354',
  'confirmed',
  'not_requested',
  '2027-04-22',
  '2027-04-24',
  1,
  'whatsapp',
  FALSE
);
-- No booking_beds, payments, or payment_events for Booking B.
