-- Wolfhouse (lodging) Admin Pricing portal storage.
--
-- Purpose:
--   Backs the Wolfhouse Admin > Pricing sub-tab: Seasons, Packages, Rentals,
--   Services and Transfers. Until now Wolfhouse pricing lived only in
--   config/clients/wolfhouse-somo.pricing.json baked into the image, so staff
--   could not change a price without a rebuild. These tables are the DB overlay;
--   the JSON stays the fallback seed when no active row exists.
--
-- Why not tenant_price_rules:
--   That table is Sunset's. Its loaders (loadTenantBusinessConfigFromDb,
--   loadTenantPriceRuleFromDb in scripts/lib/tenant-business-config.js) throw
--   tenant_scope_violation for any slug other than 'sunset' on purpose. Widening
--   those guards would put Wolfhouse writes through Sunset's read paths. These
--   tables keep the two tenants on separate storage with no shared code path.
--
-- Season model:
--   Seasons are RECURRING day/month windows, not absolute dates, so they apply
--   every year until an operator changes them. A season owns one or more ranges;
--   a range whose end falls before its start wraps the year end (e.g. Nov 1 ->
--   Feb 28 for the closed season). Overlaps between seasons are resolved by
--   priority (higher wins), matching the existing JSON where august (priority 10)
--   overrides summer. A date matching no season has no price: the quote path
--   blocks and hands off rather than guessing.
--
-- Safety:
--   * CREATE TABLE / INDEX IF NOT EXISTS — idempotent.
--   * No INSERT/UPDATE/DELETE data migration; tables start empty and every read
--     falls back to the JSON seed until staff saves a row.
--   * No RLS / GRANT changes.
--   * Safe no-op on Sunset-only databases.
--
-- Money is never trusted from the browser: all amounts are integer cents and the
-- server re-prices from active rows at write time.
--
-- Runtime twin: ensureWolfhousePricingTables() in scripts/lib/wolfhouse-pricing-store.js
-- (Lunabox cannot always run migrations against staging Postgres).

BEGIN;

-- ── Seasons ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wh_pricing_seasons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug     TEXT NOT NULL,
  code            TEXT NOT NULL,
  label           TEXT NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  bookable        BOOLEAN NOT NULL DEFAULT true,
  active          BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL
);

COMMENT ON TABLE wh_pricing_seasons IS
  'Wolfhouse Admin Pricing seasons. Named recurring periods that package prices hang off. Higher priority wins when two seasons cover the same date.';

COMMENT ON COLUMN wh_pricing_seasons.bookable IS
  'false marks a closed season: dates resolve to a season but must not be quoted or booked.';

COMMENT ON COLUMN wh_pricing_seasons.priority IS
  'Overlap tiebreak, higher wins. Mirrors the JSON seed where august (10) overrides summer (0).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_pricing_seasons_code
  ON wh_pricing_seasons (client_slug, code)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_wh_pricing_seasons_client_active
  ON wh_pricing_seasons (client_slug, active);

CREATE TRIGGER wh_pricing_seasons_updated_at
  BEFORE UPDATE ON wh_pricing_seasons FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Season ranges (recurring day/month windows) ─────────────────────────────

CREATE TABLE IF NOT EXISTS wh_pricing_season_ranges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id       UUID NOT NULL REFERENCES wh_pricing_seasons(id) ON DELETE CASCADE,
  client_slug     TEXT NOT NULL,
  start_month     SMALLINT NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  start_day       SMALLINT NOT NULL CHECK (start_day BETWEEN 1 AND 31),
  end_month       SMALLINT NOT NULL CHECK (end_month BETWEEN 1 AND 12),
  end_day         SMALLINT NOT NULL CHECK (end_day BETWEEN 1 AND 31),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE wh_pricing_season_ranges IS
  'Recurring day/month windows for a Wolfhouse season. Inclusive on both ends. A range whose end sorts before its start wraps the year boundary (Nov 1 -> Feb 28).';

COMMENT ON COLUMN wh_pricing_season_ranges.end_day IS
  'Inclusive last day. Feb 29 is accepted and clamps to Feb 28 in non-leap years at resolve time.';

CREATE INDEX IF NOT EXISTS idx_wh_pricing_season_ranges_season
  ON wh_pricing_season_ranges (season_id);

CREATE INDEX IF NOT EXISTS idx_wh_pricing_season_ranges_client
  ON wh_pricing_season_ranges (client_slug);

CREATE TRIGGER wh_pricing_season_ranges_updated_at
  BEFORE UPDATE ON wh_pricing_season_ranges FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Catalog items (staff-creatable rentals, services, packages) ─────────────

