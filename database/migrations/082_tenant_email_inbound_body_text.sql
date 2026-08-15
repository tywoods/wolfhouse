-- Persist sanitized plain-text inbound email bodies for Inbox bubbles.
-- Existing rows remain NULL; subject is never copied into body_text.
BEGIN;

ALTER TABLE tenant_email_inbound_events
  ADD COLUMN body_text TEXT;

COMMENT ON COLUMN tenant_email_inbound_events.body_text IS
  'Sanitized plain-text provider body; never HTML and never synthesized from subject.';

COMMIT;
