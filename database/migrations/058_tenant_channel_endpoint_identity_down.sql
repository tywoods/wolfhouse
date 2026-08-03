-- Explicit down/rollback for 058_tenant_channel_endpoint_identity.
-- Drops ownership index, CHECKs, then identity columns. Leaves 057 registry intact.

BEGIN;

DROP INDEX IF EXISTS tenant_channel_endpoints_verified_mailbox_ownership_uidx;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_verified_ownership_complete;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_mode_field_coherence;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_mailbox_access_kind_values;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_mailbox_kind_values;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_provider_principal_oid_shape;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_provider_resource_id_shape;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_provider_tenant_id_shape;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_binding_status_values;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_identity_requires_modes;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_identity_mode_pair;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_auth_connector_nulls;

ALTER TABLE tenant_channel_endpoints
  DROP COLUMN IF EXISTS binding_status,
  DROP COLUMN IF EXISTS mailbox_access_kind,
  DROP COLUMN IF EXISTS mailbox_kind,
  DROP COLUMN IF EXISTS provider_principal_oid,
  DROP COLUMN IF EXISTS provider_tenant_id,
  DROP COLUMN IF EXISTS connector_mode,
  DROP COLUMN IF EXISTS auth_mode;

COMMIT;
