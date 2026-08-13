-- 078_luna_outbound_approvals.sql
-- Inbox Phase 2: channel-agnostic outbound draft/approval rows.
--
-- Why a new table (not tenant_email_reply_approvals / 070):
--   070 is Graph-mailbox-bound. It requires source_inbound_event_id (FK to
--   tenant_email_inbound_events), provider='microsoft_graph', mailbox and
--   source-message ids, and a verified email endpoint. WhatsApp conversations
--   have none of that. Widening 070 would either break those CHECKs/FKs or
--   force dummy email identity onto WhatsApp drafts. This table is the
--   channel-agnostic owner named in docs/INBOX-PORTAL-REDESIGN.md.
--
-- This migration is schema only. Do not apply it to a live DB from this PR.
-- Email continue to use tenant_email_reply_approvals; this slice only writes
-- channel='whatsapp' pending rows via POST /staff/inbox/whatsapp/draft.
-- Approve-send / Graph / WhatsApp Cloud send is out of scope.
--
-- Rollback: 078_luna_outbound_approvals_down.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_users_client_id_id_uq') THEN
    ALTER TABLE staff_users ADD CONSTRAINT staff_users_client_id_id_uq UNIQUE (client_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_client_id_id_uq') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_client_id_id_uq UNIQUE (client_id, id);
  END IF;
END $$;

CREATE TABLE luna_outbound_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  channel TEXT NOT NULL,
  draft_text TEXT NOT NULL,
  edited_text TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tool_trace JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_run_id TEXT NULL,
  created_by_staff_user_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT luna_outbound_approvals_conversation_fk
    FOREIGN KEY (client_id, conversation_id) REFERENCES conversations (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT luna_outbound_approvals_draft_actor_fk
    FOREIGN KEY (client_id, created_by_staff_user_id) REFERENCES staff_users (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT luna_outbound_approvals_channel_values
    CHECK (channel IN ('whatsapp', 'email')),
  CONSTRAINT luna_outbound_approvals_status_values
    CHECK (status IN ('pending', 'approved', 'rejected', 'sent', 'expired')),
  CONSTRAINT luna_outbound_approvals_draft_text_shape
    CHECK (char_length(draft_text) BETWEEN 1 AND 64000),
  CONSTRAINT luna_outbound_approvals_edited_text_shape
    CHECK (edited_text IS NULL OR char_length(edited_text) BETWEEN 1 AND 64000),
  CONSTRAINT luna_outbound_approvals_tool_trace_object
    CHECK (jsonb_typeof(tool_trace) = 'object'),
  CONSTRAINT luna_outbound_approvals_run_id_shape
    CHECK (created_by_run_id IS NULL OR (char_length(created_by_run_id) BETWEEN 1 AND 128))
);

COMMENT ON TABLE luna_outbound_approvals IS
  'Channel-agnostic outbound drafts/approvals (Inbox Phase 2 / 078). Email Graph send still lives on tenant_email_reply_approvals. One pending row per (client_id, conversation_id, channel).';

COMMENT ON COLUMN luna_outbound_approvals.channel IS
  'whatsapp | email. This slice persists WhatsApp pending drafts only.';

COMMENT ON COLUMN luna_outbound_approvals.status IS
  'pending | approved | rejected | sent | expired. Persist+read writes pending only; approve-send is not in this slice.';

COMMENT ON COLUMN luna_outbound_approvals.created_by_run_id IS
  'Optional Hermes/Luna run id when a bot wrote the draft. Staff POSTs leave this null.';

CREATE UNIQUE INDEX luna_outbound_approvals_pending_conversation_uq
  ON luna_outbound_approvals (client_id, conversation_id, channel)
  WHERE status = 'pending';

CREATE INDEX idx_luna_outbound_approvals_client_conversation_status
  ON luna_outbound_approvals (client_id, conversation_id, status, updated_at DESC);

CREATE OR REPLACE FUNCTION luna_outbound_approvals_protect() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'luna_outbound_approvals: immutable field mutation refused' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('rejected', 'sent', 'expired') THEN
    RAISE EXCEPTION 'luna_outbound_approvals: terminal row sealed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'approved' THEN
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IS DISTINCT FROM 'sent' THEN
      RAISE EXCEPTION 'luna_outbound_approvals: illegal state transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.draft_text IS DISTINCT FROM OLD.draft_text
       OR NEW.edited_text IS DISTINCT FROM OLD.edited_text
       OR NEW.tool_trace IS DISTINCT FROM OLD.tool_trace
       OR NEW.created_by_run_id IS DISTINCT FROM OLD.created_by_run_id
       OR NEW.created_by_staff_user_id IS DISTINCT FROM OLD.created_by_staff_user_id THEN
      RAISE EXCEPTION 'luna_outbound_approvals: approved body/actor sealed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'pending' THEN
    IF NOT (NEW.status IS NOT DISTINCT FROM OLD.status
            OR NEW.status IN ('approved', 'rejected', 'expired')) THEN
      RAISE EXCEPTION 'luna_outbound_approvals: illegal state transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'luna_outbound_approvals: illegal state' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER luna_outbound_approvals_protect
  BEFORE UPDATE ON luna_outbound_approvals
  FOR EACH ROW EXECUTE FUNCTION luna_outbound_approvals_protect();

CREATE TRIGGER luna_outbound_approvals_updated_at
  BEFORE UPDATE ON luna_outbound_approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
