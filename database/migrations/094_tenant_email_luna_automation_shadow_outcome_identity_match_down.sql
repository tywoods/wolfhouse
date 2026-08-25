-- Explicit down for 094_tenant_email_luna_automation_shadow_outcome_identity_match.
-- Restores the 093 project function body (unique 070 match labeled agreement).
-- Does not drop 093 tables/rows, queue terminals, or hashes. Second execution
-- is safe (CREATE OR REPLACE). Fail closed if the 093 outcomes table is absent.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.tenant_email_luna_automation_shadow_outcomes') IS NULL THEN
    RAISE EXCEPTION '094_down_refused: 093 shadow outcomes table missing' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_shadow_outcome_project(
  p_operation uuid,
  p_issuance uuid
) RETURNS TABLE (
  luna_decision text,
  comparison_state text,
  policy_version text,
  eligibility_policy_version text,
  validator_version text,
  queue_state text,
  human_bound boolean,
  duplicate_human boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  o public.tenant_email_luna_automation_shadow_outcomes;
  q public.tenant_email_luna_automation_queue;
  exact_count integer := 0;
  rebind_count integer := 0;
  matched text;
BEGIN
  IF p_operation IS NULL OR p_issuance IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO o
    FROM public.tenant_email_luna_automation_shadow_outcomes AS so
   WHERE so.operation_id = p_operation
     AND so.issuance_id = p_issuance
     AND public.tenant_email_luna_automation_principal_authorized(
           'worker', so.client_id, so.location_id, so.location_key
         )
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO q
    FROM public.tenant_email_luna_automation_queue AS qq
   WHERE qq.operation_id = o.operation_id
     AND qq.issuance_id = o.issuance_id
     AND public.tenant_email_luna_automation_principal_authorized(
           'worker', qq.client_id, qq.location_id, qq.location_key
         )
   FOR SHARE;
  IF NOT FOUND OR q.state IS DISTINCT FROM 'shadow_captured' THEN
    RETURN;
  END IF;

  IF pg_catalog.to_regclass('public.tenant_email_reply_approvals') IS NOT NULL THEN
    SELECT COUNT(*)::integer INTO exact_count
      FROM public.tenant_email_reply_approvals a
     WHERE a.client_id = o.client_id
       AND a.location_id = o.location_id
       AND a.endpoint_id = o.endpoint_id
       AND a.conversation_id = o.conversation_id
       AND a.source_inbound_event_id = o.inbound_event_id
       AND a.state IN ('approved', 'terminal');
    SELECT COUNT(*)::integer INTO rebind_count
      FROM public.tenant_email_reply_approvals a
     WHERE a.client_id = o.client_id
       AND a.source_inbound_event_id = o.inbound_event_id
       AND a.state IN ('approved', 'terminal')
       AND (
         a.location_id IS DISTINCT FROM o.location_id
         OR a.endpoint_id IS DISTINCT FROM o.endpoint_id
         OR a.conversation_id IS DISTINCT FROM o.conversation_id
       );
  END IF;

  IF rebind_count > 0 AND exact_count = 0 THEN
    matched := 'invalid';
  ELSIF exact_count = 0 THEN
    matched := 'pending_human';
  ELSIF exact_count = 1 AND rebind_count = 0 THEN
    matched := 'agreement';
  ELSE
    matched := 'excluded';
  END IF;

  luna_decision := o.luna_decision;
  comparison_state := matched;
  policy_version := o.policy_version;
  eligibility_policy_version := o.eligibility_policy_version;
  validator_version := o.validator_version;
  queue_state := q.state;
  human_bound := exact_count >= 1;
  duplicate_human := exact_count > 1;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid) IS
  'Staff-safe later-match projection. Hides raw UUIDs, recipient digest, and 070 body. Unique 070 approved|terminal on exact inbound/conversation/location/endpoint is agreement; none is pending_human; duplicates excluded; rebound inbound identity is invalid. Never infers disagreement from absence.';

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
    RAISE EXCEPTION '094_down: queue table owner missing';
  END IF;
  EXECUTE format(
    'ALTER FUNCTION public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid) OWNER TO %I',
    table_owner
  );
END $$;

REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid) FROM PUBLIC;

COMMIT;
