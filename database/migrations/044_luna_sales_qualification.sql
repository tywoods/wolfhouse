-- 044_luna_sales_qualification.sql
-- Luna Sales Chapter 3: qualification assessments (operator-controlled policy).
--
-- Adds luna_sales.qualification_assessments for transparent, append-oriented
-- qualification decisions with explicit evidence references. Idempotent +
-- transactional. Safe to re-run.
--
-- Least-privilege assumptions unchanged from 042/043:
--   * CROWSNEST_SALES_DATABASE_URL only (never WOLFHOUSE_DATABASE_URL).
--   * SELECT, INSERT on luna_sales.qualification_assessments (append-oriented;
--     no UPDATE/DELETE required for this chapter).
--   * SELECT, INSERT only on luna_sales.audit_events (append-only).
--   * Application SQL must qualify luna_sales.* (do not rely on search_path).
-- Migration apply / Azure secret wiring remains out of scope.

BEGIN;

CREATE TABLE IF NOT EXISTS luna_sales.qualification_assessments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id     UUID NOT NULL REFERENCES luna_sales.prospects(id) ON DELETE CASCADE,
  decision        TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  evidence_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_id     TEXT NOT NULL DEFAULT 'Admin',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qualification_assessments_decision_check CHECK (
    decision IN ('qualified', 'not_qualified', 'needs_more_research')
  ),
  CONSTRAINT qualification_assessments_rationale_present_check CHECK (
    length(trim(rationale)) > 0
  ),
  CONSTRAINT qualification_assessments_evidence_ids_array_check CHECK (
    jsonb_typeof(evidence_ids) = 'array'
  )
);

CREATE INDEX IF NOT EXISTS idx_luna_sales_qualification_prospect_id
  ON luna_sales.qualification_assessments (prospect_id);
CREATE INDEX IF NOT EXISTS idx_luna_sales_qualification_created_at
  ON luna_sales.qualification_assessments (created_at DESC);

COMMIT;
