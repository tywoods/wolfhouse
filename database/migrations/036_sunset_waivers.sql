-- 036_sunset_waivers.sql
-- Sunset native waiver form requests + submissions (staging implementation).
-- Public URL token is waiv_<random>; DB lookup uses token_hash (sha256).
-- Tenant-scoped via tenant_id (default 'sunset'). Compatible with one waiver
-- per booking contact for v1; participant_key reserved for future per-student.
--
-- Idempotent + transactional (matches repo convention). Safe to re-run.
-- Legal copy remains BLOCKED_FOR_LEGAL_COPY_CONFIRMATION in
-- config/clients/sunset.waiver-form.json until Sunset confirms wording.

BEGIN;

CREATE TABLE IF NOT EXISTS waiver_form_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL DEFAULT 'sunset',
  customer_id     UUID NULL REFERENCES customers(id) ON DELETE SET NULL,
  booking_id      UUID NULL REFERENCES bookings(id) ON DELETE SET NULL,
  participant_key TEXT NULL,
  public_id       TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'completed', 'expired', 'revoked', 'needs_review')),
  form_type       TEXT NOT NULL DEFAULT 'sunset_lesson_waiver',
  form_version    TEXT NOT NULL,
  sent_to_phone   TEXT NULL,
  sent_to_email   TEXT NULL,
  prefill_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at         TIMESTAMPTZ NULL,
  completed_at    TIMESTAMPTZ NULL,
  expires_at      TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT waiver_form_requests_public_id_unique UNIQUE (public_id),
  CONSTRAINT waiver_form_requests_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_waiver_form_requests_tenant_booking
  ON waiver_form_requests (tenant_id, booking_id);

CREATE INDEX IF NOT EXISTS idx_waiver_form_requests_tenant_customer
  ON waiver_form_requests (tenant_id, customer_id);

CREATE INDEX IF NOT EXISTS idx_waiver_form_requests_tenant_status
  ON waiver_form_requests (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_waiver_form_requests_public_id
  ON waiver_form_requests (public_id);

CREATE INDEX IF NOT EXISTS idx_waiver_form_requests_token_hash
  ON waiver_form_requests (token_hash);

DROP TRIGGER IF EXISTS waiver_form_requests_updated_at ON waiver_form_requests;
CREATE TRIGGER waiver_form_requests_updated_at
  BEFORE UPDATE ON waiver_form_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE waiver_form_requests IS
  'Sunset waiver link requests. Public URL uses public_id (waiv_*); lookup prefers token_hash.';
COMMENT ON COLUMN waiver_form_requests.participant_key IS
  'Optional future per-student key; null for v1 one-waiver-per-booking-contact.';
COMMENT ON COLUMN waiver_form_requests.token_hash IS
  'sha256 hex of public_id; used for public token lookup without relying on booking ids.';

CREATE TABLE IF NOT EXISTS waiver_form_submissions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT NOT NULL DEFAULT 'sunset',
  request_id         UUID NOT NULL REFERENCES waiver_form_requests(id) ON DELETE CASCADE,
  customer_id        UUID NULL REFERENCES customers(id) ON DELETE SET NULL,
  booking_id         UUID NULL REFERENCES bookings(id) ON DELETE SET NULL,
  participant_key    TEXT NULL,
  form_type          TEXT NOT NULL,
  form_version       TEXT NOT NULL,
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address         TEXT NULL,
  user_agent         TEXT NULL,
  language           TEXT NULL,
  respondent_name    TEXT NULL,
  respondent_email   TEXT NULL,
  respondent_phone   TEXT NULL,
  raw_answers_json   JSONB NOT NULL,
  form_snapshot_json JSONB NOT NULL,
  accepted_terms_hash TEXT NULL,
  pdf_url            TEXT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT waiver_form_submissions_request_id_unique UNIQUE (request_id)
);

CREATE INDEX IF NOT EXISTS idx_waiver_form_submissions_tenant_request
  ON waiver_form_submissions (tenant_id, request_id);

CREATE INDEX IF NOT EXISTS idx_waiver_form_submissions_tenant_booking
  ON waiver_form_submissions (tenant_id, booking_id);

CREATE INDEX IF NOT EXISTS idx_waiver_form_submissions_tenant_customer
  ON waiver_form_submissions (tenant_id, customer_id);

CREATE INDEX IF NOT EXISTS idx_waiver_form_submissions_tenant_submitted
  ON waiver_form_submissions (tenant_id, submitted_at);

COMMENT ON TABLE waiver_form_submissions IS
  'Sunset waiver form submissions. One submission per request_id for v1.';

COMMIT;
