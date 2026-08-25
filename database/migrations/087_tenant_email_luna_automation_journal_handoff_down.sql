-- Explicit down for 087_tenant_email_luna_automation_journal_handoff.
-- Fail closed when canonical journal rows carry Luna handoff associations or the
-- pre-provider handoff_established/handed_off state (refuse silent identity loss).
-- Empty of those associations: restore exact pre-087 journal constraints/protect
-- function, restore 086 queue-only handoff, drop 087 columns/uniques/FK.
-- Second empty execution is safe.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_outbound_send_journal'
       AND c.relkind = 'r'
  ) AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'tenant_email_outbound_send_journal'
      AND a.attname = 'luna_automation_operation_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.tenant_email_outbound_send_journal
       WHERE luna_automation_operation_id IS NOT NULL
          OR luna_automation_issuance_id IS NOT NULL
          OR luna_automation_audit_operation_id IS NOT NULL
          OR luna_inbound_event_id IS NOT NULL
          OR luna_recipient_address IS NOT NULL
          OR luna_replay_owner_digest IS NOT NULL
          OR phase = 'handoff_established'
          OR outcome = 'handed_off'
    ) THEN
      RAISE EXCEPTION '087_down_refused: luna journal handoff identity present — refuse silent identity loss';
    END IF;
  END IF;
END $$;

ALTER TABLE public.tenant_email_outbound_send_journal
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_luna_queue_fk,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_luna_issuance_uq,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_luna_operation_uq,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_luna_operation_match,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_luna_replay_owner_digest_shape,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_luna_recipient_shape,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_outcome_phase_coupling,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_phase_draft_coupling,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_phase_values,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_outcome_values;

ALTER TABLE public.tenant_email_outbound_send_journal
  DROP COLUMN IF EXISTS luna_automation_operation_id,
  DROP COLUMN IF EXISTS luna_automation_issuance_id,
  DROP COLUMN IF EXISTS luna_automation_audit_operation_id,
  DROP COLUMN IF EXISTS luna_inbound_event_id,
  DROP COLUMN IF EXISTS luna_recipient_address,
  DROP COLUMN IF EXISTS luna_replay_owner_digest;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'tenant_email_outbound_send_journal'
      AND a.attname = 'approval_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    ALTER TABLE public.tenant_email_outbound_send_journal
      ALTER COLUMN approval_id SET NOT NULL,
      ALTER COLUMN actor_staff_user_id SET NOT NULL;
  END IF;
END $$;

