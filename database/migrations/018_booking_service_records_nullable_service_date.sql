-- Phase 26h.5 — Allow unscheduled service records
--
-- service_date NULL means a paid/requested service is not yet scheduled to a stay date.
-- The Services tab groups null (and out-of-stay) rows under Unscheduled.

BEGIN;

ALTER TABLE booking_service_records
  ALTER COLUMN service_date DROP NOT NULL;

COMMENT ON COLUMN booking_service_records.service_date IS
  'Stay night for this service row. NULL = paid/requested but not scheduled to a stay date yet (Phase 26h.5).';

COMMIT;
