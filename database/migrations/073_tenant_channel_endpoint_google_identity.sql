-- 073: safely widen endpoint identity to classified Google delegated Gmail.
-- Additive semantics only: no rows, credentials, grants, activation, routes, or sends.
BEGIN;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT tenant_channel_endpoints_identity_mode_pair,
  DROP CONSTRAINT tenant_channel_endpoints_provider_tenant_id_shape,
  DROP CONSTRAINT tenant_channel_endpoints_provider_principal_oid_shape,
  DROP CONSTRAINT tenant_channel_endpoints_provider_resource_id_shape,
  DROP CONSTRAINT tenant_channel_endpoints_verified_ownership_complete;

ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_identity_mode_pair CHECK (
  (provider = 'microsoft_graph' AND (auth_mode IS NULL OR
    (auth_mode = 'delegated_authorization_code' AND connector_mode = 'microsoft_delegated_oauth') OR
    (auth_mode = 'application_client_credentials' AND connector_mode = 'microsoft_app_only_enterprise')))
  OR (provider = 'gmail_api' AND ((auth_mode IS NULL AND connector_mode IS NULL) OR
    (auth_mode = 'delegated_authorization_code' AND connector_mode = 'google_delegated_oauth')))
  OR (provider = 'imap_smtp' AND auth_mode IS NULL AND connector_mode IS NULL
    AND provider_tenant_id IS NULL AND provider_principal_oid IS NULL
    AND mailbox_kind IS NULL AND mailbox_access_kind IS NULL AND binding_status IS NULL)
);

ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_provider_tenant_id_shape CHECK (
  provider_tenant_id IS NULL OR
  (provider = 'microsoft_graph' AND provider_tenant_id = btrim(provider_tenant_id)
    AND provider_tenant_id = lower(provider_tenant_id)
    AND provider_tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') OR
  (provider = 'gmail_api' AND provider_tenant_id COLLATE "C" = 'https://accounts.google.com' COLLATE "C")
);

ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_provider_principal_oid_shape CHECK (
  provider_principal_oid IS NULL OR
  (provider = 'microsoft_graph' AND provider_principal_oid = btrim(provider_principal_oid)
    AND provider_principal_oid = lower(provider_principal_oid)
    AND provider_principal_oid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') OR
  (provider = 'gmail_api' AND char_length(provider_principal_oid) BETWEEN 1 AND 255
    AND provider_principal_oid COLLATE "C" ~ '^[!-~]+$')
);

ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_provider_resource_id_shape CHECK (
  (provider_resource_id IS NULL AND (provider <> 'gmail_api' OR provider_principal_oid IS NULL)) OR
  (provider_resource_id IS NOT NULL
    AND provider_resource_id = btrim(provider_resource_id) AND char_length(provider_resource_id) > 0
    AND (provider <> 'gmail_api' OR (
      char_length(provider_resource_id) BETWEEN 1 AND 255
      AND provider_resource_id COLLATE "C" ~ '^[!-~]+$'
      AND provider_principal_oid IS NOT NULL
      AND provider_principal_oid COLLATE "C" = provider_resource_id COLLATE "C")))
);

ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_verified_ownership_complete CHECK (
  binding_status IS NULL OR binding_status NOT IN ('verified', 'reauthorization_required') OR (
    auth_mode IS NOT NULL AND connector_mode IS NOT NULL AND provider_tenant_id IS NOT NULL
    AND provider_resource_id IS NOT NULL AND mailbox_kind = 'user' AND (
      (provider = 'microsoft_graph' AND auth_mode = 'delegated_authorization_code'
        AND connector_mode = 'microsoft_delegated_oauth' AND provider_principal_oid IS NOT NULL
        AND mailbox_access_kind = 'own_user') OR
      (provider = 'microsoft_graph' AND auth_mode = 'application_client_credentials'
        AND connector_mode = 'microsoft_app_only_enterprise' AND provider_principal_oid IS NULL
        AND mailbox_access_kind = 'application') OR
      (provider = 'gmail_api' AND auth_mode = 'delegated_authorization_code'
        AND connector_mode = 'google_delegated_oauth' AND provider_tenant_id = 'https://accounts.google.com'
        AND provider_principal_oid IS NOT NULL
        AND provider_principal_oid COLLATE "C" = provider_resource_id COLLATE "C"
        AND mailbox_access_kind = 'own_user')
    )
  )
);

COMMENT ON COLUMN tenant_channel_endpoints.provider_tenant_id IS
  'Microsoft: canonical Entra tenant UUID. Google: exact canonical issuer https://accounts.google.com.';
COMMENT ON COLUMN tenant_channel_endpoints.provider_principal_oid IS
  'Microsoft delegated: Entra oid, not mailbox identity. Google delegated: exact case-sensitive printable ASCII OIDC sub and mailbox identity.';
COMMIT;
