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
--   * Idempotent re-run (exact target indexes / CHECK preserved as no-op)
--   * Fail closed on incompatible column types, FKs, indexes, or CHECKs
--   * Catalog-validated index/CHECK definitions (not unconditional DROP by name)
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
-- capacity column + catalog-validated CHECK (proposed 025 shape)
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_lesson_time_rules
  ADD COLUMN IF NOT EXISTS capacity INTEGER;

DO $$
DECLARE
  con_oid oid;
  con_relid oid;
  con_type "char";
  con_validated boolean;
  con_deferrable boolean;
  con_deferred boolean;
  expr_norm text;
  expected_norm text := 'capacityisnullorcapacity>=1andcapacity<=999';
BEGIN
  SELECT c.oid, c.conrelid, c.contype, c.convalidated, c.condeferrable, c.condeferred
    INTO con_oid, con_relid, con_type, con_validated, con_deferrable, con_deferred
  FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'public'
    AND c.conname = 'tenant_lesson_time_rules_capacity_check';

  IF con_oid IS NULL THEN
    ALTER TABLE tenant_lesson_time_rules
      ADD CONSTRAINT tenant_lesson_time_rules_capacity_check
      CHECK (capacity IS NULL OR (capacity >= 1 AND capacity <= 999));
  ELSE
    IF con_relid <> 'public.tenant_lesson_time_rules'::regclass THEN
      RAISE EXCEPTION
        '039: tenant_lesson_time_rules_capacity_check exists on unexpected relation %',
        con_relid::regclass;
    END IF;
    IF con_type <> 'c' THEN
      RAISE EXCEPTION
        '039: tenant_lesson_time_rules_capacity_check exists with incompatible type %',
        con_type;
    END IF;
    IF con_validated IS NOT TRUE THEN
      RAISE EXCEPTION
        '039: tenant_lesson_time_rules_capacity_check is not validated';
    END IF;
    IF con_deferrable OR con_deferred THEN
      RAISE EXCEPTION
        '039: tenant_lesson_time_rules_capacity_check has unexpected deferrability';
    END IF;

    SELECT lower(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(pg_get_expr(c.conbin, c.conrelid), '::[a-zA-Z_][a-zA-Z0-9_]*', '', 'g'),
                   '\s+', '', 'g'
                 ),
                 '[()]', '', 'g'
               ),
               '''1970-01-01''', 'date''1970-01-01''', 'gi'
             )
           )
      INTO expr_norm
    FROM pg_constraint c
    WHERE c.oid = con_oid;

    IF expr_norm IS DISTINCT FROM expected_norm THEN
      RAISE EXCEPTION
        '039: incompatible tenant_lesson_time_rules_capacity_check definition (got %)',
        expr_norm;
    END IF;
    -- Exact approved CHECK present → no-op (preserve)
  END IF;
END $$;

COMMENT ON COLUMN tenant_lesson_time_rules.capacity IS
  'Optional per-lesson slot capacity shown/edited in Sunset Admin. Falls back to tenant_lesson_capacity_rules default when NULL.';

