-- Explicit down for 097_tenant_email_luna_controlled_draft_operations.
-- Fail closed when operation or transition rows exist (refuse silent loss of
-- provider-draft identity, create-dispatch evidence, or mismatch review state).
-- ACCESS EXCLUSIVE locks parent operations then child transitions before the
-- emptiness checks so a concurrent reserve/claim cannot commit between the
-- check and DROP, matching producer reserve / worker claim lock order and
-- avoiding 40P01 deadlock. Empty tables: drop 097 functions, tables, and the
-- inbound identity unique added for this slice. Does not drop 063/085/086/092
-- rows or send-journal objects. Second empty execution is safe.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_controlled_draft_operations'
       AND c.relkind = 'r'
  ) AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_controlled_draft_transitions'
       AND c.relkind = 'r'
  ) THEN
    LOCK TABLE public.tenant_email_luna_controlled_draft_operations, public.tenant_email_luna_controlled_draft_transitions IN ACCESS EXCLUSIVE MODE;
  ELSIF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_controlled_draft_operations'
       AND c.relkind = 'r'
  ) THEN
    LOCK TABLE public.tenant_email_luna_controlled_draft_operations IN ACCESS EXCLUSIVE MODE;
  ELSIF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_controlled_draft_transitions'
       AND c.relkind = 'r'
  ) THEN
    LOCK TABLE public.tenant_email_luna_controlled_draft_transitions IN ACCESS EXCLUSIVE MODE;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_controlled_draft_transitions'
       AND c.relkind = 'r'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.tenant_email_luna_controlled_draft_transitions) THEN
      RAISE EXCEPTION '097_down_refused: luna controlled-draft transition rows present — refuse silent create-dispatch/reconciliation evidence loss' USING ERRCODE = '23514';
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
       AND c.relname = 'tenant_email_luna_controlled_draft_operations'
       AND c.relkind = 'r'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.tenant_email_luna_controlled_draft_operations) THEN
      RAISE EXCEPTION '097_down_refused: luna controlled-draft operation rows present — refuse silent provider-draft identity loss' USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

-- Both ACCESS EXCLUSIVE locks are held before emptiness checks. DROP child
-- transitions then parent operations (FK order), never lock child-before-parent.
DROP TABLE IF EXISTS public.tenant_email_luna_controlled_draft_transitions;
DROP TABLE IF EXISTS public.tenant_email_luna_controlled_draft_operations;

DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_load(uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_reconcile(uuid, uuid, integer, jsonb);
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_record_create(uuid, uuid, integer, jsonb);
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_claim_create(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_reserve(uuid, uuid, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_append_history(uuid, uuid, text, text, text, text, integer);
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_actor_kind(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_transitions_protect();
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_operations_protect();
DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_provider_id_ok(text);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'tenant_email_inbound_events_controlled_draft_identity_uq'
  ) THEN
    ALTER TABLE public.tenant_email_inbound_events
      DROP CONSTRAINT tenant_email_inbound_events_controlled_draft_identity_uq;
  END IF;
END $$;

COMMIT;
