BEGIN;
-- Independent master pause; preserves connection, credentials and configured permissions.
-- Default false keeps existing mail flow unchanged. Apply before the pause-aware runtime.
ALTER TABLE tenant_channel_endpoints
  ADD COLUMN IF NOT EXISTS mail_flow_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mail_flow_pause_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mail_flow_pause_updated_by UUID;

-- Broadcast sender preference uses endpoint.updated_at. A pause is not a mailbox
-- configuration edit: keep that ordering unchanged, with its own audit fields.
-- All other endpoint updates retain the existing set_updated_at() behavior.
CREATE OR REPLACE FUNCTION set_email_endpoint_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW.mail_flow_paused, NEW.mail_flow_pause_updated_at, NEW.mail_flow_pause_updated_by)
     IS DISTINCT FROM ROW(OLD.mail_flow_paused, OLD.mail_flow_pause_updated_at, OLD.mail_flow_pause_updated_by)
     AND (to_jsonb(NEW) - ARRAY['mail_flow_paused', 'mail_flow_pause_updated_at', 'mail_flow_pause_updated_by'])
     IS NOT DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['mail_flow_paused', 'mail_flow_pause_updated_at', 'mail_flow_pause_updated_by']) THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER tenant_channel_endpoints_updated_at
  BEFORE UPDATE ON tenant_channel_endpoints
  FOR EACH ROW EXECUTE FUNCTION set_email_endpoint_updated_at();
COMMIT;
