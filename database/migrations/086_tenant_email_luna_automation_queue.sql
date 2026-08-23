-- 086_tenant_email_luna_automation_queue.sql
-- FULL SAIL Stage 1 NIGHTWATCH Ch3 Slice A: bounded durable automation queue.
-- NOT a second outbound send journal. Canonical tenant_email_outbound_send_journal
-- remains the sole provider invocation / exact-once owner (Chapter 3B).
-- This table is claim/lease identity only: crash/retry yields at most one CLAIMED
-- AUTOMATION OPERATION. No provider, send, draft body, or journal dispatch.
-- Identity: caller operation_id UUID PK + unique issuance_id + unique handoff_id.
-- Authority: tenant/location/location_key/endpoint/conversation + normalized recipient.
-- Draft: immutable digest/reference only; canonical draft owner remains the author module.
-- Claim uses FOR UPDATE SKIP LOCKED. Empty on migrate. Send-inert.
--
-- Provenance (do not guess IDs):
--   Policy authority.inbound_message_id is tenant_email_inbound_inbox_projections.inbound_event_id
--   which is tenant_email_inbound_events.id (not messages.id, not provider_message_id).
--   Authenticated sender is tenant_email_inbound_events.sender_address (nullable metadata on 063;
--   projection requires a sender at Inbox project time). 086 adds a stored normalized projection
--   of that existing column so a composite FK can reject any other normalized recipient.
--   Conversation/location/endpoint are proven through the 067 projection unique, not by copying
--   guest body/subject onto policy audit.
--   086 adds nullable tenant_email_luna_policy_audit.inbound_event_id (do not rewrite 085).
--   Pre-086 audit rows may remain NULL and are ineligible for queue enqueue (no backfill).
--   New 086-era audit persistence writes authentic authority.inbound_message_id.
--
-- 086-owned parent keys (do not rewrite applied 085/063/067):
--   audit authority identity unique including inbound_event_id; inbound recipient-authority unique;
--   projection authority unique.
--
-- Mutation surface: SECURITY DEFINER functions only. Direct INSERT/UPDATE/DELETE by ordinary
-- runtime roles is denied. No spoofable custom GUC. Privileged table owner is out-of-band
-- administrator. Function owner is the table/migration owner — not a runtime worker.
-- Every SECURITY DEFINER function pins SET search_path TO pg_catalog, public (pg_catalog first;
-- public is the trusted application schema; no pg_temp or other writable schema). Application
-- relations, return types, now(), and gen_random_uuid() are schema-qualified. 086 does not GRANT
-- and does not CREATE ROLE (no stable application DB role exists yet).
--
-- Ch4 grant-verifier contract (comments/verifier only — not applied here):
--   Ordinary automation worker:
--     GRANT SELECT ON TABLE public.tenant_email_luna_automation_queue TO <runtime_worker_role>;
--     GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text) TO <runtime_worker_role>;
--     GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_claim(uuid, uuid) TO <runtime_worker_role>;
--     GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_handoff(uuid, uuid) TO <runtime_worker_role>;
--     GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_cancel_claimed(uuid, uuid) TO <runtime_worker_role>;
--     GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_require_handoff_claimed(uuid, uuid) TO <runtime_worker_role>;
--     GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_terminalize_attempt_cap(uuid, uuid) TO <runtime_worker_role>;
--   Worker never receives INSERT/UPDATE/DELETE on the queue table.
--   Worker never receives EXECUTE on operator pending functions:
--     public.tenant_email_luna_automation_cancel_pending(uuid, uuid)
--     public.tenant_email_luna_automation_require_handoff_pending(uuid, uuid)
--   Operator-only (future operator role/capability, not created or granted here):
--     pending cancel and pending require-handoff are tenant-scoped and operator-only.
--   Never GRANT table DML to PUBLIC. Never CREATE a fake product role in this migration.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'conversations_client_id_id_uq') THEN
    ALTER TABLE public.conversations ADD CONSTRAINT conversations_client_id_id_uq UNIQUE (client_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'tenant_locations_client_id_id_location_key_uq') THEN
    ALTER TABLE public.tenant_locations
      ADD CONSTRAINT tenant_locations_client_id_id_location_key_uq UNIQUE (client_id, id, location_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'tenant_channel_endpoints_client_id_id_location_key_uq') THEN
    ALTER TABLE public.tenant_channel_endpoints
      ADD CONSTRAINT tenant_channel_endpoints_client_id_id_location_key_uq UNIQUE (client_id, id, location_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'tenant_email_luna_policy_audit'
      AND a.attname = 'inbound_event_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    ALTER TABLE public.tenant_email_luna_policy_audit
      ADD COLUMN inbound_event_id UUID NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'tenant_email_luna_policy_audit_authority_identity_uq') THEN
    ALTER TABLE public.tenant_email_luna_policy_audit
      ADD CONSTRAINT tenant_email_luna_policy_audit_authority_identity_uq
      UNIQUE (operation_id, issuance_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'tenant_email_inbound_events'
      AND a.attname = 'sender_address_normalized'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    ALTER TABLE public.tenant_email_inbound_events
      ADD COLUMN sender_address_normalized TEXT
      GENERATED ALWAYS AS (lower(btrim(sender_address))) STORED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'tenant_email_inbound_events_luna_recipient_authority_uq') THEN
    ALTER TABLE public.tenant_email_inbound_events
      ADD CONSTRAINT tenant_email_inbound_events_luna_recipient_authority_uq
      UNIQUE (id, client_id, location_id, endpoint_id, sender_address_normalized);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'tenant_email_inbound_inbox_projections_luna_authority_uq') THEN
    ALTER TABLE public.tenant_email_inbound_inbox_projections
      ADD CONSTRAINT tenant_email_inbound_inbox_projections_luna_authority_uq
      UNIQUE (inbound_event_id, client_id, location_id, endpoint_id, conversation_id);
  END IF;
