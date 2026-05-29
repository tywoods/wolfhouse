-- Phase 3.5d / D1 — Assign overlap blocked (DOWN)
-- Removes all rows seeded by phase35d-d1-overlap-up.sql.
-- Teardown order: booking_beds first, then bookings (FK safety).

DELETE FROM booking_beds
WHERE id = 'c35d0000-0000-4000-8000-000000000001';

DELETE FROM bookings
WHERE id IN (
  'b35d0000-0000-4000-8000-000000000001',
  'b35d0000-0000-4000-8000-000000000002'
);

-- Verify teardown (counts must equal pre-seed baselines after running down.sql):
-- SELECT COUNT(*) FROM bookings  WHERE booking_code LIKE 'WH-35D-D1-%'; -- must be 0
-- SELECT COUNT(*) FROM booking_beds WHERE id = 'c35d0000-0000-4000-8000-000000000001'; -- must be 0
