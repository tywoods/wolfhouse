-- 042_luna_sales_schema.sql
-- Luna Sales Chapter 1 / Slice 1: durable prospect foundation in a dedicated schema.
--
-- Creates luna_sales.prospects, luna_sales.research_jobs, and luna_sales.audit_events.
-- Idempotent + transactional (matches repo convention). Safe to re-run.
--
-- Least-privilege / schema-scoped SQL assumptions (documented; role provisioning is
-- out of band for this slice — do not apply credentials here):
--   * Application runtime uses CROWSNEST_SALES_DATABASE_URL only (never
--     WOLFHOUSE_DATABASE_URL / DATABASE_URL).
--   * Dedicated DB role should have: USAGE on schema luna_sales;
--     SELECT, INSERT, UPDATE on luna_sales.prospects;
--     SELECT, INSERT, UPDATE on luna_sales.research_jobs;
--     SELECT, INSERT only on luna_sales.audit_events (append-only — no UPDATE/DELETE);
--     no CREATE/DROP, no access to public Wolfhouse booking tables required.
--   * All application SQL must qualify luna_sales.* (do not rely on search_path).
--   * Migration apply / Azure secret wiring is intentionally out of scope here.

BEGIN;

CREATE SCHEMA IF NOT EXISTS luna_sales;

CREATE TABLE IF NOT EXISTS luna_sales.prospects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name    TEXT NOT NULL DEFAULT '',
  website_url       TEXT NOT NULL DEFAULT '',
  lifecycle_status  TEXT NOT NULL DEFAULT 'ready_for_review',
  owner_id          TEXT NOT NULL DEFAULT 'Admin',
  last_decision     JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prospects_lifecycle_status_check CHECK (
    lifecycle_status IN (
      'ready_for_review',
      'approved',
      'rejected',
      'needs_research'
    )
  ),
  CONSTRAINT prospects_identity_present_check CHECK (
    length(trim(canonical_name)) > 0 OR length(trim(website_url)) > 0
  )
);

CREATE INDEX IF NOT EXISTS idx_luna_sales_prospects_created_at
  ON luna_sales.prospects (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_sales_prospects_lifecycle_status
  ON luna_sales.prospects (lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_luna_sales_prospects_owner_id
  ON luna_sales.prospects (owner_id);

CREATE TABLE IF NOT EXISTS luna_sales.research_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id   UUID NOT NULL REFERENCES luna_sales.prospects(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  status        TEXT NOT NULL,
  job_label     TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  facts         JSONB NOT NULL DEFAULT '[]'::jsonb,
  limitations   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT research_jobs_source_check CHECK (
    source IN ('fixture', 'manual')
  ),
  CONSTRAINT research_jobs_status_check CHECK (
    status IN ('pending', 'completed', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_luna_sales_research_jobs_prospect_id
  ON luna_sales.research_jobs (prospect_id);
CREATE INDEX IF NOT EXISTS idx_luna_sales_research_jobs_created_at
  ON luna_sales.research_jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS luna_sales.audit_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb
  -- Append-only by privilege: grant SELECT, INSERT only (no UPDATE/DELETE).
);

CREATE INDEX IF NOT EXISTS idx_luna_sales_audit_events_at
  ON luna_sales.audit_events (at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_sales_audit_events_entity
  ON luna_sales.audit_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_luna_sales_audit_events_detail_prospect
  ON luna_sales.audit_events ((detail->>'prospect_id'));

COMMIT;
