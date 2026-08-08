-- 070_tenant_email_reply_approvals.sql
BEGIN;
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_locations_client_id_id_location_key_uq') THEN
    ALTER TABLE tenant_locations ADD CONSTRAINT tenant_locations_client_id_id_location_key_uq UNIQUE (client_id, id, location_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_channel_endpoints_client_id_id_location_key_uq') THEN
    ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_client_id_id_location_key_uq UNIQUE (client_id, id, location_id);
  END IF;
END $$;
CREATE TABLE tenant_email_reply_approvals (
  approval_id UUID PRIMARY KEY,
  operation_id UUID NOT NULL,
  client_id UUID NOT NULL,
  location_id UUID NOT NULL,
  location_key TEXT NOT NULL,
  endpoint_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  source_inbound_event_id UUID NOT NULL,
  provider TEXT NOT NULL,
  provider_mailbox_id TEXT NOT NULL,
  provider_source_message_id TEXT NOT NULL,
  draft_actor_staff_user_id UUID NOT NULL,
  approved_actor_staff_user_id UUID NULL,
  message_text TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  drafted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_email_reply_approvals_operation_uq UNIQUE (operation_id),
  CONSTRAINT tenant_email_reply_approvals_location_identity_fk
    FOREIGN KEY (client_id, location_id, location_key) REFERENCES tenant_locations (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_reply_approvals_endpoint_location_fk
    FOREIGN KEY (client_id, endpoint_id, location_key) REFERENCES tenant_channel_endpoints (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_reply_approvals_conversation_fk
    FOREIGN KEY (client_id, conversation_id) REFERENCES conversations (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_reply_approvals_source_event_fk
    FOREIGN KEY (client_id, source_inbound_event_id) REFERENCES tenant_email_inbound_events (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_reply_approvals_draft_actor_fk
    FOREIGN KEY (client_id, draft_actor_staff_user_id) REFERENCES staff_users (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_reply_approvals_approved_actor_fk
    FOREIGN KEY (client_id, approved_actor_staff_user_id) REFERENCES staff_users (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_reply_approvals_location_key_shape
    CHECK (location_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(location_key) BETWEEN 1 AND 64),
  CONSTRAINT tenant_email_reply_approvals_provider_values CHECK (provider = 'microsoft_graph'),
  CONSTRAINT tenant_email_reply_approvals_mailbox_shape CHECK (char_length(provider_mailbox_id) BETWEEN 1 AND 2048),
  CONSTRAINT tenant_email_reply_approvals_source_message_shape CHECK (char_length(provider_source_message_id) BETWEEN 1 AND 2048),
  CONSTRAINT tenant_email_reply_approvals_message_shape CHECK (char_length(message_text) BETWEEN 1 AND 64000),
  CONSTRAINT tenant_email_reply_approvals_body_digest_shape CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_email_reply_approvals_state_values CHECK (state IN ('draft', 'approved', 'terminal')),
  CONSTRAINT tenant_email_reply_approvals_actor_time_coupling CHECK (
    (state = 'draft' AND approved_actor_staff_user_id IS NULL AND approved_at IS NULL)
    OR (state IN ('approved', 'terminal') AND approved_actor_staff_user_id IS NOT NULL AND approved_at IS NOT NULL)
  )
);
CREATE INDEX idx_tenant_email_reply_approvals_client_conversation_state
  ON tenant_email_reply_approvals (client_id, conversation_id, state, updated_at DESC);
CREATE OR REPLACE FUNCTION tenant_email_reply_approvals_protect() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.approval_id IS DISTINCT FROM OLD.approval_id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.location_key IS DISTINCT FROM OLD.location_key OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.source_inbound_event_id IS DISTINCT FROM OLD.source_inbound_event_id
     OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.provider_mailbox_id IS DISTINCT FROM OLD.provider_mailbox_id
     OR NEW.provider_source_message_id IS DISTINCT FROM OLD.provider_source_message_id
     OR NEW.drafted_at IS DISTINCT FROM OLD.drafted_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tenant_email_reply_approvals: immutable field mutation refused' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'terminal' THEN
    IF NEW.state IS DISTINCT FROM OLD.state OR NEW.message_text IS DISTINCT FROM OLD.message_text
       OR NEW.body_digest IS DISTINCT FROM OLD.body_digest
       OR NEW.draft_actor_staff_user_id IS DISTINCT FROM OLD.draft_actor_staff_user_id
       OR NEW.approved_actor_staff_user_id IS DISTINCT FROM OLD.approved_actor_staff_user_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'tenant_email_reply_approvals: terminal row sealed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'approved' THEN
    IF NEW.message_text IS DISTINCT FROM OLD.message_text OR NEW.body_digest IS DISTINCT FROM OLD.body_digest
       OR NEW.draft_actor_staff_user_id IS DISTINCT FROM OLD.draft_actor_staff_user_id
       OR NEW.approved_actor_staff_user_id IS DISTINCT FROM OLD.approved_actor_staff_user_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'tenant_email_reply_approvals: approved body/actor sealed' USING ERRCODE = '23514';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IS DISTINCT FROM 'terminal' THEN
      RAISE EXCEPTION 'tenant_email_reply_approvals: illegal state transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'draft' THEN
    IF NOT (NEW.state IS NOT DISTINCT FROM OLD.state OR NEW.state IN ('approved', 'terminal')) THEN
      RAISE EXCEPTION 'tenant_email_reply_approvals: illegal state transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.state IN ('approved', 'terminal') AND (NEW.approved_actor_staff_user_id IS NULL OR NEW.approved_at IS NULL) THEN
      RAISE EXCEPTION 'tenant_email_reply_approvals: approval actor/time required' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tenant_email_reply_approvals: illegal state' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tenant_email_reply_approvals_protect
  BEFORE UPDATE ON tenant_email_reply_approvals
  FOR EACH ROW EXECUTE FUNCTION tenant_email_reply_approvals_protect();
CREATE TRIGGER tenant_email_reply_approvals_updated_at
  BEFORE UPDATE ON tenant_email_reply_approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMIT;
