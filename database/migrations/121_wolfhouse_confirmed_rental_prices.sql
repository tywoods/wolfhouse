-- Promote Ale-confirmed Wolfhouse rental prices into authoritative Staff Pricing.
-- Source: config/clients/wolfhouse-somo.pricing.json Stage 3x.2g.
-- Existing active Staff rows always win; this migration only fills missing rules.
BEGIN;

WITH confirmed(item_code, amount_cents) AS (
  VALUES
    ('wetsuit_rental', 500),
    ('soft_top_rental', 1500),
    ('hard_board_rental', 2000),
    ('wetsuit_soft_top_combo', 1500),
    ('wetsuit_hard_board_combo', 2000)
)
INSERT INTO wh_pricing_rules (
  client_slug, item_type, item_code, season_code, unit,
  amount_cents, currency, active
)
SELECT
  'wolfhouse-somo', 'rental', confirmed.item_code, NULL, 'per_day',
  confirmed.amount_cents, 'EUR', true
FROM confirmed
WHERE NOT EXISTS (
  SELECT 1
  FROM wh_pricing_rules existing
  WHERE existing.client_slug = 'wolfhouse-somo'
    AND existing.item_type = 'rental'
    AND existing.item_code = confirmed.item_code
    AND existing.season_code IS NULL
    AND existing.active = true
);

COMMIT;
