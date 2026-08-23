-- Explicit down for 089_tenant_email_luna_automation_issuance_material.
-- Fail closed when issuance-material rows exist (refuse silent loss of
-- reconstitution/audit truth, including confidential booking/payment values).
-- Fail closed when producer mappings exist (refuse restoring the 088
-- worker/operator kind constraint while producer rows remain).
-- Empty table and no producer mappings: drop 089 objects, restore the 088
-- principal-kind constraint and principal_authorized body. Does not drop
-- 085/086/087/088, inbound, or queue rows. Second empty execution is safe.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_automation_issuance_material'
       AND c.relkind = 'r'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.tenant_email_luna_automation_issuance_material) THEN
      RAISE EXCEPTION '089_down_refused: luna issuance material rows present — refuse silent reconstitution/audit truth loss' USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_automation_principals'
       AND c.relkind = 'r'
  ) THEN
    IF EXISTS (
      SELECT 1
        FROM public.tenant_email_luna_automation_principals
       WHERE principal_kind = 'producer'
    ) THEN
      RAISE EXCEPTION '089_down_refused: producer principal mappings present — refuse restoring 088 kind constraint' USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_automation_queue'
       AND c.relkind = 'r'
  ) THEN
    DROP TRIGGER IF EXISTS tenant_email_luna_automation_queue_require_issuance_material
      ON public.tenant_email_luna_automation_queue;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_automation_issuance_material'
       AND c.relkind = 'r'
  ) THEN
    DROP POLICY IF EXISTS tenant_email_luna_automation_issuance_material_principal_select
      ON public.tenant_email_luna_automation_issuance_material;
    DROP TRIGGER IF EXISTS tenant_email_luna_automation_issuance_material_protect_update
      ON public.tenant_email_luna_automation_issuance_material;
    DROP TRIGGER IF EXISTS tenant_email_luna_automation_issuance_material_protect_delete
      ON public.tenant_email_luna_automation_issuance_material;
    ALTER TABLE public.tenant_email_luna_automation_issuance_material DISABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_issuance_material_load(uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_persist_and_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_queue_require_issuance_material();
DROP TABLE IF EXISTS public.tenant_email_luna_automation_issuance_material;
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_issuance_material_protect();
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_issuance_material_facts_ok(jsonb, text[], uuid, uuid);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_automation_principals'
       AND c.relkind = 'r'
  ) THEN
    ALTER TABLE public.tenant_email_luna_automation_principals
      DROP CONSTRAINT IF EXISTS tenant_email_luna_automation_principals_kind_chk;
    ALTER TABLE public.tenant_email_luna_automation_principals
      ADD CONSTRAINT tenant_email_luna_automation_principals_kind_chk
        CHECK (principal_kind IN ('worker', 'operator'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_principal_authorized(
  p_kind text,
  p_client_id uuid,
  p_location_id uuid,
  p_location_key text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT
    CASE
      WHEN p_kind IS NULL OR p_kind NOT IN ('worker', 'operator')
        OR p_client_id IS NULL OR p_location_id IS NULL OR p_location_key IS NULL THEN FALSE
      WHEN session_user IS NOT DISTINCT FROM (
        SELECT r.rolname
          FROM pg_catalog.pg_roles r
          JOIN pg_catalog.pg_class c ON c.relowner = r.oid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'tenant_email_luna_automation_queue'
           AND c.relkind = 'r'
      ) THEN TRUE
      ELSE EXISTS (
        SELECT 1
          FROM public.tenant_email_luna_automation_principals p
         WHERE p.role_name = session_user
           AND p.principal_kind = p_kind
           AND p.client_id = p_client_id
           AND p.location_id = p_location_id
           AND p.location_key = p_location_key
      )
    END;
$$;

COMMIT;