CREATE TABLE IF NOT EXISTS wh_pricing_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug     TEXT NOT NULL,
  item_type       TEXT NOT NULL CHECK (item_type IN ('package', 'rental', 'service')),
  item_code       TEXT NOT NULL,
  label           TEXT NOT NULL,
  description     TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  active          BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL
);

COMMENT ON TABLE wh_pricing_items IS
  'Wolfhouse Admin Pricing catalog identity, no money. Lets staff create new rentals and services. Prices for an item live in wh_pricing_rules.';

COMMENT ON COLUMN wh_pricing_items.metadata IS
  'Non-money item attributes, e.g. {"pricing_unit":"per_day","per_guest":true} for services or {"inclusions":[...]} for packages.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_pricing_items_code
  ON wh_pricing_items (client_slug, item_type, item_code)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_wh_pricing_items_client_type
  ON wh_pricing_items (client_slug, item_type, active);

CREATE TRIGGER wh_pricing_items_updated_at
  BEFORE UPDATE ON wh_pricing_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Price rules ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wh_pricing_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug     TEXT NOT NULL,
  item_type       TEXT NOT NULL CHECK (item_type IN (
                    'package', 'rental', 'service', 'transfer',
                    'addon', 'supplement', 'deposit')),
  item_code       TEXT NOT NULL,
  season_code     TEXT,
  unit            TEXT NOT NULL CHECK (unit IN (
                    'per_person_per_week', 'per_person_per_night', 'per_room_per_night',
                    'per_person', 'per_day', 'per_night', 'per_booking',
                    'per_lesson', 'per_class', 'per_meal', 'per_stay', 'flat')),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= 100000000),
  currency        CHAR(3) NOT NULL DEFAULT 'EUR',
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL
);

COMMENT ON TABLE wh_pricing_rules IS
  'Wolfhouse Admin Pricing money rows. One active row per client+type+code+season. NULL season_code means the price applies in every season.';

COMMENT ON COLUMN wh_pricing_rules.item_code IS
  'Package code (malibu), rental offering plus duration (wetsuit_rental__1_day), service code (yoga_class), transfer airport (SDR), deposit tier (standard_package) or supplement (private).';

COMMENT ON COLUMN wh_pricing_rules.season_code IS
  'References wh_pricing_seasons.code by value, not FK, so renaming or deactivating a season never silently deletes prices.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_pricing_rules_scope
  ON wh_pricing_rules (client_slug, item_type, item_code, COALESCE(season_code, ''))
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_wh_pricing_rules_client_type
  ON wh_pricing_rules (client_slug, item_type, active);

CREATE INDEX IF NOT EXISTS idx_wh_pricing_rules_season
  ON wh_pricing_rules (client_slug, season_code)
  WHERE active = true;

CREATE TRIGGER wh_pricing_rules_updated_at
  BEFORE UPDATE ON wh_pricing_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Transfer eligibility rules ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wh_pricing_transfer_rules (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug            TEXT NOT NULL,
  airport_code           TEXT NOT NULL,
  label                  TEXT NOT NULL,
  aliases                TEXT[] NOT NULL DEFAULT '{}',
  requires_package       BOOLEAN NOT NULL DEFAULT false,
  included_when_package  BOOLEAN NOT NULL DEFAULT false,
  min_guest_count        INTEGER CHECK (min_guest_count IS NULL OR min_guest_count > 0),
  unavailable_no_package_message      TEXT,
  unavailable_below_min_group_message TEXT,
  active                 BOOLEAN NOT NULL DEFAULT true,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by             UUID REFERENCES staff_users(id) ON DELETE SET NULL
);

COMMENT ON TABLE wh_pricing_transfer_rules IS
  'Wolfhouse airport transfer eligibility, the non-money half of a transfer. Replaces the hardcoded CLIENT_TRANSFER_CONFIGS in scripts/lib/client-transfer-config.js. Prices live in wh_pricing_rules as item_type transfer.';

COMMENT ON COLUMN wh_pricing_transfer_rules.min_guest_count IS
  'Minimum party size, e.g. Bilbao normally needs 4. NULL means no minimum. Staff can still save a manual exception.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_pricing_transfer_rules_airport
  ON wh_pricing_transfer_rules (client_slug, airport_code)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_wh_pricing_transfer_rules_client
  ON wh_pricing_transfer_rules (client_slug, active);

CREATE TRIGGER wh_pricing_transfer_rules_updated_at
  BEFORE UPDATE ON wh_pricing_transfer_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
