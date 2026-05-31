-- Stage 5.3f — Fixture confirmation-needed cleanup
-- Removes fixture booking and payments rows for phone 34600000156.
-- Scoped to wolfhouse-somo only. Safe to re-run.

BEGIN;

DELETE FROM payment_events
WHERE booking_id IN (
  SELECT b.id FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = 'wolfhouse-somo'
    AND b.phone IN ('34600000156', '+34600000156')
);

UPDATE conversations
SET current_hold_booking_id = NULL, updated_at = NOW()
WHERE phone IN ('34600000156', '+34600000156')
  AND current_hold_booking_id IN (
    SELECT b.id FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = 'wolfhouse-somo'
      AND b.phone IN ('34600000156', '+34600000156')
  );

DELETE FROM payments
WHERE booking_id IN (
  SELECT b.id FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = 'wolfhouse-somo'
    AND b.phone IN ('34600000156', '+34600000156')
);

DELETE FROM bookings
WHERE phone IN ('34600000156', '+34600000156')
  AND client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo');

DELETE FROM conversations
WHERE phone IN ('34600000156', '+34600000156')
  AND client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo');

COMMIT;

-- Post-cleanup verification (run after COMMIT, expect 0 for all)
-- SELECT COUNT(*) FROM bookings WHERE phone IN ('34600000156', '+34600000156');
-- SELECT COUNT(*) FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.phone IN ('34600000156', '+34600000156');
