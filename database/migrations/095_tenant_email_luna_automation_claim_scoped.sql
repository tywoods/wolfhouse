-- 095_tenant_email_luna_automation_claim_scoped.sql
-- FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B6: tenant/location/endpoint-scoped
-- next-claim for Sunset shadow activation. Does not rewrite 088
-- tenant_email_luna_automation_claim(uuid, uuid). Does not GRANT, CREATE ROLE,
-- or insert principal mappings. PUBLIC remains revoked.
--
-- 088 unscoped claim + principal_authorized owner-bypass is the table-owner
-- administrator path and stays available to existing callers. A Staff API
-- table-owner pool using that path can SKIP LOCKED an older non-Sunset row.
-- This function is the narrow worker owner: exact client_id + location_id +
-- location_key + endpoint_id, durable worker mapping, no table-owner bypass.
-- SKIP LOCKED / pending-or-expired-claimed attempt < 3 / 15-minute lease /
-- attempt increment / created_at order are preserved from 088.
--
-- Rollback: 095_tenant_email_luna_automation_claim_scoped_down.sql

BEGIN;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_claim_scoped(
  p_owner uuid,
  p_client_id uuid,
  p_location_id uuid,
  p_location_key text,
  p_endpoint_id uuid
) RETURNS SETOF public.tenant_email_luna_automation_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  UPDATE public.tenant_email_luna_automation_queue AS q
  SET
    state = 'claimed',
    lease_owner = p_owner,
    lease_expires_at = pg_catalog.now() + INTERVAL '15 minutes',
    attempt_count = q.attempt_count + 1
  WHERE q.operation_id = (
    SELECT operation_id
    FROM public.tenant_email_luna_automation_queue
    WHERE p_owner IS NOT NULL
      AND p_client_id IS NOT NULL
      AND p_location_id IS NOT NULL
      AND p_location_key IS NOT NULL
      AND p_endpoint_id IS NOT NULL
      AND client_id = p_client_id
      AND location_id = p_location_id
      AND location_key = p_location_key
      AND endpoint_id = p_endpoint_id
      AND session_user IS DISTINCT FROM (
        SELECT r.rolname
          FROM pg_catalog.pg_roles r
          JOIN pg_catalog.pg_class c ON c.relowner = r.oid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'tenant_email_luna_automation_queue'
           AND c.relkind = 'r'
      )
      AND EXISTS (
        SELECT 1
          FROM public.tenant_email_luna_automation_principals p
         WHERE p.role_name = session_user
           AND p.principal_kind = 'worker'
           AND p.client_id = p_client_id
           AND p.location_id = p_location_id
           AND p.location_key = p_location_key
      )
      AND (
        state = 'pending'
        OR (state = 'claimed' AND lease_expires_at < pg_catalog.now() AND attempt_count < 3)
      )
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
$$;

DO $$
DECLARE
  table_owner name;
BEGIN
  SELECT r.rolname INTO table_owner
    FROM pg_catalog.pg_roles r
    JOIN pg_catalog.pg_class c ON c.relowner = r.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_email_luna_automation_queue'
     AND c.relkind = 'r';
  IF table_owner IS NULL THEN
    RAISE EXCEPTION '095: queue table owner missing';
  END IF;
  EXECUTE format(
    'ALTER FUNCTION public.tenant_email_luna_automation_claim_scoped(uuid, uuid, uuid, text, uuid) OWNER TO %I',
    table_owner
  );
END $$;

COMMENT ON FUNCTION public.tenant_email_luna_automation_claim_scoped(uuid, uuid, uuid, text, uuid) IS
  'Worker next-claim scoped by exact client_id+location_id+location_key+endpoint_id and durable worker session_user mapping. No table-owner bypass. FOR UPDATE SKIP LOCKED. Does not rewrite 088 unscoped claim. Does not invoke a provider.';

REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_claim_scoped(uuid, uuid, uuid, text, uuid) FROM PUBLIC;

COMMIT;
