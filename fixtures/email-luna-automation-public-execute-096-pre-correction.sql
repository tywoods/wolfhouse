-- 096_tenant_email_luna_automation_public_execute.sql
-- FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1: revoke ambient PUBLIC EXECUTE on
-- every public-schema function and stop the applying owner from granting it by
-- default on future functions.
--
-- Why: PostgreSQL grants EXECUTE to PUBLIC on new functions unless default
-- privileges are altered. Direct ACL audit cannot see PUBLIC. Trusted
-- precreated worker adoption therefore fail-closes while any public-schema
-- function remains callable through ambient PUBLIC EXECUTE (pgcrypto, trigger
-- helpers, business functions). 086-095 already REVOKE PUBLIC on Luna
-- functions; this gate closes the rest of schema public.
--
-- Run as the application/table/function owner (queue table owner =
-- session_user = current_user). Does not CREATE ROLE, GRANT to any LOGIN,
-- name live roles/UUIDs, or change tables/data/providers/runtime flags.
-- Owner implicit EXECUTE is preserved (REVOKE FROM PUBLIC does not revoke
-- the owner). Existing explicit GRANT EXECUTE to named roles survive.
--
-- Owner / default-privilege nuance:
--   REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC covers
--   existing public-schema functions the applying owner can revoke, including
--   extension-owned functions such as pgcrypto when that owner created the
--   extension (typical). Functions owned by a different role are not
--   silently skipped: 096 fail-closes if any public-schema function remains
--   executable by PUBLIC.
--   ALTER DEFAULT PRIVILEGES applies only to objects later created by this
--   applying owner. Another owner (or an extension script that GRANT EXECUTE
--   TO PUBLIC explicitly) can reintroduce ambient PUBLIC execute. The
--   principal ambient audit still fail-closes on that reintroduction.
--   Procedures are outside this GRANT/REVOKE ALL FUNCTIONS shape.
--   Stock PostgreSQL records pg_default_acl. Some engines (PGlite) accept
--   ALTER DEFAULT PRIVILEGES but do not persist that catalog; 096 still
--   emits the statement. Stock-PG proofs verify newly created functions
--   default non-PUBLIC. Reintroduction is always caught by the principal
--   ambient audit.
--
-- Rollback: 096_tenant_email_luna_automation_public_execute_down.sql

BEGIN;

DO $$
DECLARE
  table_owner name;
  remaining text;
BEGIN
  SELECT r.rolname INTO table_owner
    FROM pg_catalog.pg_roles r
    JOIN pg_catalog.pg_class c ON c.relowner = r.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_email_luna_automation_queue'
     AND c.relkind = 'r';
  IF table_owner IS NULL THEN
    RAISE EXCEPTION '096: queue table owner missing' USING ERRCODE = '23514';
  END IF;
  IF session_user IS DISTINCT FROM table_owner
     OR current_user IS DISTINCT FROM table_owner THEN
    RAISE EXCEPTION '096: must run as queue table/function owner' USING ERRCODE = '42501';
  END IF;

  -- Existing functions in public, regardless of which of this owner's
  -- functions they are. Extension functions in public are included when
  -- this owner can revoke them.
  EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC';

  -- Future functions created by this owner no longer grant PUBLIC EXECUTE.
  -- Global + schema: per-schema defaults are unioned with the global
  -- default, so IN SCHEMA public alone does not override PUBLIC EXECUTE.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    table_owner
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    table_owner
  );

  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY p.proname)
    INTO remaining
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))
    ) a ON TRUE
   WHERE n.nspname = 'public'
     AND a.grantee = 0
     AND a.privilege_type = 'EXECUTE';
  IF remaining IS NOT NULL THEN
    RAISE EXCEPTION '096: public-schema function still executable by PUBLIC (%)', remaining
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_default_acl d
      JOIN pg_catalog.pg_roles r ON r.oid = d.defaclrole
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
      JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a ON TRUE
     WHERE r.rolname = table_owner
       AND d.defaclobjtype = 'f'
       AND (d.defaclnamespace = 0 OR n.nspname = 'public')
       AND a.grantee = 0
       AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION '096: applying owner default privileges still grant PUBLIC EXECUTE'
      USING ERRCODE = '42501';
  END IF;
END $$;

COMMIT;
