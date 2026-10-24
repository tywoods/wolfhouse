-- 120_luna_v3_constraint_ownership_and_transfer_decline.sql
-- Forward-only ownership remediation for the legacy 116 phone constraint and
-- authoritative linkage for successful declined transfer requests.
BEGIN;

-- Perform every ownership/shape check before the first COMMENT, DROP, ADD
-- COLUMN, or ADD CONSTRAINT. A refusal therefore leaves the whole predecessor
-- catalog untouched even before PostgreSQL's surrounding transaction rollback.
DO $preflight$
DECLARE
  marker constant text := '120_luna_v3_constraint_ownership_and_transfer_decline v1';
  phone_oid oid;
  phone_def text;
  phone_marker text;
  legacy_transfer_oid oid;
  legacy_transfer_marker text;
  owned_transfer_oid oid;
  owned_transfer_def text;
  owned_transfer_marker text;
  transfer_table_marker text;
BEGIN
  IF to_regclass('public.luna_v3_sessions') IS NULL
     OR to_regclass('public.luna_v3_transfer_requests') IS NULL
  THEN RAISE EXCEPTION '120_refused: prerequisite tables are missing'; END IF;

  SELECT oid,pg_get_constraintdef(oid,false),obj_description(oid,'pg_constraint')
    INTO phone_oid,phone_def,phone_marker
    FROM pg_constraint
   WHERE conrelid='public.luna_v3_sessions'::regclass
     AND conname='luna_v3_sessions_guest_phone_bounded';
  IF phone_oid IS NULL THEN
    RAISE EXCEPTION '120_refused: legacy 116 phone constraint is missing';
  END IF;
  IF phone_def IS DISTINCT FROM
       'CHECK (((guest_phone IS NULL) OR (((octet_length(guest_phone) >= 3) AND (octet_length(guest_phone) <= 40)) AND (guest_phone = btrim(guest_phone)))))'
  THEN RAISE EXCEPTION '120_refused: phone constraint is foreign/newer'; END IF;
  IF phone_marker IS NOT NULL AND phone_marker IS DISTINCT FROM marker THEN
    RAISE EXCEPTION '120_refused: phone constraint ownership is foreign/newer (%)',phone_marker;
  END IF;

  SELECT obj_description('public.luna_v3_transfer_requests'::regclass,'pg_class')
    INTO transfer_table_marker;
  IF transfer_table_marker IS DISTINCT FROM '115_luna_v3_guest_operations v1' THEN
    RAISE EXCEPTION '120_refused: transfer request table ownership is foreign/newer (%)',transfer_table_marker;
  END IF;

  SELECT oid,obj_description(oid,'pg_constraint')
    INTO legacy_transfer_oid,legacy_transfer_marker
    FROM pg_constraint
   WHERE conrelid='public.luna_v3_transfer_requests'::regclass
     AND pg_get_constraintdef(oid,false)=
       'CHECK (((decision = ''requested''::text) = (authoritative_transfer_id IS NOT NULL)))';
  SELECT oid,pg_get_constraintdef(oid,false),obj_description(oid,'pg_constraint')
    INTO owned_transfer_oid,owned_transfer_def,owned_transfer_marker
    FROM pg_constraint
   WHERE conrelid='public.luna_v3_transfer_requests'::regclass
     AND conname='luna_v3_transfer_requests_authoritative_required_120';

  IF legacy_transfer_oid IS NOT NULL AND owned_transfer_oid IS NOT NULL THEN
    RAISE EXCEPTION '120_refused: partial transfer constraint installation';
  ELSIF legacy_transfer_oid IS NOT NULL THEN
    IF legacy_transfer_marker IS NOT NULL THEN
      RAISE EXCEPTION '120_refused: legacy transfer constraint ownership is foreign/newer (%)',legacy_transfer_marker;
    END IF;
  ELSIF owned_transfer_oid IS NULL THEN
    RAISE EXCEPTION '120_refused: legacy transfer constraint is missing or foreign/newer';
  ELSIF owned_transfer_def IS DISTINCT FROM
          'CHECK (((NOT authoritative_link_required) OR (authoritative_transfer_id IS NOT NULL)))'
        OR owned_transfer_marker IS DISTINCT FROM marker THEN
    RAISE EXCEPTION '120_refused: transfer constraint is foreign/newer';
  ELSIF NOT EXISTS (
    SELECT 1
      FROM pg_attribute a
      JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE a.attrelid='public.luna_v3_transfer_requests'::regclass
       AND a.attname='authoritative_link_required'
       AND NOT a.attisdropped
       AND a.atttypid='boolean'::regtype
       AND a.attnotnull
       AND pg_get_expr(d.adbin,d.adrelid)='true'
       AND col_description(a.attrelid,a.attnum)=
         '120: false only for rows predating authoritative decline linkage; new rows default true'
  ) THEN
    RAISE EXCEPTION '120_refused: authoritative link marker column is missing, foreign, or newer';
  END IF;
END $preflight$;

DO $install$
DECLARE
  marker constant text := '120_luna_v3_constraint_ownership_and_transfer_decline v1';
  phone_marker text;
  legacy_transfer_oid oid;
  owned_transfer_oid oid;
BEGIN
  SELECT obj_description(oid,'pg_constraint') INTO phone_marker
    FROM pg_constraint
   WHERE conrelid='public.luna_v3_sessions'::regclass
     AND conname='luna_v3_sessions_guest_phone_bounded';
  IF phone_marker IS NULL THEN
    COMMENT ON CONSTRAINT luna_v3_sessions_guest_phone_bounded ON luna_v3_sessions IS
      '120_luna_v3_constraint_ownership_and_transfer_decline v1';
  END IF;

  SELECT oid INTO legacy_transfer_oid
    FROM pg_constraint
   WHERE conrelid='public.luna_v3_transfer_requests'::regclass
     AND pg_get_constraintdef(oid,false)=
       'CHECK (((decision = ''requested''::text) = (authoritative_transfer_id IS NOT NULL)))';
  SELECT oid INTO owned_transfer_oid
    FROM pg_constraint
   WHERE conrelid='public.luna_v3_transfer_requests'::regclass
     AND conname='luna_v3_transfer_requests_authoritative_required_120';

  IF legacy_transfer_oid IS NOT NULL THEN
    EXECUTE format('ALTER TABLE luna_v3_transfer_requests DROP CONSTRAINT %I',
      (SELECT conname FROM pg_constraint WHERE oid=legacy_transfer_oid));
    ALTER TABLE luna_v3_transfer_requests
      ADD COLUMN authoritative_link_required boolean NOT NULL DEFAULT false;
    ALTER TABLE luna_v3_transfer_requests
      ALTER COLUMN authoritative_link_required SET DEFAULT true;
    ALTER TABLE luna_v3_transfer_requests
      ADD CONSTRAINT luna_v3_transfer_requests_authoritative_required_120
      CHECK (NOT authoritative_link_required OR authoritative_transfer_id IS NOT NULL);
    COMMENT ON CONSTRAINT luna_v3_transfer_requests_authoritative_required_120
      ON luna_v3_transfer_requests IS
      '120_luna_v3_constraint_ownership_and_transfer_decline v1';
    COMMENT ON COLUMN luna_v3_transfer_requests.authoritative_link_required IS
      '120: false only for rows predating authoritative decline linkage; new rows default true';
  END IF;
END $install$;

COMMIT;
