-- 043_luna_sales_research_evidence.sql
-- Luna Sales Chapter 2: minimal research_jobs extension for manual evidence.
--
-- Extends luna_sales.research_jobs with source_url + confidence so operators can
-- record dated manual research entries without a parallel evidence table.
-- Idempotent + transactional. Safe to re-run.
--
-- Least-privilege assumptions unchanged from 042:
--   * CROWSNEST_SALES_DATABASE_URL only (never WOLFHOUSE_DATABASE_URL).
--   * SELECT, INSERT, UPDATE on luna_sales.research_jobs.
--   * SELECT, INSERT only on luna_sales.audit_events (append-only).
--   * Application SQL must qualify luna_sales.* (do not rely on search_path).
-- Migration apply / Azure secret wiring remains out of scope.

BEGIN;

ALTER TABLE luna_sales.research_jobs
  ADD COLUMN IF NOT EXISTS source_url TEXT NOT NULL DEFAULT '';

ALTER TABLE luna_sales.research_jobs
  ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'research_jobs_confidence_check'
       AND conrelid = 'luna_sales.research_jobs'::regclass
  ) THEN
    ALTER TABLE luna_sales.research_jobs
      ADD CONSTRAINT research_jobs_confidence_check CHECK (
        confidence IN ('', 'low', 'medium', 'high')
      );
  END IF;
END $$;

COMMIT;
