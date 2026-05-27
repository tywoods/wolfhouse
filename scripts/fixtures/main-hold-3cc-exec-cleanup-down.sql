-- Phase 3c.c.3 — Remove execute-test booking WH-3C-HOLD-EXEC-001 only (no payments).

BEGIN;

DELETE FROM bookings b
USING clients c
WHERE b.client_id = c.id
  AND c.slug = 'wolfhouse-somo'
  AND b.booking_code = 'WH-3C-HOLD-EXEC-001'
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id);

COMMIT;
