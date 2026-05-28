SELECT id, status, "workflowId"
FROM execution_entity
WHERE id >= 1078
ORDER BY id;

SELECT id, status, "workflowId"
FROM execution_entity
WHERE "workflowId" = 'B3c2AssignLocalPg01'
ORDER BY id DESC
LIMIT 5;

-- Target booking state
SELECT booking_code, id, status, payment_status, assignment_status, guest_gender_group_type, room_preference, rooming_notes
FROM bookings WHERE phone = '+353399990331';

SELECT bb.id, bb.bed_id, b.bed_code, bb.check_in, bb.check_out, bk.booking_code
FROM booking_beds bb
JOIN beds b ON b.id = bb.bed_id
JOIN bookings bk ON bk.id = bb.booking_id
WHERE bk.phone = '+353399990331';

SELECT COUNT(*) AS booking_beds_global FROM booking_beds;
SELECT COUNT(*) AS payments FROM payments;
SELECT COUNT(*) AS payment_events FROM payment_events;

-- Unrelated booking_beds delta: compare to baseline 13
SELECT bk.booking_code, COUNT(*) AS bed_rows
FROM booking_beds bb
JOIN bookings bk ON bk.id = bb.booking_id
GROUP BY bk.booking_code
HAVING COUNT(*) > 0
ORDER BY bk.booking_code;

-- Overlap check for newly assigned beds
WITH target_beds AS (
  SELECT bb.bed_id, bb.check_in, bb.check_out, bb.booking_id
  FROM booking_beds bb
  JOIN bookings bk ON bk.id = bb.booking_id
  WHERE bk.phone = '+353399990331'
)
SELECT tb.bed_id, b.bed_code, tb.check_in, tb.check_out, ob.booking_id AS other_booking_id, obk.booking_code AS other_booking_code
FROM target_beds tb
JOIN beds b ON b.id = tb.bed_id
JOIN booking_beds ob ON ob.bed_id = tb.bed_id AND ob.booking_id <> tb.booking_id
JOIN bookings obk ON obk.id = ob.booking_id
WHERE ob.status IS DISTINCT FROM 'cancelled'
  AND tb.check_in < ob.check_out
  AND tb.check_out > ob.check_in;

-- Side effect workflows during test window (id > 1077)
SELECT id, status, "workflowId"
FROM execution_entity
WHERE id > 1077
  AND "workflowId" IN ('KZUQvwR6SPWpvaZ5','gxivKRJexzTCw9x6','esuDIT96iPT63OaQ','whCreatePaymentStubLocal01','KchhRC9b3MIdkzPT')
ORDER BY id;
