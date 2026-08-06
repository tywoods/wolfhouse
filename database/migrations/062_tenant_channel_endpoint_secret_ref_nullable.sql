-- 062_tenant_channel_endpoint_secret_ref_nullable.sql
-- Stage 6 prerequisite: allow NULL secret_ref on tenant_channel_endpoints so a
-- pre-OAuth Microsoft delegated endpoint can be prepared without inventing a
-- placeholder secret package. Grant custody (059) holds sealed refresh material
-- after callback; secret_ref remains required for legacy/app-only registry creates.
--
-- Existing CHECK tenant_channel_endpoints_secret_ref_shape already admits NULL
-- (PostgreSQL CHECK treats UNKNOWN as pass). Only DROP NOT NULL is required.
--
-- Down: 062_tenant_channel_endpoint_secret_ref_nullable_down.sql
-- Fail-closed if any NULL secret_ref rows exist (never invent placeholders).

BEGIN;

ALTER TABLE tenant_channel_endpoints
  ALTER COLUMN secret_ref DROP NOT NULL;

COMMENT ON COLUMN tenant_channel_endpoints.secret_ref IS
  'Opaque secret-manager reference (kv:… or secret-ref:…) when present. NULL allowed for pre-OAuth Microsoft delegated prepare rows; never a password, token, or API key.';

COMMIT;
