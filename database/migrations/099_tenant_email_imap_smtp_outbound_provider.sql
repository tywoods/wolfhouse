-- MAIL-MVP-006: allow imap_smtp on staff email reply approvals and outbound journal.
-- Graph microsoft_graph rows stay valid. Does not enable Auto or live send.
BEGIN;

ALTER TABLE tenant_email_reply_approvals
  DROP CONSTRAINT tenant_email_reply_approvals_provider_values;

ALTER TABLE tenant_email_reply_approvals
  ADD CONSTRAINT tenant_email_reply_approvals_provider_values
    CHECK (provider IN ('microsoft_graph', 'imap_smtp'));

ALTER TABLE tenant_email_outbound_send_journal
  DROP CONSTRAINT tenant_email_outbound_send_journal_provider_values;

ALTER TABLE tenant_email_outbound_send_journal
  ADD CONSTRAINT tenant_email_outbound_send_journal_provider_values
    CHECK (provider IN ('microsoft_graph', 'imap_smtp'));

COMMENT ON CONSTRAINT tenant_email_reply_approvals_provider_values ON tenant_email_reply_approvals IS
  'MAIL-MVP-006: Graph or generic SMTP mailbox. Auto remains off.';

COMMENT ON CONSTRAINT tenant_email_outbound_send_journal_provider_values ON tenant_email_outbound_send_journal IS
  'MAIL-MVP-006: Graph or generic SMTP journal. Every would-be send stays journaled.';

COMMIT;
