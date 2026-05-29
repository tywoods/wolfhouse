-- Phase 3e.5b · T1 — teardown. Removes only WH-3E5-A / WH-3E5-B fixture rows.
BEGIN;
DELETE FROM conversations
 WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
   AND phone IN ('+353000035301', '+353000035302');
DELETE FROM bookings
 WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
   AND booking_code IN ('WH-3E5-A', 'WH-3E5-B');
COMMIT;
