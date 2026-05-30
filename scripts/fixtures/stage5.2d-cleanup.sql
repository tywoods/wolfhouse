-- Stage 5.2d — Fixture hold gate cleanup
-- Removes fixture booking and conversation rows written by the Stage 5.2d runtime gate.
-- Scoped to wolfhouse-somo + fixture phones only (booking code may be WH- or DRY-52- prefix).
-- Safe to re-run: all deletes are conditional on scope.

BEGIN;

-- 1. Unlink conversations from any fixture booking (either DRY-52- or WH- generated code)
UPDATE conversations
SET current_hold_booking_id = NULL, updated_at = NOW()
WHERE phone IN ('34600000152', '+34600000152')
  AND current_hold_booking_id IN (
    SELECT b.id FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = 'wolfhouse-somo'
      AND b.phone IN ('34600000152', '+34600000152')
  );

-- 2. Delete fixture booking rows (fixture phone scoped to wolfhouse-somo)
DELETE FROM bookings
WHERE phone IN ('34600000152', '+34600000152')
  AND client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo');

-- 3. Delete fixture conversation rows
DELETE FROM conversations
WHERE phone IN ('34600000152', '+34600000152')
  AND client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo');

COMMIT;

-- Post-cleanup verification (run after COMMIT, expect 0 for both)
-- SELECT COUNT(*) AS fixture_bookings FROM bookings WHERE phone IN ('34600000152', '+34600000152');
-- SELECT COUNT(*) AS fixture_conversations FROM conversations WHERE phone IN ('34600000152', '+34600000152');
