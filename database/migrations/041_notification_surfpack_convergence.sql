-- 041_notification_surfpack_convergence.sql
-- FOUNDATION Slice 13C.3c — fail-closed additive convergence for the six
-- remaining Phase C notification / surf-pack expected_only objects.
--
-- Scope (only):
--   * idx_client_notification_events_client_created
--   * idx_client_notification_events_conversation
--   * idx_client_notification_settings_client
--   * idx_tenant_surf_pack_client_loc
--   * tenant_surf_pack_rules_updated_by_fkey (FOREIGN KEY)
--   * tenant_surf_pack_rules_updated_at (TRIGGER)
--
-- Historical owners (immutable; not rewritten):
--   * 032_client_notification_settings.sql — three notification indexes
--   * 026_tenant_surf_pack_rules.sql — surf-pack index, FK (via REFERENCES), trigger
--
-- Explicitly excluded:
--   * tenant_services_date_window / tenant_services_price_unit CHECKs (Phase D)
--   * CMT / 035 changes
--   * tenant_services columns
--   * ownership / ACL mutation
--   * schema_migration_ledger bootstrap
--   * DROP / recreate of compatible objects
--
-- Safety:
--   * Forward-only additive convergence
--   * Exact compatible objects → preserve / no-op (OID-stable)
--   * Absent → CREATE
--   * Same-name or semantic conflict → RAISE (transaction rolls back)
--   * Catalog-validated (pg_catalog), not names / raw SQL alone
--
-- Lock/downtime: brief ShareLock / AccessExclusive around CREATE INDEX /
-- ADD CONSTRAINT / CREATE TRIGGER on typically small admin tables.
--
-- Apply after: 040_tenant_services_saas_catalog_columns.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- Preconditions: parent tables, columns, and set_updated_at()
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.client_notification_events') IS NULL
     OR to_regclass('public.client_notification_settings') IS NULL THEN
    RAISE EXCEPTION
      '041_notification_surfpack_convergence: notification tables missing (apply 032 first)';
  END IF;

  IF to_regclass('public.tenant_surf_pack_rules') IS NULL THEN
    RAISE EXCEPTION
      '041_notification_surfpack_convergence: tenant_surf_pack_rules missing (apply 026 first)';
  END IF;

  IF to_regclass('public.staff_users') IS NULL THEN
    RAISE EXCEPTION
      '041_notification_surfpack_convergence: staff_users missing (FK target; apply 009 first)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.tenant_surf_pack_rules'::regclass
      AND attname = 'updated_by'
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      '041_notification_surfpack_convergence: tenant_surf_pack_rules.updated_by missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.tenant_surf_pack_rules'::regclass
      AND attname = 'active'
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      '041_notification_surfpack_convergence: tenant_surf_pack_rules.active missing';
  END IF;

  IF to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION
      '041_notification_surfpack_convergence: public.set_updated_at() missing (apply 001 first)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Catalog helpers (indexes / FK / trigger)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.wh041_norm_expr(p_expr text)
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

