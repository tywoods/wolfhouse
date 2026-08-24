-- Explicit down for 093_tenant_email_luna_automation_shadow_outcomes.
-- Fail closed when shadow-outcome rows exist (refuse silent loss of comparison
-- evidence). Empty table: drop 093 objects and restore the 086 queue protect
-- trigger plus 086 state_values/state_coupling. Does not drop 085/086/087/088/092,
-- inbound, journal, or queue rows. Second empty execution is safe.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_automation_shadow_outcomes'
       AND c.relkind = 'r'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.tenant_email_luna_automation_shadow_outcomes) THEN
      RAISE EXCEPTION '093_down_refused: luna shadow outcome rows present — refuse silent comparison-evidence loss' USING ERRCODE = '23514';
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
       AND c.relname = 'tenant_email_luna_automation_shadow_outcomes'
       AND c.relkind = 'r'
  ) THEN
    DROP POLICY IF EXISTS tenant_email_luna_automation_shadow_outcomes_principal_select
      ON public.tenant_email_luna_automation_shadow_outcomes;
    DROP TRIGGER IF EXISTS tenant_email_luna_automation_shadow_outcomes_protect_update
      ON public.tenant_email_luna_automation_shadow_outcomes;
    DROP TRIGGER IF EXISTS tenant_email_luna_automation_shadow_outcomes_protect_delete
      ON public.tenant_email_luna_automation_shadow_outcomes;
    ALTER TABLE public.tenant_email_luna_automation_shadow_outcomes DISABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_shadow_outcome_load(uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_capture_shadow(uuid, uuid);
DROP TABLE IF EXISTS public.tenant_email_luna_automation_shadow_outcomes;
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_shadow_outcomes_protect();

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
    ALTER TABLE public.tenant_email_luna_automation_queue
      DROP CONSTRAINT IF EXISTS tenant_email_luna_automation_queue_shadow_identity_uq;
    ALTER TABLE public.tenant_email_luna_automation_queue
      DROP CONSTRAINT IF EXISTS tenant_email_luna_automation_queue_state_coupling;
    ALTER TABLE public.tenant_email_luna_automation_queue
      DROP CONSTRAINT IF EXISTS tenant_email_luna_automation_queue_state_values;
    ALTER TABLE public.tenant_email_luna_automation_queue
      ADD CONSTRAINT tenant_email_luna_automation_queue_state_values
        CHECK (state IN ('pending', 'claimed', 'handed_off', 'handoff_required', 'cancelled'));
    ALTER TABLE public.tenant_email_luna_automation_queue
      ADD CONSTRAINT tenant_email_luna_automation_queue_state_coupling CHECK (
        (
          state = 'pending'
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
          AND handoff_id IS NULL
          AND attempt_count = 0
        )
        OR (
          state = 'claimed'
          AND lease_owner IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND handoff_id IS NULL
          AND attempt_count BETWEEN 1 AND 3
        )
        OR (
          state = 'handed_off'
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
          AND handoff_id IS NOT NULL
          AND attempt_count BETWEEN 1 AND 3
        )
        OR (
          state = 'cancelled'
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
          AND handoff_id IS NULL
          AND attempt_count BETWEEN 0 AND 3
        )
        OR (
          state = 'handoff_required'
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
          AND handoff_id IS NULL
          AND attempt_count BETWEEN 0 AND 3
        )
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_queue_protect() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_queue: delete refused' USING ERRCODE = '23514';
  END IF;
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.issuance_id IS DISTINCT FROM OLD.issuance_id
     OR NEW.audit_operation_id IS DISTINCT FROM OLD.audit_operation_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.location_key IS DISTINCT FROM OLD.location_key
     OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.inbound_event_id IS DISTINCT FROM OLD.inbound_event_id
     OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address
     OR NEW.recipient_digest IS DISTINCT FROM OLD.recipient_digest
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.eligibility_policy_version IS DISTINCT FROM OLD.eligibility_policy_version
     OR NEW.validator_version IS DISTINCT FROM OLD.validator_version
     OR NEW.draft_digest IS DISTINCT FROM OLD.draft_digest
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_queue: immutable field mutation refused' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_queue: attempt_count decrement refused' USING ERRCODE = '23514';
  END IF;
  IF OLD.handoff_id IS NOT NULL AND NEW.handoff_id IS DISTINCT FROM OLD.handoff_id THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_queue: handoff_id replacement refused' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state IS NOT DISTINCT FROM OLD.state
    OR (OLD.state = 'pending' AND NEW.state IN ('claimed', 'cancelled', 'handoff_required'))
    OR (OLD.state = 'claimed' AND NEW.state IN ('claimed', 'handed_off', 'cancelled', 'handoff_required'))
  ) THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_queue: illegal state transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'claimed' AND NEW.state = 'claimed' THEN
    IF NOT (
      OLD.lease_expires_at < pg_catalog.now()
      AND NEW.attempt_count = OLD.attempt_count + 1
      AND NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
      AND NEW.handoff_id IS NULL
    ) THEN
      RAISE EXCEPTION 'tenant_email_luna_automation_queue: illegal state transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.state = 'pending' AND NEW.state = 'claimed' THEN
    IF NOT (NEW.attempt_count = OLD.attempt_count + 1 AND NEW.lease_owner IS NOT NULL AND NEW.handoff_id IS NULL) THEN
      RAISE EXCEPTION 'tenant_email_luna_automation_queue: illegal state transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.state = 'claimed' AND NEW.state = 'handed_off' THEN
    IF NOT (OLD.lease_expires_at >= pg_catalog.now() AND NEW.handoff_id IS NOT NULL AND NEW.attempt_count = OLD.attempt_count) THEN
      RAISE EXCEPTION 'tenant_email_luna_automation_queue: illegal state transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.state = 'claimed' AND NEW.state = 'cancelled' THEN
    IF NOT (OLD.lease_expires_at >= pg_catalog.now() AND NEW.attempt_count = OLD.attempt_count AND NEW.handoff_id IS NULL) THEN
      RAISE EXCEPTION 'tenant_email_luna_automation_queue: illegal state transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.state = 'claimed' AND NEW.state = 'handoff_required' THEN
    IF NOT (
      NEW.attempt_count = OLD.attempt_count
      AND NEW.handoff_id IS NULL
      AND (
        OLD.lease_expires_at >= pg_catalog.now()
        OR (OLD.lease_expires_at < pg_catalog.now() AND OLD.attempt_count >= 3)
      )
    ) THEN
      RAISE EXCEPTION 'tenant_email_luna_automation_queue: illegal state transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
