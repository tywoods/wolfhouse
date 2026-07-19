-- 039_sunset_admin_location_aware_rules.sql
-- FOUNDATION Slice 13C.2 — canonical forward promotion of the approved Sunset
-- location-aware admin-rule model (structural effects of proposed 023 + 025).
--
-- Scope (only):
--   * location_id on tenant_price_rules, tenant_lesson_capacity_rules,
--     tenant_lesson_time_rules (TEXT NOT NULL DEFAULT 'sunset-somo')
--   * location-scoped unique indexes replacing superseded tenant-only uniques
--   * tenant_lesson_time_rules.capacity + capacity CHECK
--
-- Explicitly excluded:
--   * conversations.location_id / proposed 024 conversation-location DDL
--   * tenant_services / customer_message_templates / ledger bootstrap
--   * inventing a DB location parent table / FK (location IDs are app-validated
--     via scripts/lib/sunset-school-locations.js, matching live + proposed 023)
--
-- Historical proposed files remain proposed_not_executable inputs; this file is
-- the reviewed executable forward migration.
--
-- Safety:
--   * Forward-only; preserves existing location_id / capacity values
--   * Idempotent re-run (IF NOT EXISTS / constraint existence checks)
--   * Fail closed on incompatible column types
--   * Requires parent admin tables from 021
--
-- Lock/downtime: short ACCESS EXCLUSIVE around ALTER TABLE / index rebuilds on
-- typically small admin-rule tables. Staff API already supports location_id when
-- present (tenant-admin-writes.js).
--
-- Apply after: 038_sunset_payment_link_idempotency.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- Preconditions: admin-rule tables from 021 must exist
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.tenant_price_rules') IS NULL
     OR to_regclass('public.tenant_lesson_capacity_rules') IS NULL
     OR to_regclass('public.tenant_lesson_time_rules') IS NULL THEN
    RAISE EXCEPTION
      '039_sunset_admin_location_aware_rules: required admin-rule tables missing (apply 021 first)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Fail closed: incompatible location_id / capacity types
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  dt text;
BEGIN
  SELECT data_type INTO dt
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'tenant_price_rules' AND column_name = 'location_id';
  IF dt IS NOT NULL AND dt <> 'text' THEN
    RAISE EXCEPTION '039: incompatible tenant_price_rules.location_id type %', dt;
  END IF;

  SELECT data_type INTO dt
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'tenant_lesson_capacity_rules' AND column_name = 'location_id';
  IF dt IS NOT NULL AND dt <> 'text' THEN
    RAISE EXCEPTION '039: incompatible tenant_lesson_capacity_rules.location_id type %', dt;
  END IF;

  SELECT data_type INTO dt
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'tenant_lesson_time_rules' AND column_name = 'location_id';
  IF dt IS NOT NULL AND dt <> 'text' THEN
    RAISE EXCEPTION '039: incompatible tenant_lesson_time_rules.location_id type %', dt;
  END IF;

  SELECT data_type INTO dt
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'tenant_lesson_time_rules' AND column_name = 'capacity';
  IF dt IS NOT NULL AND dt <> 'integer' THEN
    RAISE EXCEPTION '039: incompatible tenant_lesson_time_rules.capacity type %', dt;
  END IF;

  -- Fail closed: unexpected FK on location_id (approved model has no location parent table/FK)
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public'
      AND rel.relname IN (
        'tenant_price_rules',
        'tenant_lesson_capacity_rules',
        'tenant_lesson_time_rules'
      )
      AND c.contype = 'f'
      AND EXISTS (
        SELECT 1
        FROM unnest(c.conkey) AS ck(attnum)
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attnum = ck.attnum
        WHERE a.attname = 'location_id'
      )
  ) THEN
    RAISE EXCEPTION
      '039: unexpected FOREIGN KEY on admin-rule location_id (approved model is app-validated TEXT, no DB FK)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- location_id columns (preserve existing values; default for new/NULL rows)
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_price_rules
  ADD COLUMN IF NOT EXISTS location_id TEXT;

ALTER TABLE tenant_lesson_capacity_rules
  ADD COLUMN IF NOT EXISTS location_id TEXT;

ALTER TABLE tenant_lesson_time_rules
  ADD COLUMN IF NOT EXISTS location_id TEXT;

UPDATE tenant_price_rules
  SET location_id = 'sunset-somo'
  WHERE location_id IS NULL;

UPDATE tenant_lesson_capacity_rules
  SET location_id = 'sunset-somo'
  WHERE location_id IS NULL;

UPDATE tenant_lesson_time_rules
  SET location_id = 'sunset-somo'
  WHERE location_id IS NULL;

