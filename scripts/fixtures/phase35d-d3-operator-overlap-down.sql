-- Phase 3.5d / D3 — operator overlap blocked (DOWN)
-- Removes all rows seeded by phase35d-d3-operator-overlap-up.sql.
-- Teardown order: booking_beds first, then bookings (FK safety).

DELETE FROM booking_beds
WHERE id = 'c35d0000-0000-4000-8000-000000000003';

DELETE FROM bookings
WHERE id IN (
  'b35d0000-0000-4000-8000-000000000005',
  'b35d0000-0000-4000-8000-000000000006'
);

-- Verify teardown:
-- SELECT COUNT(*) FROM bookings  WHERE booking_code LIKE 'WH-35D-D3-%'; -- must be 0
-- SELECT COUNT(*) FROM booking_beds WHERE id = 'c35d0000-0000-4000-8000-000000000003'; -- must be 0
