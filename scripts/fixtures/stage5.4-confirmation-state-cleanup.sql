-- Stage 5.4 — Confirmation state fixture cleanup
-- Removes both Stage 5.4 fixture bookings and their payments rows.
-- Scoped to wolfhouse-somo + booking codes WH-54-NEEDS-001 / WH-54-CONFIRMED-001.
-- Safe to re-run.

BEGIN;

DELETE FROM payments
WHERE stripe_checkout_session_id IN (
  'cs_test_stage54_needs_001',
  'cs_test_stage54_confirmed_001'
);

DELETE FROM bookings
WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
  AND booking_code IN ('WH-54-NEEDS-001', 'WH-54-CONFIRMED-001');

COMMIT;