CREATE OR REPLACE FUNCTION pg_temp.wh041_norm_funcdef(p_def text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $f$
  SELECT lower(regexp_replace(coalesce(p_def, ''), '\s+', '', 'g'));
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh041_index_state(
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
  key_expr text;
  indopts int2vector;
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
    pg_temp.wh041_norm_expr(pg_get_expr(i.indpred, i.indrelid)),
    EXISTS (
      SELECT 1 FROM pg_constraint co
      WHERE co.conindid = i.indexrelid
    ),
    i.indoption
  INTO
    o_schema,
    o_table,
    o_unique,
    o_am,
    nkey,
    natts,
    o_pred,
    o_constraint_owned,
    indopts
  FROM pg_index i
  JOIN pg_class rel ON rel.oid = i.indrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  JOIN pg_am am ON am.oid = (SELECT c.relam FROM pg_class c WHERE c.oid = i.indexrelid)
  WHERE i.indexrelid = idx;

  -- pg_get_indexdef(oid, colno) omits ASC/DESC; indoption is 0-based (DESC bit 0x0001).
  FOR i IN 1..nkey LOOP
    key_expr := pg_get_indexdef(idx, i, true);
    IF (COALESCE(indopts[i - 1], 0) & 1) = 1 THEN
      key_expr := key_expr || ' DESC';
    END IF;
    keys := keys || pg_temp.wh041_norm_expr(key_expr);
  END LOOP;
  o_keys := keys;
  o_has_include := natts > nkey;
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh041_index_matches(
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
  expected_pred text := pg_temp.wh041_norm_expr(p_pred);
  expected_keys text[];
  k text;
BEGIN
  SELECT * INTO st FROM pg_temp.wh041_index_state(p_index_name);
  IF NOT st.o_exists THEN
    RETURN false;
  END IF;

  expected_keys := ARRAY[]::text[];
  FOREACH k IN ARRAY p_keys LOOP
    expected_keys := expected_keys || pg_temp.wh041_norm_expr(k);
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

CREATE OR REPLACE FUNCTION pg_temp.wh041_ensure_target_index(
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
  SELECT * INTO st FROM pg_temp.wh041_index_state(p_index_name);
  IF NOT st.o_exists THEN
    EXECUTE p_create_sql;
    RETURN;
  END IF;

  IF st.o_constraint_owned THEN
    RAISE EXCEPTION
      '041: target index name % is occupied by a constraint-owned index',
      p_index_name;
  END IF;

  IF pg_temp.wh041_index_matches(p_index_name, p_table, p_unique, p_am, p_keys, p_pred) THEN
    RETURN; -- exact approved definition → preserve / no-op
  END IF;

  RAISE EXCEPTION
    '041: incompatible target index % (table=%.% unique=% am=% keys=% pred=% include=%); refuse drop/replace',
    p_index_name, st.o_schema, st.o_table, st.o_unique, st.o_am, st.o_keys, st.o_pred, st.o_has_include;
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh041_fk_state(
  p_conname text,
  OUT o_exists boolean,
  OUT o_oid oid,
  OUT o_table text,
  OUT o_src_cols text[],
  OUT o_tgt_table text,
  OUT o_tgt_cols text[],
  OUT o_updtype "char",
  OUT o_deltype "char",
  OUT o_matchtype "char",
  OUT o_validated boolean,
  OUT o_deferrable boolean,
  OUT o_deferred boolean,
  OUT o_type "char"
)
LANGUAGE plpgsql
AS $f$
DECLARE
  con oid;
  src text[];
  tgt text[];
BEGIN
  o_exists := false;
  o_oid := NULL;

  SELECT c.oid INTO con
  FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'public'
    AND c.conname = p_conname;

  IF con IS NULL THEN
    RETURN;
  END IF;

  o_exists := true;
  o_oid := con;

  SELECT
    rel.relname,
    c.contype,
    c.confupdtype,
    c.confdeltype,
    c.confmatchtype,
    c.convalidated,
    c.condeferrable,
    c.condeferred,
    ARRAY(
      SELECT a.attname
      FROM unnest(c.conkey) WITH ORDINALITY AS ck(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ck.attnum
      ORDER BY ck.ord
    ),
    tgtrel.relname,
    ARRAY(
      SELECT a.attname
      FROM unnest(c.confkey) WITH ORDINALITY AS ck(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = ck.attnum
      ORDER BY ck.ord
    )
  INTO
    o_table,
    o_type,
    o_updtype,
    o_deltype,
    o_matchtype,
    o_validated,
    o_deferrable,
    o_deferred,
    o_src_cols,
    o_tgt_table,
    o_tgt_cols
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  LEFT JOIN pg_class tgtrel ON tgtrel.oid = c.confrelid
  WHERE c.oid = con;
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh041_fk_matches(
  p_conname text,
  p_table text,
  p_src_cols text[],
  p_tgt_table text,
  p_tgt_cols text[],
  p_updtype "char",
  p_deltype "char",
  p_matchtype "char"
)
RETURNS boolean
LANGUAGE plpgsql
AS $f$
DECLARE
  st record;
BEGIN
  SELECT * INTO st FROM pg_temp.wh041_fk_state(p_conname);
  IF NOT st.o_exists THEN
    RETURN false;
  END IF;

  RETURN st.o_type = 'f'
    AND st.o_table = p_table
    AND st.o_src_cols IS NOT DISTINCT FROM p_src_cols
    AND st.o_tgt_table = p_tgt_table
    AND st.o_tgt_cols IS NOT DISTINCT FROM p_tgt_cols
    AND st.o_updtype = p_updtype
    AND st.o_deltype = p_deltype
    AND st.o_matchtype = p_matchtype
    AND st.o_validated IS TRUE
    AND st.o_deferrable IS NOT TRUE
    AND st.o_deferred IS NOT TRUE;
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh041_ensure_fk(
  p_conname text,
  p_table text,
  p_src_cols text[],
  p_tgt_table text,
  p_tgt_cols text[],
  p_updtype "char",
  p_deltype "char",
  p_matchtype "char",
  p_create_sql text
)
RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  st record;
BEGIN
  SELECT * INTO st FROM pg_temp.wh041_fk_state(p_conname);
  IF NOT st.o_exists THEN
    EXECUTE p_create_sql;
    RETURN;
  END IF;

  IF pg_temp.wh041_fk_matches(
    p_conname, p_table, p_src_cols, p_tgt_table, p_tgt_cols,
    p_updtype, p_deltype, p_matchtype
  ) THEN
    RETURN; -- exact approved FK → preserve / no-op
  END IF;

  RAISE EXCEPTION
    '041: incompatible FK % (table=% type=% src=% tgt=%.% upd=% del=% match=% validated=% deferrable=% deferred=%); refuse drop/replace',
    p_conname, st.o_table, st.o_type, st.o_src_cols, st.o_tgt_table, st.o_tgt_cols,
    st.o_updtype, st.o_deltype, st.o_matchtype, st.o_validated, st.o_deferrable, st.o_deferred;
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh041_expected_set_updated_at_prosrc()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $f$
  -- Semantic body from 001_init.sql set_updated_at(); compared via pg_proc.prosrc
  SELECT pg_temp.wh041_norm_funcdef($d$
BEGIN
 NEW.updated_at = NOW();
 RETURN NEW;
END;
$d$);
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh041_assert_set_updated_at_compatible()
RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  r record;
BEGIN
  SELECT
    p.proname,
    n.nspname,
    p.prorettype::regtype::text AS rettype,
    l.lanname,
    p.prosrc
  INTO r
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public'
    AND p.proname = 'set_updated_at'
    AND pg_get_function_identity_arguments(p.oid) = '';

  IF NOT FOUND THEN
    RAISE EXCEPTION '041: public.set_updated_at() missing';
  END IF;

  IF r.rettype <> 'trigger' THEN
    RAISE EXCEPTION '041: public.set_updated_at() return type % (expected trigger)', r.rettype;
  END IF;

  IF r.lanname <> 'plpgsql' THEN
    RAISE EXCEPTION '041: public.set_updated_at() language % (expected plpgsql)', r.lanname;
  END IF;

  IF pg_temp.wh041_norm_funcdef(r.prosrc)
       IS DISTINCT FROM pg_temp.wh041_expected_set_updated_at_prosrc() THEN
    RAISE EXCEPTION
      '041: incompatible public.set_updated_at() definition; refuse trigger convergence';
  END IF;
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh041_trigger_state(
  p_table text,
  p_trigger text,
  OUT o_exists boolean,
  OUT o_oid oid,
  OUT o_table text,
  OUT o_enabled "char",
  OUT o_tgtype int,
  OUT o_fn_identity text,
  OUT o_fn_prosrc text,
  OUT o_fn_rettype text,
  OUT o_fn_lang text,
  OUT o_nargs int,
  OUT o_args bytea
)
LANGUAGE plpgsql
AS $f$
DECLARE
  tg oid;
BEGIN
  o_exists := false;
  o_oid := NULL;

  SELECT t.oid INTO tg
  FROM pg_trigger t
  JOIN pg_class rel ON rel.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
  WHERE n.nspname = 'public'
    AND rel.relname = p_table
    AND t.tgname = p_trigger
    AND NOT t.tgisinternal;

  IF tg IS NULL THEN
    RETURN;
  END IF;

  o_exists := true;
  o_oid := tg;

  SELECT
    rel.relname,
    t.tgenabled,
    t.tgtype::int,
    nsp.nspname || '.' || p.proname || '()',
    p.prosrc,
    p.prorettype::regtype::text,
    l.lanname,
    t.tgnargs::int,
    t.tgargs
  INTO
    o_table,
    o_enabled,
    o_tgtype,
    o_fn_identity,
    o_fn_prosrc,
    o_fn_rettype,
    o_fn_lang,
    o_nargs,
    o_args
  FROM pg_trigger t
  JOIN pg_class rel ON rel.oid = t.tgrelid
  JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE t.oid = tg;
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh041_trigger_matches(
  p_table text,
  p_trigger text,
  p_tgtype int,
  p_enabled "char",
  p_fn_identity text
)
RETURNS boolean
LANGUAGE plpgsql
AS $f$
DECLARE
  st record;
BEGIN
  SELECT * INTO st FROM pg_temp.wh041_trigger_state(p_table, p_trigger);
  IF NOT st.o_exists THEN
    RETURN false;
  END IF;

  RETURN st.o_table = p_table
    AND st.o_tgtype = p_tgtype
    AND st.o_enabled = p_enabled
    AND st.o_fn_identity = p_fn_identity
    AND st.o_fn_rettype = 'trigger'
    AND st.o_fn_lang = 'plpgsql'
    AND pg_temp.wh041_norm_funcdef(st.o_fn_prosrc)
          = pg_temp.wh041_expected_set_updated_at_prosrc()
    AND st.o_nargs = 0
    AND (st.o_args IS NULL OR length(st.o_args) = 0);
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.wh041_ensure_trigger(
  p_table text,
  p_trigger text,
  p_tgtype int,
  p_enabled "char",
  p_fn_identity text,
  p_create_sql text
)
RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  st record;
BEGIN
  PERFORM pg_temp.wh041_assert_set_updated_at_compatible();

  SELECT * INTO st FROM pg_temp.wh041_trigger_state(p_table, p_trigger);
  IF NOT st.o_exists THEN
    EXECUTE p_create_sql;
    RETURN;
  END IF;

  IF pg_temp.wh041_trigger_matches(p_table, p_trigger, p_tgtype, p_enabled, p_fn_identity) THEN
    RETURN; -- exact approved trigger → preserve / no-op
  END IF;

  RAISE EXCEPTION
    '041: incompatible trigger %.% (enabled=% tgtype=% fn=% nargs=%); refuse drop/replace',
    p_table, p_trigger, st.o_enabled, st.o_tgtype, st.o_fn_identity, st.o_nargs;
END;
$f$;

-- ---------------------------------------------------------------------------
-- Ensure the six Phase C objects
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- Notification indexes (historical owner: 032)
  PERFORM pg_temp.wh041_ensure_target_index(
    'idx_client_notification_events_client_created',
    'client_notification_events',
    false,
    'btree',
    ARRAY['client_slug', 'created_at DESC'],
    NULL,
    $sql$
      CREATE INDEX idx_client_notification_events_client_created
        ON client_notification_events (client_slug, created_at DESC)
    $sql$
  );

  PERFORM pg_temp.wh041_ensure_target_index(
    'idx_client_notification_events_conversation',
    'client_notification_events',
    false,
    'btree',
    ARRAY['conversation_id', 'notification_type'],
    NULL,
    $sql$
      CREATE INDEX idx_client_notification_events_conversation
        ON client_notification_events (conversation_id, notification_type)
    $sql$
  );

  PERFORM pg_temp.wh041_ensure_target_index(
    'idx_client_notification_settings_client',
    'client_notification_settings',
    false,
    'btree',
    ARRAY['client_slug', 'location_id'],
    NULL,
    $sql$
      CREATE INDEX idx_client_notification_settings_client
        ON client_notification_settings (client_slug, location_id)
    $sql$
  );

  -- Surf-pack index (historical owner: 026)
  PERFORM pg_temp.wh041_ensure_target_index(
    'idx_tenant_surf_pack_client_loc',
    'tenant_surf_pack_rules',
    false,
    'btree',
    ARRAY['client_slug', 'location_id'],
    'active = true',
    $sql$
      CREATE INDEX idx_tenant_surf_pack_client_loc
        ON tenant_surf_pack_rules (client_slug, location_id)
        WHERE active = true
    $sql$
  );

  -- Surf-pack FK (historical owner: 026 column REFERENCES)
  -- confupdtype 'a' = NO ACTION; confdeltype 'n' = SET NULL; confmatchtype 's' = SIMPLE
  PERFORM pg_temp.wh041_ensure_fk(
    'tenant_surf_pack_rules_updated_by_fkey',
    'tenant_surf_pack_rules',
    ARRAY['updated_by'],
    'staff_users',
    ARRAY['id'],
    'a',
    'n',
    's',
    $sql$
      ALTER TABLE tenant_surf_pack_rules
        ADD CONSTRAINT tenant_surf_pack_rules_updated_by_fkey
        FOREIGN KEY (updated_by) REFERENCES staff_users(id) ON DELETE SET NULL
    $sql$
  );

  -- Surf-pack trigger (historical owner: 026)
  -- tgtype 19 = BEFORE (2) + ROW (1) + UPDATE (16)
  PERFORM pg_temp.wh041_ensure_trigger(
    'tenant_surf_pack_rules',
    'tenant_surf_pack_rules_updated_at',
    19,
    'O',
    'public.set_updated_at()',
    $sql$
      CREATE TRIGGER tenant_surf_pack_rules_updated_at
        BEFORE UPDATE ON tenant_surf_pack_rules
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    $sql$
  );
END $$;

COMMIT;
