-- Explicit down for 086_tenant_email_luna_automation_queue.
-- Fail closed when queue rows exist (refuse silent loss of claimed automation identity).
-- Does not drop parent uniques owned by 067/068/085 or the policy audit table.
-- Restores the empty pre-086 schema exactly: drops 086-owned queue/functions/FKs,
-- audit inbound_event_id column, audit/inbound/projection unique constraints, and
-- the inbound sender_address_normalized generated column after queue FKs are gone.
-- Second empty execution is safe: trigger drops are guarded by table existence.

BEGIN;
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
    IF EXISTS (SELECT 1 FROM public.tenant_email_luna_automation_queue) THEN
      RAISE EXCEPTION '086_down_refused: luna automation queue rows present — refuse silent identity loss';
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
    DROP TRIGGER IF EXISTS tenant_email_luna_automation_queue_protect ON public.tenant_email_luna_automation_queue;
    DROP TRIGGER IF EXISTS tenant_email_luna_automation_queue_protect_delete ON public.tenant_email_luna_automation_queue;
    DROP TRIGGER IF EXISTS tenant_email_luna_automation_queue_updated_at ON public.tenant_email_luna_automation_queue;
    DROP TRIGGER IF EXISTS tenant_email_luna_automation_queue_bind_recipient_digest ON public.tenant_email_luna_automation_queue;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_claim(uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_cancel_pending(uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_cancel_pending(uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_cancel_claimed(uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_require_handoff_pending(uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_require_handoff_pending(uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_require_handoff_claimed(uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_handoff(uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_terminalize_attempt_cap(uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_terminalize_attempt_cap(uuid);
DROP TABLE IF EXISTS public.tenant_email_luna_automation_queue;
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_queue_protect();
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_queue_bind_recipient_digest();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_policy_audit'
       AND c.relkind = 'r'
  ) THEN
    ALTER TABLE public.tenant_email_luna_policy_audit
      DROP CONSTRAINT IF EXISTS tenant_email_luna_policy_audit_authority_identity_uq;
    ALTER TABLE public.tenant_email_luna_policy_audit
      DROP COLUMN IF EXISTS inbound_event_id;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_inbound_inbox_projections'
       AND c.relkind = 'r'
  ) THEN
    ALTER TABLE public.tenant_email_inbound_inbox_projections
      DROP CONSTRAINT IF EXISTS tenant_email_inbound_inbox_projections_luna_authority_uq;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_inbound_events'
       AND c.relkind = 'r'
  ) THEN
    ALTER TABLE public.tenant_email_inbound_events
      DROP CONSTRAINT IF EXISTS tenant_email_inbound_events_luna_recipient_authority_uq;
    ALTER TABLE public.tenant_email_inbound_events
      DROP COLUMN IF EXISTS sender_address_normalized;
  END IF;
END $$;
COMMIT;
