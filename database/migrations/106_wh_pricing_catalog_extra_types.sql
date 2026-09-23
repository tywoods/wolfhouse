-- PRICING-DEPOSIT-ADD-500-001
-- Renumbered from 105 because EMAIL-CARD-PAUSE-TOGGLE-001 landed first.
-- Migration 076 predates staff-creatable deposits/supplements. Its catalog
-- CHECK rejects these identities before the separately valid price is saved.
-- Apply explicitly to the approved staging DB; an API image deploy alone does
-- not upgrade an existing CHECK. No data, tenant, role, or payment changes.
-- A single DO statement is atomic, including replacement and validation.
-- Absent Wolfhouse tables (e.g. Sunset-only DB): no-op. Safe to re-run.
DO $$
BEGIN
  -- Fail rather than waiting indefinitely behind a busy table.
  PERFORM set_config('lock_timeout', '5s', true);
  IF to_regclass('public.wh_pricing_items') IS NOT NULL THEN
    ALTER TABLE public.wh_pricing_items
      DROP CONSTRAINT IF EXISTS wh_pricing_items_item_type_check;
    ALTER TABLE public.wh_pricing_items
      ADD CONSTRAINT wh_pricing_items_item_type_check
      CHECK (item_type IN ('package', 'rental', 'service', 'supplement', 'deposit'));
  END IF;
END;
$$;
