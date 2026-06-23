-- Sunset Admin surf pack rules (multi-week lesson packs with beaches, schedules, tier pricing).

CREATE TABLE IF NOT EXISTS tenant_surf_pack_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT NOT NULL DEFAULT 'sunset',
  client_slug      TEXT NOT NULL,
  location_id      TEXT,
  label            TEXT NOT NULL,
  config_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       UUID REFERENCES staff_users(id) ON DELETE SET NULL
);

COMMENT ON TABLE tenant_surf_pack_rules IS
  'Sunset Admin surf lesson pack products (weekly packs, beaches, schedules, tier prices).';

CREATE INDEX IF NOT EXISTS idx_tenant_surf_pack_client_active
  ON tenant_surf_pack_rules (client_slug, active);

CREATE INDEX IF NOT EXISTS idx_tenant_surf_pack_client_loc
  ON tenant_surf_pack_rules (client_slug, location_id)
  WHERE active = true;

CREATE TRIGGER tenant_surf_pack_rules_updated_at
  BEFORE UPDATE ON tenant_surf_pack_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
