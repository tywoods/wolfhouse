-- Refuse rollback while imap_smtp approval or journal rows exist.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_email_reply_approvals WHERE provider = 'imap_smtp')
     OR EXISTS (SELECT 1 FROM tenant_email_outbound_send_journal WHERE provider = 'imap_smtp') THEN
    RAISE EXCEPTION 'cannot roll back 099 while imap_smtp approval or journal rows exist';
  END IF;
END $$;

ALTER TABLE tenant_email_reply_approvals
  DROP CONSTRAINT tenant_email_reply_approvals_provider_values;

ALTER TABLE tenant_email_reply_approvals
  ADD CONSTRAINT tenant_email_reply_approvals_provider_values
    CHECK (provider = 'microsoft_graph');

ALTER TABLE tenant_email_outbound_send_journal
  DROP CONSTRAINT tenant_email_outbound_send_journal_provider_values;

ALTER TABLE tenant_email_outbound_send_journal
  ADD CONSTRAINT tenant_email_outbound_send_journal_provider_values
    CHECK (provider = 'microsoft_graph');

COMMIT;
