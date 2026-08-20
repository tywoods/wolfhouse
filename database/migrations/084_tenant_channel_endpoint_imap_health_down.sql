BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant_channel_endpoints WHERE imap_health_verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cannot roll back 084 while durable IMAP health facts exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM tenant_email_imap_fetch_cursors
  ) THEN
    RAISE EXCEPTION 'cannot roll back 084 while IMAP fetch cursors exist';
  END IF;
END $$;

DROP TABLE IF EXISTS tenant_email_imap_fetch_cursors;

ALTER TABLE tenant_channel_endpoints DROP COLUMN imap_health_verified_at;

COMMIT;
