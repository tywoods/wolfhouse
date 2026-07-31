-- 054_tenant_external_waiver_settings.sql
-- Tenant-wide external waiver configuration (business-scoped, not per-location).
-- One row per client_slug: enable toggle + external Google Form URL.
--
-- V1 is link-only. Does not store completion/signature state for external forms.
-- Native waiver_form_requests / waiver_form_submissions remain for historical
-- completed native Sunset waivers.
--
-- Runtime twin: ensureExternalWaiverSettingsTable() in
-- scripts/lib/tenant-external-waiver-settings.js (lazy create when migrations
-- cannot run on the host).
--
-- Rollback:
--   DROP TABLE IF EXISTS tenant_external_waiver_settings;

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_external_waiver_settings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug        TEXT NOT NULL UNIQUE,
  enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  external_form_url  TEXT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         UUID
);

CREATE INDEX IF NOT EXISTS idx_tenant_external_waiver_settings_client
  ON tenant_external_waiver_settings (client_slug);

COMMENT ON TABLE tenant_external_waiver_settings IS
  'Tenant-wide external waiver link config (one Google Form URL per business/client_slug). Not location-scoped.';
COMMENT ON COLUMN tenant_external_waiver_settings.enabled IS
  'When true and external_form_url is valid, Staff/Luna offer the external link and stop creating native waiver requests.';
COMMENT ON COLUMN tenant_external_waiver_settings.external_form_url IS
  'Validated HTTPS Google Forms URL (docs.google.com/forms/* or forms.gle/*). Never used to infer completion.';

COMMIT;
