-- Sunset Admin private lesson product (one configurable unit per client/location).
-- NOT applied automatically — operator runs when ready.

CREATE TABLE IF NOT EXISTS tenant_private_lesson_rules (
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

COMMENT ON TABLE tenant_private_lesson_rules IS
  'Sunset Admin private lesson product — one active row per client_slug + location_id.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_private_lesson_client_loc
  ON tenant_private_lesson_rules (client_slug, COALESCE(location_id, ''))
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_tenant_private_lesson_client_active
  ON tenant_private_lesson_rules (client_slug, active);

CREATE TRIGGER tenant_private_lesson_rules_updated_at
  BEFORE UPDATE ON tenant_private_lesson_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
