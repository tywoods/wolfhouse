-- Explicit down for 070. Refuse nonempty.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='tenant_email_reply_approvals')
     AND EXISTS (SELECT 1 FROM tenant_email_reply_approvals) THEN
    RAISE EXCEPTION '070_down_refused: email reply approval rows present — refuse silent draft/approval evidence loss';
  END IF;
END $$;
DROP TRIGGER IF EXISTS tenant_email_reply_approvals_protect ON tenant_email_reply_approvals;
DROP TRIGGER IF EXISTS tenant_email_reply_approvals_updated_at ON tenant_email_reply_approvals;
DROP TABLE IF EXISTS tenant_email_reply_approvals;
DROP FUNCTION IF EXISTS tenant_email_reply_approvals_protect();
COMMIT;