END $$;

CREATE TABLE public.tenant_email_luna_automation_queue (
  operation_id UUID PRIMARY KEY,
  issuance_id UUID NOT NULL,
  audit_operation_id UUID NOT NULL,
  client_id UUID NOT NULL,
  location_id UUID NOT NULL,
  location_key TEXT NOT NULL,
  endpoint_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  inbound_event_id UUID NOT NULL,
  recipient_address TEXT NOT NULL,
  recipient_digest TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  eligibility_policy_version TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  draft_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner UUID NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  handoff_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT tenant_email_luna_automation_queue_issuance_uq UNIQUE (issuance_id),
  CONSTRAINT tenant_email_luna_automation_queue_handoff_uq UNIQUE (handoff_id),
  CONSTRAINT tenant_email_luna_automation_queue_audit_fk
    FOREIGN KEY (
      audit_operation_id, issuance_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id
    )
    REFERENCES public.tenant_email_luna_policy_audit (
      operation_id, issuance_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_queue_inbound_recipient_fk
    FOREIGN KEY (inbound_event_id, client_id, location_id, endpoint_id, recipient_address)
    REFERENCES public.tenant_email_inbound_events (id, client_id, location_id, endpoint_id, sender_address_normalized)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_queue_inbound_projection_fk
    FOREIGN KEY (inbound_event_id, client_id, location_id, endpoint_id, conversation_id)
    REFERENCES public.tenant_email_inbound_inbox_projections (inbound_event_id, client_id, location_id, endpoint_id, conversation_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_queue_location_identity_fk
    FOREIGN KEY (client_id, location_id, location_key)
    REFERENCES public.tenant_locations (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_queue_endpoint_location_fk
    FOREIGN KEY (client_id, endpoint_id, location_key)
    REFERENCES public.tenant_channel_endpoints (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_queue_conversation_fk
    FOREIGN KEY (client_id, conversation_id) REFERENCES public.conversations (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_queue_location_key_shape
    CHECK (location_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(location_key) BETWEEN 1 AND 64),
  CONSTRAINT tenant_email_luna_automation_queue_recipient_shape
    CHECK (
      recipient_address = lower(recipient_address)
      AND recipient_address ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
      AND char_length(recipient_address) BETWEEN 3 AND 320
    ),
  CONSTRAINT tenant_email_luna_automation_queue_recipient_digest_shape
    CHECK (recipient_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_email_luna_automation_queue_policy_version_values
    CHECK (policy_version = 'email-luna-draft-policy.v1' AND char_length(policy_version) BETWEEN 1 AND 64),
  CONSTRAINT tenant_email_luna_automation_queue_eligibility_version_values
    CHECK (
      eligibility_policy_version = 'email-luna-autonomous-eligibility-policy.v1'
      AND char_length(eligibility_policy_version) BETWEEN 1 AND 64
    ),
  CONSTRAINT tenant_email_luna_automation_queue_validator_version_values
    CHECK (
      validator_version = 'email-luna-draft-validator.v1'
      AND char_length(validator_version) BETWEEN 1 AND 64
    ),
  CONSTRAINT tenant_email_luna_automation_queue_draft_digest_shape
    CHECK (draft_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_email_luna_automation_queue_state_values
    CHECK (state IN ('pending', 'claimed', 'handed_off', 'handoff_required', 'cancelled')),
  CONSTRAINT tenant_email_luna_automation_queue_attempt_bounds
    CHECK (attempt_count >= 0 AND attempt_count <= 3),
  CONSTRAINT tenant_email_luna_automation_queue_state_coupling CHECK (
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
  )
);

COMMENT ON TABLE public.tenant_email_luna_automation_queue IS
  'Luna automation claim queue. NOT a second outbound send journal. Identity/lease only; canonical journal remains sole provider/exact-once owner.';
COMMENT ON COLUMN public.tenant_email_luna_automation_queue.draft_digest IS
  'SHA-256 of canonical author subject/body/language. Exact draft text stays with the author owner; this queue does not persist draft content.';
COMMENT ON COLUMN public.tenant_email_luna_automation_queue.handoff_id IS
  'Immutable unique identity for later canonical-journal handoff (Ch3B). At-most-one later provider invocation is established only through this id plus claim semantics.';
COMMENT ON COLUMN public.tenant_email_luna_automation_queue.recipient_address IS
  'Normalized exact guest address bound from authenticated inbound_events.sender_address via composite FK. Never caller-selected.';
COMMENT ON COLUMN public.tenant_email_luna_automation_queue.inbound_event_id IS
  'Canonical inbound identity: tenant_email_inbound_events.id (policy authority.inbound_message_id / projection.inbound_event_id).';
COMMENT ON COLUMN public.tenant_email_luna_automation_queue.recipient_digest IS
  'SHA-256 of normalized recipient_address. Composite with inbound_event_id; not guest body/subject.';
COMMENT ON COLUMN public.tenant_email_luna_policy_audit.inbound_event_id IS
  '086-owned nullable inbound identity. Pre-086 rows remain NULL and cannot be referenced by the queue FK. New persistence writes authentic policy authority.inbound_message_id. Bounded identifier only; no recipient or content.';
COMMENT ON CONSTRAINT tenant_email_luna_policy_audit_authority_identity_uq ON public.tenant_email_luna_policy_audit IS
  '086-owned canonical audit identity. Queue composite FK binds operation+issuance+full authority+inbound_event_id so same-authority/different inbound, different issuance, and cross tenant/location/endpoint/conversation cannot attach.';

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_queue_bind_recipient_digest() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO pg_catalog, public
AS $$
BEGIN
  NEW.recipient_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.recipient_address, 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_email_luna_automation_queue_bind_recipient_digest
  BEFORE INSERT ON public.tenant_email_luna_automation_queue
  FOR EACH ROW EXECUTE FUNCTION public.tenant_email_luna_automation_queue_bind_recipient_digest();

CREATE INDEX idx_tenant_email_luna_automation_queue_claim
  ON public.tenant_email_luna_automation_queue (created_at)
  WHERE state IN ('pending', 'claimed');
CREATE INDEX idx_tenant_email_luna_automation_queue_conversation
  ON public.tenant_email_luna_automation_queue (client_id, conversation_id, created_at DESC);
CREATE INDEX idx_tenant_email_luna_automation_queue_endpoint
  ON public.tenant_email_luna_automation_queue (client_id, endpoint_id, created_at DESC);

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

CREATE TRIGGER tenant_email_luna_automation_queue_protect
  BEFORE UPDATE ON public.tenant_email_luna_automation_queue
  FOR EACH ROW EXECUTE FUNCTION public.tenant_email_luna_automation_queue_protect();
CREATE TRIGGER tenant_email_luna_automation_queue_protect_delete
  BEFORE DELETE ON public.tenant_email_luna_automation_queue
  FOR EACH ROW EXECUTE FUNCTION public.tenant_email_luna_automation_queue_protect();
CREATE TRIGGER tenant_email_luna_automation_queue_updated_at
  BEFORE UPDATE ON public.tenant_email_luna_automation_queue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

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
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  UPDATE public.tenant_email_luna_automation_queue
  SET
    state = 'handed_off',
    handoff_id = pg_catalog.gen_random_uuid(),
    lease_owner = NULL,
    lease_expires_at = NULL
  WHERE operation_id = p_operation
    AND state = 'claimed'
    AND lease_owner = p_owner
    AND lease_expires_at >= pg_catalog.now()
  RETURNING *;
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

COMMENT ON FUNCTION public.tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text) IS
  'Worker enqueue. Composite audit/inbound/projection FKs bind issuance, authority, and inbound_event_id. Function owner is table owner. Does not invoke a provider.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_claim(uuid, uuid) IS
  'Worker atomic lease claim with FOR UPDATE SKIP LOCKED. Does not invoke a provider or write the outbound send journal.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_cancel_pending(uuid, uuid) IS
  'Operator-only tenant-scoped cancel of pending rows. Ch4 operator grant contract; never granted to the ordinary automation worker. UUID knowledge is not authorization.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_cancel_claimed(uuid, uuid) IS
  'Worker live claimed owner CAS cancel. Stale/expired owner is a no-op.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_require_handoff_pending(uuid, uuid) IS
  'Operator-only tenant-scoped handoff_required of pending rows. Ch4 operator grant contract; never granted to the ordinary automation worker. UUID knowledge is not authorization.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_require_handoff_claimed(uuid, uuid) IS
  'Worker live claimed owner CAS reclassify to handoff_required. Stale/expired owner is a no-op.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_handoff(uuid, uuid) IS
  'Worker live claimed owner CAS handoff. Mints exactly one handoff_id with pg_catalog.gen_random_uuid().';
COMMENT ON FUNCTION public.tenant_email_luna_automation_terminalize_attempt_cap(uuid, uuid) IS
  'Worker owner-scoped attempt-cap terminalization: matching lease owner token, exact operation, expired lease, and attempt cap. No global or null mutation.';

REVOKE INSERT, UPDATE, DELETE ON TABLE public.tenant_email_luna_automation_queue FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_claim(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_cancel_pending(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_cancel_claimed(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_require_handoff_pending(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_require_handoff_claimed(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_handoff(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_terminalize_attempt_cap(uuid, uuid) FROM PUBLIC;

COMMIT;
