-- Phase 3e.4a read-only preflight (wolfhouse PG)
SELECT COUNT(*) AS payments FROM payments;
SELECT COUNT(*) AS payment_events FROM payment_events;
SELECT COUNT(*) AS booking_beds FROM booking_beds;
SELECT COUNT(*) AS active_rooms FROM rooms WHERE active = true;
SELECT COUNT(*) AS sellable_beds FROM beds WHERE sellable = true;

SELECT booking_code, status, payment_status, phone, check_in, check_out, guest_count
FROM bookings
WHERE phone = '+353399990331'
ORDER BY created_at DESC;

SELECT b.booking_code, COUNT(bb.id) AS bed_rows
FROM bookings b
LEFT JOIN booking_beds bb ON bb.booking_id = b.id
WHERE b.phone IN ('+353399990329', '+353399990330', '+353399990331')
GROUP BY b.booking_code
ORDER BY b.booking_code;