ALTER TABLE public.tenant_email_outbound_send_journal
  ADD CONSTRAINT tenant_email_outbound_send_journal_phase_values
    CHECK (phase IN (
      'claimed', 'create_dispatched', 'draft_created', 'update_dispatched',
      'draft_updated', 'send_dispatched', 'reconciled_sent', 'terminal'
    )),
  ADD CONSTRAINT tenant_email_outbound_send_journal_outcome_values
    CHECK (outcome IN ('claimed','committed','not_committed','outcome_unknown','conflict','rejected')),
  ADD CONSTRAINT tenant_email_outbound_send_journal_phase_draft_coupling CHECK (
    (phase = 'claimed' AND immutable_draft_id IS NULL
      AND create_invocation_count = 0 AND update_invocation_count = 0 AND send_invocation_count = 0)
    OR (phase = 'create_dispatched' AND immutable_draft_id IS NULL
      AND create_invocation_count = 1 AND update_invocation_count = 0 AND send_invocation_count = 0)
    OR (phase = 'draft_created' AND immutable_draft_id IS NOT NULL
      AND create_invocation_count = 1 AND update_invocation_count = 0 AND send_invocation_count = 0)
    OR (phase = 'update_dispatched' AND immutable_draft_id IS NOT NULL
      AND create_invocation_count = 1 AND update_invocation_count = 1 AND send_invocation_count = 0)
    OR (phase = 'draft_updated' AND immutable_draft_id IS NOT NULL
      AND create_invocation_count = 1 AND update_invocation_count = 1 AND send_invocation_count = 0)
    OR (phase = 'send_dispatched' AND immutable_draft_id IS NOT NULL
      AND create_invocation_count = 1 AND update_invocation_count = 1 AND send_invocation_count = 1)
    OR (phase = 'reconciled_sent' AND immutable_draft_id IS NOT NULL
      AND create_invocation_count = 1 AND update_invocation_count = 1 AND send_invocation_count = 1
      AND outcome = 'committed')
    OR (phase = 'terminal' AND outcome IN ('not_committed', 'outcome_unknown', 'conflict', 'rejected')
      AND create_invocation_count >= 0 AND create_invocation_count <= 1
      AND update_invocation_count >= 0 AND update_invocation_count <= 1
      AND send_invocation_count >= 0 AND send_invocation_count <= 1
      AND (update_invocation_count = 0 OR create_invocation_count = 1)
      AND (send_invocation_count = 0 OR (
        create_invocation_count = 1 AND update_invocation_count = 1
      ))
      AND (immutable_draft_id IS NULL OR create_invocation_count = 1)
    )
  ),
  ADD CONSTRAINT tenant_email_outbound_send_journal_outcome_phase_coupling CHECK (
    (outcome = 'claimed' AND phase = 'claimed')
    OR (outcome = 'committed' AND phase = 'reconciled_sent')
    OR (outcome = 'not_committed' AND phase IN ('claimed', 'draft_created', 'draft_updated', 'terminal')
      AND send_invocation_count = 0)
    OR (outcome = 'outcome_unknown' AND phase IN (
      'create_dispatched', 'update_dispatched', 'send_dispatched', 'terminal'
    ))
    OR (outcome = 'conflict' AND phase = 'terminal')
    OR (outcome = 'rejected' AND phase = 'terminal')
  );

CREATE OR REPLACE FUNCTION tenant_email_outbound_send_journal_protect() RETURNS TRIGGER AS $$
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
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tenant_email_outbound_send_journal: immutable field mutation refused' USING ERRCODE = '23514';
  END IF;
  -- Terminal seal: same-phase terminal may only change ordinary timestamps (updated_at trigger).
  -- Refuse post-terminal draft/count/outcome/phase fabrication; identity fields already immutable above.
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
  oo := CASE OLD.outcome WHEN 'claimed' THEN 0 WHEN 'not_committed' THEN 1 WHEN 'outcome_unknown' THEN 2 WHEN 'committed' THEN 3 WHEN 'conflict' THEN 3 WHEN 'rejected' THEN 3 ELSE -1 END;
  onr := CASE NEW.outcome WHEN 'claimed' THEN 0 WHEN 'not_committed' THEN 1 WHEN 'outcome_unknown' THEN 2 WHEN 'committed' THEN 3 WHEN 'conflict' THEN 3 WHEN 'rejected' THEN 3 ELSE -1 END;
  -- Intent completion: create_dispatched/update_dispatched (outcome_unknown) → draft_* (not_committed) is forward, not regression.
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
END; $$ LANGUAGE plpgsql;

COMMENT ON TABLE tenant_email_outbound_send_journal IS
  'Outbound send journal (Graph reply-draft). Pre-invocation intents create/update/send each ≤1; body_digest only; location ownership preserved.';

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

COMMENT ON FUNCTION public.tenant_email_luna_automation_handoff(uuid, uuid) IS
  'Worker live claimed owner CAS handoff. Mints exactly one handoff_id with pg_catalog.gen_random_uuid().';

ALTER TABLE public.tenant_email_luna_automation_queue
  DROP CONSTRAINT IF EXISTS tenant_email_luna_automation_queue_journal_bind_uq;

REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_handoff(uuid, uuid) FROM PUBLIC;

COMMIT;
