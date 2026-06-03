-- Stage 8.8.8 — Teardown demo booking_service_records fixture
--
-- Deletes ONLY demo_fixture_stage888 rows for wolfhouse-somo.
-- Safe to re-run. Does NOT touch production or non-demo service rows.
-- NOT applied automatically.

BEGIN;

DELETE FROM booking_service_records
 WHERE client_slug = 'wolfhouse-somo'
   AND source = 'demo_fixture_stage888';

COMMIT;
