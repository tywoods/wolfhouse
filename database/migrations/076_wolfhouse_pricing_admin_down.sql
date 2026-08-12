-- Down for 076: refuse destructive rollback while Wolfhouse pricing overlay rows exist.
-- Dropping these tables would silently revert every staff price edit back to the
-- JSON seed baked into the image, with no record of what was lost.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM wh_pricing_rules)
     OR EXISTS (SELECT 1 FROM wh_pricing_items)
     OR EXISTS (SELECT 1 FROM wh_pricing_seasons)
     OR EXISTS (SELECT 1 FROM wh_pricing_transfer_rules) THEN
    RAISE EXCEPTION '076 rollback refused: Wolfhouse pricing tables are nonempty'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

BEGIN;
DROP TABLE wh_pricing_season_ranges;
DROP TABLE wh_pricing_seasons;
DROP TABLE wh_pricing_rules;
DROP TABLE wh_pricing_items;
DROP TABLE wh_pricing_transfer_rules;
COMMIT;
