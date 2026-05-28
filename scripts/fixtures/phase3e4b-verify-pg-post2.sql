SELECT booking_code, id, status, payment_status, assignment_status, guest_gender_group_type, room_preference, rooming_notes, airtable_record_id
FROM bookings WHERE phone = '+353399990331';

SELECT COUNT(*) AS target_booking_beds
FROM booking_beds bb
JOIN bookings bk ON bk.id = bb.booking_id
WHERE bk.phone = '+353399990331';

SELECT bb.id, bb.bed_id, bd.bed_code, bk.booking_code, bk.check_in, bk.check_out
FROM booking_beds bb
JOIN beds bd ON bd.id = bb.bed_id
JOIN bookings bk ON bk.id = bb.booking_id
WHERE bk.phone = '+353399990331';

SELECT COUNT(*) AS booking_beds_global FROM booking_beds;
SELECT COUNT(*) AS payments FROM payments;
SELECT COUNT(*) AS payment_events FROM payment_events;

-- beds assigned to other bookings only (unchanged list)
SELECT bk.booking_code, COUNT(*) AS bed_rows
FROM booking_beds bb
JOIN bookings bk ON bk.id = bb.booking_id
GROUP BY bk.booking_code
ORDER BY bk.booking_code;
