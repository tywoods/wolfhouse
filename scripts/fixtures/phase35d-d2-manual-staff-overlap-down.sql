-- Phase 3.5d / D2 — manual_staff overlap blocked (DOWN)
-- Removes all rows seeded by phase35d-d2-manual-staff-overlap-up.sql.
-- Teardown order: booking_beds first, then bookings (FK safety).

DELETE FROM booking_beds
WHERE id = 'c35d0000-0000-4000-8000-000000000002';

DELETE FROM bookings
WHERE id IN (
  'b35d0000-0000-4000-8000-000000000003',
  'b35d0000-0000-4000-8000-000000000004'
);

-- Verify teardown:
-- SELECT COUNT(*) FROM bookings  WHERE booking_code LIKE 'WH-35D-D2-%'; -- must be 0
-- SELECT COUNT(*) FROM booking_beds WHERE id = 'c35d0000-0000-4000-8000-000000000002'; -- must be 0
