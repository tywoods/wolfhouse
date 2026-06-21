-- PROPOSED ONLY — DO NOT RUN without explicit Captain approval.
-- Adds school/location scoping to Sunset Admin config tables (migration 021).
-- On Sunset staging, 021 is already applied (2026-06); apply this file only for 023.
-- Until applied, runtime uses Postgres tenant_* without per-school rows; JSON overlay
-- is dev-only fallback when tables are absent.--
-- Apply after: 021_sunset_admin_business_config.sql (when approved)
-- Rollback (manual):
--   DROP INDEX IF EXISTS uq_tenant_price_rules_active_window_loc;
--   ALTER TABLE tenant_price_rules DROP COLUMN IF EXISTS location_id;
--   (repeat for capacity/time tables + recreate old indexes)

BEGIN;

ALTER TABLE tenant_price_rules
  ADD COLUMN IF NOT EXISTS location_id TEXT NOT NULL DEFAULT 'sunset-somo';

ALTER TABLE tenant_lesson_capacity_rules
  ADD COLUMN IF NOT EXISTS location_id TEXT NOT NULL DEFAULT 'sunset-somo';

ALTER TABLE tenant_lesson_time_rules
  ADD COLUMN IF NOT EXISTS location_id TEXT NOT NULL DEFAULT 'sunset-somo';

COMMENT ON COLUMN tenant_price_rules.location_id IS
  'Sunset school partition: sunset-somo (Sunset) or sunset-sardinero (El Sardi).';

-- Replace tenant-wide unique indexes with location-scoped variants
DROP INDEX IF EXISTS uq_tenant_price_rules_active_window;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_price_rules_active_window_loc
  ON tenant_price_rules (client_slug, location_id, item_type, item_code, unit, COALESCE(effective_from, DATE '1970-01-01'))
  WHERE active = true;

DROP INDEX IF EXISTS uq_tenant_lesson_capacity_default;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_lesson_capacity_default_loc
  ON tenant_lesson_capacity_rules (client_slug, location_id)
  WHERE scope = 'default' AND active = true;

DROP INDEX IF EXISTS uq_tenant_lesson_capacity_weekday;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_lesson_capacity_weekday_loc
  ON tenant_lesson_capacity_rules (client_slug, location_id, weekday)
  WHERE scope = 'weekday' AND active = true;

DROP INDEX IF EXISTS uq_tenant_lesson_capacity_date;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_lesson_capacity_date_loc
  ON tenant_lesson_capacity_rules (client_slug, location_id, service_date)
  WHERE scope = 'date' AND active = true;

DROP INDEX IF EXISTS uq_tenant_lesson_time_recurring;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_lesson_time_recurring_loc
  ON tenant_lesson_time_rules (client_slug, location_id, lesson_type, time_local)
  WHERE service_date IS NULL AND active = true;

DROP INDEX IF EXISTS uq_tenant_lesson_time_date;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_lesson_time_date_loc
  ON tenant_lesson_time_rules (client_slug, location_id, service_date, time_local, lesson_type)
  WHERE service_date IS NOT NULL AND active = true;

COMMIT;
