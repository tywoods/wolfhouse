-- Phase 3e.5b · T5 — teardown. Removes only WH-3E5-T5A / WH-3E5-T5B beds + bookings.
BEGIN;
DELETE FROM booking_beds
 WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
   AND booking_id IN ('b3e50000-0000-4000-8000-0000000000e1',
                      'b3e50000-0000-4000-8000-0000000000e2');
DELETE FROM bookings
 WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
   AND booking_code IN ('WH-3E5-T5A', 'WH-3E5-T5B');
COMMIT;
