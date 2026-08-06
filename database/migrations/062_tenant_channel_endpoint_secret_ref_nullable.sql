-- 062_tenant_channel_endpoint_secret_ref_nullable.sql
-- Stage 6 prerequisite: allow NULL secret_ref ONLY for Microsoft delegated
-- OAuth endpoints (encrypted grant storage is separate on 059). Fail-closed
-- for every other provider/mode including legacy Microsoft graph and app-only.
--
-- DROP NOT NULL is paired with a named CHECK so nullability cannot silently
-- admit invalid rows. Preflight rejects existing rows that would violate the
-- CHECK so the migration fails rather than permits bad data.
--
-- Policy (all lifecycle statuses for the delegated triple):
--   secret_ref MUST be NULL when
--     provider = microsoft_graph
--     AND auth_mode = delegated_authorization_code
--     AND connector_mode = microsoft_delegated_oauth
--   secret_ref MUST be NON-NULL for every other provider/mode
--     (legacy Microsoft graph, app-only, Gmail, IMAP, …).
--
-- CHECK uses IS NOT DISTINCT FROM so NULL auth_mode/connector_mode cannot
-- slip through three-valued logic (plain = yields UNKNOWN; CHECK treats
-- UNKNOWN as pass). Equality form:
--   (secret_ref IS NULL) = (delegated triple exact)
--
-- Existing CHECK tenant_channel_endpoints_secret_ref_shape already admits NULL
-- (PostgreSQL CHECK treats UNKNOWN as pass) for the shape predicate only.
--
-- Down: 062_tenant_channel_endpoint_secret_ref_nullable_down.sql

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM tenant_channel_endpoints
     WHERE NOT (
       (secret_ref IS NULL) = (
         provider = 'microsoft_graph'
         AND auth_mode IS NOT DISTINCT FROM 'delegated_authorization_code'
         AND connector_mode IS NOT DISTINCT FROM 'microsoft_delegated_oauth'
       )
     )
  ) THEN
    RAISE EXCEPTION
      '062_tenant_channel_endpoint_secret_ref_nullable: existing rows violate secret_ref nullability policy (delegated microsoft must be NULL; all others NON-NULL); refuse silent permit'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

ALTER TABLE tenant_channel_endpoints
  ALTER COLUMN secret_ref DROP NOT NULL;

ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_secret_ref_null_policy
  CHECK (
    (secret_ref IS NULL) = (
      provider = 'microsoft_graph'
      AND auth_mode IS NOT DISTINCT FROM 'delegated_authorization_code'
      AND connector_mode IS NOT DISTINCT FROM 'microsoft_delegated_oauth'
    )
  );

COMMENT ON COLUMN tenant_channel_endpoints.secret_ref IS
  'Opaque secret-manager reference (kv:… or secret-ref:…) when required. NULL only for microsoft_graph + delegated_authorization_code + microsoft_delegated_oauth (all lifecycle statuses; encrypted grant storage is separate). Never a password, token, or API key.';

COMMENT ON CONSTRAINT tenant_channel_endpoints_secret_ref_null_policy ON tenant_channel_endpoints IS
  '062: secret_ref MUST be NULL for Microsoft delegated OAuth; MUST be NON-NULL for every other provider/mode including legacy Microsoft graph and app-only. Uses IS NOT DISTINCT FROM to close NULL three-valued holes.';

COMMIT;
