-- Phase 25b — Generic staff/owner phone allowlist (multi-client)
--
-- Rows are per client_slug; runtime logic stays generic.
-- Staging/test apply until explicitly approved for production.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_phone_access (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug      TEXT NOT NULL,
  phone_e164       TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  display_name     TEXT,
  role             TEXT NOT NULL CHECK (role IN ('operator', 'owner')),
  channel          TEXT NOT NULL DEFAULT 'whatsapp',
  is_active        BOOLEAN NOT NULL DEFAULT true,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_phone_access_client_phone_channel_unique
    UNIQUE (client_slug, phone_normalized, channel)
);

COMMENT ON TABLE staff_phone_access IS
  'Phase 25b allowlisted staff/owner phones per client (WhatsApp channel). '
  'Lookup by client_slug + phone_normalized + channel; only is_active rows route in 25c.';

CREATE INDEX IF NOT EXISTS idx_staff_phone_access_client_phone
  ON staff_phone_access (client_slug, phone_normalized);

CREATE INDEX IF NOT EXISTS idx_staff_phone_access_client_role
  ON staff_phone_access (client_slug, role);

CREATE INDEX IF NOT EXISTS idx_staff_phone_access_client_active
  ON staff_phone_access (client_slug, is_active);

CREATE TRIGGER staff_phone_access_updated_at
  BEFORE UPDATE ON staff_phone_access FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
