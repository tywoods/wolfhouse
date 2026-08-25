-- Explicit down for 098_tenant_email_luna_controlled_drafting_staging_test_authorization.
-- Fail closed when authorization rows exist (refuse silent loss of the
-- server-owned staging test marker). ACCESS EXCLUSIVE lock before the
-- emptiness check. Empty table: drop 098 functions and table. Does not
-- drop 063/092/097 rows. Second empty execution is safe.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_controlled_drafting_staging_test_authorizations'
       AND c.relkind = 'r'
  ) THEN
    LOCK TABLE public.tenant_email_luna_controlled_drafting_staging_test_authorizations IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public.tenant_email_luna_controlled_drafting_staging_test_authorizations) THEN
      RAISE EXCEPTION '098_down_refused: luna controlled-drafting staging test authorization rows present — refuse silent evidence loss' USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS public.tenant_email_luna_controlled_drafting_staging_test_authorizations;

DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_staging_test_revoke(uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_staging_test_consume(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_staging_test_prove(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_staging_test_authorize(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_staging_schema_ready();
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_drafting_staging_test_auth_protect();

COMMIT;
