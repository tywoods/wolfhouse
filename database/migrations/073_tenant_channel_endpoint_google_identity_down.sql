-- Explicit rollback for 073. Forward-only safety: refuse to erase or rewrite Google identity.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_channel_endpoints
    WHERE provider = 'gmail_api' AND (auth_mode IS NOT NULL OR connector_mode IS NOT NULL
      OR provider_tenant_id IS NOT NULL OR provider_principal_oid IS NOT NULL
      OR mailbox_kind IS NOT NULL OR mailbox_access_kind IS NOT NULL OR binding_status IS NOT NULL)) THEN
    RAISE EXCEPTION '073 rollback blocked: classified gmail_api endpoint identity exists';
  END IF;
END $$;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT tenant_channel_endpoints_verified_ownership_complete,
  DROP CONSTRAINT tenant_channel_endpoints_provider_resource_id_shape,
  DROP CONSTRAINT tenant_channel_endpoints_provider_principal_oid_shape,
  DROP CONSTRAINT tenant_channel_endpoints_provider_tenant_id_shape,
  DROP CONSTRAINT tenant_channel_endpoints_identity_mode_pair;

ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_identity_mode_pair CHECK (
  (provider = 'microsoft_graph' AND (auth_mode IS NULL OR
    (auth_mode = 'delegated_authorization_code' AND connector_mode = 'microsoft_delegated_oauth') OR
    (auth_mode = 'application_client_credentials' AND connector_mode = 'microsoft_app_only_enterprise')))
  OR (provider <> 'microsoft_graph' AND auth_mode IS NULL AND connector_mode IS NULL
    AND provider_tenant_id IS NULL AND provider_principal_oid IS NULL
    AND mailbox_kind IS NULL AND mailbox_access_kind IS NULL AND binding_status IS NULL)
);
ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_provider_tenant_id_shape CHECK (
  provider_tenant_id IS NULL OR (provider_tenant_id = btrim(provider_tenant_id)
    AND provider_tenant_id = lower(provider_tenant_id)
    AND provider_tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_provider_principal_oid_shape CHECK (
  provider_principal_oid IS NULL OR (provider_principal_oid = btrim(provider_principal_oid)
    AND provider_principal_oid = lower(provider_principal_oid)
    AND provider_principal_oid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_provider_resource_id_shape CHECK (
  provider_resource_id IS NULL OR
  (provider_resource_id = btrim(provider_resource_id) AND char_length(provider_resource_id) > 0)
);
ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_verified_ownership_complete CHECK (
  binding_status IS NULL OR binding_status NOT IN ('verified', 'reauthorization_required') OR (
    provider = 'microsoft_graph' AND auth_mode IS NOT NULL AND connector_mode IS NOT NULL
    AND provider_tenant_id IS NOT NULL AND provider_resource_id IS NOT NULL AND mailbox_kind = 'user'
    AND ((auth_mode = 'delegated_authorization_code' AND connector_mode = 'microsoft_delegated_oauth'
      AND provider_principal_oid IS NOT NULL AND mailbox_access_kind = 'own_user')
      OR (auth_mode = 'application_client_credentials' AND connector_mode = 'microsoft_app_only_enterprise'
      AND provider_principal_oid IS NULL AND mailbox_access_kind = 'application')))
);
COMMENT ON COLUMN tenant_channel_endpoints.provider_tenant_id IS
  'Slice 2D: Entra tenant tid; canonical lowercase hyphenated UUID when present.';
COMMENT ON COLUMN tenant_channel_endpoints.provider_principal_oid IS
  'Slice 2D: Entra user oid for delegated only; NOT mailbox identity; NULL for app-only.';
COMMIT;
