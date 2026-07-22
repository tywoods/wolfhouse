-- 047_luna_sales_contact_candidates.sql
-- Luna Sales Chapter 9: manual contact candidates (enrichment without Apollo).
--
-- Adds luna_sales.contact_candidates so operators can manually record named
-- contacts (name, role, optional email/phone/LinkedIn, source, confidence)
-- tied to a prospect. Append-oriented inserts; newest-first listing. No Apollo
-- or other external enrichment calls, no auto-find, no CRM write, no outreach
-- send. Idempotent + transactional. Safe to re-run.
--
-- Least-privilege assumptions unchanged from 042–046:
--   * CROWSNEST_SALES_DATABASE_URL only (never WOLFHOUSE_DATABASE_URL).
--   * SELECT, INSERT on luna_sales.contact_candidates (append-oriented;
--     no UPDATE/DELETE required for this chapter).
--   * SELECT, INSERT only on luna_sales.audit_events (append-only).
--   * Application SQL must qualify luna_sales.* (do not rely on search_path).
-- Migration apply / Azure secret wiring remains out of scope.

BEGIN;

CREATE TABLE IF NOT EXISTS luna_sales.contact_candidates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id       UUID NOT NULL REFERENCES luna_sales.prospects(id) ON DELETE CASCADE,
  full_name         TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT '',
  email             TEXT NOT NULL DEFAULT '',
  phone             TEXT NOT NULL DEFAULT '',
  linkedin_url      TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL,
  confidence        TEXT NOT NULL,
  author_id         TEXT NOT NULL DEFAULT 'Admin',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contact_candidates_confidence_check CHECK (
    confidence IN ('low', 'medium', 'high')
  ),
  CONSTRAINT contact_candidates_full_name_nonempty CHECK (
    length(btrim(full_name)) > 0
  ),
  CONSTRAINT contact_candidates_source_nonempty CHECK (
    length(btrim(source)) > 0
  )
);

CREATE INDEX IF NOT EXISTS idx_luna_sales_contact_candidates_prospect_id
  ON luna_sales.contact_candidates (prospect_id);

CREATE INDEX IF NOT EXISTS idx_luna_sales_contact_candidates_created_at
  ON luna_sales.contact_candidates (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_sales_contact_candidates_prospect_created
  ON luna_sales.contact_candidates (prospect_id, created_at DESC);

COMMIT;
