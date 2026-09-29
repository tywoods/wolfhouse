-- Optional configured transfer group limit; no booking/capacity enforcement.
-- Additive upgrade of 076; existing rows retain NULL (no configured maximum).
-- Runtime twin: scripts/lib/wolfhouse-pricing-store.js CREATE_SQL.
BEGIN;
ALTER TABLE wh_pricing_transfer_rules
  ADD COLUMN IF NOT EXISTS max_guest_count INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wh_pricing_transfer_rules'::regclass
      AND conname = 'wh_pricing_transfer_rules_max_guest_count_check'
  ) THEN
    ALTER TABLE wh_pricing_transfer_rules
      ADD CONSTRAINT wh_pricing_transfer_rules_max_guest_count_check
      CHECK (max_guest_count IS NULL OR
        (max_guest_count BETWEEN 1 AND 99 AND
          (min_guest_count IS NULL OR max_guest_count >= min_guest_count)));
  END IF;
END $$;
COMMIT;
