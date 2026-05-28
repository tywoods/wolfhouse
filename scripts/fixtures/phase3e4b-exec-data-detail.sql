SELECT
  (data::text LIKE '%parse_ok\":false%') AS parse_ok_false,
  (data::text LIKE '%parse_ok\":true%') AS parse_ok_true,
  (data::text LIKE '%partial_failure%') AS has_partial,
  (data::text LIKE '%\"ok\":false%') AS ok_false,
  (data::text LIKE '%missing_record_id%') AS missing_record,
  (data::text LIKE '%Get Booking To Reassign%') AS reached_get_booking,
  (data::text LIKE '%HTTP Request - Trigger Local Assign%') AS reached_assign_http,
  (data::text LIKE '%Postgres - Delete Reassign%') AS reached_pg_delete
FROM execution_data
WHERE "executionId" = 1080;

SELECT
  (data::text LIKE '%Call Reassign Booking Beds%') AS called_reassign,
  (data::text LIKE '%rooming_details_provided%') AS rooming_route,
  (data::text LIKE '%Needs Bed Reassignment%') AS needs_reassign,
  (data::text LIKE '%recZvoLjvDYXiMzQP%') AS target_at_rec
FROM execution_data
WHERE "executionId" = 1079;
