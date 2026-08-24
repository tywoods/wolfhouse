-- 093_tenant_email_luna_automation_shadow_outcomes.sql
-- FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B4: durable Luna-side shadow comparison
-- outcome plus a shadow_captured queue terminal. One owner. NOT a second queue,
-- journal, policy, Inbox, or provider. Send-inert. Empty on migrate.
--
-- Why a new table (inspection of 085/086/070/078/067/092):
--   085 is producer-time policy audit (canonical/eligibility), not worker-computed
--     would_send after claim/load/recover, and has no claim-lease identity.
--   086 is claim/lease identity only; successful B3 would_send stayed claimed and
--     could exhaust attempts. handed_off is journal/provider identity (087).
--   092 is reconstitution material (classifier/facts/plan), not a comparison.
--   070 tenant_email_reply_approvals is staff Graph draft/approve/send with its
--     own operation_id. source_inbound_event_id can later-match, but draft is not
--     a send decision, there is no grounded would-not-send/reject, and duplicates
--     are allowed. Absence is not disagreement.
--   078 luna_outbound_approvals is conversation-level (no inbound_event_id).
--   067 Inbox projections are inbound identity, not staff send decisions.
--   Canonical outbound journal remains the sole provider/exact-once owner.
--
-- Canonical key: one row per exact queue operation + policy issuance
-- (operation_id PK, unique issuance_id). Composite FK to the 086 queue identity
-- unique added here (operation+issuance+audit+authority+inbound+recipient_digest
-- +policy versions) and to 085/086 audit authority unique. Stores recipient
-- digest, never recipient address, subject, body, or secrets.
--
-- Luna decision is derived inside SECURITY DEFINER from locked claimed queue +
-- matching 092 material + 085 draft_ready/eligible. Caller supplies only
-- operation_id + current lease owner. would_send, reason, versions, human
-- outcome, comparison result, and identities are not parameters.
--
-- Capture-time comparison_state is pending_human with null human identity.
-- Later-match is a read-time projection against 070 approved|terminal on exact
-- client/location/endpoint/conversation/source_inbound_event_id. This slice does
-- not UPDATE the outcome. Disagreement is not grounded in 070 and is never
-- inferred from absence. No model-based body comparison.
--
-- Queue terminal: claimed → shadow_captured with live-lease CAS, lease released,
-- handoff_id null, attempt_count unchanged. Replay-safe. Not handed_off and not
-- a canonical-journal or provider terminal.
--
-- Mutation: SECURITY DEFINER capture (worker persist+terminalize), load (worker
-- reconstitution of the outcome), and project (staff-safe later-match). Direct
-- table DML denied. 093 does not GRANT and does not CREATE ROLE. PUBLIC revoked.
-- search_path pg_catalog, public. Function owner is the queue table owner.
-- Worker EXECUTE is provisioned by the existing principal provisioner when the
-- 093 objects exist.
--
-- Rollback: 093_tenant_email_luna_automation_shadow_outcomes_down.sql

BEGIN;

ALTER TABLE public.tenant_email_luna_automation_queue
  DROP CONSTRAINT IF EXISTS tenant_email_luna_automation_queue_state_values;
ALTER TABLE public.tenant_email_luna_automation_queue
  ADD CONSTRAINT tenant_email_luna_automation_queue_state_values
    CHECK (state IN ('pending', 'claimed', 'handed_off', 'handoff_required', 'cancelled', 'shadow_captured'));

