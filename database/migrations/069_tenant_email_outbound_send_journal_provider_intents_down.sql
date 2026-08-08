-- Explicit down for 069_tenant_email_outbound_send_journal_provider_intents.
-- Fail closed whenever any journal rows exist (refuse silent provider-intent
-- evidence loss / unsafe reconstruction of 068 shape). Empty-table downgrade
-- may proceed: drop intent counts, restore 068 phase set, coupling, and protect
-- function. Leaves table/FKs/indexes intact.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = 'tenant_email_outbound_send_journal'
  ) AND EXISTS (
    SELECT 1 FROM tenant_email_outbound_send_journal
  ) THEN
    RAISE EXCEPTION
      '069_down_refused: journal rows present — refuse silent provider-intent evidence loss';
  END IF;
END $$;

ALTER TABLE tenant_email_outbound_send_journal
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_outcome_phase_coupling,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_phase_draft_coupling,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_update_count_bounds,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_create_count_bounds,
  DROP CONSTRAINT IF EXISTS tenant_email_outbound_send_journal_phase_values;

ALTER TABLE tenant_email_outbound_send_journal
  DROP COLUMN IF EXISTS create_invocation_count,
  DROP COLUMN IF EXISTS update_invocation_count;

ALTER TABLE tenant_email_outbound_send_journal
  ADD CONSTRAINT tenant_email_outbound_send_journal_phase_values
    CHECK (phase IN ('claimed','draft_created','draft_updated','send_dispatched','reconciled_sent','terminal')),
  ADD CONSTRAINT tenant_email_outbound_send_journal_phase_draft_coupling CHECK (
    (phase = 'claimed' AND immutable_draft_id IS NULL AND send_invocation_count = 0)
    OR (phase IN ('draft_created','draft_updated') AND immutable_draft_id IS NOT NULL AND send_invocation_count = 0)
    OR (phase = 'send_dispatched' AND immutable_draft_id IS NOT NULL AND send_invocation_count = 1)
    OR (phase = 'reconciled_sent' AND immutable_draft_id IS NOT NULL AND send_invocation_count = 1 AND outcome = 'committed')
    OR (phase = 'terminal' AND outcome IN ('not_committed','outcome_unknown','conflict','rejected'))
  ),
  ADD CONSTRAINT tenant_email_outbound_send_journal_outcome_phase_coupling CHECK (
    (outcome = 'claimed' AND phase = 'claimed')
    OR (outcome = 'committed' AND phase = 'reconciled_sent')
    OR (outcome = 'not_committed' AND phase IN ('claimed','draft_created','draft_updated','terminal') AND send_invocation_count = 0)
    OR (outcome = 'outcome_unknown' AND phase IN ('send_dispatched','terminal'))
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
  IF OLD.immutable_draft_id IS NOT NULL AND NEW.immutable_draft_id IS DISTINCT FROM OLD.immutable_draft_id THEN
    RAISE EXCEPTION 'tenant_email_outbound_send_journal: immutable_draft_id replacement refused' USING ERRCODE = '23514';
  END IF;
  IF NEW.send_invocation_count < OLD.send_invocation_count THEN
    RAISE EXCEPTION 'tenant_email_outbound_send_journal: send_invocation_count decrement refused' USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.phase IS NOT DISTINCT FROM OLD.phase
    OR (OLD.phase = 'claimed' AND NEW.phase IN ('draft_created','terminal'))
    OR (OLD.phase = 'draft_created' AND NEW.phase IN ('draft_updated','terminal'))
    OR (OLD.phase = 'draft_updated' AND NEW.phase IN ('send_dispatched','terminal'))
    OR (OLD.phase = 'send_dispatched' AND NEW.phase IN ('reconciled_sent','terminal'))) THEN
    RAISE EXCEPTION 'tenant_email_outbound_send_journal: illegal phase transition' USING ERRCODE = '23514';
  END IF;
  oo := CASE OLD.outcome WHEN 'claimed' THEN 0 WHEN 'not_committed' THEN 1 WHEN 'outcome_unknown' THEN 2 WHEN 'committed' THEN 3 WHEN 'conflict' THEN 3 WHEN 'rejected' THEN 3 ELSE -1 END;
  onr := CASE NEW.outcome WHEN 'claimed' THEN 0 WHEN 'not_committed' THEN 1 WHEN 'outcome_unknown' THEN 2 WHEN 'committed' THEN 3 WHEN 'conflict' THEN 3 WHEN 'rejected' THEN 3 ELSE -1 END;
  IF onr < oo THEN RAISE EXCEPTION 'tenant_email_outbound_send_journal: outcome regression refused' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

COMMENT ON TABLE tenant_email_outbound_send_journal IS
  'Outbound send journal (Graph reply-draft). location_id+location_key+endpoint share one canonical location; body_digest only; send ≤1.';

COMMIT;
