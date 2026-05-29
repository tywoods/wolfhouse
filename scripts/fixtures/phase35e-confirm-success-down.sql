-- Stage 3.5e runtime gate teardown — reverses phase35e-confirm-success-up.sql
-- Removes the disposable booking and any workflow_events / automation_errors
-- rows it produced. Touches no protected payment tables.
BEGIN;

DELETE FROM workflow_events
WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = 'WH-35E-TEST-1')
   OR payload->>'booking_code' = 'WH-35E-TEST-1';

DELETE FROM automation_errors
WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = 'WH-35E-TEST-1')
   OR payload->>'booking_code' = 'WH-35E-TEST-1';

DELETE FROM bookings WHERE booking_code = 'WH-35E-TEST-1';

COMMIT;
