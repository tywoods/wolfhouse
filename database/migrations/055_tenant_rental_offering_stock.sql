-- 055: location-scoped physical stock on tenant_rental_offerings.
--
-- Product: Admin sets total stock (0..999 whole units) per rentable offering at
-- a client+location. Remaining stock for a calendar date is computed later by
-- the canonical stock calculator (scripts/lib/tenant-rental-stock.js) as
--   configured stock − active non-cancelled/non-archived reservations
-- for the exact offering_key. Multi-day availability is the min remaining
-- across the inclusive date range.
--
-- NULLABLE by design: existing tenants must not receive invented stock counts.
-- Missing stock fails closed for new stock checks (not unlimited).
-- Zero means sold out, not deleted.
--
-- Stock lives on the offering identity row — never on price rows.
-- Every Admin-created offering (including a user-named "Surfboard + Wetsuit")
-- is an independent stock-controlled product by exact offering_key; no hidden
-- bundle/component deductions.
--
-- ADDITIVE / UNWIRED: column only. Booking write enforcement and Admin UI land
-- in later slices after this foundation.
--
-- Refs: .hermes/plans/2026-07-31_173018-rental-equipment-stock.md slice 1.

ALTER TABLE tenant_rental_offerings
  ADD COLUMN IF NOT EXISTS stock_quantity INTEGER;

-- Allow NULL (unconfigured). When set, enforce 0..999 inclusive.
ALTER TABLE tenant_rental_offerings
  DROP CONSTRAINT IF EXISTS tenant_rental_offerings_stock_quantity_check;

ALTER TABLE tenant_rental_offerings
  ADD CONSTRAINT tenant_rental_offerings_stock_quantity_check
  CHECK (stock_quantity IS NULL OR (stock_quantity >= 0 AND stock_quantity <= 999));

COMMENT ON COLUMN tenant_rental_offerings.stock_quantity IS
  'Physical rental units available at this client+location for this exact offering_key (0..999). NULL = unconfigured (fail closed for new stock checks). Zero = sold out, not deleted. Independent per offering_key; no bundle component coupling.';
