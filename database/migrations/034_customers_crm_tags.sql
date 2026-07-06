-- 034_customers_crm_tags.sql
-- Lightweight CRM tags/flags on customers (lead, vip, do_not_contact, etc.).
-- Additive only — safe to re-run.

BEGIN;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS crm_tags JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_customers_crm_tags ON customers USING gin (crm_tags);

COMMIT;
