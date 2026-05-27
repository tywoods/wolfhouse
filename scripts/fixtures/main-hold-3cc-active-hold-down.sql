-- Phase 3c.c.2 — Tear down active-hold guard fixture (this booking_code only).
-- Deletes only when no payments (and thus no payment_events) reference the booking.

BEGIN;

DELETE FROM bookings b
USING clients c
WHERE b.client_id = c.id
  AND c.slug = 'wolfhouse-somo'
  AND b.booking_code = 'WH-3C-ACTIVE-HOLD-GUARD-001'
  AND NOT EXISTS (
    SELECT 1 FROM payments p WHERE p.booking_id = b.id
  );

COMMIT;
