-- 068_tenant_email_outbound_send_journal.sql
-- Exactly-once outbound Graph reply-draft journal. Empty on migrate. location_id+location_key+endpoint share one canonical location.
-- body_digest only; send 0|1; update guard (immutable identity/draft NULL→one/non-decrement send/legal phase graph). Down fail-closed with rows.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_client_id_id_uq') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_client_id_id_uq UNIQUE (client_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_locations_client_id_id_location_key_uq') THEN
    ALTER TABLE tenant_locations
      ADD CONSTRAINT tenant_locations_client_id_id_location_key_uq UNIQUE (client_id, id, location_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_channel_endpoints_client_id_id_location_key_uq') THEN
    ALTER TABLE tenant_channel_endpoints
      ADD CONSTRAINT tenant_channel_endpoints_client_id_id_location_key_uq UNIQUE (client_id, id, location_id);
  END IF;
END $$;
CREATE TABLE tenant_email_outbound_send_journal (
  operation_id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  location_id UUID NOT NULL,
  location_key TEXT NOT NULL,
  endpoint_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  approval_id UUID NOT NULL,
  actor_staff_user_id UUID NOT NULL,
  provider TEXT NOT NULL,
  immutable_draft_id TEXT NULL,
  body_digest TEXT NOT NULL,
  phase TEXT NOT NULL,
  outcome TEXT NOT NULL,
  send_invocation_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_email_outbound_send_journal_location_identity_fk
    FOREIGN KEY (client_id, location_id, location_key)
    REFERENCES tenant_locations (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_outbound_send_journal_endpoint_location_fk
    FOREIGN KEY (client_id, endpoint_id, location_key)
    REFERENCES tenant_channel_endpoints (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_outbound_send_journal_conversation_fk
    FOREIGN KEY (client_id, conversation_id) REFERENCES conversations (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_outbound_send_journal_actor_fk
    FOREIGN KEY (client_id, actor_staff_user_id) REFERENCES staff_users (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_outbound_send_journal_location_key_shape
    CHECK (location_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(location_key) BETWEEN 1 AND 64),
  CONSTRAINT tenant_email_outbound_send_journal_provider_values CHECK (provider = 'microsoft_graph'),
  CONSTRAINT tenant_email_outbound_send_journal_draft_shape
    CHECK (immutable_draft_id IS NULL OR char_length(immutable_draft_id) BETWEEN 1 AND 2048),
  CONSTRAINT tenant_email_outbound_send_journal_body_digest_shape CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_email_outbound_send_journal_phase_values
    CHECK (phase IN ('claimed','draft_created','draft_updated','send_dispatched','reconciled_sent','terminal')),
  CONSTRAINT tenant_email_outbound_send_journal_outcome_values
    CHECK (outcome IN ('claimed','committed','not_committed','outcome_unknown','conflict','rejected')),
  CONSTRAINT tenant_email_outbound_send_journal_send_count_bounds
    CHECK (send_invocation_count >= 0 AND send_invocation_count <= 1),
  CONSTRAINT tenant_email_outbound_send_journal_phase_draft_coupling CHECK (
    (phase = 'claimed' AND immutable_draft_id IS NULL AND send_invocation_count = 0)
    OR (phase IN ('draft_created','draft_updated') AND immutable_draft_id IS NOT NULL AND send_invocation_count = 0)
    OR (phase = 'send_dispatched' AND immutable_draft_id IS NOT NULL AND send_invocation_count = 1)
    OR (phase = 'reconciled_sent' AND immutable_draft_id IS NOT NULL AND send_invocation_count = 1 AND outcome = 'committed')
    OR (phase = 'terminal' AND outcome IN ('not_committed','outcome_unknown','conflict','rejected'))
  ),
  CONSTRAINT tenant_email_outbound_send_journal_outcome_phase_coupling CHECK (
    (outcome = 'claimed' AND phase = 'claimed')
    OR (outcome = 'committed' AND phase = 'reconciled_sent')
    OR (outcome = 'not_committed' AND phase IN ('claimed','draft_created','draft_updated','terminal') AND send_invocation_count = 0)
    OR (outcome = 'outcome_unknown' AND phase IN ('send_dispatched','terminal'))
    OR (outcome = 'conflict' AND phase = 'terminal')
    OR (outcome = 'rejected' AND phase = 'terminal')
  ),
  CONSTRAINT tenant_email_outbound_send_journal_approval_uq UNIQUE (client_id, approval_id),
  CONSTRAINT tenant_email_outbound_send_journal_draft_uq UNIQUE (provider, immutable_draft_id)
);
COMMENT ON TABLE tenant_email_outbound_send_journal IS 'Outbound send journal (Graph reply-draft). location_id+location_key+endpoint share one canonical location; body_digest only; send ≤1.';
COMMENT ON COLUMN tenant_email_outbound_send_journal.location_key IS 'Canonical location token; ties location UUID and endpoint to the same location.';
CREATE INDEX idx_tenant_email_outbound_send_journal_endpoint_outcome_time
  ON tenant_email_outbound_send_journal (client_id, endpoint_id, outcome, created_at DESC);
CREATE INDEX idx_tenant_email_outbound_send_journal_conversation
  ON tenant_email_outbound_send_journal (client_id, conversation_id, created_at DESC);
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
CREATE TRIGGER tenant_email_outbound_send_journal_protect
  BEFORE UPDATE ON tenant_email_outbound_send_journal
  FOR EACH ROW EXECUTE FUNCTION tenant_email_outbound_send_journal_protect();
CREATE TRIGGER tenant_email_outbound_send_journal_updated_at
  BEFORE UPDATE ON tenant_email_outbound_send_journal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMIT;
