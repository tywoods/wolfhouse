-- Sunset employee-managed Accommodation (seasonal per-night ranges).
--
-- Purpose:
--   Admin Pricing card + Create/Edit booking commercial line for Sunset only.
--   Settings hold enable/disable (disabled blocks NEW additions; historical
--   booking_service_records keep their snapshotted charged breakdown).
--   Season ranges are free-text titled half-open [check_in, check_out) windows
--   with authoritative per-night amount_cents. Adjacent ranges allowed;
--   overlapping ranges rejected at the application layer (atomic save).
--
-- Safety:
--   * CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS — idempotent.
--   * No INSERT/UPDATE/DELETE data migration.
--   * No RLS / GRANT changes.
--   * Safe no-op on Wolfhouse-only databases (empty tables until Sunset admin save).
--
-- Booking persistence: one booking_service_records row per stay (service_type
-- addon_service) with dedicated metadata identity:
--   source/component = staff_accommodation, staff_accommodation = true,
--   check_in/check_out, nights, nightly_breakdown[], season_groups[], total_cents.
-- Money is never trusted from the browser; server re-prices from active ranges
-- at write time and snapshots the breakdown.
--
-- Runtime twin: ensureAccommodationTables() in scripts/lib/sunset-accommodation-admin.js
-- (lunabox cannot always run migrations against staging Postgres).

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_accommodation_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug     TEXT NOT NULL,
  location_id     TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  currency        CHAR(3) NOT NULL DEFAULT 'EUR',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL
);

COMMENT ON TABLE tenant_accommodation_settings IS
  'Sunset Admin Accommodation product enable/disable per client+location. Disabled blocks new booking additions; historical service-row snapshots remain.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_accommodation_settings_scope
  ON tenant_accommodation_settings (client_slug, COALESCE(location_id, ''));

CREATE INDEX IF NOT EXISTS idx_tenant_accommodation_settings_client
  ON tenant_accommodation_settings (client_slug);

CREATE TRIGGER tenant_accommodation_settings_updated_at
  BEFORE UPDATE ON tenant_accommodation_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS tenant_accommodation_season_ranges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug     TEXT NOT NULL,
  location_id     TEXT,
  title           TEXT NOT NULL,
  check_in        DATE NOT NULL,
  check_out       DATE NOT NULL,
  amount_cents    INTEGER NOT NULL
                  CHECK (amount_cents > 0 AND amount_cents <= 100000000),
  currency        CHAR(3) NOT NULL DEFAULT 'EUR',
  active          BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT tenant_accommodation_season_ranges_half_open
    CHECK (check_out > check_in)
);

COMMENT ON TABLE tenant_accommodation_season_ranges IS
  'Sunset Admin Accommodation seasonal per-night prices. Half-open [check_in, check_out): checkout night is not charged. Overlap rejected by app atomic save.';

COMMENT ON COLUMN tenant_accommodation_season_ranges.check_in IS
  'Inclusive first occupied night of this season range.';

COMMENT ON COLUMN tenant_accommodation_season_ranges.check_out IS
  'Exclusive end date of this season range (same half-open semantics as booking checkout).';

CREATE INDEX IF NOT EXISTS idx_tenant_accommodation_ranges_client_active
  ON tenant_accommodation_season_ranges (client_slug, active);

CREATE INDEX IF NOT EXISTS idx_tenant_accommodation_ranges_client_loc
  ON tenant_accommodation_season_ranges (client_slug, location_id)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_tenant_accommodation_ranges_window
  ON tenant_accommodation_season_ranges (client_slug, check_in, check_out)
  WHERE active = true;

CREATE TRIGGER tenant_accommodation_season_ranges_updated_at
  BEFORE UPDATE ON tenant_accommodation_season_ranges FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
