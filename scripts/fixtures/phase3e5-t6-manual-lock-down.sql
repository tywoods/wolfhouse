-- Phase 3e.5b · T6 — teardown. Removes only WH-3E5-MAN-OP / WH-3E5-MAN-ST / WH-3E5-GUEST rows.
BEGIN;
DELETE FROM booking_beds
 WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
   AND booking_id IN ('b3e50000-0000-4000-8000-0000000000f1',
                      'b3e50000-0000-4000-8000-0000000000f3');
DELETE FROM bookings
 WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
   AND booking_code IN ('WH-3E5-MAN-OP', 'WH-3E5-MAN-ST', 'WH-3E5-GUEST');
COMMIT;
