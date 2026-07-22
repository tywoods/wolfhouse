-- 046_luna_sales_outreach_drafts.sql
-- Luna Sales Chapter 6: outreach draft revisions (internal drafts only).
--
-- Adds luna_sales.outreach_draft_revisions so operators can manually create and
-- edit a single current outreach draft per CRM-ready prospect. Each save appends
-- a revision (history = newest-first revisions). Latest revision_number for a
-- prospect is the current draft. No send, no SMTP, no WhatsApp/LinkedIn/HubSpot
-- delivery, no auto-generation.
-- Idempotent + transactional. Safe to re-run.
--
-- Least-privilege assumptions unchanged from 042–045:
--   * CROWSNEST_SALES_DATABASE_URL only (never WOLFHOUSE_DATABASE_URL).
--   * SELECT, INSERT on luna_sales.outreach_draft_revisions (append-oriented;
--     no UPDATE/DELETE required for this chapter).
--   * SELECT, INSERT only on luna_sales.audit_events (append-only).
--   * Application SQL must qualify luna_sales.* (do not rely on search_path).
-- Migration apply / Azure secret wiring remains out of scope.

BEGIN;

CREATE TABLE IF NOT EXISTS luna_sales.outreach_draft_revisions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id       UUID NOT NULL REFERENCES luna_sales.prospects(id) ON DELETE CASCADE,
  revision_number   INTEGER NOT NULL,
  subject           TEXT NOT NULL DEFAULT '',
  body              TEXT NOT NULL DEFAULT '',
  channel           TEXT NOT NULL,
  next_step_note    TEXT NOT NULL DEFAULT '',
  author_id         TEXT NOT NULL DEFAULT 'Admin',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT outreach_draft_revisions_channel_check CHECK (
    channel IN ('email', 'linkedin', 'other')
  ),
  CONSTRAINT outreach_draft_revisions_revision_positive CHECK (
    revision_number >= 1
  ),
  CONSTRAINT outreach_draft_revisions_prospect_revision_unique UNIQUE (prospect_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_luna_sales_outreach_draft_revisions_prospect_id
  ON luna_sales.outreach_draft_revisions (prospect_id);

CREATE INDEX IF NOT EXISTS idx_luna_sales_outreach_draft_revisions_created_at
  ON luna_sales.outreach_draft_revisions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_sales_outreach_draft_revisions_prospect_rev
  ON luna_sales.outreach_draft_revisions (prospect_id, revision_number DESC);

COMMIT;
