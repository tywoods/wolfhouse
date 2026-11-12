BEGIN;

-- Settings only. Existing accommodation-only / package amounts become the
-- below-threshold / at-or-above-threshold per-person amounts, respectively.
-- Preserve custom prices and edited thresholds on rerun. No booking, guest,
-- payment, quote snapshot or historical deposit is rewritten.
INSERT INTO wh_pricing_items (client_slug, item_type, item_code, label, metadata)
VALUES ('wolfhouse-somo', 'deposit', 'standard_package', 'Nights-based deposit', '{"nights_threshold":6}'::jsonb)
ON CONFLICT (client_slug, item_type, item_code) WHERE active = true
DO UPDATE SET metadata = '{"nights_threshold":6}'::jsonb || wh_pricing_items.metadata;

INSERT INTO wh_pricing_rules (client_slug, item_type, item_code, season_code, unit, amount_cents, currency)
VALUES
  ('wolfhouse-somo', 'deposit', 'standard_package', NULL, 'per_person', 20000, 'EUR'),
  ('wolfhouse-somo', 'deposit', 'custom_or_short_stay', NULL, 'per_person', 10000, 'EUR')
ON CONFLICT DO NOTHING;

COMMIT;
