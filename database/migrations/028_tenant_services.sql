-- 028_tenant_services.sql
-- Wolfhouse Services admin (catalog layer). Idempotent: CREATE TABLE / INDEX IF NOT EXISTS.
-- Also created at runtime by ensureServicesTable() in scripts/lib/tenant-services-writes.js,
-- so staging works without a manual migration run.

CREATE TABLE IF NOT EXISTS tenant_services (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL DEFAULT 'wolfhouse',
  client_slug     TEXT NOT NULL,
  name            TEXT NOT NULL,
  category        TEXT,
  notes_for_luna  TEXT,
  keywords        TEXT[] NOT NULL DEFAULT '{}',
  start_date      DATE,
  end_date        DATE,
  price_cents     INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  price_unit      TEXT NOT NULL DEFAULT 'per_day',
  per_guest       BOOLEAN NOT NULL DEFAULT true,
  span_booking    BOOLEAN NOT NULL DEFAULT false,
  luna_visible    BOOLEAN NOT NULL DEFAULT true,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID,
  CONSTRAINT tenant_services_date_window
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  CONSTRAINT tenant_services_price_unit
    CHECK (price_unit IN ('per_day', 'per_week', 'per_stay', 'one_off'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_services_client_active
  ON tenant_services (client_slug, active);

COMMENT ON TABLE tenant_services IS
  'Wolfhouse add-on service catalog (admin-managed). Name is the booking line item; '
  'price is per-guest; span_booking applies per_day across nights within [start_date,end_date].';
