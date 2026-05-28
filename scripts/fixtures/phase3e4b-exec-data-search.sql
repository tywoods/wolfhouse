SELECT substring(data::text from 1 for 800) AS sample
FROM execution_data
WHERE "executionId" = 1080;

SELECT
  (data::text LIKE '%assign_triggered%') AS has_assign_triggered,
  (data::text LIKE '%pg_inserted_count%') AS has_pg_inserted,
  (data::text LIKE '%ok\":true%') AS has_ok_true,
  (data::text LIKE '%partial_failure%') AS has_partial,
  (data::text LIKE '%HTTP Request%') AS has_http,
  (data::text LIKE '%error%') AS has_error
FROM execution_data
WHERE "executionId" = 1080;

SELECT
  (data::text LIKE '%rooming_details_provided%') AS has_rooming_route,
  (data::text LIKE '%resolved_route%') AS has_resolved_route,
  (data::text LIKE '%booking_flow%') AS has_booking_flow,
  (data::text LIKE '%WH-260528-8239%') AS has_target_booking_code,
  (data::text LIKE '%recZvoLjvDYXiMzQP%') AS has_target_at_id
FROM execution_data
WHERE "executionId" = 1079;

SELECT
  (data::text LIKE '%rooming_details_provided%') AS has_rooming_route,
  (data::text LIKE '%resolved_route%') AS has_resolved_route
FROM execution_data
WHERE "executionId" = 1078;
