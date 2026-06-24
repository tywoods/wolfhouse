-- 030 — Tenant "house notes": owner-editable, client-facing info for Luna to share
-- with guests on demand (e.g. parking, wifi, quiet hours, pets policy). One row per
-- tenant (client_slug). Tenant-neutral: scoped by client_slug so Sunset is unaffected.
-- Idempotent + reversible.
--
-- Runtime twin: lunabox can't reach Postgres to run migrations, so the same table is
-- created lazily by ensureHouseNotesTable() in scripts/lib/tenant-house-notes.js.
--
-- Rollback:
--   DROP TABLE IF EXISTS tenant_house_notes;

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_house_notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug  TEXT NOT NULL UNIQUE,
  notes        TEXT NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   UUID
);

COMMENT ON TABLE tenant_house_notes IS 'Owner-editable client-facing house info Luna shares with guests on demand (one row per client_slug).';

COMMIT;
