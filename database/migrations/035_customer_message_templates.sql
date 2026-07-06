-- 035_customer_message_templates.sql
-- Tenant-scoped canned WhatsApp message templates for Customers CRM outreach drawer.
-- Additive only — safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS customer_message_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'whatsapp',
  tags        JSONB NOT NULL DEFAULT '[]'::jsonb,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_message_templates_client_active
  ON customer_message_templates (client_id, active, updated_at DESC);

COMMENT ON TABLE customer_message_templates IS 'Staff Portal: saved WhatsApp message templates for Customers outreach (per tenant).';

COMMIT;
