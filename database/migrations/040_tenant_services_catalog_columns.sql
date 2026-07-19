-- 040_tenant_services_catalog_columns.sql
-- FOUNDATION Slice 13C.3a — promote approved live tenant_services columns only
-- (DEC-004 Phase C column portion).
--
-- Scope (only):
--   * weekdays SMALLINT[] NOT NULL DEFAULT '{}'
--   * block_rooms_enabled BOOLEAN NOT NULL DEFAULT false
--   * blocked_room_codes TEXT[] NOT NULL DEFAULT '{}'
--   * room_block_booking_ids UUID[] NOT NULL DEFAULT '{}'
--
-- Explicitly excluded:
--   * Phase D CHECKs tenant_services_date_window / tenant_services_price_unit
--   * migration 035 / customer_message_templates
--   * notification indexes / surf-pack FK/index/trigger
--   * ledger bootstrap
--
-- Matches Staff ensure-DDL:
--   scripts/lib/tenant-services-writes.js (weekdays)
--   scripts/lib/tenant-service-room-blocks.js (block columns)
--
-- Safety:
--   * Additive forward-only; preserves existing values
--   * Absent compatible column → ADD
--   * Exact compatible column → no-op / preserve
--   * Incompatible type/default/nullability/generated/identity → RAISE (rollback)
--   * No DROP, destructive conversion, or row rewrite
--
-- Lock/downtime: brief ACCESS EXCLUSIVE on tenant_services for ADD COLUMN on a
-- typically small catalog table. Staff API already reads/writes these columns.
--
-- Apply after: 039_sunset_admin_location_aware_rules.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.tenant_services') IS NULL THEN
    RAISE EXCEPTION
      '040_tenant_services_catalog_columns: tenant_services missing (apply 028 first)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.wh040_norm_default(p_expr text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $f$
  SELECT lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(coalesce(p_expr, ''), '::[a-zA-Z_][a-zA-Z0-9_]*', '', 'g'),
        '\s+', '', 'g'
      ),
      '[()]', '', 'g'
    )
  );
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh040_column_state(
  p_table text,
  p_column text,
  OUT o_exists boolean,
  OUT o_attnum int,
  OUT o_type text,
  OUT o_udt text,
  OUT o_nullable text,
  OUT o_default_norm text,
  OUT o_has_default boolean,
  OUT o_identity text,
  OUT o_generated text
)
LANGUAGE plpgsql
AS $f$
BEGIN
  o_exists := false;
  o_attnum := NULL;
  o_type := NULL;
  o_udt := NULL;
  o_nullable := NULL;
  o_default_norm := NULL;
  o_has_default := false;
  o_identity := '';
  o_generated := '';

  SELECT
    a.attnum,
    format_type(a.atttypid, a.atttypmod),
    t.typname,
    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END,
    pg_temp.wh040_norm_default(pg_get_expr(ad.adbin, ad.adrelid)),
    (ad.adbin IS NOT NULL),
    coalesce(nullif(a.attidentity, ''), ''),
    coalesce(nullif(a.attgenerated, ''), '')
  INTO
    o_attnum, o_type, o_udt, o_nullable, o_default_norm, o_has_default, o_identity, o_generated
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  WHERE n.nspname = 'public'
    AND c.relname = p_table
    AND a.attname = p_column
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF FOUND THEN
    o_exists := true;
  ELSE
    o_exists := false;
  END IF;
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh040_ensure_column(
  p_column text,
  p_expected_udt text,
  p_expected_nullable text,
  p_expected_default_norm text,
  p_add_sql text
)
RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  st record;
BEGIN
  SELECT * INTO st FROM pg_temp.wh040_column_state('tenant_services', p_column);
  IF NOT st.o_exists THEN
    EXECUTE p_add_sql;
    RETURN;
  END IF;

  IF st.o_identity <> '' THEN
    RAISE EXCEPTION
      '040: tenant_services.% has unexpected identity state %',
      p_column, st.o_identity;
  END IF;
  IF st.o_generated <> '' THEN
    RAISE EXCEPTION
      '040: tenant_services.% has unexpected generated state %',
      p_column, st.o_generated;
  END IF;
  IF st.o_udt IS DISTINCT FROM p_expected_udt THEN
    RAISE EXCEPTION
      '040: incompatible tenant_services.% type (udt=% expected %)',
      p_column, st.o_udt, p_expected_udt;
  END IF;
  IF st.o_nullable IS DISTINCT FROM p_expected_nullable THEN
    RAISE EXCEPTION
      '040: incompatible tenant_services.% nullability (got % expected %)',
      p_column, st.o_nullable, p_expected_nullable;
  END IF;
  IF NOT st.o_has_default THEN
    RAISE EXCEPTION
      '040: tenant_services.% missing required default',
      p_column;
  END IF;
  IF st.o_default_norm IS DISTINCT FROM pg_temp.wh040_norm_default(p_expected_default_norm) THEN
    RAISE EXCEPTION
      '040: incompatible tenant_services.% default (got % expected %)',
      p_column, st.o_default_norm, pg_temp.wh040_norm_default(p_expected_default_norm);
  END IF;
  -- Exact compatible column → preserve / no-op
END;
$f$;

DO $$
BEGIN
  PERFORM pg_temp.wh040_ensure_column(
    'weekdays',
    '_int2',
    'NO',
    '''{}''::smallint[]',
    $sql$ALTER TABLE tenant_services ADD COLUMN weekdays SMALLINT[] NOT NULL DEFAULT '{}'::smallint[]$sql$
  );

  PERFORM pg_temp.wh040_ensure_column(
    'block_rooms_enabled',
    'bool',
    'NO',
    'false',
    $sql$ALTER TABLE tenant_services ADD COLUMN block_rooms_enabled BOOLEAN NOT NULL DEFAULT false$sql$
  );

  PERFORM pg_temp.wh040_ensure_column(
    'blocked_room_codes',
    '_text',
    'NO',
    '''{}''::text[]',
    $sql$ALTER TABLE tenant_services ADD COLUMN blocked_room_codes TEXT[] NOT NULL DEFAULT '{}'::text[]$sql$
  );

  PERFORM pg_temp.wh040_ensure_column(
    'room_block_booking_ids',
    '_uuid',
    'NO',
    '''{}''::uuid[]',
    $sql$ALTER TABLE tenant_services ADD COLUMN room_block_booking_ids UUID[] NOT NULL DEFAULT '{}'::uuid[]$sql$
  );
END $$;

COMMENT ON COLUMN tenant_services.weekdays IS
  'Optional service schedule weekdays (0=Sun .. 6=Sat). Empty means unrestricted / use other schedule fields.';

COMMENT ON COLUMN tenant_services.block_rooms_enabled IS
  'When true, Staff syncs whole-room inventory blocks for blocked_room_codes over [start_date,end_date].';

COMMENT ON COLUMN tenant_services.blocked_room_codes IS
  'Room codes blocked while block_rooms_enabled is true.';

COMMENT ON COLUMN tenant_services.room_block_booking_ids IS
  'Booking IDs created to hold whole-room blocks; managed by Staff room-block sync.';

-- Intentionally does not add Phase D CHECKs or touch CMT / notification / surf-pack / ledger.

COMMIT;