ALTER TABLE tenant_price_rules
  ALTER COLUMN location_id SET DEFAULT 'sunset-somo';
ALTER TABLE tenant_lesson_capacity_rules
  ALTER COLUMN location_id SET DEFAULT 'sunset-somo';
ALTER TABLE tenant_lesson_time_rules
  ALTER COLUMN location_id SET DEFAULT 'sunset-somo';

ALTER TABLE tenant_price_rules
  ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE tenant_lesson_capacity_rules
  ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE tenant_lesson_time_rules
  ALTER COLUMN location_id SET NOT NULL;

COMMENT ON COLUMN tenant_price_rules.location_id IS
  'Sunset school partition: sunset-somo (Sunset) or sunset-sardinero (El Sardi).';

COMMENT ON COLUMN tenant_lesson_capacity_rules.location_id IS
  'Sunset school partition: sunset-somo (Sunset) or sunset-sardinero (El Sardi).';

COMMENT ON COLUMN tenant_lesson_time_rules.location_id IS
  'Sunset school partition: sunset-somo (Sunset) or sunset-sardinero (El Sardi).';

-- ---------------------------------------------------------------------------
-- capacity column + CHECK (proposed 025 shape)
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_lesson_time_rules
  ADD COLUMN IF NOT EXISTS capacity INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_lesson_time_rules_capacity_check'
      AND conrelid = 'public.tenant_lesson_time_rules'::regclass
  ) THEN
    ALTER TABLE tenant_lesson_time_rules
      ADD CONSTRAINT tenant_lesson_time_rules_capacity_check
      CHECK (capacity IS NULL OR (capacity >= 1 AND capacity <= 999));
  END IF;
END $$;

COMMENT ON COLUMN tenant_lesson_time_rules.capacity IS
  'Optional per-lesson slot capacity shown/edited in Sunset Admin. Falls back to tenant_lesson_capacity_rules default when NULL.';

-- ---------------------------------------------------------------------------
-- Replace tenant-wide unique indexes with location-scoped variants.
-- Drop both old and target loc index names first so an incompatible pre-existing
-- loc index cannot be retained by IF NOT EXISTS.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS uq_tenant_price_rules_active_window;
DROP INDEX IF EXISTS uq_tenant_price_rules_active_window_loc;
CREATE UNIQUE INDEX uq_tenant_price_rules_active_window_loc
  ON tenant_price_rules (
    client_slug,
    location_id,
    item_type,
    item_code,
    unit,
    COALESCE(effective_from, DATE '1970-01-01')
  )
  WHERE active = true;

DROP INDEX IF EXISTS uq_tenant_lesson_capacity_default;
DROP INDEX IF EXISTS uq_tenant_lesson_capacity_default_loc;
CREATE UNIQUE INDEX uq_tenant_lesson_capacity_default_loc
  ON tenant_lesson_capacity_rules (client_slug, location_id)
  WHERE scope = 'default' AND active = true;

DROP INDEX IF EXISTS uq_tenant_lesson_capacity_weekday;
DROP INDEX IF EXISTS uq_tenant_lesson_capacity_weekday_loc;
CREATE UNIQUE INDEX uq_tenant_lesson_capacity_weekday_loc
  ON tenant_lesson_capacity_rules (client_slug, location_id, weekday)
  WHERE scope = 'weekday' AND active = true;

DROP INDEX IF EXISTS uq_tenant_lesson_capacity_date;
DROP INDEX IF EXISTS uq_tenant_lesson_capacity_date_loc;
CREATE UNIQUE INDEX uq_tenant_lesson_capacity_date_loc
  ON tenant_lesson_capacity_rules (client_slug, location_id, service_date)
  WHERE scope = 'date' AND active = true;

DROP INDEX IF EXISTS uq_tenant_lesson_time_recurring;
DROP INDEX IF EXISTS uq_tenant_lesson_time_recurring_loc;
CREATE UNIQUE INDEX uq_tenant_lesson_time_recurring_loc
  ON tenant_lesson_time_rules (client_slug, location_id, lesson_type, time_local)
  WHERE service_date IS NULL AND active = true;

DROP INDEX IF EXISTS uq_tenant_lesson_time_date;
DROP INDEX IF EXISTS uq_tenant_lesson_time_date_loc;
CREATE UNIQUE INDEX uq_tenant_lesson_time_date_loc
  ON tenant_lesson_time_rules (client_slug, location_id, service_date, time_local, lesson_type)
  WHERE service_date IS NOT NULL AND active = true;

-- Intentionally does not touch conversations / proposed 024 conversation-location DDL.

COMMIT;
