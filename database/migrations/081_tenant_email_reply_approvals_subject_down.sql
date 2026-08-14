-- Explicit down for 081. Refuse when a real persisted subject would be lost.
BEGIN;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'tenant_email_reply_approvals'
      AND column_name = 'subject'
  ) AND EXISTS (
    SELECT 1 FROM tenant_email_reply_approvals WHERE subject IS NOT NULL
  ) THEN
    RAISE EXCEPTION '081_down_refused: persisted reply subjects present — refuse silent subject loss';
  END IF;
END $$;

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

ALTER TABLE tenant_email_reply_approvals
  DROP CONSTRAINT IF EXISTS tenant_email_reply_approvals_subject_shape;
ALTER TABLE tenant_email_reply_approvals
  DROP COLUMN IF EXISTS subject;
COMMIT;
