-- Phase 3e.5b · T2 — teardown. Removes only WH-3E5-OLD / WH-3E5-NEW fixture rows.
BEGIN;
DELETE FROM conversations
 WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
   AND phone = '+353000035303';
DELETE FROM bookings
 WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
   AND booking_code IN ('WH-3E5-OLD', 'WH-3E5-NEW');
COMMIT;
