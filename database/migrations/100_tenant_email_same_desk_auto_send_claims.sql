-- 100_tenant_email_same_desk_auto_send_claims.sql
-- SAME-DESK-004: dedicated durable auto-send claim owner with bounded lease.
--
-- Independent of tenant_email_reply_approvals so generic Microsoft and SMTP
-- staff drafts remain unlimited for the same inbound event. Auto-send workers
-- INSERT-claim this table; losers skip without a provider send. Ownership is
-- a lease_token + lease_epoch CAS: pre-dispatch failure is retry-safe
-- (release/expire/reclaim); once state=dispatching, never release or retry.
-- Explicit auto_provenance + approval linkage is the only auto payload.
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
  lease_token UUID NOT NULL,
  lease_epoch BIGINT NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  auto_provenance TEXT NOT NULL,
  approval_id UUID NULL,
  operation_id UUID NULL,
  state TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL,
  linked_at TIMESTAMPTZ NULL,
  dispatching_at TIMESTAMPTZ NULL,
  released_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_email_same_desk_auto_send_claims_identity_uq
    UNIQUE (client_id, conversation_id, source_inbound_event_id),
  CONSTRAINT tenant_email_same_desk_auto_send_claims_lease_token_uq
    UNIQUE (lease_token),
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
    CHECK (state IN ('leased', 'linked', 'dispatching', 'released')),
  CONSTRAINT tenant_email_same_desk_auto_send_claims_epoch_positive
    CHECK (lease_epoch >= 1),
  CONSTRAINT tenant_email_same_desk_auto_send_claims_provenance
    CHECK (auto_provenance = 'same_desk_004_auto'),
  CONSTRAINT tenant_email_same_desk_auto_send_claims_link_coupling CHECK (
    (state = 'leased' AND approval_id IS NULL AND linked_at IS NULL
      AND dispatching_at IS NULL AND released_at IS NULL)
    OR (state = 'linked' AND approval_id IS NOT NULL AND linked_at IS NOT NULL
      AND dispatching_at IS NULL AND released_at IS NULL)
    OR (state = 'dispatching' AND approval_id IS NOT NULL AND linked_at IS NOT NULL
      AND dispatching_at IS NOT NULL AND released_at IS NULL)
    OR (state = 'released' AND dispatching_at IS NULL AND released_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX tenant_email_same_desk_auto_send_claims_approval_uq
  ON tenant_email_same_desk_auto_send_claims (approval_id)
  WHERE approval_id IS NOT NULL;

COMMENT ON TABLE tenant_email_same_desk_auto_send_claims IS
  'SAME-DESK-004: exactly-once auto-send lease per (client_id, conversation_id, source_inbound_event_id). lease_token/epoch CAS. Pre-dispatch is retry-safe; dispatching is outcome-unknown no-retry. Does not constrain generic staff or SMTP tenant_email_reply_approvals rows.';

CREATE OR REPLACE FUNCTION tenant_email_same_desk_auto_send_claims_protect() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.claim_id IS DISTINCT FROM OLD.claim_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.source_inbound_event_id IS DISTINCT FROM OLD.source_inbound_event_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.auto_provenance IS DISTINCT FROM OLD.auto_provenance THEN
    RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: immutable field mutation refused' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'dispatching' THEN
    RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: dispatching sealed' USING ERRCODE = '23514';
  END IF;
  IF NEW.lease_epoch < OLD.lease_epoch THEN
    RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: lease_epoch must not decrease' USING ERRCODE = '23514';
  END IF;
  IF NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch THEN
    IF NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch + 1 THEN
      RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: lease_epoch must increment by 1' USING ERRCODE = '23514';
    END IF;
    IF NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token THEN
      RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: reclaim requires new lease_token' USING ERRCODE = '23514';
    END IF;
    IF NEW.state IS DISTINCT FROM 'leased' THEN
      RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: reclaim must enter leased' USING ERRCODE = '23514';
    END IF;
    IF OLD.state NOT IN ('leased', 'linked', 'released') THEN
      RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: illegal reclaim source' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
    RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: lease_token mutation requires epoch increment' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'leased' AND NEW.state = 'linked' THEN
    RETURN NEW;
  END IF;
  IF OLD.state IN ('leased', 'linked') AND NEW.state = 'released' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'linked' AND NEW.state = 'dispatching' THEN
    RETURN NEW;
  END IF;
  IF OLD.state IS NOT DISTINCT FROM NEW.state THEN
    RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: same-state field mutation refused' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'tenant_email_same_desk_auto_send_claims: illegal state transition' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_email_same_desk_auto_send_claims_protect
  BEFORE UPDATE ON tenant_email_same_desk_auto_send_claims
  FOR EACH ROW EXECUTE FUNCTION tenant_email_same_desk_auto_send_claims_protect();

CREATE TRIGGER tenant_email_same_desk_auto_send_claims_updated_at
  BEFORE UPDATE ON tenant_email_same_desk_auto_send_claims
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
