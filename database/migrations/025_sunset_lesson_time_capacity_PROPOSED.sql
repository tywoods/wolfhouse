-- Sunset Admin per-lesson capacity column.
--
-- PROPOSED ONLY — do not run without explicit operator approval.
-- Enables the Admin lesson card capacity input to persist per lesson time.
-- Staging target when approved: sunset_staging only.

BEGIN;

ALTER TABLE tenant_lesson_time_rules
  ADD COLUMN IF NOT EXISTS capacity INTEGER
  CHECK (capacity IS NULL OR (capacity >= 1 AND capacity <= 999));

COMMENT ON COLUMN tenant_lesson_time_rules.capacity IS
  'Optional per-lesson slot capacity shown/edited in Sunset Admin. Falls back to tenant_lesson_capacity_rules default when NULL.';

COMMIT;

-- Rollback, if needed after confirming no per-lesson capacity data must be retained:
-- BEGIN;
-- ALTER TABLE tenant_lesson_time_rules DROP COLUMN IF EXISTS capacity;
-- COMMIT;
