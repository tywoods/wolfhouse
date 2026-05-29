-- Phase 3.5c / I3 — Stripe duplicate-event idempotency fixture (DOWN)
-- Removes all rows seeded by phase35c-i3-up.sql plus any payment_events
-- created during the I3 runtime gate.

DELETE FROM payment_events
WHERE stripe_event_id = 'evt_test_idemp_i3_001';

DELETE FROM payments
WHERE id = 'a35c0000-0000-4000-8000-000000000001';

DELETE FROM bookings
WHERE id = 'b35c0000-0000-4000-8000-000000000001';

-- Verify teardown (counts must equal baselines after running down.sql):
-- SELECT COUNT(*) FROM bookings  WHERE booking_code = 'WH-35C-I3-TEST-1';     -- must be 0
-- SELECT COUNT(*) FROM payments  WHERE id = 'a35c0000-0000-4000-8000-000000000001'; -- must be 0
-- SELECT COUNT(*) FROM payment_events WHERE stripe_event_id = 'evt_test_idemp_i3_001'; -- must be 0
