-- 087_tenant_email_luna_automation_journal_handoff.sql
-- FULL SAIL Stage 1 NIGHTWATCH Ch3 Slice B: atomic queue-to-canonical-outbound-journal handoff.
-- Canonical tenant_email_outbound_send_journal remains the sole provider / exact-once owner.
-- Queue never calls a provider, never owns send status, and never creates a second journal.
--
-- 068/069 journal identity still starts at claimed/claimed for staff Graph reply-draft.
-- That path requires approval_id + actor_staff_user_id and may proceed to create_dispatched.
-- Luna automation has no staff approval and must not enter provider authorization.
-- Smallest explicit pre-provider state: phase handoff_established + outcome handed_off,
-- counts 0, immutable_draft_id NULL, approval/actor NULL, sealed (no create/update/send).
--
-- Handoff transaction (SECURITY DEFINER): exact operation + matching live lease owner +
-- pg_catalog.now(). Lock queue then journal by operation_id. Create-or-replay exactly one
-- canonical journal row copied from the locked queue (not caller-selected tenant/provider/
-- address). Detect identity conflict. Only then set queue handed_off with handoff_id =
-- journal.operation_id = queue.operation_id. One winner under concurrency.
--
-- Durable one-way replay authority: in the same first-handoff transaction, persist
-- luna_replay_owner_digest = encode(sha256(convert_to('luna-replay-owner-v1:' ||
-- canonical live owner uuid text, 'UTF8')), 'hex') using pg_catalog.sha256 / encode /
-- convert_to (already used by 086; not a contrib crypto extension; schema-qualified).
-- Store only the 64-hex digest; never the plaintext owner token. Required exactly for
-- Luna handoff_established; NULL for all legacy staff states; shape-checked; immutable.
-- After terminalize, lease_owner is cleared, so replay cannot use the live lease.
-- On q.state=handed_off, require p_owner non-null and the SHA-256 of p_owner equal to the
-- sealed digest before returning any row. Random/different/stale non-owner returns no
-- row and reveals no queue/journal metadata through this function. Same-owner replay
-- after unknown commit returns the same linked identity. Blind replay cannot mint
-- another. This proof secures the privileged replay function. General table SELECT
-- scoping is a later runtime-role/RLS decision (Ch4) only if the architecture already
-- treats the worker as service-wide trusted.
--
-- 087 does not GRANT and does not CREATE ROLE. PUBLIC is revoked on the replaced handoff
-- function. Worker/operator grant contract is comments/verifier only (Ch4). Direct worker
-- DML on queue and journal remains denied. No runtime wiring, activation flag, transport,
-- or provider network import.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'tenant_email_luna_automation_queue_journal_bind_uq'
  ) THEN
    ALTER TABLE public.tenant_email_luna_automation_queue
      ADD CONSTRAINT tenant_email_luna_automation_queue_journal_bind_uq UNIQUE (
        operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
        endpoint_id, conversation_id, inbound_event_id, recipient_address, draft_digest
      );
  END IF;
END $$;

ALTER TABLE public.tenant_email_outbound_send_journal
  ALTER COLUMN approval_id DROP NOT NULL,
  ALTER COLUMN actor_staff_user_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'tenant_email_outbound_send_journal'
      AND a.attname = 'luna_automation_operation_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    ALTER TABLE public.tenant_email_outbound_send_journal
      ADD COLUMN luna_automation_operation_id UUID NULL,
      ADD COLUMN luna_automation_issuance_id UUID NULL,
      ADD COLUMN luna_automation_audit_operation_id UUID NULL,
      ADD COLUMN luna_inbound_event_id UUID NULL,
      ADD COLUMN luna_recipient_address TEXT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'tenant_email_outbound_send_journal'
      AND a.attname = 'luna_replay_owner_digest'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    ALTER TABLE public.tenant_email_outbound_send_journal
      ADD COLUMN luna_replay_owner_digest TEXT NULL;
  END IF;
END $$;

ALTER TABLE public.tenant_email_outbound_send_journal
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_phase_values,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_phase_draft_coupling,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_outcome_phase_coupling,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_outcome_values;

