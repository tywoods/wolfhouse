-- 088_tenant_email_luna_automation_principal_grants.sql
-- FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice A: runtime DB principal / grant boundary
-- for the merged Luna automation queue + canonical-journal handoff.
--
-- Architecture (verified, not assumed):
--   Live clients use isolated Postgres databases (Wolfhouse vs Sunset vs Mirleft).
--   Locations of one client share that client's DB. Schema authority still carries
--   client_id + location_id + location_key. Staging may share a server; rows are
--   still tenant-keyed. A shared worker LOGIN with EXECUTE on 086/087 SECURITY
--   DEFINER functions can otherwise mutate arbitrary tenant/location rows because
--   those functions trust caller-supplied ids / global SKIP LOCKED claim.
--   Caller-settable custom GUCs are not authorization (086/087 already forbid them).
--   session_user is the authenticated LOGIN principal and cannot be forged by
--   ordinary callers (SET ROLE does not change it; SET SESSION AUTHORIZATION is
--   superuser-only).
--
-- Design: durable mapping of LOGIN role_name → exactly one (client, location, kind).
-- Mutation functions require session_user to match that mapping (or to be the
-- table owner, who is the out-of-band administrator — not an ordinary runtime
-- principal). Default-off: 088 does not CREATE ROLE, does not GRANT to any
-- product/login role, and does not insert mapping rows. Privileges exist only
-- after explicit offline provisioning.
--
-- Queue SELECT is RLS ENABLE (not FORCE) so the table owner / Staff API bypasses
-- and a provisioned worker sees only mapped location rows. Journal RLS is not
-- enabled: tenant_email_outbound_send_journal is shared with staff Graph and this
-- repo has no prior RLS model; FORCE/ENABLE there would hide staff rows from any
-- non-owner reader. Workers receive no raw journal SELECT. The only worker journal
-- access is tenant_email_luna_automation_journal_handoff_lock, which authorizes
-- session_user against the queue client/location before locking or returning any
-- journal row, requires operation + replay owner, and returns no row/metadata for
-- a foreign location or wrong owner. Journal mutation remains function-only;
-- handoff_established stays sealed by 087. No provider create/update/send
-- authorization.
--
-- 088 does not CREATE ROLE and does not GRANT. PUBLIC remains revoked. Function
-- owner is the queue table / migration owner. SECURITY DEFINER search_path is
-- pg_catalog, public. No fake product login role, no hardcoded live credential,
-- no password, no current_setting.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tenant_email_luna_automation_principals (
  role_name name PRIMARY KEY,
  principal_kind text NOT NULL,
  client_id uuid NOT NULL,
  location_id uuid NOT NULL,
  location_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT tenant_email_luna_automation_principals_kind_chk
    CHECK (principal_kind IN ('worker', 'operator')),
  CONSTRAINT tenant_email_luna_automation_principals_role_shape
    CHECK (role_name::text ~ '^[a-z][a-z0-9_]{2,62}$' AND role_name::text !~ '^pg_'),
  CONSTRAINT tenant_email_luna_automation_principals_location_key_shape
    CHECK (location_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT tenant_email_luna_automation_principals_location_fk
    FOREIGN KEY (client_id, location_id, location_key)
    REFERENCES public.tenant_locations (client_id, id, location_id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_principals_protect()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, public
AS $$
DECLARE
  table_owner name;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_principals: rows are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT r.rolname INTO table_owner
      FROM pg_catalog.pg_roles r
      JOIN pg_catalog.pg_class c ON c.relowner = r.oid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_automation_queue'
       AND c.relkind = 'r';
    IF NEW.role_name IS NULL
       OR NEW.role_name::text !~ '^[a-z][a-z0-9_]{2,62}$'
       OR NEW.role_name::text LIKE 'pg_%'
       OR NEW.role_name IN (
            'public', 'postgres', 'azure_pg_admin', 'azure_superuser',
            'replication', 'current_user', 'session_user', 'user'
          )
       OR NEW.role_name IS NOT DISTINCT FROM table_owner THEN
      RAISE EXCEPTION 'tenant_email_luna_automation_principals: role is not a provisionable LOGIN principal' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles r
       WHERE r.rolname = NEW.role_name
         AND r.rolcanlogin IS TRUE
         AND r.rolsuper IS FALSE
         AND r.rolcreatedb IS FALSE
         AND r.rolcreaterole IS FALSE
         AND r.rolreplication IS FALSE
         AND r.rolbypassrls IS FALSE
    ) THEN
      RAISE EXCEPTION 'tenant_email_luna_automation_principals: role missing or attributes are not fail-closed LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_email_luna_automation_principals_protect ON public.tenant_email_luna_automation_principals;
CREATE TRIGGER tenant_email_luna_automation_principals_protect
  BEFORE INSERT OR UPDATE ON public.tenant_email_luna_automation_principals
  FOR EACH ROW EXECUTE FUNCTION public.tenant_email_luna_automation_principals_protect();

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
  )
  SELECT
    p_operation_id, p_issuance_id, p_audit_operation_id, p_client_id, p_location_id, p_location_key,
    p_endpoint_id, p_conversation_id, p_inbound_event_id, p_recipient_address, p_policy_version,
    p_eligibility_policy_version, p_validator_version, p_draft_digest
  WHERE public.tenant_email_luna_automation_principal_authorized(
    'worker', p_client_id, p_location_id, p_location_key
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
    WHERE public.tenant_email_luna_automation_principal_authorized(
            'worker', client_id, location_id, location_key
          )
      AND (
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
    AND public.tenant_email_luna_automation_principal_authorized(
          'operator', client_id, location_id, location_key
        )
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
    AND public.tenant_email_luna_automation_principal_authorized(
          'worker', client_id, location_id, location_key
        )
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
    AND public.tenant_email_luna_automation_principal_authorized(
          'operator', client_id, location_id, location_key
        )
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
    AND public.tenant_email_luna_automation_principal_authorized(
          'worker', client_id, location_id, location_key
        )
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
     AND public.tenant_email_luna_automation_principal_authorized(
           'worker', client_id, location_id, location_key
         )
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO j
    FROM public.tenant_email_outbound_send_journal
   WHERE operation_id = p_operation
     AND client_id = q.client_id
     AND location_id = q.location_id
     AND location_key = q.location_key
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
       AND client_id = q.client_id
       AND location_id = q.location_id
       AND location_key = q.location_key
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
     AND public.tenant_email_luna_automation_principal_authorized(
           'worker', client_id, location_id, location_key
         )
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
    AND public.tenant_email_luna_automation_principal_authorized(
          'worker', client_id, location_id, location_key
        )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_journal_handoff_lock(
  p_operation uuid,
  p_owner uuid
) RETURNS SETOF public.tenant_email_outbound_send_journal
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  q public.tenant_email_luna_automation_queue;
  j public.tenant_email_outbound_send_journal;
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
     AND public.tenant_email_luna_automation_principal_authorized(
           'worker', client_id, location_id, location_key
         )
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF q.state IS DISTINCT FROM 'handed_off' THEN
    RETURN;
  END IF;

  SELECT * INTO j
    FROM public.tenant_email_outbound_send_journal
   WHERE operation_id = p_operation
     AND client_id = q.client_id
     AND location_id = q.location_id
     AND location_key = q.location_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

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
    RAISE EXCEPTION 'tenant_email_luna_automation_journal_handoff_lock: journal identity conflict' USING ERRCODE = '23514';
  END IF;

  RETURN NEXT j;
  RETURN;
END;
$$;

DO $$
DECLARE
  table_owner name;
  fn_ident text;
  fns text[] := ARRAY[
    'tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text)',
    'tenant_email_luna_automation_principals_protect()',
    'tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text)',
    'tenant_email_luna_automation_claim(uuid, uuid)',
    'tenant_email_luna_automation_cancel_pending(uuid, uuid)',
    'tenant_email_luna_automation_cancel_claimed(uuid, uuid)',
    'tenant_email_luna_automation_require_handoff_pending(uuid, uuid)',
    'tenant_email_luna_automation_require_handoff_claimed(uuid, uuid)',
    'tenant_email_luna_automation_handoff(uuid, uuid)',
    'tenant_email_luna_automation_terminalize_attempt_cap(uuid, uuid)',
    'tenant_email_luna_automation_journal_handoff_lock(uuid, uuid)'
  ];
BEGIN
  SELECT r.rolname INTO table_owner
    FROM pg_catalog.pg_roles r
    JOIN pg_catalog.pg_class c ON c.relowner = r.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_email_luna_automation_queue'
     AND c.relkind = 'r';
  IF table_owner IS NULL THEN
    RAISE EXCEPTION '088: queue table owner missing';
  END IF;
  EXECUTE format('ALTER TABLE public.tenant_email_luna_automation_principals OWNER TO %I', table_owner);
  FOREACH fn_ident IN ARRAY fns LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO %I', fn_ident, table_owner);
  END LOOP;
END $$;

ALTER TABLE public.tenant_email_luna_automation_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_email_luna_automation_queue_principal_select
  ON public.tenant_email_luna_automation_queue;
CREATE POLICY tenant_email_luna_automation_queue_principal_select
  ON public.tenant_email_luna_automation_queue
  FOR SELECT
  USING (
    public.tenant_email_luna_automation_principal_authorized('worker', client_id, location_id, location_key)
    OR public.tenant_email_luna_automation_principal_authorized('operator', client_id, location_id, location_key)
  );

COMMENT ON TABLE public.tenant_email_luna_automation_principals IS
  'Ch4 durable LOGIN principal mapping. role_name = session_user. One role → one client/location/kind. Table owner provisions; ordinary workers cannot DML. Default empty.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text) IS
  'Non-forgeable authorization: session_user is table owner (administrator) or a mapped LOGIN principal of the requested kind and location. Not a custom GUC.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text) IS
  'Worker enqueue bound to session_user principal mapping. Function owner is table owner. Does not invoke a provider.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_claim(uuid, uuid) IS
  'Worker atomic lease claim with FOR UPDATE SKIP LOCKED, restricted to the session_user mapped location.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_cancel_pending(uuid, uuid) IS
  'Operator-only tenant/location-scoped cancel of pending rows. UUID knowledge is not authorization.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_cancel_claimed(uuid, uuid) IS
  'Worker live claimed owner CAS cancel, restricted to the session_user mapped location.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_require_handoff_pending(uuid, uuid) IS
  'Operator-only tenant/location-scoped handoff_required of pending rows. UUID knowledge is not authorization.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_require_handoff_claimed(uuid, uuid) IS
  'Worker live claimed owner CAS reclassify, restricted to the session_user mapped location.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_handoff(uuid, uuid) IS
  'Worker live claimed owner CAS handoff, restricted to the session_user mapped location. Queue SELECT FOR UPDATE includes principal_authorized so a foreign UUID cannot lock or probe. Preserves 087 sealed handoff_established journal identity. Does not invoke a provider.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_terminalize_attempt_cap(uuid, uuid) IS
  'Worker owner-scoped attempt-cap terminalization, restricted to the session_user mapped location.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_journal_handoff_lock(uuid, uuid) IS
  'Narrow worker journal read/lock/replay-verification. Authorizes session_user against the queue client/location before locking journal. Requires operation + replay owner. Returns no row/metadata for a foreign location or wrong owner. Validates exact Luna handoff_established identity. Does not invoke a provider.';

REVOKE INSERT, UPDATE, DELETE ON TABLE public.tenant_email_luna_automation_queue FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.tenant_email_outbound_send_journal FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_email_luna_automation_principals FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_principals_protect() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_claim(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_cancel_pending(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_cancel_claimed(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_require_handoff_pending(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_require_handoff_claimed(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_handoff(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_terminalize_attempt_cap(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_journal_handoff_lock(uuid, uuid) FROM PUBLIC;

COMMIT;