ALTER TABLE public.tenant_email_luna_automation_queue
  DROP CONSTRAINT IF EXISTS tenant_email_luna_automation_queue_state_coupling;
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
    OR (
      state = 'shadow_captured'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND handoff_id IS NULL
      AND attempt_count BETWEEN 1 AND 3
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'tenant_email_luna_automation_queue_shadow_identity_uq'
  ) THEN
    ALTER TABLE public.tenant_email_luna_automation_queue
      ADD CONSTRAINT tenant_email_luna_automation_queue_shadow_identity_uq UNIQUE (
        operation_id,
        issuance_id,
        audit_operation_id,
        client_id,
        location_id,
        location_key,
        endpoint_id,
        conversation_id,
        inbound_event_id,
        recipient_digest,
        policy_version,
        eligibility_policy_version,
        validator_version
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
    OR (OLD.state = 'claimed' AND NEW.state IN ('claimed', 'handed_off', 'cancelled', 'handoff_required', 'shadow_captured'))
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
  IF OLD.state = 'claimed' AND NEW.state = 'shadow_captured' THEN
    IF NOT (
      OLD.lease_expires_at >= pg_catalog.now()
      AND NEW.attempt_count = OLD.attempt_count
      AND NEW.handoff_id IS NULL
      AND NEW.lease_owner IS NULL
      AND NEW.lease_expires_at IS NULL
    ) THEN
      RAISE EXCEPTION 'tenant_email_luna_automation_queue: illegal state transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.tenant_email_luna_automation_shadow_outcomes (
  operation_id uuid PRIMARY KEY,
  issuance_id uuid NOT NULL,
  audit_operation_id uuid NOT NULL,
  claim_lease_owner uuid NOT NULL,
  client_id uuid NOT NULL,
  location_id uuid NOT NULL,
  location_key text NOT NULL,
  endpoint_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  inbound_event_id uuid NOT NULL,
  recipient_digest text NOT NULL,
  policy_version text NOT NULL,
  eligibility_policy_version text NOT NULL,
  validator_version text NOT NULL,
  luna_decision text NOT NULL,
  comparison_state text NOT NULL,
  human_action_id uuid NULL,
  human_outcome text NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_issuance_uq UNIQUE (issuance_id),
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_queue_fk
    FOREIGN KEY (
      operation_id,
      issuance_id,
      audit_operation_id,
      client_id,
      location_id,
      location_key,
      endpoint_id,
      conversation_id,
      inbound_event_id,
      recipient_digest,
      policy_version,
      eligibility_policy_version,
      validator_version
    )
    REFERENCES public.tenant_email_luna_automation_queue (
      operation_id,
      issuance_id,
      audit_operation_id,
      client_id,
      location_id,
      location_key,
      endpoint_id,
      conversation_id,
      inbound_event_id,
      recipient_digest,
      policy_version,
      eligibility_policy_version,
      validator_version
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_audit_fk
    FOREIGN KEY (
      audit_operation_id, issuance_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id
    )
    REFERENCES public.tenant_email_luna_policy_audit (
      operation_id, issuance_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_material_fk
    FOREIGN KEY (operation_id)
    REFERENCES public.tenant_email_luna_automation_issuance_material (operation_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_location_fk
    FOREIGN KEY (client_id, location_id, location_key)
    REFERENCES public.tenant_locations (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_digest_shape
    CHECK (recipient_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_policy_values
    CHECK (policy_version = 'email-luna-draft-policy.v1' AND char_length(policy_version) BETWEEN 1 AND 64),
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_eligibility_values
    CHECK (
      eligibility_policy_version = 'email-luna-autonomous-eligibility-policy.v1'
      AND char_length(eligibility_policy_version) BETWEEN 1 AND 64
    ),
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_validator_values
    CHECK (
      validator_version = 'email-luna-draft-validator.v1'
      AND char_length(validator_version) BETWEEN 1 AND 64
    ),
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_decision_values
    CHECK (luna_decision = 'would_send'),
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_comparison_values
    CHECK (comparison_state = 'pending_human'),
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_human_unbound
    CHECK (human_action_id IS NULL AND human_outcome IS NULL),
  CONSTRAINT tenant_email_luna_automation_shadow_outcomes_location_key_shape
    CHECK (location_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(location_key) BETWEEN 1 AND 64)
);

COMMENT ON TABLE public.tenant_email_luna_automation_shadow_outcomes IS
  'Luna-side durable shadow comparison outcome. One row per automation operation. Safe decision metadata only; not subject/body/recipient/secrets. Later-match against 070 is read-time; capture always stores pending_human. NOT a send journal.';
COMMENT ON COLUMN public.tenant_email_luna_automation_shadow_outcomes.claim_lease_owner IS
  'Lease owner token that first captured the outcome. Append-only; reclaim does not overwrite.';
COMMENT ON COLUMN public.tenant_email_luna_automation_shadow_outcomes.recipient_digest IS
  'SHA-256 of the queue-bound normalized recipient. Raw recipient address is not stored here.';
COMMENT ON COLUMN public.tenant_email_luna_automation_shadow_outcomes.luna_decision IS
  'Derived would_send from locked claimed queue + 092 material + 085 draft_ready/eligible. Not caller-selected.';
COMMENT ON COLUMN public.tenant_email_luna_automation_shadow_outcomes.comparison_state IS
  'Capture-time pending_human. Agreement/excluded/invalid are computed by later-match projection against 070; disagreement is not grounded.';
COMMENT ON COLUMN public.tenant_email_luna_automation_shadow_outcomes.human_action_id IS
  'Reserved. This slice does not bind a human action; later-match reads 070 without writing this column.';

CREATE INDEX IF NOT EXISTS idx_tenant_email_luna_automation_shadow_outcomes_conversation
  ON public.tenant_email_luna_automation_shadow_outcomes (client_id, conversation_id, inbound_event_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_shadow_outcomes_protect() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'tenant_email_luna_automation_shadow_outcomes: append-only mutation refused' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS tenant_email_luna_automation_shadow_outcomes_protect_update
  ON public.tenant_email_luna_automation_shadow_outcomes;
CREATE TRIGGER tenant_email_luna_automation_shadow_outcomes_protect_update
  BEFORE UPDATE ON public.tenant_email_luna_automation_shadow_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.tenant_email_luna_automation_shadow_outcomes_protect();
DROP TRIGGER IF EXISTS tenant_email_luna_automation_shadow_outcomes_protect_delete
  ON public.tenant_email_luna_automation_shadow_outcomes;
CREATE TRIGGER tenant_email_luna_automation_shadow_outcomes_protect_delete
  BEFORE DELETE ON public.tenant_email_luna_automation_shadow_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.tenant_email_luna_automation_shadow_outcomes_protect();

DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_capture_shadow(uuid, uuid);
CREATE FUNCTION public.tenant_email_luna_automation_capture_shadow(
  p_operation uuid,
  p_owner uuid
) RETURNS TABLE (
  persist_status text,
  operation_id uuid,
  issuance_id uuid,
  audit_operation_id uuid,
  claim_lease_owner uuid,
  client_id uuid,
  location_id uuid,
  location_key text,
  endpoint_id uuid,
  conversation_id uuid,
  inbound_event_id uuid,
  recipient_digest text,
  policy_version text,
  eligibility_policy_version text,
  validator_version text,
  luna_decision text,
  comparison_state text,
  queue_state text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  q public.tenant_email_luna_automation_queue;
  m public.tenant_email_luna_automation_issuance_material;
  o public.tenant_email_luna_automation_shadow_outcomes;
  audit_ok boolean;
BEGIN
  IF p_operation IS NULL OR p_owner IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO o
    FROM public.tenant_email_luna_automation_shadow_outcomes AS so
   WHERE so.operation_id = p_operation
   FOR SHARE;

  SELECT * INTO q
    FROM public.tenant_email_luna_automation_queue AS qq
   WHERE qq.operation_id = p_operation
     AND public.tenant_email_luna_automation_principal_authorized(
           'worker', qq.client_id, qq.location_id, qq.location_key
         )
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF q.state = 'shadow_captured' AND o.operation_id IS NOT NULL THEN
    IF o.operation_id IS DISTINCT FROM q.operation_id
       OR o.issuance_id IS DISTINCT FROM q.issuance_id
       OR o.audit_operation_id IS DISTINCT FROM q.audit_operation_id
       OR o.client_id IS DISTINCT FROM q.client_id
       OR o.location_id IS DISTINCT FROM q.location_id
       OR o.location_key IS DISTINCT FROM q.location_key
       OR o.endpoint_id IS DISTINCT FROM q.endpoint_id
       OR o.conversation_id IS DISTINCT FROM q.conversation_id
       OR o.inbound_event_id IS DISTINCT FROM q.inbound_event_id
       OR o.recipient_digest IS DISTINCT FROM q.recipient_digest
       OR o.luna_decision IS DISTINCT FROM 'would_send'
       OR o.comparison_state IS DISTINCT FROM 'pending_human' THEN
      RAISE EXCEPTION 'tenant_email_luna_automation_capture_shadow: identity conflict' USING ERRCODE = '23514';
    END IF;
    persist_status := 'replayed';
    operation_id := o.operation_id;
    issuance_id := o.issuance_id;
    audit_operation_id := o.audit_operation_id;
    claim_lease_owner := o.claim_lease_owner;
    client_id := o.client_id;
    location_id := o.location_id;
    location_key := o.location_key;
    endpoint_id := o.endpoint_id;
    conversation_id := o.conversation_id;
    inbound_event_id := o.inbound_event_id;
    recipient_digest := o.recipient_digest;
    policy_version := o.policy_version;
    eligibility_policy_version := o.eligibility_policy_version;
    validator_version := o.validator_version;
    luna_decision := o.luna_decision;
    comparison_state := o.comparison_state;
    queue_state := q.state;
    attempt_count := q.attempt_count;
    RETURN NEXT;
    RETURN;
  END IF;

  IF q.state IS DISTINCT FROM 'claimed'
     OR q.lease_owner IS DISTINCT FROM p_owner
     OR q.lease_expires_at IS NULL
     OR q.lease_expires_at < pg_catalog.now()
     OR q.handoff_id IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT * INTO m
    FROM public.tenant_email_luna_automation_issuance_material AS mat
   WHERE mat.operation_id = q.operation_id
     AND mat.issuance_id = q.issuance_id
     AND mat.audit_operation_id = q.audit_operation_id
     AND mat.client_id = q.client_id
     AND mat.location_id = q.location_id
     AND mat.location_key = q.location_key
     AND mat.endpoint_id = q.endpoint_id
     AND mat.conversation_id = q.conversation_id
     AND mat.inbound_event_id = q.inbound_event_id
     AND mat.draft_digest = q.draft_digest
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT true INTO audit_ok
    FROM public.tenant_email_luna_policy_audit AS a
   WHERE a.operation_id = q.audit_operation_id
     AND a.issuance_id = q.issuance_id
     AND a.client_id = q.client_id
     AND a.location_id = q.location_id
     AND a.location_key = q.location_key
     AND a.endpoint_id = q.endpoint_id
     AND a.conversation_id = q.conversation_id
     AND a.inbound_event_id = q.inbound_event_id
     AND a.canonical_status = 'draft_ready'
     AND a.eligibility_status = 'eligible'
     AND a.policy_version = q.policy_version
     AND a.eligibility_policy_version = q.eligibility_policy_version
   FOR SHARE;
  IF audit_ok IS DISTINCT FROM TRUE THEN
    RETURN;
  END IF;

  IF o.operation_id IS NOT NULL THEN
    IF o.issuance_id IS DISTINCT FROM q.issuance_id
       OR o.claim_lease_owner IS NULL
       OR o.luna_decision IS DISTINCT FROM 'would_send'
       OR o.comparison_state IS DISTINCT FROM 'pending_human'
       OR o.recipient_digest IS DISTINCT FROM q.recipient_digest THEN
      RAISE EXCEPTION 'tenant_email_luna_automation_capture_shadow: identity conflict' USING ERRCODE = '23514';
    END IF;
  ELSE
    BEGIN
      INSERT INTO public.tenant_email_luna_automation_shadow_outcomes (
        operation_id, issuance_id, audit_operation_id, claim_lease_owner,
        client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id,
        recipient_digest, policy_version, eligibility_policy_version, validator_version,
        luna_decision, comparison_state, human_action_id, human_outcome
      ) VALUES (
        q.operation_id, q.issuance_id, q.audit_operation_id, p_owner,
        q.client_id, q.location_id, q.location_key, q.endpoint_id, q.conversation_id, q.inbound_event_id,
        q.recipient_digest, q.policy_version, q.eligibility_policy_version, q.validator_version,
        'would_send', 'pending_human', NULL, NULL
      )
      RETURNING * INTO o;
    EXCEPTION
      WHEN unique_violation THEN
        SELECT * INTO o
          FROM public.tenant_email_luna_automation_shadow_outcomes AS so
         WHERE so.operation_id = q.operation_id
           AND so.issuance_id = q.issuance_id
           AND so.luna_decision = 'would_send'
           AND so.comparison_state = 'pending_human'
         FOR SHARE;
        IF o.operation_id IS NULL THEN
          RAISE EXCEPTION 'tenant_email_luna_automation_capture_shadow: identity conflict' USING ERRCODE = '23514';
        END IF;
    END;
  END IF;

  UPDATE public.tenant_email_luna_automation_queue AS qq
     SET state = 'shadow_captured',
         lease_owner = NULL,
         lease_expires_at = NULL
   WHERE qq.operation_id = q.operation_id
     AND qq.state = 'claimed'
     AND qq.lease_owner = p_owner
     AND qq.lease_expires_at >= pg_catalog.now()
     AND qq.handoff_id IS NULL
     AND public.tenant_email_luna_automation_principal_authorized(
           'worker', qq.client_id, qq.location_id, qq.location_key
         )
  RETURNING * INTO q;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_capture_shadow: queue terminalize refused' USING ERRCODE = '23514';
  END IF;

  persist_status := CASE
    WHEN o.claim_lease_owner IS NOT DISTINCT FROM p_owner THEN 'committed'
    ELSE 'replayed'
  END;
  operation_id := o.operation_id;
  issuance_id := o.issuance_id;
  audit_operation_id := o.audit_operation_id;
  claim_lease_owner := o.claim_lease_owner;
  client_id := o.client_id;
  location_id := o.location_id;
  location_key := o.location_key;
  endpoint_id := o.endpoint_id;
  conversation_id := o.conversation_id;
  inbound_event_id := o.inbound_event_id;
  recipient_digest := o.recipient_digest;
  policy_version := o.policy_version;
  eligibility_policy_version := o.eligibility_policy_version;
  validator_version := o.validator_version;
  luna_decision := o.luna_decision;
  comparison_state := o.comparison_state;
  queue_state := q.state;
  attempt_count := q.attempt_count;
  RETURN NEXT;
END;
$$;

DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_shadow_outcome_load(uuid, uuid);
CREATE FUNCTION public.tenant_email_luna_automation_shadow_outcome_load(
  p_operation uuid,
  p_issuance uuid
) RETURNS TABLE (
  operation_id uuid,
  issuance_id uuid,
  audit_operation_id uuid,
  claim_lease_owner uuid,
  client_id uuid,
  location_id uuid,
  location_key text,
  endpoint_id uuid,
  conversation_id uuid,
  inbound_event_id uuid,
  recipient_digest text,
  policy_version text,
  eligibility_policy_version text,
  validator_version text,
  luna_decision text,
  comparison_state text,
  queue_state text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  o public.tenant_email_luna_automation_shadow_outcomes;
  q public.tenant_email_luna_automation_queue;
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
   WHERE qq.operation_id = p_operation
     AND qq.issuance_id = p_issuance
     AND public.tenant_email_luna_automation_principal_authorized(
           'worker', qq.client_id, qq.location_id, qq.location_key
         )
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF q.state IS DISTINCT FROM 'shadow_captured' THEN
    RETURN;
  END IF;
  IF q.handoff_id IS NOT NULL
     OR o.recipient_digest IS DISTINCT FROM q.recipient_digest
     OR o.luna_decision IS DISTINCT FROM 'would_send'
     OR o.comparison_state IS DISTINCT FROM 'pending_human' THEN
    RETURN;
  END IF;

  operation_id := o.operation_id;
  issuance_id := o.issuance_id;
  audit_operation_id := o.audit_operation_id;
  claim_lease_owner := o.claim_lease_owner;
  client_id := o.client_id;
  location_id := o.location_id;
  location_key := o.location_key;
  endpoint_id := o.endpoint_id;
  conversation_id := o.conversation_id;
  inbound_event_id := o.inbound_event_id;
  recipient_digest := o.recipient_digest;
  policy_version := o.policy_version;
  eligibility_policy_version := o.eligibility_policy_version;
  validator_version := o.validator_version;
  luna_decision := o.luna_decision;
  comparison_state := o.comparison_state;
  queue_state := q.state;
  attempt_count := q.attempt_count;
  RETURN NEXT;
END;
$$;

DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid);
CREATE FUNCTION public.tenant_email_luna_automation_shadow_outcome_project(
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

COMMENT ON FUNCTION public.tenant_email_luna_automation_capture_shadow(uuid, uuid) IS
  'Worker live-lease CAS persist of the Luna shadow outcome and claimed→shadow_captured terminal. Derives would_send/pending_human from locked queue+material+audit. Same-identity replay. Stale/expired owner is a no-op. Does not invoke a provider or write the outbound send journal.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_shadow_outcome_load(uuid, uuid) IS
  'Scoped worker load of a captured shadow outcome. Authorizes session_user in the locking predicate. Requires shadow_captured. Returns identity+digest+safe decision metadata, not subject/body/recipient/secrets.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid) IS
  'Staff-safe later-match projection. Hides raw UUIDs, recipient digest, and 070 body. Unique 070 approved|terminal on exact inbound/conversation/location/endpoint is agreement; none is pending_human; duplicates excluded; rebound inbound identity is invalid. Never infers disagreement from absence.';

DO $$
DECLARE
  table_owner name;
  fn_ident text;
  fns text[] := ARRAY[
    'tenant_email_luna_automation_queue_protect()',
    'tenant_email_luna_automation_shadow_outcomes_protect()',
    'tenant_email_luna_automation_capture_shadow(uuid, uuid)',
    'tenant_email_luna_automation_shadow_outcome_load(uuid, uuid)',
    'tenant_email_luna_automation_shadow_outcome_project(uuid, uuid)'
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
    RAISE EXCEPTION '093: queue table owner missing';
  END IF;
  EXECUTE format('ALTER TABLE public.tenant_email_luna_automation_shadow_outcomes OWNER TO %I', table_owner);
  FOREACH fn_ident IN ARRAY fns LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO %I', fn_ident, table_owner);
  END LOOP;
END $$;

ALTER TABLE public.tenant_email_luna_automation_shadow_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_email_luna_automation_shadow_outcomes_principal_select
  ON public.tenant_email_luna_automation_shadow_outcomes;
CREATE POLICY tenant_email_luna_automation_shadow_outcomes_principal_select
  ON public.tenant_email_luna_automation_shadow_outcomes
  FOR SELECT
  USING (
    public.tenant_email_luna_automation_principal_authorized('worker', client_id, location_id, location_key)
  );

REVOKE INSERT, UPDATE, DELETE ON TABLE public.tenant_email_luna_automation_shadow_outcomes FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_email_luna_automation_shadow_outcomes FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_shadow_outcomes_protect() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_capture_shadow(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_shadow_outcome_load(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid) FROM PUBLIC;

COMMIT;