ALTER TABLE public.tenant_email_outbound_send_journal
  ADD CONSTRAINT tenant_email_outbound_send_journal_phase_values
    CHECK (phase IN (
      'handoff_established', 'claimed', 'create_dispatched', 'draft_created', 'update_dispatched',
      'draft_updated', 'send_dispatched', 'reconciled_sent', 'terminal'
    )),
  ADD CONSTRAINT tenant_email_outbound_send_journal_outcome_values
    CHECK (outcome IN (
      'handed_off', 'claimed', 'committed', 'not_committed', 'outcome_unknown', 'conflict', 'rejected'
    )),
  ADD CONSTRAINT tenant_email_outbound_send_journal_luna_recipient_shape
    CHECK (
      luna_recipient_address IS NULL
      OR (
        luna_recipient_address = lower(luna_recipient_address)
        AND luna_recipient_address ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
        AND char_length(luna_recipient_address) BETWEEN 3 AND 320
      )
    ),
  ADD CONSTRAINT tenant_email_outbound_send_journal_luna_replay_owner_digest_shape
    CHECK (
      luna_replay_owner_digest IS NULL
      OR luna_replay_owner_digest ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT tenant_email_outbound_send_journal_luna_operation_match
    CHECK (
      luna_automation_operation_id IS NULL
      OR luna_automation_operation_id = operation_id
    ),
  ADD CONSTRAINT tenant_email_outbound_send_journal_phase_draft_coupling CHECK (
    (
      phase = 'handoff_established'
      AND outcome = 'handed_off'
      AND immutable_draft_id IS NULL
      AND approval_id IS NULL
      AND actor_staff_user_id IS NULL
      AND create_invocation_count = 0
      AND update_invocation_count = 0
      AND send_invocation_count = 0
      AND luna_automation_operation_id IS NOT NULL
      AND luna_automation_issuance_id IS NOT NULL
      AND luna_automation_audit_operation_id IS NOT NULL
      AND luna_inbound_event_id IS NOT NULL
      AND luna_recipient_address IS NOT NULL
      AND luna_replay_owner_digest IS NOT NULL
    )
    OR (
      phase = 'claimed' AND immutable_draft_id IS NULL
      AND create_invocation_count = 0 AND update_invocation_count = 0 AND send_invocation_count = 0
      AND approval_id IS NOT NULL AND actor_staff_user_id IS NOT NULL
      AND luna_automation_operation_id IS NULL AND luna_automation_issuance_id IS NULL
      AND luna_automation_audit_operation_id IS NULL AND luna_inbound_event_id IS NULL
      AND luna_recipient_address IS NULL
      AND luna_replay_owner_digest IS NULL
    )
    OR (
      phase = 'create_dispatched' AND immutable_draft_id IS NULL
      AND create_invocation_count = 1 AND update_invocation_count = 0 AND send_invocation_count = 0
      AND approval_id IS NOT NULL AND actor_staff_user_id IS NOT NULL
      AND luna_automation_operation_id IS NULL AND luna_automation_issuance_id IS NULL
      AND luna_automation_audit_operation_id IS NULL AND luna_inbound_event_id IS NULL
      AND luna_recipient_address IS NULL
      AND luna_replay_owner_digest IS NULL
    )
    OR (
      phase = 'draft_created' AND immutable_draft_id IS NOT NULL
      AND create_invocation_count = 1 AND update_invocation_count = 0 AND send_invocation_count = 0
      AND approval_id IS NOT NULL AND actor_staff_user_id IS NOT NULL
      AND luna_automation_operation_id IS NULL AND luna_automation_issuance_id IS NULL
      AND luna_automation_audit_operation_id IS NULL AND luna_inbound_event_id IS NULL
      AND luna_recipient_address IS NULL
      AND luna_replay_owner_digest IS NULL
    )
    OR (
      phase = 'update_dispatched' AND immutable_draft_id IS NOT NULL
      AND create_invocation_count = 1 AND update_invocation_count = 1 AND send_invocation_count = 0
      AND approval_id IS NOT NULL AND actor_staff_user_id IS NOT NULL
      AND luna_automation_operation_id IS NULL AND luna_automation_issuance_id IS NULL
      AND luna_automation_audit_operation_id IS NULL AND luna_inbound_event_id IS NULL
      AND luna_recipient_address IS NULL
      AND luna_replay_owner_digest IS NULL
    )
    OR (
      phase = 'draft_updated' AND immutable_draft_id IS NOT NULL
      AND create_invocation_count = 1 AND update_invocation_count = 1 AND send_invocation_count = 0
      AND approval_id IS NOT NULL AND actor_staff_user_id IS NOT NULL
      AND luna_automation_operation_id IS NULL AND luna_automation_issuance_id IS NULL
      AND luna_automation_audit_operation_id IS NULL AND luna_inbound_event_id IS NULL
      AND luna_recipient_address IS NULL
      AND luna_replay_owner_digest IS NULL
    )
    OR (
      phase = 'send_dispatched' AND immutable_draft_id IS NOT NULL
      AND create_invocation_count = 1 AND update_invocation_count = 1 AND send_invocation_count = 1
      AND approval_id IS NOT NULL AND actor_staff_user_id IS NOT NULL
      AND luna_automation_operation_id IS NULL AND luna_automation_issuance_id IS NULL
      AND luna_automation_audit_operation_id IS NULL AND luna_inbound_event_id IS NULL
      AND luna_recipient_address IS NULL
      AND luna_replay_owner_digest IS NULL
    )
    OR (
      phase = 'reconciled_sent' AND immutable_draft_id IS NOT NULL
      AND create_invocation_count = 1 AND update_invocation_count = 1 AND send_invocation_count = 1
      AND outcome = 'committed'
      AND approval_id IS NOT NULL AND actor_staff_user_id IS NOT NULL
      AND luna_automation_operation_id IS NULL AND luna_automation_issuance_id IS NULL
      AND luna_automation_audit_operation_id IS NULL AND luna_inbound_event_id IS NULL
      AND luna_recipient_address IS NULL
      AND luna_replay_owner_digest IS NULL
    )
    OR (
      phase = 'terminal' AND outcome IN ('not_committed', 'outcome_unknown', 'conflict', 'rejected')
      AND create_invocation_count >= 0 AND create_invocation_count <= 1
      AND update_invocation_count >= 0 AND update_invocation_count <= 1
      AND send_invocation_count >= 0 AND send_invocation_count <= 1
      AND (update_invocation_count = 0 OR create_invocation_count = 1)
      AND (send_invocation_count = 0 OR (
        create_invocation_count = 1 AND update_invocation_count = 1
      ))
      AND (immutable_draft_id IS NULL OR create_invocation_count = 1)
      AND approval_id IS NOT NULL AND actor_staff_user_id IS NOT NULL
      AND luna_automation_operation_id IS NULL AND luna_automation_issuance_id IS NULL
      AND luna_automation_audit_operation_id IS NULL AND luna_inbound_event_id IS NULL
      AND luna_recipient_address IS NULL
      AND luna_replay_owner_digest IS NULL
    )
  ),
  ADD CONSTRAINT tenant_email_outbound_send_journal_outcome_phase_coupling CHECK (
    (outcome = 'handed_off' AND phase = 'handoff_established')
    OR (outcome = 'claimed' AND phase = 'claimed')
    OR (outcome = 'committed' AND phase = 'reconciled_sent')
    OR (outcome = 'not_committed' AND phase IN ('claimed', 'draft_created', 'draft_updated', 'terminal')
      AND send_invocation_count = 0)
    OR (outcome = 'outcome_unknown' AND phase IN (
      'create_dispatched', 'update_dispatched', 'send_dispatched', 'terminal'
    ))
    OR (outcome = 'conflict' AND phase = 'terminal')
    OR (outcome = 'rejected' AND phase = 'terminal')
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'tenant_email_outbound_send_journal_luna_operation_uq'
  ) THEN
    ALTER TABLE public.tenant_email_outbound_send_journal
      ADD CONSTRAINT tenant_email_outbound_send_journal_luna_operation_uq
      UNIQUE (luna_automation_operation_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'tenant_email_outbound_send_journal_luna_issuance_uq'
  ) THEN
    ALTER TABLE public.tenant_email_outbound_send_journal
      ADD CONSTRAINT tenant_email_outbound_send_journal_luna_issuance_uq
      UNIQUE (luna_automation_issuance_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'tenant_email_outbound_send_journal_luna_queue_fk'
  ) THEN
    ALTER TABLE public.tenant_email_outbound_send_journal
      ADD CONSTRAINT tenant_email_outbound_send_journal_luna_queue_fk
      FOREIGN KEY (
        luna_automation_operation_id,
        luna_automation_issuance_id,
        luna_automation_audit_operation_id,
        client_id,
        location_id,
        location_key,
        endpoint_id,
        conversation_id,
        luna_inbound_event_id,
        luna_recipient_address,
        body_digest
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
        recipient_address,
        draft_digest
      )
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tenant_email_outbound_send_journal_protect() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO pg_catalog, public
AS $$
DECLARE oo INT; onr INT;
BEGIN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.location_key IS DISTINCT FROM OLD.location_key
     OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
     OR NEW.actor_staff_user_id IS DISTINCT FROM OLD.actor_staff_user_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.body_digest IS DISTINCT FROM OLD.body_digest
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.luna_automation_operation_id IS DISTINCT FROM OLD.luna_automation_operation_id
     OR NEW.luna_automation_issuance_id IS DISTINCT FROM OLD.luna_automation_issuance_id
     OR NEW.luna_automation_audit_operation_id IS DISTINCT FROM OLD.luna_automation_audit_operation_id
     OR NEW.luna_inbound_event_id IS DISTINCT FROM OLD.luna_inbound_event_id
     OR NEW.luna_recipient_address IS DISTINCT FROM OLD.luna_recipient_address
     OR NEW.luna_replay_owner_digest IS DISTINCT FROM OLD.luna_replay_owner_digest THEN
    RAISE EXCEPTION 'tenant_email_outbound_send_journal: immutable field mutation refused' USING ERRCODE = '23514';
  END IF;
  IF OLD.phase = 'handoff_established' THEN
    IF NEW.phase IS DISTINCT FROM OLD.phase
       OR NEW.outcome IS DISTINCT FROM OLD.outcome
       OR NEW.immutable_draft_id IS DISTINCT FROM OLD.immutable_draft_id
       OR NEW.create_invocation_count IS DISTINCT FROM OLD.create_invocation_count
       OR NEW.update_invocation_count IS DISTINCT FROM OLD.update_invocation_count
       OR NEW.send_invocation_count IS DISTINCT FROM OLD.send_invocation_count THEN
      RAISE EXCEPTION 'tenant_email_outbound_send_journal: handoff_established row sealed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.phase = 'terminal' THEN
    IF NEW.phase IS DISTINCT FROM OLD.phase
       OR NEW.outcome IS DISTINCT FROM OLD.outcome
       OR NEW.immutable_draft_id IS DISTINCT FROM OLD.immutable_draft_id
       OR NEW.create_invocation_count IS DISTINCT FROM OLD.create_invocation_count
       OR NEW.update_invocation_count IS DISTINCT FROM OLD.update_invocation_count
       OR NEW.send_invocation_count IS DISTINCT FROM OLD.send_invocation_count THEN
      RAISE EXCEPTION 'tenant_email_outbound_send_journal: terminal row sealed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.immutable_draft_id IS NOT NULL AND NEW.immutable_draft_id IS DISTINCT FROM OLD.immutable_draft_id THEN
    RAISE EXCEPTION 'tenant_email_outbound_send_journal: immutable_draft_id replacement refused' USING ERRCODE = '23514';
  END IF;
  IF NEW.create_invocation_count < OLD.create_invocation_count THEN
    RAISE EXCEPTION 'tenant_email_outbound_send_journal: create_invocation_count decrement refused' USING ERRCODE = '23514';
  END IF;
  IF NEW.update_invocation_count < OLD.update_invocation_count THEN
    RAISE EXCEPTION 'tenant_email_outbound_send_journal: update_invocation_count decrement refused' USING ERRCODE = '23514';
  END IF;
  IF NEW.send_invocation_count < OLD.send_invocation_count THEN
    RAISE EXCEPTION 'tenant_email_outbound_send_journal: send_invocation_count decrement refused' USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.phase IS NOT DISTINCT FROM OLD.phase
    OR (OLD.phase = 'claimed' AND NEW.phase IN ('create_dispatched', 'terminal'))
    OR (OLD.phase = 'create_dispatched' AND NEW.phase IN ('draft_created', 'terminal'))
    OR (OLD.phase = 'draft_created' AND NEW.phase IN ('update_dispatched', 'terminal'))
    OR (OLD.phase = 'update_dispatched' AND NEW.phase IN ('draft_updated', 'terminal'))
    OR (OLD.phase = 'draft_updated' AND NEW.phase IN ('send_dispatched', 'terminal'))
    OR (OLD.phase = 'send_dispatched' AND NEW.phase IN ('reconciled_sent', 'terminal'))) THEN
    RAISE EXCEPTION 'tenant_email_outbound_send_journal: illegal phase transition' USING ERRCODE = '23514';
  END IF;
  oo := CASE OLD.outcome WHEN 'claimed' THEN 0 WHEN 'not_committed' THEN 1 WHEN 'outcome_unknown' THEN 2 WHEN 'committed' THEN 3 WHEN 'conflict' THEN 3 WHEN 'rejected' THEN 3 WHEN 'handed_off' THEN 3 ELSE -1 END;
  onr := CASE NEW.outcome WHEN 'claimed' THEN 0 WHEN 'not_committed' THEN 1 WHEN 'outcome_unknown' THEN 2 WHEN 'committed' THEN 3 WHEN 'conflict' THEN 3 WHEN 'rejected' THEN 3 WHEN 'handed_off' THEN 3 ELSE -1 END;
  IF onr < oo AND NOT (
    OLD.outcome = 'outcome_unknown' AND NEW.outcome = 'not_committed'
    AND (
      (OLD.phase = 'create_dispatched' AND NEW.phase = 'draft_created')
      OR (OLD.phase = 'update_dispatched' AND NEW.phase = 'draft_updated')
    )
  ) THEN
    RAISE EXCEPTION 'tenant_email_outbound_send_journal: outcome regression refused' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
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

