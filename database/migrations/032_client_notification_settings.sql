-- 032 — Per-client staff WhatsApp notification settings + send audit/dedupe events
-- Types: new_conversation, human_needed
-- Tenant-scoped by client_slug (+ optional location_id for multi-location clients).
--
-- Rollback:
--   DROP TABLE IF EXISTS client_notification_events;
--   DROP TABLE IF EXISTS client_notification_settings;

BEGIN;

CREATE TABLE IF NOT EXISTS client_notification_settings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug       TEXT NOT NULL,
  location_id       TEXT NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('new_conversation', 'human_needed')),
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  recipients        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_notification_settings_scope_type
  ON client_notification_settings (client_slug, COALESCE(location_id, ''), notification_type);

CREATE INDEX IF NOT EXISTS idx_client_notification_settings_client
  ON client_notification_settings (client_slug, location_id);

COMMENT ON TABLE client_notification_settings IS 'Staff Portal: WhatsApp alert recipients per client/location and notification type.';
COMMENT ON COLUMN client_notification_settings.recipients IS 'Array of {name, phone, enabled} objects; phones E.164.';

CREATE TABLE IF NOT EXISTS client_notification_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug         TEXT NOT NULL,
  location_id         TEXT NULL,
  conversation_id     UUID NULL,
  notification_type   TEXT NOT NULL CHECK (notification_type IN ('new_conversation', 'human_needed')),
  handoff_event_key   TEXT NOT NULL DEFAULT 'initial',
  recipient_phone     TEXT NOT NULL,
  recipient_name      TEXT NULL,
  status              TEXT NOT NULL CHECK (status IN ('dry_run', 'sent', 'failed', 'skipped')),
  reason              TEXT NULL,
  message_preview     TEXT NULL,
  provider_message_id TEXT NULL,
  error               TEXT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_notification_events_dedupe
  ON client_notification_events (
    client_slug,
    COALESCE(location_id, ''),
    conversation_id,
    notification_type,
    handoff_event_key,
    recipient_phone
  );

CREATE INDEX IF NOT EXISTS idx_client_notification_events_client_created
  ON client_notification_events (client_slug, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_notification_events_conversation
  ON client_notification_events (conversation_id, notification_type);

COMMENT ON TABLE client_notification_events IS 'Audit + dedupe log for staff WhatsApp notification sends.';
COMMENT ON COLUMN client_notification_events.handoff_event_key IS 'Dedupe key: initial for new_conversation; luna_handoff_at or transition id for human_needed.';

COMMIT;
