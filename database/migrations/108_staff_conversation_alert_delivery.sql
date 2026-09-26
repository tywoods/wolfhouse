BEGIN;
CREATE TABLE IF NOT EXISTS staff_alert_authorizations (
  authorization_id TEXT PRIMARY KEY, binding_fingerprint TEXT NOT NULL, binding JSONB NOT NULL,
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 2), expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL, spent_total INTEGER NOT NULL DEFAULT 0,
  spent_new_conversation INTEGER NOT NULL DEFAULT 0, spent_human_needed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE client_notification_events DROP CONSTRAINT IF EXISTS client_notification_events_status_check;
ALTER TABLE client_notification_events ADD CONSTRAINT client_notification_events_status_check
  CHECK (status IN ('dry_run','pending','accepted','sent','failed','unknown','skipped'));
ALTER TABLE client_notification_events ADD COLUMN IF NOT EXISTS authorization_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS staff_number_id UUID NULL, ADD COLUMN IF NOT EXISTS directory_revision TEXT NULL,
  ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ NULL, ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ NULL;
DROP INDEX IF EXISTS uq_client_notification_events_dedupe;
CREATE UNIQUE INDEX uq_client_notification_events_audit_dedupe ON client_notification_events
 (client_slug,COALESCE(location_id,''),conversation_id,notification_type,handoff_event_key,recipient_phone)
 WHERE authorization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_alert_live_claim ON client_notification_events
 (authorization_id,client_slug,COALESCE(location_id,''),conversation_id,notification_type,handoff_event_key,staff_number_id)
 WHERE authorization_id IS NOT NULL;
COMMIT;
