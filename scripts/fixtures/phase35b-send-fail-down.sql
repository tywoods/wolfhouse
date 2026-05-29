-- Stage 3.5b runtime gate teardown — reverses phase35b-send-fail-up.sql
-- Removes the disposable booking and any automation_errors / workflow_events
-- rows it produced. Touches no protected payment tables.
BEGIN;

DELETE FROM automation_errors
WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = 'WH-35B-TEST-1')
   OR payload->>'booking_code' = 'WH-35B-TEST-1';

DELETE FROM workflow_events
WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = 'WH-35B-TEST-1')
   OR payload->>'booking_code' = 'WH-35B-TEST-1';

DELETE FROM bookings WHERE booking_code = 'WH-35B-TEST-1';

COMMIT;
