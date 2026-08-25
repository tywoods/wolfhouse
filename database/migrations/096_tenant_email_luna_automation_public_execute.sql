-- 096_tenant_email_luna_automation_public_execute.sql
-- FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1: revoke ambient PUBLIC EXECUTE on
-- every public-schema function the applying owner can revoke, stop that owner
-- from granting PUBLIC EXECUTE by default, and fail closed on every remaining
-- PUBLIC-executable public-schema routine except the frozen stock pgcrypto 1.3
-- computational allowlist proven by catalogs as members of extension pgcrypto.
--
-- Why: PostgreSQL grants EXECUTE to PUBLIC on new functions unless default
-- privileges are altered. Direct ACL audit cannot see PUBLIC. Trusted
-- precreated worker adoption therefore fail-closes while any public-schema
-- function remains callable through ambient PUBLIC EXECUTE (pgcrypto, trigger
-- helpers, business functions). 086-095 already REVOKE PUBLIC on Luna
-- functions; this gate closes the rest of schema public.
--
-- Azure-compatible residual: some engines install pgcrypto as another owner
-- so REVOKE ALL FUNCTIONS cannot touch those members. 096 does not trust
-- owner name, search_path, env, or caller input. Residual PUBLIC execute is
-- allowed only when all of the following hold for that exact routine:
--   * pg_depend deptype=e membership of pg_extension.extname=pgcrypto
--   * extversion is exactly 1.3 (stock pgcrypto--1.3.sql; 1.4 adds
--     fips_mode() and is not this residual)
--   * prokind=f, LANGUAGE c, NOT SECURITY DEFINER, no SET/proconfig
--   * exact input identity arguments (oidvectortypes(proargtypes); OUT
--     omitted) plus expected volatility/strict/set-returning properties
--     from the frozen 36-signature allowlist
-- public.gen_random_uuid() is exempt only as that catalog-proven pgcrypto 1.3
-- member. pg_catalog.gen_random_uuid() is core PG13+ and is outside this
-- public-schema residual. Fake same-name, non-member, wrong version, wrong
-- properties, extra extension members, and arbitrary PUBLIC functions fail.
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
--   executable by PUBLIC unless it is the frozen proven pgcrypto 1.3 residual.
--   ALTER DEFAULT PRIVILEGES applies only to objects later created by this
--   applying owner. Another owner (or an extension script that GRANT EXECUTE
--   TO PUBLIC explicitly) can reintroduce ambient PUBLIC execute. The
--   principal ambient audit still fail-closes on that reintroduction unless
--   the same catalog-proven pgcrypto 1.3 residual matches exactly.
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
  unpinned text;
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

  SELECT string_agg(n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')', ', ' ORDER BY p.proname, pg_catalog.oidvectortypes(p.proargtypes))
    INTO unpinned
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_depend d
      ON d.objid = p.oid
     AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
     AND d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
     AND d.deptype = 'e'
    JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
    JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))
    ) a ON TRUE
   WHERE n.nspname = 'public'
     AND e.extname = 'pgcrypto'
     AND e.extversion IS DISTINCT FROM '1.3'
     AND a.grantee = 0
     AND a.privilege_type = 'EXECUTE';
  IF unpinned IS NOT NULL THEN
    RAISE EXCEPTION '096: PUBLIC-executable pgcrypto residual is not pinned extension version 1.3 (%)', unpinned
      USING ERRCODE = '42501';
  END IF;

  SELECT string_agg(n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')', ', ' ORDER BY p.proname, pg_catalog.oidvectortypes(p.proargtypes))
    INTO remaining
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))
    ) a ON TRUE
   WHERE n.nspname = 'public'
     AND a.grantee = 0
     AND a.privilege_type = 'EXECUTE'
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_language l
         JOIN pg_catalog.pg_depend d
           ON d.objid = p.oid
          AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
          AND d.deptype = 'e'
         JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
         JOIN (VALUES
           -- NIGHTWATCH_PGCRYPTO_1_3_ALLOWLIST_BEGIN
           ('armor', 'bytea', 'i', FALSE, TRUE),
           ('armor', 'bytea, text[], text[]', 'i', FALSE, TRUE),
           ('crypt', 'text, text', 'i', FALSE, TRUE),
           ('dearmor', 'text', 'i', FALSE, TRUE),
           ('decrypt', 'bytea, bytea, text', 'i', FALSE, TRUE),
           ('decrypt_iv', 'bytea, bytea, bytea, text', 'i', FALSE, TRUE),
           ('digest', 'bytea, text', 'i', FALSE, TRUE),
           ('digest', 'text, text', 'i', FALSE, TRUE),
           ('encrypt', 'bytea, bytea, text', 'i', FALSE, TRUE),
           ('encrypt_iv', 'bytea, bytea, bytea, text', 'i', FALSE, TRUE),
           ('gen_random_bytes', 'integer', 'v', FALSE, TRUE),
           ('gen_random_uuid', '', 'v', FALSE, FALSE),
           ('gen_salt', 'text', 'v', FALSE, TRUE),
           ('gen_salt', 'text, integer', 'v', FALSE, TRUE),
           ('hmac', 'bytea, bytea, text', 'i', FALSE, TRUE),
           ('hmac', 'text, text, text', 'i', FALSE, TRUE),
           ('pgp_armor_headers', 'text', 'i', TRUE, TRUE),
           ('pgp_key_id', 'bytea', 'i', FALSE, TRUE),
           ('pgp_pub_decrypt', 'bytea, bytea', 'i', FALSE, TRUE),
           ('pgp_pub_decrypt', 'bytea, bytea, text', 'i', FALSE, TRUE),
           ('pgp_pub_decrypt', 'bytea, bytea, text, text', 'i', FALSE, TRUE),
           ('pgp_pub_decrypt_bytea', 'bytea, bytea', 'i', FALSE, TRUE),
           ('pgp_pub_decrypt_bytea', 'bytea, bytea, text', 'i', FALSE, TRUE),
           ('pgp_pub_decrypt_bytea', 'bytea, bytea, text, text', 'i', FALSE, TRUE),
           ('pgp_pub_encrypt', 'text, bytea', 'v', FALSE, TRUE),
           ('pgp_pub_encrypt', 'text, bytea, text', 'v', FALSE, TRUE),
           ('pgp_pub_encrypt_bytea', 'bytea, bytea', 'v', FALSE, TRUE),
           ('pgp_pub_encrypt_bytea', 'bytea, bytea, text', 'v', FALSE, TRUE),
           ('pgp_sym_decrypt', 'bytea, text', 'i', FALSE, TRUE),
           ('pgp_sym_decrypt', 'bytea, text, text', 'i', FALSE, TRUE),
           ('pgp_sym_decrypt_bytea', 'bytea, text', 'i', FALSE, TRUE),
           ('pgp_sym_decrypt_bytea', 'bytea, text, text', 'i', FALSE, TRUE),
           ('pgp_sym_encrypt', 'text, text', 'v', FALSE, TRUE),
           ('pgp_sym_encrypt', 'text, text, text', 'v', FALSE, TRUE),
           ('pgp_sym_encrypt_bytea', 'bytea, text', 'v', FALSE, TRUE),
           ('pgp_sym_encrypt_bytea', 'bytea, text, text', 'v', FALSE, TRUE)
           -- NIGHTWATCH_PGCRYPTO_1_3_ALLOWLIST_END
         ) AS allowlist(proname, identity_args, provolatile, proretset, proisstrict)
           ON allowlist.proname = p.proname
          AND allowlist.identity_args = pg_catalog.oidvectortypes(p.proargtypes)
          AND allowlist.provolatile = p.provolatile
          AND allowlist.proretset IS NOT DISTINCT FROM p.proretset
          AND allowlist.proisstrict IS NOT DISTINCT FROM p.proisstrict
        WHERE l.oid = p.prolang
          AND e.extname = 'pgcrypto'
          AND e.extversion = '1.3'
          AND p.prokind = 'f'
          AND p.prosecdef = false
          AND COALESCE(pg_catalog.cardinality(p.proconfig), 0) = 0
          AND l.lanname = 'c'
     );
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
