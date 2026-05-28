-- Overlap check for target booking beds (uses booking dates)
WITH target AS (
  SELECT bk.id AS booking_id, bk.check_in, bk.check_out
  FROM bookings bk
  WHERE bk.phone = '+353399990331'
)
SELECT COUNT(*) AS overlap_conflicts
FROM booking_beds bb
JOIN target t ON bb.booking_id = t.booking_id
JOIN booking_beds ob ON ob.bed_id = bb.bed_id AND ob.booking_id <> bb.booking_id
JOIN bookings obk ON obk.id = ob.booking_id
WHERE obk.status NOT IN ('cancelled')
  AND t.check_in < obk.check_out
  AND t.check_out > obk.check_in;
