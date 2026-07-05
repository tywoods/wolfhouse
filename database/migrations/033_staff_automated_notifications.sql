-- 033 — Scheduled staff automated notifications (prompt + WhatsApp recipients + schedule)
-- Tenant-scoped by client_slug (+ optional location_id for multi-location clients).
-- Includes dry-run audit events table (no live WhatsApp in this migration).
--
-- Rollback:
--   DROP TABLE IF EXISTS staff_automated_notification_events;
--   DROP TABLE IF EXISTS staff_automated_notifications;

BEGIN;

CREATE TABLE IF NOT EXISTS staff_automated_notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug   TEXT NOT NULL,
  location_id   TEXT NULL,
  title         TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  recipients    JSONB NOT NULL DEFAULT '[]'::jsonb,
  days_of_week  INT[] NOT NULL,
  local_time    TIME NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'Europe/Madrid',
  last_run_at   TIMESTAMPTZ NULL,
  last_status   TEXT NULL CHECK (last_status IS NULL OR last_status IN ('sent', 'dry_run', 'failed', 'skipped')),
  last_error    TEXT NULL,
  created_by    TEXT NULL,
  updated_by    TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_automated_notifications_client_location
  ON staff_automated_notifications (client_slug, COALESCE(location_id, ''));

CREATE INDEX IF NOT EXISTS idx_staff_automated_notifications_enabled_time
  ON staff_automated_notifications (client_slug, COALESCE(location_id, ''), enabled, local_time)
  WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_staff_automated_notifications_client_updated
  ON staff_automated_notifications (client_slug, updated_at DESC);

COMMENT ON TABLE staff_automated_notifications IS 'Staff Portal: scheduled Luna prompt runs WhatsApping selected staff/owner numbers.';
COMMENT ON COLUMN staff_automated_notifications.recipients IS 'Array of {staff_number_id, name, phone, permission_group} from active wolfhouse_staff_whatsapp_numbers rows.';
COMMENT ON COLUMN staff_automated_notifications.days_of_week IS 'Unique integers 0–6 (0=Mon … 6=Sun).';

CREATE TABLE IF NOT EXISTS staff_automated_notification_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id    UUID NOT NULL,
  client_slug      TEXT NOT NULL,
  location_id      TEXT NULL,
  due_local_date   DATE NOT NULL,
  due_local_time   TIME NOT NULL,
  dedupe_key       TEXT NOT NULL,
  recipient_phone  TEXT NOT NULL,
  recipient_name   TEXT NULL,
  status           TEXT NOT NULL CHECK (status IN ('dry_run', 'sent', 'failed', 'skipped')),
  question         TEXT NULL,
  answer_preview   TEXT NULL,
  error            TEXT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_automated_notification_events_dedupe
  ON staff_automated_notification_events (dedupe_key, recipient_phone);

CREATE INDEX IF NOT EXISTS idx_staff_automated_notification_events_client_created
  ON staff_automated_notification_events (client_slug, COALESCE(location_id, ''), created_at DESC);

COMMENT ON TABLE staff_automated_notification_events IS 'Audit + dedupe log for automated staff notification runs (dry-run and future live sends).';

COMMIT;
