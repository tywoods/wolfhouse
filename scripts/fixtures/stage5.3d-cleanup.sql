-- Stage 5.3d — Fixture payment cleanup
-- Removes all fixture booking, payments, payment_events, and conversation rows
-- created by the Stage 5.3d runtime gate.
-- Scoped to wolfhouse-somo + fixture phone 34600000153 only.
-- Safe to re-run: all deletes are conditional on scope.

BEGIN;

-- 1. Delete fixture payment_events (if any were written by webhook replay)
DELETE FROM payment_events
WHERE booking_id IN (
  SELECT b.id FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = 'wolfhouse-somo'
    AND b.phone IN ('34600000153', '+34600000153')
);

-- 2. Unlink conversations from fixture booking
UPDATE conversations
SET current_hold_booking_id = NULL, updated_at = NOW()
WHERE phone IN ('34600000153', '+34600000153')
  AND current_hold_booking_id IN (
    SELECT b.id FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = 'wolfhouse-somo'
      AND b.phone IN ('34600000153', '+34600000153')
  );

-- 3. Delete fixture payments rows
DELETE FROM payments
WHERE booking_id IN (
  SELECT b.id FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = 'wolfhouse-somo'
    AND b.phone IN ('34600000153', '+34600000153')
);

-- 4. Delete fixture booking rows
DELETE FROM bookings
WHERE phone IN ('34600000153', '+34600000153')
  AND client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo');

-- 5. Delete fixture conversation rows
DELETE FROM conversations
WHERE phone IN ('34600000153', '+34600000153')
  AND client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo');

COMMIT;

-- Post-cleanup verification (run after COMMIT, expect 0 for all)
-- SELECT COUNT(*) AS fixture_bookings   FROM bookings   WHERE phone IN ('34600000153', '+34600000153');
-- SELECT COUNT(*) AS fixture_payments   FROM payments   WHERE booking_id NOT IN (SELECT id FROM bookings WHERE phone IN ('34600000153','+34600000153'));
-- SELECT COUNT(*) AS fixture_convs      FROM conversations WHERE phone IN ('34600000153', '+34600000153');
