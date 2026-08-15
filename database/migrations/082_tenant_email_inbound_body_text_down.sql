BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant_email_inbound_events WHERE body_text IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cannot roll back 082 while inbound body_text values exist';
  END IF;
END $$;

ALTER TABLE tenant_email_inbound_events DROP COLUMN body_text;

COMMIT;
