-- Package seasonal pricing (Wolfhouse Somo — shared room, EUR per person per WEEK)
-- Shorter stays: prorate weekly price by nights/7, round UP to nearest EUR 5 (per person).
-- Double/private: +10 EUR per person per night on top (application logic).

BEGIN;

CREATE TABLE IF NOT EXISTS package_price_rules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  package_id        UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  rule_name         TEXT NOT NULL,
  month_numbers     INT[] NOT NULL,  -- 1-12; check-in month selects rule (August uses priority)
  price_per_person_per_week_cents INTEGER NOT NULL CHECK (price_per_person_per_week_cents >= 0),
  room_type         TEXT NOT NULL DEFAULT 'shared',
  double_supplement_per_person_per_night_cents INTEGER NOT NULL DEFAULT 1000, -- 10 EUR
  priority          INTEGER NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, package_id, rule_name)
);

-- Migrate column name if an older draft of this migration was applied
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'package_price_rules'
      AND column_name = 'price_per_person_per_night_cents'
  ) THEN
    ALTER TABLE package_price_rules
      RENAME COLUMN price_per_person_per_night_cents TO price_per_person_per_week_cents;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_package_price_rules_lookup
  ON package_price_rules (client_id, package_id, active);

DROP TRIGGER IF EXISTS package_price_rules_updated_at ON package_price_rules;
CREATE TRIGGER package_price_rules_updated_at
  BEFORE UPDATE ON package_price_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Round amount in whole EUR up to nearest 5 (e.g. 106.71 -> 110)
CREATE OR REPLACE FUNCTION ceil_eur_to_nearest_5(amount_eur NUMERIC)
RETURNS NUMERIC AS $$
  SELECT CEIL(amount_eur / 5) * 5;
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- Prorated per-person stay total from weekly package price
CREATE OR REPLACE FUNCTION package_stay_total_per_person_eur(
  weekly_price_eur NUMERIC,
  nights INTEGER
)
RETURNS NUMERIC AS $$
  SELECT ceil_eur_to_nearest_5(weekly_price_eur * GREATEST(nights, 1) / 7.0);
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- Optional display rate for quotes: weekly/7 rounded up to nearest 5 EUR/night
CREATE OR REPLACE FUNCTION package_display_nightly_per_person_eur(weekly_price_eur NUMERIC)
RETURNS NUMERIC AS $$
  SELECT ceil_eur_to_nearest_5(weekly_price_eur / 7.0);
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- Seed: weekly EUR (cents) from wolf-house.com
INSERT INTO package_price_rules (client_id, package_id, rule_name, month_numbers, price_per_person_per_week_cents, priority)
SELECT c.id, p.id, v.rule_name, v.months, v.cents, v.priority
FROM clients c
CROSS JOIN (VALUES
  ('malibu',  'malibu_spring_autumn',  ARRAY[4,5,6,10], 24900, 0),
  ('uluwatu', 'uluwatu_spring_autumn', ARRAY[4,5,6,10], 34900, 0),
  ('waimea',  'waimea_spring_autumn',  ARRAY[4,5,6,10], 49900, 0),
  ('malibu',  'malibu_summer',         ARRAY[7,9],      29900, 0),
  ('uluwatu', 'uluwatu_summer',        ARRAY[7,9],      39900, 0),
  ('waimea',  'waimea_summer',         ARRAY[7,9],      54900, 0),
  ('malibu',  'malibu_august',         ARRAY[8],        34900, 10),
  ('uluwatu', 'uluwatu_august',        ARRAY[8],        44900, 10),
  ('waimea',  'waimea_august',         ARRAY[8],        59900, 10)
) AS v(pkg, rule_name, months, cents, priority)
JOIN packages p ON p.client_id = c.id AND p.code = v.pkg
WHERE c.slug = 'wolfhouse-somo'
ON CONFLICT (client_id, package_id, rule_name) DO UPDATE
SET month_numbers = EXCLUDED.month_numbers,
    price_per_person_per_week_cents = EXCLUDED.price_per_person_per_week_cents,
    priority = EXCLUDED.priority;

COMMENT ON TABLE package_price_rules IS
  'Weekly package price per person (shared). Prorate: ceil_eur_to_nearest_5(weekly * nights/7). Double: +10 EUR/person/night.';

COMMIT;
