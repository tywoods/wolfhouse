-- 074: admit only exact classified Gmail delegated endpoints to the existing
-- encrypted grant custodian. No rows, credentials, activation, routes, or sends.
BEGIN;

CREATE OR REPLACE FUNCTION tenant_email_delegated_grants_require_delegated_endpoint()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ep tenant_channel_endpoints%ROWTYPE;
BEGIN
  SELECT e.* INTO ep
  FROM tenant_channel_endpoints e
  WHERE e.id = NEW.endpoint_id AND e.client_id = NEW.client_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_email_delegated_grants: endpoint not found for client'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (ep.provider IS NOT DISTINCT FROM 'microsoft_graph'
      AND ep.auth_mode IS NOT DISTINCT FROM 'delegated_authorization_code'
      AND ep.connector_mode IS NOT DISTINCT FROM 'microsoft_delegated_oauth')
    OR
    (ep.provider IS NOT DISTINCT FROM 'gmail_api'
      AND ep.auth_mode IS NOT DISTINCT FROM 'delegated_authorization_code'
      AND ep.connector_mode IS NOT DISTINCT FROM 'google_delegated_oauth'
      AND ep.binding_status IS NOT DISTINCT FROM 'verified'
      AND ep.provider_tenant_id COLLATE "C" IS NOT DISTINCT FROM 'https://accounts.google.com' COLLATE "C"
      AND ep.provider_principal_oid IS NOT NULL
      AND char_length(ep.provider_principal_oid) BETWEEN 1 AND 255
      AND ep.provider_principal_oid COLLATE "C" ~ '^[!-~]+$'
      AND ep.provider_resource_id IS NOT NULL
      AND ep.provider_resource_id COLLATE "C" = ep.provider_principal_oid COLLATE "C"
      AND ep.mailbox_kind IS NOT DISTINCT FROM 'user'
      AND ep.mailbox_access_kind IS NOT DISTINCT FROM 'own_user')
  ) THEN
    RAISE EXCEPTION 'tenant_email_delegated_grants: endpoint is not an exact delegated custody mode'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tenant_email_delegated_grants_require_delegated_endpoint() IS
  '074 closed grant applicability: existing Microsoft delegated tuple or fully verified canonical Gmail delegated own-user identity.';

-- Preserve Microsoft mode protection. For Gmail, permit syntactic/no-op updates
-- while freezing the complete verified identity tuple under a live grant.
CREATE OR REPLACE FUNCTION tenant_channel_endpoints_protect_delegated_grant_mode()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant_email_delegated_grants g
    WHERE g.endpoint_id = OLD.id
  ) THEN
    IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
      RAISE EXCEPTION 'tenant_channel_endpoints: cannot change client while delegated grant exists'
        USING ERRCODE = '23514';
    ELSIF OLD.provider IS NOT DISTINCT FROM 'gmail_api'
       OR NEW.provider IS NOT DISTINCT FROM 'gmail_api' THEN
      IF NEW.provider IS DISTINCT FROM 'gmail_api'
         OR NEW.auth_mode IS DISTINCT FROM 'delegated_authorization_code'
         OR NEW.connector_mode IS DISTINCT FROM 'google_delegated_oauth'
         OR NEW.binding_status IS DISTINCT FROM 'verified'
         OR NEW.provider_tenant_id COLLATE "C" IS DISTINCT FROM 'https://accounts.google.com' COLLATE "C"
         OR NEW.provider_principal_oid IS NULL
         OR NEW.provider_principal_oid COLLATE "C" !~ '^[!-~]{1,255}$'
         OR NEW.provider_resource_id COLLATE "C" IS DISTINCT FROM NEW.provider_principal_oid COLLATE "C"
         OR NEW.mailbox_kind IS DISTINCT FROM 'user'
         OR NEW.mailbox_access_kind IS DISTINCT FROM 'own_user'
         OR NEW.provider IS DISTINCT FROM OLD.provider
         OR NEW.auth_mode IS DISTINCT FROM OLD.auth_mode
         OR NEW.connector_mode IS DISTINCT FROM OLD.connector_mode
         OR NEW.binding_status IS DISTINCT FROM OLD.binding_status
         OR NEW.provider_tenant_id COLLATE "C" IS DISTINCT FROM OLD.provider_tenant_id COLLATE "C"
         OR NEW.provider_principal_oid COLLATE "C" IS DISTINCT FROM OLD.provider_principal_oid COLLATE "C"
         OR NEW.provider_resource_id COLLATE "C" IS DISTINCT FROM OLD.provider_resource_id COLLATE "C"
         OR NEW.mailbox_kind IS DISTINCT FROM OLD.mailbox_kind
         OR NEW.mailbox_access_kind IS DISTINCT FROM OLD.mailbox_access_kind THEN
        RAISE EXCEPTION 'tenant_channel_endpoints: cannot change Gmail delegated identity while grant exists'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.provider IS DISTINCT FROM 'microsoft_graph'
       OR NEW.auth_mode IS DISTINCT FROM 'delegated_authorization_code'
       OR NEW.connector_mode IS DISTINCT FROM 'microsoft_delegated_oauth' THEN
      RAISE EXCEPTION 'tenant_channel_endpoints: cannot change mode while delegated grant exists'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER tenant_channel_endpoints_protect_delegated_grant_mode ON tenant_channel_endpoints;
CREATE TRIGGER tenant_channel_endpoints_protect_delegated_grant_mode
  BEFORE UPDATE OF provider, auth_mode, connector_mode, client_id, binding_status,
    provider_tenant_id, provider_principal_oid, provider_resource_id,
    mailbox_kind, mailbox_access_kind
  ON tenant_channel_endpoints
  FOR EACH ROW EXECUTE FUNCTION tenant_channel_endpoints_protect_delegated_grant_mode();

COMMENT ON TABLE tenant_email_delegated_grants IS
  'Slice 2F-A/074: one delegated Microsoft or exact classified Gmail refresh-grant custody row per endpoint. Owner-approved envelope only; raw refresh tokens forbidden.';
COMMIT;