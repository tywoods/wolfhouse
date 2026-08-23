-- Explicit down for 088_tenant_email_luna_automation_principal_grants.
-- Fail closed when principal mapping rows exist (refuse silent loss of the
-- runtime grant boundary). Empty mapping: drop 088 objects, disable queue RLS,
-- restore 086 mutation functions and the 087 journal handoff function.
-- Second empty execution is safe.

BEGIN;

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
    IF EXISTS (SELECT 1 FROM public.tenant_email_luna_automation_principals) THEN
      RAISE EXCEPTION '088_down_refused: luna automation principal mapping rows present — refuse silent grant-boundary loss';
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
    DROP POLICY IF EXISTS tenant_email_luna_automation_queue_principal_select
      ON public.tenant_email_luna_automation_queue;
    ALTER TABLE public.tenant_email_luna_automation_queue DISABLE ROW LEVEL SECURITY;
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
    DROP TRIGGER IF EXISTS tenant_email_luna_automation_principals_protect
      ON public.tenant_email_luna_automation_principals;
  END IF;
END $$;

DROP TABLE IF EXISTS public.tenant_email_luna_automation_principals;
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_journal_handoff_lock(uuid, uuid);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_principals_protect();

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_enqueue(
  p_operation_id uuid,
  p_issuance_id uuid,
  p_audit_operation_id uuid,
  p_client_id uuid,
  p_location_id uuid,
  p_location_key text,
  p_endpoint_id uuid,
  p_conversation_id uuid,
  p_inbound_event_id uuid,
  p_recipient_address text,
  p_policy_version text,
  p_eligibility_policy_version text,
  p_validator_version text,
  p_draft_digest text
) RETURNS SETOF public.tenant_email_luna_automation_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  INSERT INTO public.tenant_email_luna_automation_queue (
    operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
    endpoint_id, conversation_id, inbound_event_id, recipient_address, policy_version,
    eligibility_policy_version, validator_version, draft_digest
  ) VALUES (
    p_operation_id, p_issuance_id, p_audit_operation_id, p_client_id, p_location_id, p_location_key,
    p_endpoint_id, p_conversation_id, p_inbound_event_id, p_recipient_address, p_policy_version,
    p_eligibility_policy_version, p_validator_version, p_draft_digest
  )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_claim(p_owner uuid, p_operation uuid)
RETURNS SETOF public.tenant_email_luna_automation_queue
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
    WHERE (
        (p_operation IS NULL AND (
          state = 'pending'
          OR (state = 'claimed' AND lease_expires_at < pg_catalog.now() AND attempt_count < 3)
        ))
        OR (
          p_operation IS NOT NULL AND operation_id = p_operation AND (
            state = 'pending'
            OR (state = 'claimed' AND lease_expires_at < pg_catalog.now() AND attempt_count < 3)
          )
        )
      )
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_cancel_pending(p_client_id uuid, p_operation uuid)
RETURNS SETOF public.tenant_email_luna_automation_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  UPDATE public.tenant_email_luna_automation_queue
  SET state = 'cancelled'
  WHERE operation_id = p_operation
    AND client_id = p_client_id
    AND state = 'pending'
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_cancel_claimed(p_operation uuid, p_owner uuid)
RETURNS SETOF public.tenant_email_luna_automation_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  UPDATE public.tenant_email_luna_automation_queue
  SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
  WHERE operation_id = p_operation
    AND state = 'claimed'
    AND lease_owner = p_owner
    AND lease_expires_at >= pg_catalog.now()
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_require_handoff_pending(p_client_id uuid, p_operation uuid)
RETURNS SETOF public.tenant_email_luna_automation_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  UPDATE public.tenant_email_luna_automation_queue
  SET state = 'handoff_required'
  WHERE operation_id = p_operation
    AND client_id = p_client_id
    AND state = 'pending'
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_require_handoff_claimed(p_operation uuid, p_owner uuid)
RETURNS SETOF public.tenant_email_luna_automation_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  UPDATE public.tenant_email_luna_automation_queue
  SET state = 'handoff_required', lease_owner = NULL, lease_expires_at = NULL
  WHERE operation_id = p_operation
    AND state = 'claimed'
    AND lease_owner = p_owner
    AND lease_expires_at >= pg_catalog.now()
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_handoff(p_operation uuid, p_owner uuid)
RETURNS SETOF public.tenant_email_luna_automation_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  q public.tenant_email_luna_automation_queue;
  j public.tenant_email_outbound_send_journal;
  endpoint_provider text;
  owner_digest text;
