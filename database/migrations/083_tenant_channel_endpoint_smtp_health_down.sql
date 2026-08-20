BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant_channel_endpoints WHERE smtp_health_verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cannot roll back 083 while durable SMTP health facts exist';
  END IF;
END $$;

ALTER TABLE tenant_channel_endpoints DROP COLUMN smtp_health_verified_at;

COMMIT;
