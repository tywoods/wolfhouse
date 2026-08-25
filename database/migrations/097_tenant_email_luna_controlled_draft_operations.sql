-- 097_tenant_email_luna_controlled_draft_operations.sql
-- FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 2: durable provider-draft
-- state machine. Dedicated table. NOT an outbound send journal, NOT a send
-- phase, NOT a send counter, NOT journal handoff. Send-inert. Empty on migrate.
--
-- Why a new table (inspection of 068/069/086/087/092/093):
--   068/069 are staff Graph reply-draft SEND authority (createReply→update→send
--     at most once). Their phases and counters authorize delivery. Reusing
--     them would couple Luna drafting to send.
--   086 is claim/lease identity only; no provider draft.
--   087 is queue→canonical-journal handoff (send-path). Forbidden here.
--   092 is reconstitution material, not a provider-draft lifecycle.
--   093 is shadow comparison, not a provider draft.
--
-- Canonical key: one row per authentic Stage 1 queue operation / issuance
-- (operation_id PK, unique issuance_id). Trusted scope is loaded from 092/086/082
-- /085/057 rows. Callers cannot invent tenant/location/mailbox/inbound/thread.
--
-- States (explicit; never claim delivery or send):
--   reserved
--   create_dispatched_outcome_unknown
--   provider_draft_reconciled_exact
--   provider_draft_modified_by_staff
--   provider_draft_removed_by_staff
--   provider_mismatch_blocked
--
-- Create dispatch is claimed at most once. Repeated claims return the existing
-- row. There is no attempt counter and no blind create retry. Unknown create
-- outcome cannot return to reserved; recovery is reconcile-only.
--
-- Mutation: SECURITY DEFINER functions only. Direct table DML denied.
-- 097 does not GRANT and does not CREATE ROLE. PUBLIC revoked.
-- search_path pg_catalog, public. Function owner is the queue table owner.
--
-- Rollback: 097_tenant_email_luna_controlled_draft_operations_down.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_inbound_events'
       AND a.attname = 'provider_mailbox_id'
       AND a.attnum > 0
       AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION '097_up_refused: inbound provider identity columns missing — refuse controlled-draft binding without 063 mailbox/message/thread identity' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'tenant_email_inbound_events_controlled_draft_identity_uq'
  ) THEN
    ALTER TABLE public.tenant_email_inbound_events
      ADD CONSTRAINT tenant_email_inbound_events_controlled_draft_identity_uq UNIQUE (
        id, client_id, location_id, endpoint_id, provider,
        provider_mailbox_id, provider_message_id, conversation_id
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_controlled_draft_provider_id_ok(p_id text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO pg_catalog, public
AS $$
  SELECT
    p_id IS NOT NULL
    AND char_length(p_id) BETWEEN 1 AND 2048
    AND p_id IS DISTINCT FROM '.'
    AND p_id IS DISTINCT FROM '..'
    AND p_id !~ '[/?#]'
    AND p_id ~ '^[\x21-\x7e]+$';
$$;

CREATE TABLE IF NOT EXISTS public.tenant_email_luna_controlled_draft_operations (
  operation_id uuid PRIMARY KEY,
  issuance_id uuid NOT NULL,
  audit_operation_id uuid NOT NULL,
  client_id uuid NOT NULL,
  location_id uuid NOT NULL,
  location_key text NOT NULL,
  endpoint_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  inbound_event_id uuid NOT NULL,
  provider text NOT NULL,
  mailbox_id text NOT NULL,
  inbound_provider_message_id text NOT NULL,
  inbound_provider_thread_id text NOT NULL,
  recipient_address text NOT NULL,
  canonical_subject text NOT NULL,
  canonical_body text NOT NULL,
  subject_digest text NOT NULL,
  body_digest text NOT NULL,
  draft_digest text NOT NULL,
  policy_version text NOT NULL,
  eligibility_policy_version text NOT NULL,
  validator_version text NOT NULL,
  state text NOT NULL,
  create_dispatch_claimed boolean NOT NULL DEFAULT FALSE,
  create_dispatch_claimed_at timestamptz NULL,
  provider_draft_id text NULL,
  is_draft boolean NULL,
  state_generation integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_issuance_uq UNIQUE (issuance_id),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_bind_uq UNIQUE (
    operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
    endpoint_id, conversation_id, inbound_event_id, provider, mailbox_id,
    inbound_provider_message_id, inbound_provider_thread_id, recipient_address, draft_digest
  ),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_material_fk
    FOREIGN KEY (
      operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
      endpoint_id, conversation_id, inbound_event_id, recipient_address, draft_digest
    )
    REFERENCES public.tenant_email_luna_automation_issuance_material (
      operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
      endpoint_id, conversation_id, inbound_event_id, recipient_address, draft_digest
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_controlled_draft_operations_inbound_fk
    FOREIGN KEY (
      inbound_event_id, client_id, location_id, endpoint_id, provider,
      mailbox_id, inbound_provider_message_id, inbound_provider_thread_id
    )
    REFERENCES public.tenant_email_inbound_events (
      id, client_id, location_id, endpoint_id, provider,
      provider_mailbox_id, provider_message_id, conversation_id
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_controlled_draft_operations_location_fk
    FOREIGN KEY (client_id, location_id, location_key)
    REFERENCES public.tenant_locations (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_controlled_draft_operations_endpoint_fk
    FOREIGN KEY (client_id, endpoint_id, location_key)
    REFERENCES public.tenant_channel_endpoints (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_controlled_draft_operations_location_key_shape
    CHECK (location_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(location_key) BETWEEN 1 AND 64),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_provider_values
    CHECK (provider = 'microsoft_graph'),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_mailbox_shape
    CHECK (public.tenant_email_luna_controlled_draft_provider_id_ok(mailbox_id)),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_inbound_message_shape
    CHECK (public.tenant_email_luna_controlled_draft_provider_id_ok(inbound_provider_message_id)),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_inbound_thread_shape
    CHECK (public.tenant_email_luna_controlled_draft_provider_id_ok(inbound_provider_thread_id)),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_recipient_shape
    CHECK (
      recipient_address = lower(recipient_address)
      AND recipient_address ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
      AND char_length(recipient_address) BETWEEN 3 AND 320
    ),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_subject_shape
    CHECK (char_length(canonical_subject) BETWEEN 1 AND 998),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_body_shape
    CHECK (char_length(canonical_body) BETWEEN 1 AND 64000),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_subject_digest_shape
    CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_body_digest_shape
    CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_draft_digest_shape
    CHECK (draft_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_policy_version_values
    CHECK (policy_version = 'email-luna-draft-policy.v1'),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_eligibility_version_values
    CHECK (eligibility_policy_version = 'email-luna-autonomous-eligibility-policy.v1'),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_validator_version_values
    CHECK (validator_version = 'email-luna-draft-validator.v1'),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_state_values
    CHECK (state IN (
      'reserved',
      'create_dispatched_outcome_unknown',
      'provider_draft_reconciled_exact',
      'provider_draft_modified_by_staff',
      'provider_draft_removed_by_staff',
      'provider_mismatch_blocked'
    )),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_generation_bounds
    CHECK (state_generation >= 1 AND state_generation <= 1000000000),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_draft_id_shape
    CHECK (
      provider_draft_id IS NULL
      OR public.tenant_email_luna_controlled_draft_provider_id_ok(provider_draft_id)
    ),
  CONSTRAINT tenant_email_luna_controlled_draft_operations_state_coupling CHECK (
    (
      state = 'reserved'
      AND create_dispatch_claimed IS FALSE
      AND create_dispatch_claimed_at IS NULL
      AND provider_draft_id IS NULL
      AND is_draft IS NULL
    )
    OR (
      state = 'create_dispatched_outcome_unknown'
      AND create_dispatch_claimed IS TRUE
      AND create_dispatch_claimed_at IS NOT NULL
      AND provider_draft_id IS NULL
      AND is_draft IS NULL
    )
    OR (
      state = 'provider_draft_reconciled_exact'
      AND create_dispatch_claimed IS TRUE
      AND create_dispatch_claimed_at IS NOT NULL
      AND provider_draft_id IS NOT NULL
      AND is_draft IS TRUE
    )
    OR (
      state = 'provider_draft_modified_by_staff'
      AND create_dispatch_claimed IS TRUE
      AND create_dispatch_claimed_at IS NOT NULL
      AND provider_draft_id IS NOT NULL
      AND is_draft IS TRUE
    )
    OR (
      state = 'provider_draft_removed_by_staff'
      AND create_dispatch_claimed IS TRUE
      AND create_dispatch_claimed_at IS NOT NULL
      AND provider_draft_id IS NOT NULL
    )
    OR (
      state = 'provider_mismatch_blocked'
      AND create_dispatch_claimed IS TRUE
      AND create_dispatch_claimed_at IS NOT NULL
    )
  )
);

COMMENT ON TABLE public.tenant_email_luna_controlled_draft_operations IS
  'Stage 2 Ch2 Luna controlled provider-draft operations. At most one Luna-owned draft per authentic issuance. No send phase, send counter, or send authorization. Trusted scope is loaded from Stage 1 rows.';

CREATE UNIQUE INDEX IF NOT EXISTS tenant_email_luna_controlled_draft_operations_provider_draft_uq
  ON public.tenant_email_luna_controlled_draft_operations (provider, provider_draft_id)
  WHERE provider_draft_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.tenant_email_luna_controlled_draft_transitions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  operation_id uuid NOT NULL,
  issuance_id uuid NOT NULL,
  from_state text NULL,
  to_state text NOT NULL,
  action text NOT NULL,
  actor_kind text NOT NULL,
  state_generation integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT tenant_email_luna_controlled_draft_transitions_operation_fk
    FOREIGN KEY (operation_id)
    REFERENCES public.tenant_email_luna_controlled_draft_operations (operation_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_controlled_draft_transitions_from_state_values
    CHECK (
      from_state IS NULL
      OR from_state IN (
        'reserved',
        'create_dispatched_outcome_unknown',
        'provider_draft_reconciled_exact',
        'provider_draft_modified_by_staff',
        'provider_draft_removed_by_staff',
        'provider_mismatch_blocked'
      )
    ),
  CONSTRAINT tenant_email_luna_controlled_draft_transitions_to_state_values
    CHECK (to_state IN (
      'reserved',
      'create_dispatched_outcome_unknown',
      'provider_draft_reconciled_exact',
      'provider_draft_modified_by_staff',
      'provider_draft_removed_by_staff',
      'provider_mismatch_blocked'
    )),
  CONSTRAINT tenant_email_luna_controlled_draft_transitions_action_values
    CHECK (action IN (
      'reserve',
      'claim_create',
      'record_create',
      'reconcile_exact',
      'reconcile_modified_by_staff',
      'reconcile_removed_by_staff',
      'reconcile_not_found',
      'reconcile_mismatch'
    )),
  CONSTRAINT tenant_email_luna_controlled_draft_transitions_actor_values
    CHECK (actor_kind IN ('producer', 'worker', 'table_owner')),
  CONSTRAINT tenant_email_luna_controlled_draft_transitions_generation_bounds
    CHECK (state_generation >= 1 AND state_generation <= 1000000000)
);

COMMENT ON TABLE public.tenant_email_luna_controlled_draft_transitions IS
  'Append-only controlled-draft transition journal. Actor kind is derived from session principal mapping, never from a request field.';

CREATE OR REPLACE FUNCTION public.tenant_email_luna_controlled_draft_operations_protect()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_operations: delete refused' USING ERRCODE = '23514';
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
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.mailbox_id IS DISTINCT FROM OLD.mailbox_id
     OR NEW.inbound_provider_message_id IS DISTINCT FROM OLD.inbound_provider_message_id
     OR NEW.inbound_provider_thread_id IS DISTINCT FROM OLD.inbound_provider_thread_id
     OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address
     OR NEW.canonical_subject IS DISTINCT FROM OLD.canonical_subject
     OR NEW.canonical_body IS DISTINCT FROM OLD.canonical_body
     OR NEW.subject_digest IS DISTINCT FROM OLD.subject_digest
     OR NEW.body_digest IS DISTINCT FROM OLD.body_digest
     OR NEW.draft_digest IS DISTINCT FROM OLD.draft_digest
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.eligibility_policy_version IS DISTINCT FROM OLD.eligibility_policy_version
     OR NEW.validator_version IS DISTINCT FROM OLD.validator_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_operations: immutable field mutation refused' USING ERRCODE = '23514';
  END IF;
  IF OLD.create_dispatch_claimed IS TRUE AND NEW.create_dispatch_claimed IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_operations: create dispatch unclaim refused' USING ERRCODE = '23514';
  END IF;
  IF OLD.create_dispatch_claimed_at IS NOT NULL
     AND NEW.create_dispatch_claimed_at IS DISTINCT FROM OLD.create_dispatch_claimed_at THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_operations: create dispatch timestamp mutation refused' USING ERRCODE = '23514';
  END IF;
  IF OLD.provider_draft_id IS NOT NULL
     AND NEW.provider_draft_id IS DISTINCT FROM OLD.provider_draft_id THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_operations: provider_draft_id replacement refused' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state IS NOT DISTINCT FROM OLD.state
    OR (OLD.state = 'reserved' AND NEW.state = 'create_dispatched_outcome_unknown')
    OR (OLD.state = 'create_dispatched_outcome_unknown' AND NEW.state IN (
         'provider_draft_reconciled_exact',
         'provider_draft_modified_by_staff',
         'provider_draft_removed_by_staff',
         'provider_mismatch_blocked'
       ))
    OR (OLD.state = 'provider_draft_reconciled_exact' AND NEW.state IN (
         'provider_draft_reconciled_exact',
         'provider_draft_modified_by_staff',
         'provider_draft_removed_by_staff',
         'provider_mismatch_blocked'
       ))
  ) THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_operations: illegal state transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state_generation IS DISTINCT FROM (OLD.state_generation + 1) THEN
      RAISE EXCEPTION 'tenant_email_luna_controlled_draft_operations: generation coupling refused' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.state_generation IS DISTINCT FROM OLD.state_generation THEN
      RAISE EXCEPTION 'tenant_email_luna_controlled_draft_operations: generation coupling refused' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_email_luna_controlled_draft_operations_protect
  ON public.tenant_email_luna_controlled_draft_operations;
CREATE TRIGGER tenant_email_luna_controlled_draft_operations_protect
  BEFORE UPDATE OR DELETE ON public.tenant_email_luna_controlled_draft_operations
  FOR EACH ROW EXECUTE FUNCTION public.tenant_email_luna_controlled_draft_operations_protect();

CREATE OR REPLACE FUNCTION public.tenant_email_luna_controlled_draft_transitions_protect()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_transitions: update refused' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_transitions: delete refused' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_email_luna_controlled_draft_transitions_protect
  ON public.tenant_email_luna_controlled_draft_transitions;
CREATE TRIGGER tenant_email_luna_controlled_draft_transitions_protect
  BEFORE UPDATE OR DELETE ON public.tenant_email_luna_controlled_draft_transitions
  FOR EACH ROW EXECUTE FUNCTION public.tenant_email_luna_controlled_draft_transitions_protect();

CREATE OR REPLACE FUNCTION public.tenant_email_luna_controlled_draft_actor_kind(
  p_client_id uuid,
  p_location_id uuid,
  p_location_key text
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
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
  IF session_user IS NOT DISTINCT FROM table_owner THEN
    RETURN 'table_owner';
  END IF;
  IF public.tenant_email_luna_automation_principal_authorized(
       'producer', p_client_id, p_location_id, p_location_key
     ) THEN
    RETURN 'producer';
  END IF;
  IF public.tenant_email_luna_automation_principal_authorized(
       'worker', p_client_id, p_location_id, p_location_key
     ) THEN
    RETURN 'worker';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_controlled_draft_append_history(
  p_operation_id uuid,
  p_issuance_id uuid,
  p_from_state text,
  p_to_state text,
  p_action text,
  p_actor_kind text,
  p_state_generation integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.tenant_email_luna_controlled_draft_transitions (
    operation_id, issuance_id, from_state, to_state, action, actor_kind, state_generation
  ) VALUES (
    p_operation_id, p_issuance_id, p_from_state, p_to_state, p_action, p_actor_kind, p_state_generation
  );
END;
$$;

DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_reserve(uuid, uuid, text, text, text, text, text, text);
CREATE FUNCTION public.tenant_email_luna_controlled_draft_reserve(
  p_operation_id uuid,
  p_issuance_id uuid,
  p_canonical_subject text,
  p_canonical_body text,
  p_language text,
  p_subject_digest text,
  p_body_digest text,
  p_draft_digest text
) RETURNS TABLE (
  status text,
  operation_id uuid,
  issuance_id uuid,
  audit_operation_id uuid,
  client_id uuid,
  location_id uuid,
  location_key text,
  endpoint_id uuid,
  conversation_id uuid,
  inbound_event_id uuid,
  provider text,
  mailbox_id text,
  inbound_provider_message_id text,
  inbound_provider_thread_id text,
  recipient_address text,
  canonical_subject text,
  canonical_body text,
  subject_digest text,
  body_digest text,
  draft_digest text,
  policy_version text,
  eligibility_policy_version text,
  validator_version text,
  state text,
  create_dispatch_claimed boolean,
  provider_draft_id text,
  is_draft boolean,
  state_generation integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  m public.tenant_email_luna_automation_issuance_material;
  q public.tenant_email_luna_automation_queue;
  e public.tenant_email_inbound_events;
  op public.tenant_email_luna_controlled_draft_operations;
  actor text;
BEGIN
  IF p_operation_id IS NULL OR p_issuance_id IS NULL
     OR p_canonical_subject IS NULL OR p_canonical_body IS NULL
     OR p_language IS NULL OR p_subject_digest IS NULL
     OR p_body_digest IS NULL OR p_draft_digest IS NULL THEN
    RETURN;
  END IF;
  IF char_length(p_canonical_subject) < 1 OR char_length(p_canonical_subject) > 998
     OR char_length(p_canonical_body) < 1 OR char_length(p_canonical_body) > 64000
     OR p_subject_digest !~ '^[0-9a-f]{64}$'
     OR p_body_digest !~ '^[0-9a-f]{64}$'
     OR p_draft_digest !~ '^[0-9a-f]{64}$'
     OR p_language NOT IN ('en', 'es') THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reserve: material shape refused' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO m
    FROM public.tenant_email_luna_automation_issuance_material AS mat
   WHERE mat.operation_id = p_operation_id
     AND mat.issuance_id = p_issuance_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reserve: authentic issuance missing' USING ERRCODE = '23514';
  END IF;

  actor := public.tenant_email_luna_controlled_draft_actor_kind(m.client_id, m.location_id, m.location_key);
  IF actor IS NULL OR actor NOT IN ('producer', 'table_owner') THEN
    RETURN;
  END IF;

  SELECT * INTO q
    FROM public.tenant_email_luna_automation_queue AS qq
   WHERE qq.operation_id = p_operation_id
     AND qq.issuance_id = p_issuance_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reserve: authentic queue missing' USING ERRCODE = '23514';
  END IF;
  IF q.audit_operation_id IS DISTINCT FROM m.audit_operation_id
     OR q.client_id IS DISTINCT FROM m.client_id
     OR q.location_id IS DISTINCT FROM m.location_id
     OR q.location_key IS DISTINCT FROM m.location_key
     OR q.endpoint_id IS DISTINCT FROM m.endpoint_id
     OR q.conversation_id IS DISTINCT FROM m.conversation_id
     OR q.inbound_event_id IS DISTINCT FROM m.inbound_event_id
     OR q.recipient_address IS DISTINCT FROM m.recipient_address
     OR q.draft_digest IS DISTINCT FROM m.draft_digest THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reserve: issuance/queue identity conflict' USING ERRCODE = '23514';
  END IF;
  IF m.language IS DISTINCT FROM p_language
     OR m.draft_digest IS DISTINCT FROM p_draft_digest THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reserve: digest/language mismatch' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO e
    FROM public.tenant_email_inbound_events AS ev
   WHERE ev.id = m.inbound_event_id
     AND ev.client_id = m.client_id
     AND ev.location_id = m.location_id
     AND ev.endpoint_id = m.endpoint_id
     AND ev.sender_address_normalized = m.recipient_address
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reserve: inbound reconstitution refused' USING ERRCODE = '23514';
  END IF;
  IF e.provider IS DISTINCT FROM 'microsoft_graph'
     OR NOT public.tenant_email_luna_controlled_draft_provider_id_ok(e.provider_mailbox_id)
     OR NOT public.tenant_email_luna_controlled_draft_provider_id_ok(e.provider_message_id)
     OR NOT public.tenant_email_luna_controlled_draft_provider_id_ok(e.conversation_id) THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reserve: inbound provider identity refused' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO op
    FROM public.tenant_email_luna_controlled_draft_operations AS o
   WHERE o.operation_id = p_operation_id
      OR o.issuance_id = p_issuance_id
   FOR SHARE;
  IF FOUND THEN
    IF op.operation_id IS DISTINCT FROM p_operation_id
       OR op.issuance_id IS DISTINCT FROM p_issuance_id
       OR op.canonical_subject IS DISTINCT FROM p_canonical_subject
       OR op.canonical_body IS DISTINCT FROM p_canonical_body
       OR op.subject_digest IS DISTINCT FROM p_subject_digest
       OR op.body_digest IS DISTINCT FROM p_body_digest
       OR op.draft_digest IS DISTINCT FROM p_draft_digest THEN
      RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reserve: identity conflict' USING ERRCODE = '23514';
    END IF;
    status := 'replayed';
    operation_id := op.operation_id;
    issuance_id := op.issuance_id;
    audit_operation_id := op.audit_operation_id;
    client_id := op.client_id;
    location_id := op.location_id;
    location_key := op.location_key;
    endpoint_id := op.endpoint_id;
    conversation_id := op.conversation_id;
    inbound_event_id := op.inbound_event_id;
    provider := op.provider;
    mailbox_id := op.mailbox_id;
    inbound_provider_message_id := op.inbound_provider_message_id;
    inbound_provider_thread_id := op.inbound_provider_thread_id;
    recipient_address := op.recipient_address;
    canonical_subject := op.canonical_subject;
    canonical_body := op.canonical_body;
    subject_digest := op.subject_digest;
    body_digest := op.body_digest;
    draft_digest := op.draft_digest;
    policy_version := op.policy_version;
    eligibility_policy_version := op.eligibility_policy_version;
    validator_version := op.validator_version;
    state := op.state;
    create_dispatch_claimed := op.create_dispatch_claimed;
    provider_draft_id := op.provider_draft_id;
    is_draft := op.is_draft;
    state_generation := op.state_generation;
    RETURN NEXT;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.tenant_email_luna_controlled_draft_operations (
      operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
      endpoint_id, conversation_id, inbound_event_id, provider, mailbox_id,
      inbound_provider_message_id, inbound_provider_thread_id, recipient_address,
      canonical_subject, canonical_body, subject_digest, body_digest, draft_digest,
      policy_version, eligibility_policy_version, validator_version,
      state, create_dispatch_claimed, create_dispatch_claimed_at,
      provider_draft_id, is_draft, state_generation
    ) VALUES (
      m.operation_id, m.issuance_id, m.audit_operation_id, m.client_id, m.location_id, m.location_key,
      m.endpoint_id, m.conversation_id, m.inbound_event_id, e.provider, e.provider_mailbox_id,
      e.provider_message_id, e.conversation_id, m.recipient_address,
      p_canonical_subject, p_canonical_body, p_subject_digest, p_body_digest, m.draft_digest,
      q.policy_version, q.eligibility_policy_version, q.validator_version,
      'reserved', FALSE, NULL, NULL, NULL, 1
    )
    RETURNING * INTO op;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO op
        FROM public.tenant_email_luna_controlled_draft_operations AS o
       WHERE o.operation_id = p_operation_id
         AND o.issuance_id = p_issuance_id
         AND o.draft_digest = p_draft_digest
       FOR SHARE;
      IF op.operation_id IS NULL THEN
        RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reserve: identity conflict' USING ERRCODE = '23514';
      END IF;
      status := 'replayed';
      operation_id := op.operation_id;
      issuance_id := op.issuance_id;
      audit_operation_id := op.audit_operation_id;
      client_id := op.client_id;
      location_id := op.location_id;
      location_key := op.location_key;
      endpoint_id := op.endpoint_id;
      conversation_id := op.conversation_id;
      inbound_event_id := op.inbound_event_id;
      provider := op.provider;
      mailbox_id := op.mailbox_id;
      inbound_provider_message_id := op.inbound_provider_message_id;
      inbound_provider_thread_id := op.inbound_provider_thread_id;
      recipient_address := op.recipient_address;
      canonical_subject := op.canonical_subject;
      canonical_body := op.canonical_body;
      subject_digest := op.subject_digest;
      body_digest := op.body_digest;
      draft_digest := op.draft_digest;
      policy_version := op.policy_version;
      eligibility_policy_version := op.eligibility_policy_version;
      validator_version := op.validator_version;
      state := op.state;
      create_dispatch_claimed := op.create_dispatch_claimed;
      provider_draft_id := op.provider_draft_id;
      is_draft := op.is_draft;
      state_generation := op.state_generation;
      RETURN NEXT;
      RETURN;
  END;

  PERFORM public.tenant_email_luna_controlled_draft_append_history(
    op.operation_id, op.issuance_id, NULL, 'reserved', 'reserve', actor, op.state_generation
  );

  status := 'reserved';
  operation_id := op.operation_id;
  issuance_id := op.issuance_id;
  audit_operation_id := op.audit_operation_id;
  client_id := op.client_id;
  location_id := op.location_id;
  location_key := op.location_key;
  endpoint_id := op.endpoint_id;
  conversation_id := op.conversation_id;
  inbound_event_id := op.inbound_event_id;
  provider := op.provider;
  mailbox_id := op.mailbox_id;
  inbound_provider_message_id := op.inbound_provider_message_id;
  inbound_provider_thread_id := op.inbound_provider_thread_id;
  recipient_address := op.recipient_address;
  canonical_subject := op.canonical_subject;
  canonical_body := op.canonical_body;
  subject_digest := op.subject_digest;
  body_digest := op.body_digest;
  draft_digest := op.draft_digest;
  policy_version := op.policy_version;
  eligibility_policy_version := op.eligibility_policy_version;
  validator_version := op.validator_version;
  state := op.state;
  create_dispatch_claimed := op.create_dispatch_claimed;
  provider_draft_id := op.provider_draft_id;
  is_draft := op.is_draft;
  state_generation := op.state_generation;
  RETURN NEXT;
END;
$$;

DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_claim_create(uuid, uuid, integer);
CREATE FUNCTION public.tenant_email_luna_controlled_draft_claim_create(
  p_operation_id uuid,
  p_issuance_id uuid,
  p_expected_generation integer
) RETURNS TABLE (
  status text,
  operation_id uuid,
  issuance_id uuid,
  audit_operation_id uuid,
  client_id uuid,
  location_id uuid,
  location_key text,
  endpoint_id uuid,
  conversation_id uuid,
  inbound_event_id uuid,
  provider text,
  mailbox_id text,
  inbound_provider_message_id text,
  inbound_provider_thread_id text,
  recipient_address text,
  canonical_subject text,
  canonical_body text,
  subject_digest text,
  body_digest text,
  draft_digest text,
  policy_version text,
  eligibility_policy_version text,
  validator_version text,
  state text,
  create_dispatch_claimed boolean,
  provider_draft_id text,
  is_draft boolean,
  state_generation integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  op public.tenant_email_luna_controlled_draft_operations;
  actor text;
  claimed_at timestamptz;
BEGIN
  IF p_operation_id IS NULL OR p_issuance_id IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO op
    FROM public.tenant_email_luna_controlled_draft_operations AS o
   WHERE o.operation_id = p_operation_id
     AND o.issuance_id = p_issuance_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  actor := public.tenant_email_luna_controlled_draft_actor_kind(op.client_id, op.location_id, op.location_key);
  IF actor IS NULL OR actor NOT IN ('worker', 'table_owner') THEN
    RETURN;
  END IF;

  IF p_expected_generation IS NOT NULL AND p_expected_generation IS DISTINCT FROM op.state_generation THEN
    status := 'stale_generation';
    operation_id := op.operation_id;
    issuance_id := op.issuance_id;
    audit_operation_id := op.audit_operation_id;
    client_id := op.client_id;
    location_id := op.location_id;
    location_key := op.location_key;
    endpoint_id := op.endpoint_id;
    conversation_id := op.conversation_id;
    inbound_event_id := op.inbound_event_id;
    provider := op.provider;
    mailbox_id := op.mailbox_id;
    inbound_provider_message_id := op.inbound_provider_message_id;
    inbound_provider_thread_id := op.inbound_provider_thread_id;
    recipient_address := op.recipient_address;
    canonical_subject := op.canonical_subject;
    canonical_body := op.canonical_body;
    subject_digest := op.subject_digest;
    body_digest := op.body_digest;
    draft_digest := op.draft_digest;
    policy_version := op.policy_version;
    eligibility_policy_version := op.eligibility_policy_version;
    validator_version := op.validator_version;
    state := op.state;
    create_dispatch_claimed := op.create_dispatch_claimed;
    provider_draft_id := op.provider_draft_id;
    is_draft := op.is_draft;
    state_generation := op.state_generation;
    RETURN NEXT;
    RETURN;
  END IF;

  IF op.create_dispatch_claimed IS TRUE THEN
    status := 'replayed';
    operation_id := op.operation_id;
    issuance_id := op.issuance_id;
    audit_operation_id := op.audit_operation_id;
    client_id := op.client_id;
    location_id := op.location_id;
    location_key := op.location_key;
    endpoint_id := op.endpoint_id;
    conversation_id := op.conversation_id;
    inbound_event_id := op.inbound_event_id;
    provider := op.provider;
    mailbox_id := op.mailbox_id;
    inbound_provider_message_id := op.inbound_provider_message_id;
    inbound_provider_thread_id := op.inbound_provider_thread_id;
    recipient_address := op.recipient_address;
    canonical_subject := op.canonical_subject;
    canonical_body := op.canonical_body;
    subject_digest := op.subject_digest;
    body_digest := op.body_digest;
    draft_digest := op.draft_digest;
    policy_version := op.policy_version;
    eligibility_policy_version := op.eligibility_policy_version;
    validator_version := op.validator_version;
    state := op.state;
    create_dispatch_claimed := op.create_dispatch_claimed;
    provider_draft_id := op.provider_draft_id;
    is_draft := op.is_draft;
    state_generation := op.state_generation;
    RETURN NEXT;
    RETURN;
  END IF;

  IF op.state IS DISTINCT FROM 'reserved' THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_claim_create: illegal state' USING ERRCODE = '23514';
  END IF;

  claimed_at := pg_catalog.now();
  UPDATE public.tenant_email_luna_controlled_draft_operations AS o
     SET state = 'create_dispatched_outcome_unknown',
         create_dispatch_claimed = TRUE,
         create_dispatch_claimed_at = claimed_at,
         state_generation = o.state_generation + 1,
         updated_at = claimed_at
   WHERE o.operation_id = op.operation_id
  RETURNING * INTO op;

  PERFORM public.tenant_email_luna_controlled_draft_append_history(
    op.operation_id, op.issuance_id, 'reserved', 'create_dispatched_outcome_unknown',
    'claim_create', actor, op.state_generation
  );

  status := 'create_dispatched_outcome_unknown';
  operation_id := op.operation_id;
  issuance_id := op.issuance_id;
  audit_operation_id := op.audit_operation_id;
  client_id := op.client_id;
  location_id := op.location_id;
  location_key := op.location_key;
  endpoint_id := op.endpoint_id;
  conversation_id := op.conversation_id;
  inbound_event_id := op.inbound_event_id;
  provider := op.provider;
  mailbox_id := op.mailbox_id;
  inbound_provider_message_id := op.inbound_provider_message_id;
  inbound_provider_thread_id := op.inbound_provider_thread_id;
  recipient_address := op.recipient_address;
  canonical_subject := op.canonical_subject;
  canonical_body := op.canonical_body;
  subject_digest := op.subject_digest;
  body_digest := op.body_digest;
  draft_digest := op.draft_digest;
  policy_version := op.policy_version;
  eligibility_policy_version := op.eligibility_policy_version;
  validator_version := op.validator_version;
  state := op.state;
  create_dispatch_claimed := op.create_dispatch_claimed;
  provider_draft_id := op.provider_draft_id;
  is_draft := op.is_draft;
  state_generation := op.state_generation;
  RETURN NEXT;
END;
$$;

DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_record_create(uuid, uuid, integer, jsonb);
CREATE FUNCTION public.tenant_email_luna_controlled_draft_record_create(
  p_operation_id uuid,
  p_issuance_id uuid,
  p_expected_generation integer,
  p_ack jsonb
) RETURNS TABLE (
  status text,
  operation_id uuid,
  issuance_id uuid,
  audit_operation_id uuid,
  client_id uuid,
  location_id uuid,
  location_key text,
  endpoint_id uuid,
  conversation_id uuid,
  inbound_event_id uuid,
  provider text,
  mailbox_id text,
  inbound_provider_message_id text,
  inbound_provider_thread_id text,
  recipient_address text,
  canonical_subject text,
  canonical_body text,
  subject_digest text,
  body_digest text,
  draft_digest text,
  policy_version text,
  eligibility_policy_version text,
  validator_version text,
  state text,
  create_dispatch_claimed boolean,
  provider_draft_id text,
  is_draft boolean,
  state_generation integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  op public.tenant_email_luna_controlled_draft_operations;
  actor text;
  ack_keys text[];
  ack_draft_id text;
  ack_is_draft boolean;
  mismatch boolean := FALSE;
BEGIN
  IF p_operation_id IS NULL OR p_issuance_id IS NULL OR p_ack IS NULL THEN
    RETURN;
  END IF;
  IF pg_catalog.jsonb_typeof(p_ack) IS DISTINCT FROM 'object'
     OR pg_catalog.octet_length(p_ack::pg_catalog.text) > 8192 THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_record_create: acknowledgement shape refused' USING ERRCODE = '23514';
  END IF;
  SELECT pg_catalog.array_agg(k ORDER BY k) INTO ack_keys
    FROM pg_catalog.jsonb_object_keys(p_ack) AS k;
  IF ack_keys IS DISTINCT FROM ARRAY[
       'body_digest','client_id','endpoint_id','inbound_provider_message_id',
       'inbound_provider_thread_id','is_draft','issuance_id','location_id',
       'location_key','mailbox_id','operation_id','outcome','provider',
       'provider_draft_id','recipient_address','subject_digest'
     ]::text[] THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_record_create: acknowledgement shape refused' USING ERRCODE = '23514';
  END IF;
  ack_draft_id := p_ack ->> 'provider_draft_id';
  IF NOT public.tenant_email_luna_controlled_draft_provider_id_ok(ack_draft_id) THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_record_create: provider_draft_id refused' USING ERRCODE = '23514';
  END IF;
  IF (p_ack ->> 'is_draft') IS DISTINCT FROM 'true' AND (p_ack ->> 'is_draft') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_record_create: acknowledgement shape refused' USING ERRCODE = '23514';
  END IF;
  ack_is_draft := (p_ack ->> 'is_draft')::boolean;
  IF (p_ack ->> 'outcome') IS DISTINCT FROM 'draft_created' THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_record_create: acknowledgement shape refused' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO op
    FROM public.tenant_email_luna_controlled_draft_operations AS o
   WHERE o.operation_id = p_operation_id
     AND o.issuance_id = p_issuance_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  actor := public.tenant_email_luna_controlled_draft_actor_kind(op.client_id, op.location_id, op.location_key);
  IF actor IS NULL OR actor NOT IN ('worker', 'table_owner') THEN
    RETURN;
  END IF;

  IF p_expected_generation IS NOT NULL AND p_expected_generation IS DISTINCT FROM op.state_generation THEN
    status := 'stale_generation';
  ELSIF op.state = 'provider_draft_reconciled_exact'
        AND op.provider_draft_id IS NOT DISTINCT FROM ack_draft_id
        AND op.is_draft IS TRUE
        AND ack_is_draft IS TRUE
        AND (p_ack ->> 'client_id') IS NOT DISTINCT FROM op.client_id::text
        AND (p_ack ->> 'location_id') IS NOT DISTINCT FROM op.location_id::text
        AND (p_ack ->> 'location_key') IS NOT DISTINCT FROM op.location_key
        AND (p_ack ->> 'endpoint_id') IS NOT DISTINCT FROM op.endpoint_id::text
        AND (p_ack ->> 'provider') IS NOT DISTINCT FROM op.provider
        AND (p_ack ->> 'mailbox_id') IS NOT DISTINCT FROM op.mailbox_id
        AND (p_ack ->> 'inbound_provider_message_id') IS NOT DISTINCT FROM op.inbound_provider_message_id
        AND (p_ack ->> 'inbound_provider_thread_id') IS NOT DISTINCT FROM op.inbound_provider_thread_id
        AND (p_ack ->> 'recipient_address') IS NOT DISTINCT FROM op.recipient_address
        AND (p_ack ->> 'subject_digest') IS NOT DISTINCT FROM op.subject_digest
        AND (p_ack ->> 'body_digest') IS NOT DISTINCT FROM op.body_digest
        AND (p_ack ->> 'issuance_id') IS NOT DISTINCT FROM op.issuance_id::text
        AND (p_ack ->> 'operation_id') IS NOT DISTINCT FROM op.operation_id::text THEN
    status := 'replayed';
  ELSIF op.state IS DISTINCT FROM 'create_dispatched_outcome_unknown' THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_record_create: unknown outcome is reconcile-only' USING ERRCODE = '23514';
  ELSE
    IF ack_is_draft IS DISTINCT FROM TRUE
       OR (p_ack ->> 'client_id') IS DISTINCT FROM op.client_id::text
       OR (p_ack ->> 'location_id') IS DISTINCT FROM op.location_id::text
       OR (p_ack ->> 'location_key') IS DISTINCT FROM op.location_key
       OR (p_ack ->> 'endpoint_id') IS DISTINCT FROM op.endpoint_id::text
       OR (p_ack ->> 'provider') IS DISTINCT FROM op.provider
       OR (p_ack ->> 'mailbox_id') IS DISTINCT FROM op.mailbox_id
       OR (p_ack ->> 'inbound_provider_message_id') IS DISTINCT FROM op.inbound_provider_message_id
       OR (p_ack ->> 'inbound_provider_thread_id') IS DISTINCT FROM op.inbound_provider_thread_id
       OR (p_ack ->> 'recipient_address') IS DISTINCT FROM op.recipient_address
       OR (p_ack ->> 'subject_digest') IS DISTINCT FROM op.subject_digest
       OR (p_ack ->> 'body_digest') IS DISTINCT FROM op.body_digest
       OR (p_ack ->> 'issuance_id') IS DISTINCT FROM op.issuance_id::text
       OR (p_ack ->> 'operation_id') IS DISTINCT FROM op.operation_id::text THEN
      mismatch := TRUE;
    END IF;
    IF mismatch THEN
      UPDATE public.tenant_email_luna_controlled_draft_operations AS o
         SET state = 'provider_mismatch_blocked',
             state_generation = o.state_generation + 1,
             updated_at = pg_catalog.now()
       WHERE o.operation_id = op.operation_id
      RETURNING * INTO op;
      PERFORM public.tenant_email_luna_controlled_draft_append_history(
        op.operation_id, op.issuance_id, 'create_dispatched_outcome_unknown',
        'provider_mismatch_blocked', 'record_create', actor, op.state_generation
      );
      status := 'provider_mismatch_blocked';
    ELSE
      UPDATE public.tenant_email_luna_controlled_draft_operations AS o
         SET state = 'provider_draft_reconciled_exact',
             provider_draft_id = ack_draft_id,
             is_draft = TRUE,
             state_generation = o.state_generation + 1,
             updated_at = pg_catalog.now()
       WHERE o.operation_id = op.operation_id
      RETURNING * INTO op;
      PERFORM public.tenant_email_luna_controlled_draft_append_history(
        op.operation_id, op.issuance_id, 'create_dispatched_outcome_unknown',
        'provider_draft_reconciled_exact', 'record_create', actor, op.state_generation
      );
      status := 'provider_draft_reconciled_exact';
    END IF;
  END IF;

  operation_id := op.operation_id;
  issuance_id := op.issuance_id;
  audit_operation_id := op.audit_operation_id;
  client_id := op.client_id;
  location_id := op.location_id;
  location_key := op.location_key;
  endpoint_id := op.endpoint_id;
  conversation_id := op.conversation_id;
  inbound_event_id := op.inbound_event_id;
  provider := op.provider;
  mailbox_id := op.mailbox_id;
  inbound_provider_message_id := op.inbound_provider_message_id;
  inbound_provider_thread_id := op.inbound_provider_thread_id;
  recipient_address := op.recipient_address;
  canonical_subject := op.canonical_subject;
  canonical_body := op.canonical_body;
  subject_digest := op.subject_digest;
  body_digest := op.body_digest;
  draft_digest := op.draft_digest;
  policy_version := op.policy_version;
  eligibility_policy_version := op.eligibility_policy_version;
  validator_version := op.validator_version;
  state := op.state;
  create_dispatch_claimed := op.create_dispatch_claimed;
  provider_draft_id := op.provider_draft_id;
  is_draft := op.is_draft;
  state_generation := op.state_generation;
  RETURN NEXT;
END;
$$;

DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_reconcile(uuid, uuid, integer, jsonb);
CREATE FUNCTION public.tenant_email_luna_controlled_draft_reconcile(
  p_operation_id uuid,
  p_issuance_id uuid,
  p_expected_generation integer,
  p_observation jsonb
) RETURNS TABLE (
  status text,
  operation_id uuid,
  issuance_id uuid,
  audit_operation_id uuid,
  client_id uuid,
  location_id uuid,
  location_key text,
  endpoint_id uuid,
  conversation_id uuid,
  inbound_event_id uuid,
  provider text,
  mailbox_id text,
  inbound_provider_message_id text,
  inbound_provider_thread_id text,
  recipient_address text,
  canonical_subject text,
  canonical_body text,
  subject_digest text,
  body_digest text,
  draft_digest text,
  policy_version text,
  eligibility_policy_version text,
  validator_version text,
  state text,
  create_dispatch_claimed boolean,
  provider_draft_id text,
  is_draft boolean,
  state_generation integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  op public.tenant_email_luna_controlled_draft_operations;
  actor text;
  obs_kind text;
  obs_draft_id text;
  obs_is_draft boolean;
  next_state text;
  next_action text;
  from_state text;
BEGIN
  IF p_operation_id IS NULL OR p_issuance_id IS NULL OR p_observation IS NULL THEN
    RETURN;
  END IF;
  IF pg_catalog.jsonb_typeof(p_observation) IS DISTINCT FROM 'object'
     OR pg_catalog.octet_length(p_observation::pg_catalog.text) > 4096 THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reconcile: observation shape refused' USING ERRCODE = '23514';
  END IF;
  obs_kind := p_observation ->> 'kind';
  IF obs_kind IS NULL OR obs_kind NOT IN (
       'exact', 'modified_by_staff', 'removed_by_staff', 'not_found', 'provider_mismatch'
     ) THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reconcile: observation shape refused' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO op
    FROM public.tenant_email_luna_controlled_draft_operations AS o
   WHERE o.operation_id = p_operation_id
     AND o.issuance_id = p_issuance_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  actor := public.tenant_email_luna_controlled_draft_actor_kind(op.client_id, op.location_id, op.location_key);
  IF actor IS NULL OR actor NOT IN ('worker', 'table_owner') THEN
    RETURN;
  END IF;

  IF p_expected_generation IS NOT NULL AND p_expected_generation IS DISTINCT FROM op.state_generation THEN
    status := 'stale_generation';
    operation_id := op.operation_id;
    issuance_id := op.issuance_id;
    audit_operation_id := op.audit_operation_id;
    client_id := op.client_id;
    location_id := op.location_id;
    location_key := op.location_key;
    endpoint_id := op.endpoint_id;
    conversation_id := op.conversation_id;
    inbound_event_id := op.inbound_event_id;
    provider := op.provider;
    mailbox_id := op.mailbox_id;
    inbound_provider_message_id := op.inbound_provider_message_id;
    inbound_provider_thread_id := op.inbound_provider_thread_id;
    recipient_address := op.recipient_address;
    canonical_subject := op.canonical_subject;
    canonical_body := op.canonical_body;
    subject_digest := op.subject_digest;
    body_digest := op.body_digest;
    draft_digest := op.draft_digest;
    policy_version := op.policy_version;
    eligibility_policy_version := op.eligibility_policy_version;
    validator_version := op.validator_version;
    state := op.state;
    create_dispatch_claimed := op.create_dispatch_claimed;
    provider_draft_id := op.provider_draft_id;
    is_draft := op.is_draft;
    state_generation := op.state_generation;
    RETURN NEXT;
    RETURN;
  END IF;

  IF op.state = 'reserved' THEN
    RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reconcile: reserved is not reconcile-ready' USING ERRCODE = '23514';
  END IF;

  IF op.state IN ('provider_draft_modified_by_staff', 'provider_draft_removed_by_staff', 'provider_mismatch_blocked') THEN
    status := op.state;
    operation_id := op.operation_id;
    issuance_id := op.issuance_id;
    audit_operation_id := op.audit_operation_id;
    client_id := op.client_id;
    location_id := op.location_id;
    location_key := op.location_key;
    endpoint_id := op.endpoint_id;
    conversation_id := op.conversation_id;
    inbound_event_id := op.inbound_event_id;
    provider := op.provider;
    mailbox_id := op.mailbox_id;
    inbound_provider_message_id := op.inbound_provider_message_id;
    inbound_provider_thread_id := op.inbound_provider_thread_id;
    recipient_address := op.recipient_address;
    canonical_subject := op.canonical_subject;
    canonical_body := op.canonical_body;
    subject_digest := op.subject_digest;
    body_digest := op.body_digest;
    draft_digest := op.draft_digest;
    policy_version := op.policy_version;
    eligibility_policy_version := op.eligibility_policy_version;
    validator_version := op.validator_version;
    state := op.state;
    create_dispatch_claimed := op.create_dispatch_claimed;
    provider_draft_id := op.provider_draft_id;
    is_draft := op.is_draft;
    state_generation := op.state_generation;
    RETURN NEXT;
    RETURN;
  END IF;

  obs_draft_id := p_observation ->> 'provider_draft_id';
  IF (p_observation ->> 'is_draft') IS NOT NULL THEN
    IF (p_observation ->> 'is_draft') IS DISTINCT FROM 'true'
       AND (p_observation ->> 'is_draft') IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'tenant_email_luna_controlled_draft_reconcile: observation shape refused' USING ERRCODE = '23514';
    END IF;
    obs_is_draft := (p_observation ->> 'is_draft')::boolean;
  END IF;

  IF obs_kind = 'exact' THEN
    IF obs_draft_id IS NULL
       OR NOT public.tenant_email_luna_controlled_draft_provider_id_ok(obs_draft_id)
       OR obs_is_draft IS DISTINCT FROM TRUE
       OR (p_observation ->> 'subject_digest') IS DISTINCT FROM op.subject_digest
       OR (p_observation ->> 'body_digest') IS DISTINCT FROM op.body_digest THEN
      next_state := 'provider_mismatch_blocked';
      next_action := 'reconcile_mismatch';
    ELSIF op.provider_draft_id IS NOT NULL AND op.provider_draft_id IS DISTINCT FROM obs_draft_id THEN
      next_state := 'provider_mismatch_blocked';
      next_action := 'reconcile_mismatch';
    ELSE
      next_state := 'provider_draft_reconciled_exact';
      next_action := 'reconcile_exact';
    END IF;
  ELSIF obs_kind = 'modified_by_staff' THEN
    IF obs_draft_id IS NULL
       OR NOT public.tenant_email_luna_controlled_draft_provider_id_ok(obs_draft_id)
       OR obs_is_draft IS DISTINCT FROM TRUE THEN
      next_state := 'provider_mismatch_blocked';
      next_action := 'reconcile_mismatch';
    ELSIF op.provider_draft_id IS NOT NULL AND op.provider_draft_id IS DISTINCT FROM obs_draft_id THEN
      next_state := 'provider_mismatch_blocked';
      next_action := 'reconcile_mismatch';
    ELSE
      next_state := 'provider_draft_modified_by_staff';
      next_action := 'reconcile_modified_by_staff';
    END IF;
  ELSIF obs_kind IN ('removed_by_staff', 'not_found') THEN
    IF op.provider_draft_id IS NULL THEN
      next_state := 'provider_mismatch_blocked';
      next_action := 'reconcile_mismatch';
    ELSIF obs_draft_id IS NOT NULL AND op.provider_draft_id IS DISTINCT FROM obs_draft_id THEN
      next_state := 'provider_mismatch_blocked';
      next_action := 'reconcile_mismatch';
    ELSE
      next_state := 'provider_draft_removed_by_staff';
      next_action := CASE WHEN obs_kind = 'not_found' THEN 'reconcile_not_found' ELSE 'reconcile_removed_by_staff' END;
    END IF;
  ELSE
    next_state := 'provider_mismatch_blocked';
    next_action := 'reconcile_mismatch';
  END IF;

  IF next_state = op.state
     AND (
       next_state <> 'provider_draft_reconciled_exact'
       OR op.provider_draft_id IS NOT DISTINCT FROM obs_draft_id
     ) THEN
    status := 'replayed';
  ELSE
    from_state := op.state;
    UPDATE public.tenant_email_luna_controlled_draft_operations AS o
       SET state = next_state,
           provider_draft_id = CASE
             WHEN next_state IN ('provider_draft_reconciled_exact', 'provider_draft_modified_by_staff')
               THEN COALESCE(o.provider_draft_id, obs_draft_id)
             ELSE o.provider_draft_id
           END,
           is_draft = CASE
             WHEN next_state IN ('provider_draft_reconciled_exact', 'provider_draft_modified_by_staff') THEN TRUE
             ELSE o.is_draft
           END,
           state_generation = o.state_generation + 1,
           updated_at = pg_catalog.now()
     WHERE o.operation_id = op.operation_id
    RETURNING * INTO op;
    PERFORM public.tenant_email_luna_controlled_draft_append_history(
      op.operation_id, op.issuance_id, from_state, next_state, next_action, actor, op.state_generation
    );
    status := next_state;
  END IF;

  operation_id := op.operation_id;
  issuance_id := op.issuance_id;
  audit_operation_id := op.audit_operation_id;
  client_id := op.client_id;
  location_id := op.location_id;
  location_key := op.location_key;
  endpoint_id := op.endpoint_id;
  conversation_id := op.conversation_id;
  inbound_event_id := op.inbound_event_id;
  provider := op.provider;
  mailbox_id := op.mailbox_id;
  inbound_provider_message_id := op.inbound_provider_message_id;
  inbound_provider_thread_id := op.inbound_provider_thread_id;
  recipient_address := op.recipient_address;
  canonical_subject := op.canonical_subject;
  canonical_body := op.canonical_body;
  subject_digest := op.subject_digest;
  body_digest := op.body_digest;
  draft_digest := op.draft_digest;
  policy_version := op.policy_version;
  eligibility_policy_version := op.eligibility_policy_version;
  validator_version := op.validator_version;
  state := op.state;
  create_dispatch_claimed := op.create_dispatch_claimed;
  provider_draft_id := op.provider_draft_id;
  is_draft := op.is_draft;
  state_generation := op.state_generation;
  RETURN NEXT;
END;
$$;

DROP FUNCTION IF EXISTS public.tenant_email_luna_controlled_draft_load(uuid, uuid);
CREATE FUNCTION public.tenant_email_luna_controlled_draft_load(
  p_operation_id uuid,
  p_issuance_id uuid
) RETURNS TABLE (
  status text,
  operation_id uuid,
  issuance_id uuid,
  audit_operation_id uuid,
  client_id uuid,
  location_id uuid,
  location_key text,
  endpoint_id uuid,
  conversation_id uuid,
  inbound_event_id uuid,
  provider text,
  mailbox_id text,
  inbound_provider_message_id text,
  inbound_provider_thread_id text,
  recipient_address text,
  canonical_subject text,
  canonical_body text,
  subject_digest text,
  body_digest text,
  draft_digest text,
  policy_version text,
  eligibility_policy_version text,
  validator_version text,
  state text,
  create_dispatch_claimed boolean,
  provider_draft_id text,
  is_draft boolean,
  state_generation integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  op public.tenant_email_luna_controlled_draft_operations;
  actor text;
BEGIN
  IF p_operation_id IS NULL OR p_issuance_id IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO op
    FROM public.tenant_email_luna_controlled_draft_operations AS o
   WHERE o.operation_id = p_operation_id
     AND o.issuance_id = p_issuance_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  actor := public.tenant_email_luna_controlled_draft_actor_kind(op.client_id, op.location_id, op.location_key);
  IF actor IS NULL THEN
    RETURN;
  END IF;

  status := 'loaded';
  operation_id := op.operation_id;
  issuance_id := op.issuance_id;
  audit_operation_id := op.audit_operation_id;
  client_id := op.client_id;
  location_id := op.location_id;
  location_key := op.location_key;
  endpoint_id := op.endpoint_id;
  conversation_id := op.conversation_id;
  inbound_event_id := op.inbound_event_id;
  provider := op.provider;
  mailbox_id := op.mailbox_id;
  inbound_provider_message_id := op.inbound_provider_message_id;
  inbound_provider_thread_id := op.inbound_provider_thread_id;
  recipient_address := op.recipient_address;
  canonical_subject := op.canonical_subject;
  canonical_body := op.canonical_body;
  subject_digest := op.subject_digest;
  body_digest := op.body_digest;
  draft_digest := op.draft_digest;
  policy_version := op.policy_version;
  eligibility_policy_version := op.eligibility_policy_version;
  validator_version := op.validator_version;
  state := op.state;
  create_dispatch_claimed := op.create_dispatch_claimed;
  provider_draft_id := op.provider_draft_id;
  is_draft := op.is_draft;
  state_generation := op.state_generation;
  RETURN NEXT;
END;
$$;

DO $$
DECLARE
  table_owner name;
  fn_ident text;
  fns text[] := ARRAY[
    'tenant_email_luna_controlled_draft_provider_id_ok(text)',
    'tenant_email_luna_controlled_draft_operations_protect()',
    'tenant_email_luna_controlled_draft_transitions_protect()',
    'tenant_email_luna_controlled_draft_actor_kind(uuid, uuid, text)',
    'tenant_email_luna_controlled_draft_append_history(uuid, uuid, text, text, text, text, integer)',
    'tenant_email_luna_controlled_draft_reserve(uuid, uuid, text, text, text, text, text, text)',
    'tenant_email_luna_controlled_draft_claim_create(uuid, uuid, integer)',
    'tenant_email_luna_controlled_draft_record_create(uuid, uuid, integer, jsonb)',
    'tenant_email_luna_controlled_draft_reconcile(uuid, uuid, integer, jsonb)',
    'tenant_email_luna_controlled_draft_load(uuid, uuid)'
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
    RAISE EXCEPTION '097: queue table owner missing';
  END IF;
  EXECUTE format('ALTER TABLE public.tenant_email_luna_controlled_draft_operations OWNER TO %I', table_owner);
  EXECUTE format('ALTER TABLE public.tenant_email_luna_controlled_draft_transitions OWNER TO %I', table_owner);
  FOREACH fn_ident IN ARRAY fns LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO %I', fn_ident, table_owner);
  END LOOP;
END $$;

ALTER TABLE public.tenant_email_luna_controlled_draft_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_email_luna_controlled_draft_transitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_email_luna_controlled_draft_operations_principal_select
  ON public.tenant_email_luna_controlled_draft_operations;
CREATE POLICY tenant_email_luna_controlled_draft_operations_principal_select
  ON public.tenant_email_luna_controlled_draft_operations
  FOR SELECT
  USING (
    public.tenant_email_luna_automation_principal_authorized('worker', client_id, location_id, location_key)
    OR public.tenant_email_luna_automation_principal_authorized('producer', client_id, location_id, location_key)
  );

COMMENT ON FUNCTION public.tenant_email_luna_controlled_draft_reserve(uuid, uuid, text, text, text, text, text, text) IS
  'Producer reserve of one controlled provider-draft operation from authentic Stage 1 issuance/queue/inbound rows. Does not invent tenant/location/mailbox/inbound identity. Same-identity replay returns the existing row. No send.';
COMMENT ON FUNCTION public.tenant_email_luna_controlled_draft_claim_create(uuid, uuid, integer) IS
  'Worker one-shot create-dispatch claim. Repeated claims return the existing state and never increment an attempt counter. Unknown outcome cannot return to reserved.';
COMMENT ON FUNCTION public.tenant_email_luna_controlled_draft_record_create(uuid, uuid, integer, jsonb) IS
  'Worker record of a trusted create acknowledgement. Requires exact provider draft id, is_draft true, and exact stored bindings. Mismatch is fail-closed and never overwrites identity. No send.';
COMMENT ON FUNCTION public.tenant_email_luna_controlled_draft_reconcile(uuid, uuid, integer, jsonb) IS
  'Worker reconciliation of an already-dispatched create. Distinguishes exact, staff-modified, removed/not-found, and provider mismatch. Modified/removed/mismatch are not recreate-ready.';
COMMENT ON FUNCTION public.tenant_email_luna_controlled_draft_load(uuid, uuid) IS
  'Scoped load of immutable controlled-draft operation material for recovery. Does not mint policy evidence or create-dispatch authority.';

REVOKE ALL ON TABLE public.tenant_email_luna_controlled_draft_operations FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_email_luna_controlled_draft_transitions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_provider_id_ok(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_operations_protect() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_transitions_protect() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_actor_kind(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_append_history(uuid, uuid, text, text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_reserve(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_claim_create(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_record_create(uuid, uuid, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_reconcile(uuid, uuid, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_load(uuid, uuid) FROM PUBLIC;

COMMIT;
