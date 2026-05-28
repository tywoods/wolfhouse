-- POST #1 verification for +353399990331
SELECT booking_code, id, status, payment_status, phone, check_in, check_out, guest_count, airtable_record_id, assignment_status
FROM bookings WHERE phone = '+353399990331' OR phone = '353399990331' ORDER BY created_at DESC;

SELECT COUNT(*) AS booking_count FROM bookings WHERE phone IN ('+353399990331', '353399990331');

SELECT c.id, c.phone, c.current_hold_booking_id, b.booking_code
FROM conversations c
LEFT JOIN bookings b ON b.id = c.current_hold_booking_id
WHERE c.phone IN ('+353399990331', '353399990331');

SELECT COUNT(*) AS target_booking_beds FROM booking_beds bb
JOIN bookings b ON b.id = bb.booking_id
WHERE b.phone IN ('+353399990331', '353399990331');

SELECT COUNT(*) AS payments FROM payments;
SELECT COUNT(*) AS payment_events FROM payment_events;
SELECT COUNT(*) AS booking_beds_global FROM booking_beds;

SELECT id, status, "workflowId" FROM execution_entity WHERE id > 1064 ORDER BY id;