BEGIN
  IF p_operation IS NULL OR p_owner IS NULL THEN
    RETURN;
  END IF;

  owner_digest := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(('luna-replay-owner-v1:' || p_owner::text), 'UTF8')
    ),
    'hex'
  );

  SELECT * INTO q
    FROM public.tenant_email_luna_automation_queue
   WHERE operation_id = p_operation
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO j
    FROM public.tenant_email_outbound_send_journal
   WHERE operation_id = p_operation
   FOR UPDATE;

  IF q.state = 'handed_off' THEN
    IF j.luna_replay_owner_digest IS NULL
       OR j.luna_replay_owner_digest IS DISTINCT FROM owner_digest THEN
      RETURN;
    END IF;
    IF j.operation_id IS NULL
       OR j.luna_automation_operation_id IS DISTINCT FROM q.operation_id
       OR j.luna_automation_issuance_id IS DISTINCT FROM q.issuance_id
       OR j.luna_automation_audit_operation_id IS DISTINCT FROM q.audit_operation_id
       OR j.client_id IS DISTINCT FROM q.client_id
       OR j.location_id IS DISTINCT FROM q.location_id
       OR j.location_key IS DISTINCT FROM q.location_key
       OR j.endpoint_id IS DISTINCT FROM q.endpoint_id
       OR j.conversation_id IS DISTINCT FROM q.conversation_id
       OR j.luna_inbound_event_id IS DISTINCT FROM q.inbound_event_id
       OR j.luna_recipient_address IS DISTINCT FROM q.recipient_address
       OR j.body_digest IS DISTINCT FROM q.draft_digest
       OR j.phase IS DISTINCT FROM 'handoff_established'
       OR j.outcome IS DISTINCT FROM 'handed_off'
       OR j.immutable_draft_id IS NOT NULL
       OR j.create_invocation_count IS DISTINCT FROM 0
       OR j.update_invocation_count IS DISTINCT FROM 0
       OR j.send_invocation_count IS DISTINCT FROM 0
       OR j.approval_id IS NOT NULL
       OR j.actor_staff_user_id IS NOT NULL
       OR j.provider IS DISTINCT FROM 'microsoft_graph'
       OR j.luna_replay_owner_digest IS DISTINCT FROM owner_digest
       OR q.handoff_id IS DISTINCT FROM j.operation_id THEN
      RAISE EXCEPTION 'tenant_email_luna_automation_handoff: journal identity conflict' USING ERRCODE = '23514';
    END IF;
    RETURN NEXT q;
    RETURN;
  END IF;

  IF q.state IS DISTINCT FROM 'claimed'
     OR q.lease_owner IS DISTINCT FROM p_owner
     OR q.lease_expires_at IS NULL
     OR q.lease_expires_at < pg_catalog.now()
     OR q.handoff_id IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT e.provider INTO endpoint_provider
    FROM public.tenant_channel_endpoints e
   WHERE e.id = q.endpoint_id
     AND e.client_id = q.client_id
     AND e.location_id = q.location_key;
  IF endpoint_provider IS DISTINCT FROM 'microsoft_graph' THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_handoff: endpoint provider refused' USING ERRCODE = '23514';
  END IF;

  IF j.operation_id IS NULL THEN
    BEGIN
      INSERT INTO public.tenant_email_outbound_send_journal (
        operation_id, client_id, location_id, location_key, endpoint_id, conversation_id,
        approval_id, actor_staff_user_id, provider, immutable_draft_id, body_digest,
        phase, outcome, create_invocation_count, update_invocation_count, send_invocation_count,
        luna_automation_operation_id, luna_automation_issuance_id, luna_automation_audit_operation_id,
        luna_inbound_event_id, luna_recipient_address, luna_replay_owner_digest
      ) VALUES (
        q.operation_id, q.client_id, q.location_id, q.location_key, q.endpoint_id, q.conversation_id,
        NULL, NULL, 'microsoft_graph', NULL, q.draft_digest,
        'handoff_established', 'handed_off', 0, 0, 0,
        q.operation_id, q.issuance_id, q.audit_operation_id,
        q.inbound_event_id, q.recipient_address,
        pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(('luna-replay-owner-v1:' || q.lease_owner::text), 'UTF8')
          ),
          'hex'
        )
      );
    EXCEPTION
      WHEN unique_violation THEN
        NULL;
    END;
    SELECT * INTO j
      FROM public.tenant_email_outbound_send_journal
     WHERE operation_id = p_operation
     FOR UPDATE;
  END IF;

  IF j.operation_id IS NULL
     OR j.luna_automation_operation_id IS DISTINCT FROM q.operation_id
     OR j.luna_automation_issuance_id IS DISTINCT FROM q.issuance_id
     OR j.luna_automation_audit_operation_id IS DISTINCT FROM q.audit_operation_id
     OR j.client_id IS DISTINCT FROM q.client_id
     OR j.location_id IS DISTINCT FROM q.location_id
     OR j.location_key IS DISTINCT FROM q.location_key
     OR j.endpoint_id IS DISTINCT FROM q.endpoint_id
     OR j.conversation_id IS DISTINCT FROM q.conversation_id
     OR j.luna_inbound_event_id IS DISTINCT FROM q.inbound_event_id
     OR j.luna_recipient_address IS DISTINCT FROM q.recipient_address
     OR j.body_digest IS DISTINCT FROM q.draft_digest
     OR j.phase IS DISTINCT FROM 'handoff_established'
     OR j.outcome IS DISTINCT FROM 'handed_off'
     OR j.immutable_draft_id IS NOT NULL
     OR j.create_invocation_count IS DISTINCT FROM 0
     OR j.update_invocation_count IS DISTINCT FROM 0
     OR j.send_invocation_count IS DISTINCT FROM 0
     OR j.approval_id IS NOT NULL
     OR j.actor_staff_user_id IS NOT NULL
     OR j.provider IS DISTINCT FROM 'microsoft_graph'
     OR j.luna_replay_owner_digest IS DISTINCT FROM owner_digest THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_handoff: journal identity conflict' USING ERRCODE = '23514';
  END IF;

  UPDATE public.tenant_email_luna_automation_queue
     SET state = 'handed_off',
         handoff_id = j.operation_id,
         lease_owner = NULL,
         lease_expires_at = NULL
   WHERE operation_id = p_operation
     AND state = 'claimed'
     AND lease_owner = p_owner
     AND lease_expires_at >= pg_catalog.now()
     AND handoff_id IS NULL
  RETURNING * INTO q;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_handoff: queue terminalize refused' USING ERRCODE = '23514';
  END IF;

  RETURN NEXT q;
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_terminalize_attempt_cap(p_operation uuid, p_owner uuid)
RETURNS SETOF public.tenant_email_luna_automation_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  UPDATE public.tenant_email_luna_automation_queue
  SET state = 'handoff_required', lease_owner = NULL, lease_expires_at = NULL
  WHERE operation_id = p_operation
    AND p_operation IS NOT NULL
    AND p_owner IS NOT NULL
    AND state = 'claimed'
    AND lease_owner = p_owner
    AND lease_expires_at < pg_catalog.now()
    AND attempt_count >= 3
  RETURNING *;
$$;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.tenant_email_luna_automation_queue FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.tenant_email_outbound_send_journal FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_claim(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_cancel_pending(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_cancel_claimed(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_require_handoff_pending(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_require_handoff_claimed(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_handoff(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_terminalize_attempt_cap(uuid, uuid) FROM PUBLIC;

COMMIT;
