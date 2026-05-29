-- Phase 3e.5b · T3 — teardown. Removes only WH-3E5-T3A / WH-3E5-T3B fixture rows.
BEGIN;
DELETE FROM conversations
 WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
   AND phone = '+353000035304';
DELETE FROM bookings
 WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
   AND booking_code IN ('WH-3E5-T3A', 'WH-3E5-T3B');
COMMIT;
