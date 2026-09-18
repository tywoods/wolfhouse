-- Tenant/property-scoped surf beach catalog. Catalog identity only: no money or capacity.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant_surf_beaches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL DEFAULT 'sunset',
  client_slug  TEXT NOT NULL,
  location_id  TEXT NOT NULL,
  beach_key    TEXT NOT NULL CHECK (beach_key ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  display_name TEXT NOT NULL CHECK (btrim(display_name) <> ''),
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   UUID REFERENCES staff_users(id) ON DELETE SET NULL
);

COMMENT ON TABLE tenant_surf_beaches IS
  'Stable tenant/property-scoped surf beach catalog identities. Prices and capacity intentionally live elsewhere.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_surf_beaches_scope_key
  ON tenant_surf_beaches (client_slug, location_id, beach_key) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_tenant_surf_beaches_scope
  ON tenant_surf_beaches (client_slug, location_id, active);
DROP TRIGGER IF EXISTS tenant_surf_beaches_updated_at ON tenant_surf_beaches;
CREATE TRIGGER tenant_surf_beaches_updated_at
  BEFORE UPDATE ON tenant_surf_beaches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Preserve every beach identity already referenced by an existing pack. This is
-- additive and never rewrites pack JSON, prices, group size, or capacity.
INSERT INTO tenant_surf_beaches (tenant_id, client_slug, location_id, beach_key, display_name)
SELECT DISTINCT p.tenant_id, p.client_slug, COALESCE(NULLIF(p.location_id, ''), 'somo'), b.beach_key,
       initcap(replace(b.beach_key, '_', ' '))
FROM tenant_surf_pack_rules p
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(p.config_json->'beaches') = 'array'
       THEN p.config_json->'beaches' ELSE '[]'::jsonb END
) AS b(beach_key)
WHERE b.beach_key ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'
ON CONFLICT DO NOTHING;

COMMIT;