-- ---------------------------------------------------------------------------
-- Catalog-validated unique index promotion.
-- Superseded tenant-wide indexes: absent OK; exact old def → DROP; else RAISE.
-- Target *_loc indexes: absent → CREATE; exact approved → no-op; else RAISE.
-- Never DROP an incompatible or exact-compatible target merely to recreate it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.wh039_norm_expr(p_expr text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $f$
  SELECT lower(
    regexp_replace(
      regexp_replace(
        -- Strip type casts BEFORE collapsing whitespace so '::text AND' is not eaten.
        regexp_replace(
          regexp_replace(
            regexp_replace(coalesce(p_expr, ''), 'date\s*''1970-01-01''', 'DATE_EPOCH', 'gi'),
            '''1970-01-01''\s*::\s*date', 'DATE_EPOCH', 'gi'
          ),
          '::[a-zA-Z_][a-zA-Z0-9_]*', '', 'g'
        ),
        '\s+', '', 'g'
      ),
      '[()]', '', 'g'
    )
  );
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh039_index_state(
  p_index_name text,
  OUT o_exists boolean,
  OUT o_oid oid,
  OUT o_schema text,
  OUT o_table text,
  OUT o_unique boolean,
  OUT o_am text,
  OUT o_keys text[],
  OUT o_pred text,
  OUT o_has_include boolean,
  OUT o_constraint_owned boolean
)
LANGUAGE plpgsql
AS $f$
DECLARE
  idx oid;
  i int;
  nkey int;
  natts int;
  keys text[] := ARRAY[]::text[];
BEGIN
  o_exists := false;
  o_oid := NULL;
  o_schema := NULL;
  o_table := NULL;
  o_unique := NULL;
  o_am := NULL;
  o_keys := NULL;
  o_pred := NULL;
  o_has_include := NULL;
  o_constraint_owned := NULL;

  SELECT c.oid
    INTO idx
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'i'
    AND c.relname = p_index_name;

  IF idx IS NULL THEN
    RETURN;
  END IF;

  o_exists := true;
  o_oid := idx;

  SELECT
    ns.nspname,
    rel.relname,
    i.indisunique,
    am.amname,
    i.indnkeyatts,
    i.indnatts,
    pg_temp.wh039_norm_expr(pg_get_expr(i.indpred, i.indrelid)),
    EXISTS (
      SELECT 1 FROM pg_constraint co
      WHERE co.conindid = i.indexrelid
    )
  INTO
    o_schema,
    o_table,
    o_unique,
    o_am,
    nkey,
    natts,
    o_pred,
    o_constraint_owned
  FROM pg_index i
  JOIN pg_class rel ON rel.oid = i.indrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  JOIN pg_am am ON am.oid = (SELECT c.relam FROM pg_class c WHERE c.oid = i.indexrelid)
  WHERE i.indexrelid = idx;

  FOR i IN 1..nkey LOOP
    keys := keys || pg_temp.wh039_norm_expr(pg_get_indexdef(idx, i, true));
  END LOOP;
  o_keys := keys;
  o_has_include := natts > nkey;
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh039_index_matches(
  p_index_name text,
  p_table text,
  p_unique boolean,
  p_am text,
  p_keys text[],
  p_pred text
)
RETURNS boolean
LANGUAGE plpgsql
AS $f$
DECLARE
  st record;
  expected_pred text := pg_temp.wh039_norm_expr(p_pred);
  expected_keys text[];
  k text;
BEGIN
  SELECT * INTO st FROM pg_temp.wh039_index_state(p_index_name);
  IF NOT st.o_exists THEN
    RETURN false;
  END IF;

  expected_keys := ARRAY[]::text[];
  FOREACH k IN ARRAY p_keys LOOP
    expected_keys := expected_keys || pg_temp.wh039_norm_expr(k);
  END LOOP;

  RETURN st.o_schema = 'public'
    AND st.o_table = p_table
    AND st.o_unique IS NOT DISTINCT FROM p_unique
    AND st.o_am = p_am
    AND st.o_keys IS NOT DISTINCT FROM expected_keys
    AND coalesce(st.o_pred, '') IS NOT DISTINCT FROM coalesce(expected_pred, '')
    AND st.o_has_include IS NOT TRUE
    AND st.o_constraint_owned IS NOT TRUE;
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh039_assert_or_drop_superseded(
  p_index_name text,
  p_table text,
  p_unique boolean,
  p_am text,
  p_keys text[],
  p_pred text
)
RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  st record;
BEGIN
  SELECT * INTO st FROM pg_temp.wh039_index_state(p_index_name);
  IF NOT st.o_exists THEN
    RETURN; -- absent is acceptable
  END IF;

  IF st.o_constraint_owned THEN
    RAISE EXCEPTION
      '039: superseded index % is constraint-owned; refuse silent drop',
      p_index_name;
  END IF;

  IF NOT pg_temp.wh039_index_matches(p_index_name, p_table, p_unique, p_am, p_keys, p_pred) THEN
    RAISE EXCEPTION
      '039: incompatible superseded index % (table=%.% unique=% am=% keys=% pred=% include=%)',
      p_index_name, st.o_schema, st.o_table, st.o_unique, st.o_am, st.o_keys, st.o_pred, st.o_has_include;
  END IF;

  EXECUTE format('DROP INDEX public.%I', p_index_name);
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh039_ensure_target_index(
  p_index_name text,
  p_table text,
  p_unique boolean,
  p_am text,
  p_keys text[],
  p_pred text,
  p_create_sql text
)
RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  st record;
BEGIN
  SELECT * INTO st FROM pg_temp.wh039_index_state(p_index_name);
  IF NOT st.o_exists THEN
    EXECUTE p_create_sql;
    RETURN;
  END IF;

  IF st.o_constraint_owned THEN
    RAISE EXCEPTION
      '039: target index name % is occupied by a constraint-owned index',
      p_index_name;
  END IF;

  IF pg_temp.wh039_index_matches(p_index_name, p_table, p_unique, p_am, p_keys, p_pred) THEN
    RETURN; -- exact approved definition → preserve / no-op
  END IF;

  RAISE EXCEPTION
    '039: incompatible target index % (table=%.% unique=% am=% keys=% pred=% include=%); refuse drop/replace',
    p_index_name, st.o_schema, st.o_table, st.o_unique, st.o_am, st.o_keys, st.o_pred, st.o_has_include;
END;
$f$;

DO $$
BEGIN
  -- Superseded tenant-wide uniques (021)
  PERFORM pg_temp.wh039_assert_or_drop_superseded(
    'uq_tenant_price_rules_active_window',
    'tenant_price_rules',
    true,
    'btree',
    ARRAY[
      'client_slug',
      'item_type',
      'item_code',
      'unit',
      'COALESCE(effective_from, DATE ''1970-01-01'')'
    ],
    'active = true'
  );

  PERFORM pg_temp.wh039_assert_or_drop_superseded(
    'uq_tenant_lesson_capacity_default',
    'tenant_lesson_capacity_rules',
    true,
    'btree',
    ARRAY['client_slug'],
    'scope = ''default'' AND active = true'
  );

  PERFORM pg_temp.wh039_assert_or_drop_superseded(
    'uq_tenant_lesson_capacity_weekday',
    'tenant_lesson_capacity_rules',
    true,
    'btree',
    ARRAY['client_slug', 'weekday'],
    'scope = ''weekday'' AND active = true'
  );

  PERFORM pg_temp.wh039_assert_or_drop_superseded(
    'uq_tenant_lesson_capacity_date',
    'tenant_lesson_capacity_rules',
    true,
    'btree',
    ARRAY['client_slug', 'service_date'],
    'scope = ''date'' AND active = true'
  );

  PERFORM pg_temp.wh039_assert_or_drop_superseded(
    'uq_tenant_lesson_time_recurring',
    'tenant_lesson_time_rules',
    true,
    'btree',
    ARRAY['client_slug', 'lesson_type', 'time_local'],
    'service_date IS NULL AND active = true'
  );

  PERFORM pg_temp.wh039_assert_or_drop_superseded(
    'uq_tenant_lesson_time_date',
    'tenant_lesson_time_rules',
    true,
    'btree',
    ARRAY['client_slug', 'service_date', 'time_local', 'lesson_type'],
    'service_date IS NOT NULL AND active = true'
  );

  -- Target location-scoped uniques
  PERFORM pg_temp.wh039_ensure_target_index(
    'uq_tenant_price_rules_active_window_loc',
    'tenant_price_rules',
    true,
    'btree',
    ARRAY[
      'client_slug',
      'location_id',
      'item_type',
      'item_code',
      'unit',
      'COALESCE(effective_from, DATE ''1970-01-01'')'
    ],
    'active = true',
    $sql$
      CREATE UNIQUE INDEX uq_tenant_price_rules_active_window_loc
        ON tenant_price_rules (
          client_slug,
          location_id,
          item_type,
          item_code,
          unit,
          COALESCE(effective_from, DATE '1970-01-01')
        )
        WHERE active = true
    $sql$
  );

  PERFORM pg_temp.wh039_ensure_target_index(
    'uq_tenant_lesson_capacity_default_loc',
    'tenant_lesson_capacity_rules',
    true,
    'btree',
    ARRAY['client_slug', 'location_id'],
    'scope = ''default'' AND active = true',
    $sql$
      CREATE UNIQUE INDEX uq_tenant_lesson_capacity_default_loc
        ON tenant_lesson_capacity_rules (client_slug, location_id)
        WHERE scope = 'default' AND active = true
    $sql$
  );

  PERFORM pg_temp.wh039_ensure_target_index(
    'uq_tenant_lesson_capacity_weekday_loc',
    'tenant_lesson_capacity_rules',
    true,
    'btree',
    ARRAY['client_slug', 'location_id', 'weekday'],
    'scope = ''weekday'' AND active = true',
    $sql$
      CREATE UNIQUE INDEX uq_tenant_lesson_capacity_weekday_loc
        ON tenant_lesson_capacity_rules (client_slug, location_id, weekday)
        WHERE scope = 'weekday' AND active = true
    $sql$
  );

  PERFORM pg_temp.wh039_ensure_target_index(
    'uq_tenant_lesson_capacity_date_loc',
    'tenant_lesson_capacity_rules',
    true,
    'btree',
    ARRAY['client_slug', 'location_id', 'service_date'],
    'scope = ''date'' AND active = true',
    $sql$
      CREATE UNIQUE INDEX uq_tenant_lesson_capacity_date_loc
        ON tenant_lesson_capacity_rules (client_slug, location_id, service_date)
        WHERE scope = 'date' AND active = true
    $sql$
  );

  PERFORM pg_temp.wh039_ensure_target_index(
    'uq_tenant_lesson_time_recurring_loc',
    'tenant_lesson_time_rules',
    true,
    'btree',
    ARRAY['client_slug', 'location_id', 'lesson_type', 'time_local'],
    'service_date IS NULL AND active = true',
    $sql$
      CREATE UNIQUE INDEX uq_tenant_lesson_time_recurring_loc
        ON tenant_lesson_time_rules (client_slug, location_id, lesson_type, time_local)
        WHERE service_date IS NULL AND active = true
    $sql$
  );

  PERFORM pg_temp.wh039_ensure_target_index(
    'uq_tenant_lesson_time_date_loc',
    'tenant_lesson_time_rules',
    true,
    'btree',
    ARRAY['client_slug', 'location_id', 'service_date', 'time_local', 'lesson_type'],
    'service_date IS NOT NULL AND active = true',
    $sql$
      CREATE UNIQUE INDEX uq_tenant_lesson_time_date_loc
        ON tenant_lesson_time_rules (client_slug, location_id, service_date, time_local, lesson_type)
        WHERE service_date IS NOT NULL AND active = true
    $sql$
  );
END $$;

-- Intentionally does not touch conversations / proposed 024 conversation-location DDL.

COMMIT;
