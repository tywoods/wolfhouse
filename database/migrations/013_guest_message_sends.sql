-- Phase 19e.5a — Luna guest reply send idempotency / audit
--
-- Persistent idempotency for POST /staff/bot/guest-reply-send.
-- One row per (client_slug, idempotency_key). Prevents duplicate WhatsApp sends on retry.
--
-- Staging/test apply only until explicitly approved for production.

BEGIN;

CREATE TABLE IF NOT EXISTS guest_message_sends (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug         TEXT NOT NULL,
  channel             TEXT NOT NULL DEFAULT 'whatsapp',
  to_phone            TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  send_kind           TEXT NOT NULL,
  source              TEXT,
  message_text        TEXT NOT NULL,
  status              TEXT NOT NULL,
  blocked_reasons     JSONB,
  provider_message_id TEXT,
  provider_response   JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at             TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT guest_message_sends_status_check
    CHECK (status IN ('pending', 'sent', 'blocked', 'failed')),
  CONSTRAINT guest_message_sends_client_idempotency_unique
    UNIQUE (client_slug, idempotency_key)
);

COMMENT ON TABLE guest_message_sends IS
  'Phase 19e.5a idempotency/audit for Luna guest reply WhatsApp sends. '
  'Unique (client_slug, idempotency_key) prevents duplicate external sends on retry.';

CREATE INDEX IF NOT EXISTS idx_guest_message_sends_client_slug
  ON guest_message_sends (client_slug);

CREATE INDEX IF NOT EXISTS idx_guest_message_sends_status
  ON guest_message_sends (status);

CREATE TRIGGER guest_message_sends_updated_at
  BEFORE UPDATE ON guest_message_sends FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
