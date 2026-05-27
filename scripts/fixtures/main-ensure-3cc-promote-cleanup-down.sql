-- Phase 3c.c.4 — Remove WH-3C-PROMOTE-* fixture bookings (no payments).

BEGIN;

DELETE FROM bookings b
USING clients c
WHERE b.client_id = c.id
  AND c.slug = 'wolfhouse-somo'
  AND b.booking_code LIKE 'WH-3C-PROMOTE-%'
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id);

COMMIT;
