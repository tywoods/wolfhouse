-- Phase 19g.8 — Meta inbound message + Luna decision persistence
--
-- Stores every inbound WhatsApp webhook event and draft/send-gate metadata.
-- Complements guest_message_sends (eligible send attempts only).
--
-- Staging/test apply only until explicitly approved for production.

BEGIN;

CREATE TABLE IF NOT EXISTS guest_message_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug           TEXT NOT NULL,
  channel               TEXT NOT NULL DEFAULT 'whatsapp',
  direction             TEXT NOT NULL DEFAULT 'inbound',
  from_phone            TEXT,
  to_phone_number_id    TEXT,
  wa_message_id         TEXT NOT NULL,
  message_type          TEXT,
  message_text          TEXT,
  profile_name          TEXT,
  raw_payload           JSONB,
  normalized            JSONB,
  draft_called          BOOLEAN NOT NULL DEFAULT FALSE,
  next_action           TEXT,
  suggested_reply       TEXT,
  handoff_required      BOOLEAN NOT NULL DEFAULT FALSE,
  send_attempted        BOOLEAN NOT NULL DEFAULT FALSE,
  send_idempotency_key  TEXT,
  send_status           TEXT,
  send_blocked_reasons  JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT guest_message_events_client_wa_unique
    UNIQUE (client_slug, wa_message_id)
);

COMMENT ON TABLE guest_message_events IS
  'Phase 19g.8 inbound WhatsApp webhook events and Luna draft/send-gate decisions. '
  'Unique (client_slug, wa_message_id) enables idempotent Meta webhook replay.';

CREATE INDEX IF NOT EXISTS idx_guest_message_events_client_slug
  ON guest_message_events (client_slug);

CREATE INDEX IF NOT EXISTS idx_guest_message_events_from_phone
  ON guest_message_events (from_phone);

CREATE INDEX IF NOT EXISTS idx_guest_message_events_created_at
  ON guest_message_events (created_at DESC);

CREATE TRIGGER guest_message_events_updated_at
  BEFORE UPDATE ON guest_message_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
