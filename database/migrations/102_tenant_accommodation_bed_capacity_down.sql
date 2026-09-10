BEGIN;

ALTER TABLE tenant_accommodation_settings
  DROP COLUMN IF EXISTS bed_capacity;

COMMIT;
