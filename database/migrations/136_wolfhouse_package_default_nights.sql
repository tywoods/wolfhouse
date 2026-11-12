BEGIN;

-- Settings only. No booking, guest, payment, quote snapshot or historical
-- deposit is rewritten. Prod apply waits for Ty's OK through Chief.
--
-- Before: package prices live on wh_pricing_rules.amount_cents only; package
-- items have no default_nights. Luna assumed a 7-night week.
-- After: per_night_cents is stored separately (prefilled package÷6); existing
-- packages get default_nights = 6 unless already set. allow_daily_proration
-- is left in metadata unused.

ALTER TABLE wh_pricing_rules
  ADD COLUMN IF NOT EXISTS per_night_cents INTEGER;

UPDATE wh_pricing_items
SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{default_nights}', '6'::jsonb)
WHERE item_type = 'package'
  AND active = true
  AND (metadata->>'default_nights') IS NULL;

UPDATE wh_pricing_rules
SET per_night_cents = ROUND(amount_cents::numeric / 6)
WHERE item_type = 'package'
  AND active = true
  AND per_night_cents IS NULL
  AND amount_cents >= 0;

COMMIT;