COMMENT ON FUNCTION public.tenant_email_luna_automation_handoff(uuid, uuid) IS
  'Worker live claimed owner CAS handoff. Atomically create-or-replay exactly one canonical outbound-journal handoff_established row, then terminalize queue handed_off with journal-linked identity. Replay of handed_off requires p_owner whose pg_catalog.sha256 digest equals the immutable luna_replay_owner_digest sealed at first handoff. Wrong owner returns no row. Does not invoke a provider. Secures this privileged function; table SELECT scoping is a later Ch4 runtime-role/RLS decision.';
COMMENT ON COLUMN public.tenant_email_outbound_send_journal.luna_automation_operation_id IS
  '087 Luna automation operation identity. NULL on staff Graph journal rows. Equals operation_id when set.';
COMMENT ON COLUMN public.tenant_email_outbound_send_journal.luna_replay_owner_digest IS
  '087-owned one-way replay authority. SHA-256 hex of domain-separated canonical live owner UUID (luna-replay-owner-v1: + uuid text) via pg_catalog.sha256/encode/convert_to. Required for Luna handoff_established; NULL on staff rows; never plaintext owner; immutable.';
COMMENT ON COLUMN public.tenant_email_outbound_send_journal.luna_automation_issuance_id IS
  '087 Luna policy issuance bound through the queue composite FK. Unique when set.';
COMMENT ON TABLE public.tenant_email_outbound_send_journal IS
  'Outbound send journal. Staff Graph path remains claimed→create_dispatched→…; Luna automation establishes sealed handoff_established before any provider intent. Journal remains sole provider/exact-once owner.';

REVOKE INSERT, UPDATE, DELETE ON TABLE public.tenant_email_luna_automation_queue FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.tenant_email_outbound_send_journal FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_handoff(uuid, uuid) FROM PUBLIC;

COMMIT;
