-- 062_tenant_channel_endpoint_secret_ref_nullable_down.sql
-- Restore NOT NULL secret_ref only when no NULL rows exist. Never invent refs.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant_channel_endpoints WHERE secret_ref IS NULL
  ) THEN
    RAISE EXCEPTION
      '062_tenant_channel_endpoint_secret_ref_nullable_down: NULL secret_ref rows prevent restoring NOT NULL; refuse invent/backfill'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

ALTER TABLE tenant_channel_endpoints
  ALTER COLUMN secret_ref SET NOT NULL;

COMMENT ON COLUMN tenant_channel_endpoints.secret_ref IS
  'Opaque secret-manager reference (kv:… or secret-ref:…). Never a password, token, or API key.';

COMMIT;
