-- 049_luna_sales_approved_crm_sync_attempts.sql
-- Luna Sales: durable approved CRM sync attempt records (HubSpot Company/Contact).
--
-- Adds luna_sales.approved_crm_sync_attempts so an explicit operator-approved
-- CRM sync can persist attempt identity, idempotency, status category, and
-- confirmed provider object IDs only. No Deal rows, no background sync, no
-- outreach. Idempotent + transactional. Safe to re-run.
--
-- Data model stores ONLY:
--   * internal attempt id
--   * prospect id + CRM-review mark id
--   * provider ('hubspot')
--   * idempotency key (UNIQUE)
--   * status category (pending / succeeded / failed)
--   * provider Company ID if confirmed
--   * provider Contact IDs if confirmed
--   * actor + timestamps
--   * sanitized error category
-- Never stores Service Key, token, raw HubSpot payload, request headers, full
-- provider response, email, phone, prompt, or arbitrary JSON blob.
--
-- Least-privilege assumptions unchanged from 042–047:
--   * CROWSNEST_SALES_DATABASE_URL only (never WOLFHOUSE_DATABASE_URL).
--   * SELECT, INSERT, UPDATE on luna_sales.approved_crm_sync_attempts
--     (outcome finalization updates status / confirmed provider IDs).
--   * SELECT, INSERT only on luna_sales.audit_events (append-only; callers may
--     append separately — this migration does not invoke attempts).
--   * Application SQL must qualify luna_sales.* (do not rely on search_path).
-- Migration apply / Azure secret wiring remains out of scope.

BEGIN;

CREATE TABLE IF NOT EXISTS luna_sales.approved_crm_sync_attempts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id             UUID NOT NULL REFERENCES luna_sales.prospects(id) ON DELETE CASCADE,
  crm_review_mark_id      UUID NOT NULL REFERENCES luna_sales.crm_review_marks(id) ON DELETE RESTRICT,
  provider                TEXT NOT NULL,
  idempotency_key         TEXT NOT NULL,
  status                  TEXT NOT NULL,
  provider_company_id     TEXT NOT NULL DEFAULT '',
  provider_contact_ids    TEXT[] NOT NULL DEFAULT '{}',
  actor_id                TEXT NOT NULL DEFAULT 'Admin',
  error_category          TEXT NOT NULL DEFAULT '',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT approved_crm_sync_attempts_provider_check CHECK (
    provider = 'hubspot'
  ),
  CONSTRAINT approved_crm_sync_attempts_status_check CHECK (
    status IN ('pending', 'succeeded', 'failed')
  ),
  CONSTRAINT approved_crm_sync_attempts_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT approved_crm_sync_attempts_idempotency_key_nonempty CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT approved_crm_sync_attempts_actor_nonempty CHECK (
    length(btrim(actor_id)) > 0
  )
);

CREATE INDEX IF NOT EXISTS idx_luna_sales_approved_crm_sync_attempts_prospect_id
  ON luna_sales.approved_crm_sync_attempts (prospect_id);

CREATE INDEX IF NOT EXISTS idx_luna_sales_approved_crm_sync_attempts_mark_id
  ON luna_sales.approved_crm_sync_attempts (crm_review_mark_id);

CREATE INDEX IF NOT EXISTS idx_luna_sales_approved_crm_sync_attempts_created_at
  ON luna_sales.approved_crm_sync_attempts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_sales_approved_crm_sync_attempts_prospect_created
  ON luna_sales.approved_crm_sync_attempts (prospect_id, created_at DESC);

COMMIT;
