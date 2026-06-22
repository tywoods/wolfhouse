-- 027 — Wolfhouse staff WhatsApp numbers (permission groups: staff | owner)
-- Replaces the static JSON allowlist (config/clients/*.staff-whatsapp-allowlist.json)
-- as the runtime source for /staff/ask-luna source=staff_whatsapp recognition.
-- Tenant-neutral table: every row is scoped by client_slug so Sunset is unaffected.
-- Matches gen_random_uuid() id convention used by 024_booking_guests.sql (pgcrypto).
-- Idempotent + reversible.
--
-- Rollback:
--   DROP TABLE IF EXISTS wolfhouse_staff_whatsapp_numbers;

BEGIN;

CREATE TABLE IF NOT EXISTS wolfhouse_staff_whatsapp_numbers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug       TEXT NOT NULL,
  phone             TEXT NOT NULL,
  permission_group  TEXT NOT NULL CHECK (permission_group IN ('staff', 'owner')),
  display_name      TEXT NULL,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_slug, phone)
);

CREATE INDEX IF NOT EXISTS idx_wolfhouse_staff_whatsapp_numbers_client_active
  ON wolfhouse_staff_whatsapp_numbers (client_slug, active);

COMMENT ON TABLE wolfhouse_staff_whatsapp_numbers IS 'Per-tenant staff/owner WhatsApp numbers for Luna staff recognition (source=staff_whatsapp). permission_group: staff=operations only, owner=operations + owner insights.';
COMMENT ON COLUMN wolfhouse_staff_whatsapp_numbers.phone IS 'E.164 phone, normalized to leading + and digits only.';
COMMENT ON COLUMN wolfhouse_staff_whatsapp_numbers.permission_group IS 'staff = operations access only; owner = operations + owner insights.';

COMMIT;
