-- 037_sunset_group_waivers.sql
-- Sunset group waiver links: one request, many student submissions.
-- Extends 036 (already applied on sunset_staging). Idempotent + transactional.
--
-- Single mode: app logic enforces one submission per request.
-- Group mode: multiple submissions share one request_id until target_count met.

BEGIN;

ALTER TABLE waiver_form_requests
  ADD COLUMN IF NOT EXISTS request_mode TEXT NOT NULL DEFAULT 'single';

ALTER TABLE waiver_form_requests
  ADD COLUMN IF NOT EXISTS target_count INTEGER NULL;

ALTER TABLE waiver_form_requests
  DROP CONSTRAINT IF EXISTS waiver_form_requests_request_mode_check;

ALTER TABLE waiver_form_requests
  ADD CONSTRAINT waiver_form_requests_request_mode_check
  CHECK (request_mode IN ('single', 'group'));

ALTER TABLE waiver_form_requests
  DROP CONSTRAINT IF EXISTS waiver_form_requests_target_count_check;

ALTER TABLE waiver_form_requests
  ADD CONSTRAINT waiver_form_requests_target_count_check
  CHECK (target_count IS NULL OR target_count > 0);

CREATE INDEX IF NOT EXISTS idx_waiver_form_requests_tenant_request_mode
  ON waiver_form_requests (tenant_id, request_mode);

CREATE INDEX IF NOT EXISTS idx_waiver_form_requests_tenant_booking_mode
  ON waiver_form_requests (tenant_id, booking_id, request_mode);

CREATE INDEX IF NOT EXISTS idx_waiver_form_submissions_tenant_request_submitted
  ON waiver_form_submissions (tenant_id, request_id, submitted_at);

-- 036 enforced one submission per request; group mode needs many rows per request_id.
ALTER TABLE waiver_form_submissions
  DROP CONSTRAINT IF EXISTS waiver_form_submissions_request_id_unique;

COMMENT ON COLUMN waiver_form_requests.request_mode IS
  'single = one student submission; group = shared link accepts multiple submissions.';
COMMENT ON COLUMN waiver_form_requests.target_count IS
  'Expected student count for group mode; snapshot at link creation (may sync while 0 submissions).';

COMMIT;
