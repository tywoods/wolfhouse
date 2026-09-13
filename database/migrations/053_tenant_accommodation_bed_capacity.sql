-- Sunset Admin Accommodation — optional bed capacity for Finance occupancy.
-- bed_capacity is the number of sellable staff beds at the location.
-- Finance uses guest-nights / (bed_capacity × period_days) when configured.

BEGIN;

ALTER TABLE tenant_accommodation_settings
  ADD COLUMN IF NOT EXISTS bed_capacity INTEGER
  CHECK (bed_capacity IS NULL OR (bed_capacity >= 1 AND bed_capacity <= 999));

COMMENT ON COLUMN tenant_accommodation_settings.bed_capacity IS
  'Optional staff-bed count for Finance Alojamiento occupancy (guest-nights / beds×days). Null hides the capacity row.';

COMMIT;
