-- 040_tenant_services_saas_catalog_columns.sql
-- FOUNDATION Slice 13C.3a — canonical forward promotion of approved
-- tenant_services live-only SaaS catalog columns (DEC-004 Phase C).
--
-- Scope (only):
--   * weekdays SMALLINT[] NOT NULL DEFAULT '{}'
--   * block_rooms_enabled BOOLEAN NOT NULL DEFAULT false
--   * blocked_room_codes TEXT[] NOT NULL DEFAULT '{}'
--   * room_block_booking_ids UUID[] NOT NULL DEFAULT '{}'
--
-- Explicitly excluded:
--   * tenant_services_date_window / tenant_services_price_unit CHECKs (Phase D)
--   * customer_message_templates / notification / surf-pack reconciliation
--   * schema_migration_ledger bootstrap
--
-- Safety:
--   * Forward-only; preserves existing column values
--   * Idempotent re-run (exact compatible columns → no-op)
--   * Fail closed on incompatible type/default/nullability/generated/identity
--
-- Lock/downtime: brief ACCESS EXCLUSIVE on ALTER TABLE tenant_services ADD COLUMN;
-- catalog table is typically small. Staff ensure-DDL already tolerates these columns live.
--
-- Apply after: 039_sunset_admin_location_aware_rules.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.tenant_services') IS NULL THEN
    RAISE EXCEPTION
      '040_tenant_services_saas_catalog_columns: tenant_services missing (apply 028 first)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.wh040_norm_default(p_expr text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $f$
  SELECT lower(
    regexp_replace(
      regexp_replace(coalesce(p_expr, ''), '::[a-zA-Z_][a-zA-Z0-9_]*', '', 'g'),
      '\s+',
      '',
      'g'
    )
  );
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh040_assert_column_compat(
  p_table text,
  p_column text,
  p_udt text,
  p_nullable boolean,
  p_default_sql text
)
RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  r record;
  def_norm text;
  expected_norm text;
BEGIN
  SELECT
    t.typname AS udt_name,
    NOT a.attnotnull AS is_nullable,
    pg_get_expr(d.adbin, d.adrelid) AS col_default,
    a.attgenerated,
    a.attidentity
  INTO r
  FROM pg_attribute a
  JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = format('public.%I', p_table)::regclass
    AND a.attname = p_column
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF r.udt_name <> p_udt THEN
    RAISE EXCEPTION '040: incompatible %.% type udt=% expected=%',
      p_table, p_column, r.udt_name, p_udt;
  END IF;

  IF r.is_nullable IS DISTINCT FROM p_nullable THEN
    RAISE EXCEPTION '040: incompatible %.% nullability got nullable=% expected=%',
      p_table, p_column, r.is_nullable, p_nullable;
  END IF;

  IF coalesce(r.attgenerated, '') <> '' THEN
    RAISE EXCEPTION '040: %.% is a generated column', p_table, p_column;
  END IF;

  IF coalesce(r.attidentity, '') <> '' THEN
    RAISE EXCEPTION '040: %.% is an identity column', p_table, p_column;
  END IF;

  def_norm := pg_temp.wh040_norm_default(r.col_default);
  expected_norm := pg_temp.wh040_norm_default(p_default_sql);
  IF def_norm IS DISTINCT FROM expected_norm THEN
    RAISE EXCEPTION '040: incompatible %.% default got=% expected=%',
      p_table, p_column, r.col_default, p_default_sql;
  END IF;
END;
$f$;

DO $$
BEGIN
  PERFORM pg_temp.wh040_assert_column_compat(
    'tenant_services', 'weekdays', '_int2', false, '''{}''::smallint[]'
  );
END $$;
ALTER TABLE tenant_services
  ADD COLUMN IF NOT EXISTS weekdays SMALLINT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  PERFORM pg_temp.wh040_assert_column_compat(
    'tenant_services', 'block_rooms_enabled', 'bool', false, 'false'
  );
END $$;
ALTER TABLE tenant_services
  ADD COLUMN IF NOT EXISTS block_rooms_enabled BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  PERFORM pg_temp.wh040_assert_column_compat(
    'tenant_services', 'blocked_room_codes', '_text', false, '''{}''::text[]'
  );
END $$;
ALTER TABLE tenant_services
  ADD COLUMN IF NOT EXISTS blocked_room_codes TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  PERFORM pg_temp.wh040_assert_column_compat(
    'tenant_services', 'room_block_booking_ids', '_uuid', false, '''{}''::uuid[]'
  );
END $$;
ALTER TABLE tenant_services
  ADD COLUMN IF NOT EXISTS room_block_booking_ids UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN tenant_services.weekdays IS
  'Optional weekday filter (0=Sun..6=Sat) for recurring availability in Camps and Services admin.';
COMMENT ON COLUMN tenant_services.block_rooms_enabled IS
  'When true, syncServiceRoomBlocks creates whole-room operator blocks for blocked_room_codes.';
COMMENT ON COLUMN tenant_services.blocked_room_codes IS
  'Room codes to block when block_rooms_enabled (normalized uppercase in app).';
COMMENT ON COLUMN tenant_services.room_block_booking_ids IS
  'UUIDs of operator whole_room bookings backing active room blocks for this service.';

COMMIT;
