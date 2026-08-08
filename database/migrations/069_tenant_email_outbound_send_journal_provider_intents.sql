-- 069_tenant_email_outbound_send_journal_provider_intents.sql
-- Evolve 068 outbound send journal with durable pre-invocation intents for createReply/update.
-- Phases: create_dispatched + update_dispatched. Counts: create/update/send each 0|1 monotonic.
-- Legal graph: claimed→create_dispatched→draft_created→update_dispatched→draft_updated→send_dispatched→reconciled_sent
-- (+ legal terminal exits). Backfill 068 rows from durable phase/draft/send before NOT NULL/checks.
-- No seed/route/UI/activation. Preserve identity/ownership guards.

BEGIN;

ALTER TABLE tenant_email_outbound_send_journal
  ADD COLUMN create_invocation_count INTEGER NULL,
  ADD COLUMN update_invocation_count INTEGER NULL;

-- Deterministic backfill from durable 068 state. Nonterminal: exact phase mapping.
-- Terminal: conservatively preserve possible provider-invocation evidence — if any
-- draft exists or send_invocation_count=1, set create+update counts to 1; else 0
-- (covers valid-068 terminal outcome_unknown|conflict|rejected with send=1 draft NULL).
UPDATE tenant_email_outbound_send_journal SET
  create_invocation_count = CASE
    WHEN phase = 'claimed' THEN 0
    WHEN phase IN ('draft_created', 'draft_updated', 'send_dispatched', 'reconciled_sent') THEN 1
    WHEN phase = 'terminal' AND (immutable_draft_id IS NOT NULL OR send_invocation_count >= 1) THEN 1
    WHEN phase = 'terminal' THEN 0
    ELSE NULL
  END,
  update_invocation_count = CASE
    WHEN phase IN ('draft_updated', 'send_dispatched', 'reconciled_sent') THEN 1
    WHEN phase = 'terminal' AND (immutable_draft_id IS NOT NULL OR send_invocation_count >= 1) THEN 1
    WHEN phase IN ('claimed', 'draft_created') THEN 0
    WHEN phase = 'terminal' THEN 0
    ELSE NULL
  END;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant_email_outbound_send_journal
     WHERE create_invocation_count IS NULL OR update_invocation_count IS NULL
  ) THEN
    RAISE EXCEPTION '069_up_refused: provider-intent count backfill incomplete'
      USING ERRCODE = '23514';
  END IF;
END $$;

ALTER TABLE tenant_email_outbound_send_journal
  ALTER COLUMN create_invocation_count SET DEFAULT 0,
  ALTER COLUMN create_invocation_count SET NOT NULL,
  ALTER COLUMN update_invocation_count SET DEFAULT 0,
  ALTER COLUMN update_invocation_count SET NOT NULL;

ALTER TABLE tenant_email_outbound_send_journal
  DROP CONSTRAINT tenant_email_outbound_send_journal_phase_values,
  DROP CONSTRAINT tenant_email_outbound_send_journal_phase_draft_coupling,
  DROP CONSTRAINT tenant_email_outbound_send_journal_outcome_phase_coupling;

ALTER TABLE tenant_email_outbound_send_journal
  ADD CONSTRAINT tenant_email_outbound_send_journal_phase_values
    CHECK (phase IN (
      'claimed', 'create_dispatched', 'draft_created', 'update_dispatched',
      'draft_updated', 'send_dispatched', 'reconciled_sent', 'terminal'
    )),
  ADD CONSTRAINT tenant_email_outbound_send_journal_create_count_bounds
    CHECK (create_invocation_count >= 0 AND create_invocation_count <= 1),
  ADD CONSTRAINT tenant_email_outbound_send_journal_update_count_bounds
    CHECK (update_invocation_count >= 0 AND update_invocation_count <= 1),
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
COMMENT ON COLUMN tenant_email_outbound_send_journal.create_invocation_count IS
  'createReply provider intent claim count 0|1; monotonic; set on create_dispatched.';
COMMENT ON COLUMN tenant_email_outbound_send_journal.update_invocation_count IS
  'updateApprovedDraft provider intent claim count 0|1; monotonic; set on update_dispatched.';

COMMIT;
