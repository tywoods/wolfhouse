-- 045_luna_sales_crm_review.sql
-- Luna Sales Chapter 5: CRM review readiness marks (preview-only sync adapter).
--
-- Adds luna_sales.crm_review_marks so operators can manually mark a currently
-- qualified prospect as ready for CRM review. Marks are append-oriented and
-- retain a durable link to the qualification assessment (evidence/reason
-- traceability). No CRM provider writes, no Deal records, no outreach.
-- Idempotent + transactional. Safe to re-run.
--
-- Least-privilege assumptions unchanged from 042–044:
--   * CROWSNEST_SALES_DATABASE_URL only (never WOLFHOUSE_DATABASE_URL).
--   * SELECT, INSERT on luna_sales.crm_review_marks (append-oriented;
--     no UPDATE/DELETE required for this chapter).
--   * SELECT, INSERT only on luna_sales.audit_events (append-only).
--   * Application SQL must qualify luna_sales.* (do not rely on search_path).
-- Migration apply / Azure secret wiring remains out of scope.

BEGIN;

CREATE TABLE IF NOT EXISTS luna_sales.crm_review_marks (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id                   UUID NOT NULL REFERENCES luna_sales.prospects(id) ON DELETE CASCADE,
  qualification_assessment_id   UUID NOT NULL REFERENCES luna_sales.qualification_assessments(id) ON DELETE RESTRICT,
  reviewer_id                   TEXT NOT NULL DEFAULT 'Admin',
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_sales_crm_review_marks_prospect_id
  ON luna_sales.crm_review_marks (prospect_id);
CREATE INDEX IF NOT EXISTS idx_luna_sales_crm_review_marks_created_at
  ON luna_sales.crm_review_marks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_sales_crm_review_marks_qualification_id
  ON luna_sales.crm_review_marks (qualification_assessment_id);

COMMIT;
