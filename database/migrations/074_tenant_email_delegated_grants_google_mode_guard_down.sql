-- Down for 074. Refuse while Gmail grant custody exists; no DML.
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant_email_delegated_grants g
    JOIN tenant_channel_endpoints e ON e.id = g.endpoint_id AND e.client_id = g.client_id
    WHERE e.provider = 'gmail_api'
  ) THEN
    RAISE EXCEPTION '074 rollback refused: Gmail delegated grant rows exist'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- Exact pre-074 (059) Microsoft-only function body.
CREATE OR REPLACE FUNCTION tenant_email_delegated_grants_require_delegated_endpoint()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ep_provider TEXT;
  ep_auth_mode TEXT;
  ep_connector_mode TEXT;
BEGIN
  SELECT e.provider, e.auth_mode, e.connector_mode
    INTO ep_provider, ep_auth_mode, ep_connector_mode
  FROM tenant_channel_endpoints e
  WHERE e.id = NEW.endpoint_id
    AND e.client_id = NEW.client_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_email_delegated_grants: endpoint not found for client'
      USING ERRCODE = '23514';
  END IF;

  IF ep_provider IS DISTINCT FROM 'microsoft_graph'
     OR ep_auth_mode IS DISTINCT FROM 'delegated_authorization_code'
     OR ep_connector_mode IS DISTINCT FROM 'microsoft_delegated_oauth' THEN
    RAISE EXCEPTION 'tenant_email_delegated_grants: endpoint must be microsoft_graph/delegated_authorization_code/microsoft_delegated_oauth'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tenant_email_delegated_grants_require_delegated_endpoint() IS NULL;

-- Exact pre-074 (059) endpoint protection function body.
CREATE OR REPLACE FUNCTION tenant_channel_endpoints_protect_delegated_grant_mode()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant_email_delegated_grants g
    WHERE g.endpoint_id = NEW.id AND g.client_id = NEW.client_id
  ) THEN
    IF NEW.provider IS DISTINCT FROM 'microsoft_graph'
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
  BEFORE UPDATE OF provider, auth_mode, connector_mode, client_id
  ON tenant_channel_endpoints
  FOR EACH ROW
  EXECUTE FUNCTION tenant_channel_endpoints_protect_delegated_grant_mode();
COMMENT ON TABLE tenant_email_delegated_grants IS
  'Slice 2F-A: one delegated MS refresh-grant custody row per endpoint. Owner-approved envelope (AES-256-GCM + wrapped DEK + version-pinned KEK). Raw refresh tokens forbidden. Empty on migrate.';
COMMIT;