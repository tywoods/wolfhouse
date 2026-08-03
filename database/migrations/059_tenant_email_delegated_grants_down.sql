-- Explicit down/rollback for 059_tenant_email_delegated_grants.
--
-- OPERATIONAL WARNING: After production use this rollback is structurally
-- reversible (drops sealed grant rows + triggers + parent unique) but
-- operationally irreversible for live mailboxes — sealed envelopes are
-- destroyed and Microsoft refresh grants become unrecoverable without reauth.
-- Does not delete or disable Key Vault wrapping keys.
-- Leaves 057/058 registry tables and identity columns intact.

BEGIN;

DROP TRIGGER IF EXISTS tenant_channel_endpoints_protect_delegated_grant_mode
  ON tenant_channel_endpoints;
DROP FUNCTION IF EXISTS tenant_channel_endpoints_protect_delegated_grant_mode();

DROP TRIGGER IF EXISTS tenant_email_delegated_grants_mode_guard
  ON tenant_email_delegated_grants;
DROP FUNCTION IF EXISTS tenant_email_delegated_grants_require_delegated_endpoint();

DROP TRIGGER IF EXISTS tenant_email_delegated_grants_updated_at
  ON tenant_email_delegated_grants;

DROP TABLE IF EXISTS tenant_email_delegated_grants;

ALTER TABLE tenant_channel_endpoints
  DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_client_id_id_uq;

COMMIT;
