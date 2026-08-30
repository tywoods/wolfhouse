-- 100_tenant_email_same_desk_auto_send_claims.sql
-- SAME-DESK-004: dedicated durable auto-send claim owner.
--
-- Independent of tenant_email_reply_approvals so generic Microsoft and SMTP
-- staff drafts remain unlimited for the same inbound event. Auto-send workers
-- INSERT-claim this table; losers ON CONFLICT DO NOTHING skip without a
-- provider send. Explicit approval linkage is for winner/loser reconciliation.
--
-- Does not rewrite 070 operation uniqueness, approve-send CAS, or generic
-- staff/SMTP draft insert semantics.
--
-- Rollback: 100_tenant_email_same_desk_auto_send_claims_down.sql

BEGIN;

-- Rewrite of unmerged 100: drop the withdrawn global unique on
-- tenant_email_reply_approvals inbound identity if a previous PR head
-- applied it. Generic Microsoft/SMTP staff drafts must remain unlimited.
DROP INDEX IF EXISTS tenant_email_reply_approvals_inbound_claim_uq;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_users_client_id_id_uq') THEN
    ALTER TABLE staff_users ADD CONSTRAINT staff_users_client_id_id_uq UNIQUE (client_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_client_id_id_uq') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_client_id_id_uq UNIQUE (client_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_email_inbound_events_client_id_id_uq') THEN
    ALTER TABLE tenant_email_inbound_events ADD CONSTRAINT tenant_email_inbound_events_client_id_id_uq UNIQUE (client_id, id);
  END IF;
END $$;

CREATE TABLE tenant_email_same_desk_auto_send_claims (
  claim_id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  source_inbound_event_id UUID NOT NULL,
  claimant_staff_user_id UUID NOT NULL,
  approval_id UUID NULL,
  operation_id UUID NULL,
  state TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_email_same_desk_auto_send_claims_identity_uq
    UNIQUE (client_id, conversation_id, source_inbound_event_id),
  CONSTRAINT tenant_email_same_desk_auto_send_claims_conversation_fk
    FOREIGN KEY (client_id, conversation_id) REFERENCES conversations (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_same_desk_auto_send_claims_source_event_fk
    FOREIGN KEY (client_id, source_inbound_event_id) REFERENCES tenant_email_inbound_events (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_same_desk_auto_send_claims_actor_fk
    FOREIGN KEY (client_id, claimant_staff_user_id) REFERENCES staff_users (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_same_desk_auto_send_claims_approval_fk
    FOREIGN KEY (approval_id) REFERENCES tenant_email_reply_approvals (approval_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_same_desk_auto_send_claims_state_values
    CHECK (state IN ('claimed', 'linked')),
  CONSTRAINT tenant_email_same_desk_auto_send_claims_link_coupling CHECK (
    (state = 'claimed' AND approval_id IS NULL AND linked_at IS NULL)
    OR (state = 'linked' AND approval_id IS NOT NULL AND linked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX tenant_email_same_desk_auto_send_claims_approval_uq
  ON tenant_email_same_desk_auto_send_claims (approval_id)
  WHERE approval_id IS NOT NULL;

COMMENT ON TABLE tenant_email_same_desk_auto_send_claims IS
  'SAME-DESK-004: exactly-once auto-send claim per (client_id, conversation_id, source_inbound_event_id). Does not constrain generic staff or SMTP tenant_email_reply_approvals rows.';

CREATE OR REPLACE FUNCTION tenant_email_same_desk_auto_send_claims_protect() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.claim_id IS DISTINCT FROM OLD.claim_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.source_inbound_event_id IS DISTINCT FROM OLD.source_inbound_event_id
     OR NEW.claimant_staff_user_id IS DISTINCT FROM OLD.claimant_staff_user_id
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: immutable field mutation refused' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'linked' AND (
       NEW.approval_id IS DISTINCT FROM OLD.approval_id
    OR NEW.linked_at IS DISTINCT FROM OLD.linked_at
    OR NEW.state IS DISTINCT FROM OLD.state
  ) THEN
    RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: linked approval sealed' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'claimed' AND NEW.state IS DISTINCT FROM OLD.state AND NEW.state IS DISTINCT FROM 'linked' THEN
    RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: illegal state transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_email_same_desk_auto_send_claims_protect
  BEFORE UPDATE ON tenant_email_same_desk_auto_send_claims
  FOR EACH ROW EXECUTE FUNCTION tenant_email_same_desk_auto_send_claims_protect();

CREATE TRIGGER tenant_email_same_desk_auto_send_claims_updated_at
  BEFORE UPDATE ON tenant_email_same_desk_auto_send_claims
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
