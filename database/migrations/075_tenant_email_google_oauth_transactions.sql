-- 075: isolated, short-lived, server-owned Google OAuth authorization transactions.
-- No provider credentials, tokens, grants, mailbox identity, or activation belong here.
BEGIN;

CREATE TABLE tenant_email_google_oauth_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  location_id UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  staff_user_id UUID NOT NULL,
  auth_session_id UUID NOT NULL,
  operation_id UUID NOT NULL UNIQUE,
  state_hash BYTEA NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  authorization_intent TEXT NOT NULL DEFAULT 'initial_connect',
  scope_version TEXT NOT NULL DEFAULT 'phase_a_v2',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  CONSTRAINT tenant_email_google_oauth_transactions_staff_fk
    FOREIGN KEY (client_id, staff_user_id)
    REFERENCES staff_users (client_id, id) ON DELETE CASCADE,
  CONSTRAINT tenant_email_google_oauth_transactions_session_fk
    FOREIGN KEY (client_id, auth_session_id, staff_user_id)
    REFERENCES auth_sessions (client_id, id, staff_user_id) ON DELETE CASCADE,
  CONSTRAINT tenant_email_google_oauth_transactions_location_fk
    FOREIGN KEY (client_id, location_id)
    REFERENCES tenant_locations (client_id, id) ON DELETE CASCADE,
  CONSTRAINT tenant_email_google_oauth_transactions_endpoint_fk
    FOREIGN KEY (client_id, endpoint_id)
    REFERENCES tenant_channel_endpoints (client_id, id) ON DELETE CASCADE,
  CONSTRAINT tenant_email_google_oauth_transactions_state_hash_shape
    CHECK (octet_length(state_hash) = 32),
  CONSTRAINT tenant_email_google_oauth_transactions_verifier_shape
    CHECK (char_length(code_verifier) BETWEEN 43 AND 128
      AND code_verifier COLLATE "C" ~ '^[A-Za-z0-9._~-]+$'),
  CONSTRAINT tenant_email_google_oauth_transactions_nonce_shape
    CHECK (char_length(nonce) BETWEEN 43 AND 128
      AND nonce COLLATE "C" ~ '^[A-Za-z0-9_-]+$'),
  CONSTRAINT tenant_email_google_oauth_transactions_intent_exact
    CHECK (authorization_intent = 'initial_connect'),
  CONSTRAINT tenant_email_google_oauth_transactions_scope_exact
    CHECK (scope_version = 'phase_a_v2'),
  CONSTRAINT tenant_email_google_oauth_transactions_ttl
    CHECK (expires_at > issued_at
      AND expires_at <= issued_at + interval '600 seconds'),
  CONSTRAINT tenant_email_google_oauth_transactions_consumed_shape
    CHECK (consumed_at IS NULL
      OR (consumed_at >= issued_at AND consumed_at <= expires_at))
);

CREATE OR REPLACE FUNCTION tenant_email_google_oauth_transactions_require_endpoint()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  eligible_endpoint BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'tenant_email_google_oauth_transactions: insert must be unconsumed'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
       OR NEW.staff_user_id IS DISTINCT FROM OLD.staff_user_id
       OR NEW.auth_session_id IS DISTINCT FROM OLD.auth_session_id
       OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
       OR NEW.state_hash IS DISTINCT FROM OLD.state_hash
       OR NEW.code_verifier IS DISTINCT FROM OLD.code_verifier
       OR NEW.nonce IS DISTINCT FROM OLD.nonce
       OR NEW.authorization_intent IS DISTINCT FROM OLD.authorization_intent
       OR NEW.scope_version IS DISTINCT FROM OLD.scope_version
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'tenant_email_google_oauth_transactions: transaction authority is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.consumed_at IS NOT NULL
       OR NEW.consumed_at IS NULL
       OR NEW.consumed_at < OLD.issued_at
       OR NEW.consumed_at > OLD.expires_at THEN
      RAISE EXCEPTION 'tenant_email_google_oauth_transactions: only one valid consume transition is permitted'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Revalidate at issuance and again at consume. The row locks keep endpoint and
  -- location authority stable until the transaction performing this write ends.
  SELECT TRUE INTO eligible_endpoint
  FROM tenant_channel_endpoints e
  JOIN tenant_locations l
    ON l.client_id = NEW.client_id
   AND l.id = NEW.location_id
   AND l.location_id = e.location_id
  WHERE e.client_id = NEW.client_id
    AND e.id = NEW.endpoint_id
    AND e.provider IS NOT DISTINCT FROM 'gmail_api'
    AND e.auth_mode IS NOT DISTINCT FROM 'delegated_authorization_code'
    AND e.connector_mode IS NOT DISTINCT FROM 'google_delegated_oauth'
    AND e.binding_status IN ('unverified_offline', 'pending_manual_validation')
    AND e.provider_tenant_id IS NULL
    AND e.provider_principal_oid IS NULL
    AND e.provider_resource_id IS NULL
    AND e.mailbox_kind IS NULL
    AND e.mailbox_access_kind IS NULL
  FOR KEY SHARE OF e, l;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_email_google_oauth_transactions: endpoint is not eligible for client and location'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_email_google_oauth_transactions_require_endpoint
  BEFORE INSERT OR UPDATE ON tenant_email_google_oauth_transactions
  FOR EACH ROW
  EXECUTE FUNCTION tenant_email_google_oauth_transactions_require_endpoint();

COMMENT ON TABLE tenant_email_google_oauth_transactions IS
  'Isolated single-use Google delegated OAuth starts. State is SHA-256 only; verifier and nonce remain server-confined.';

CREATE INDEX tenant_email_google_oauth_transactions_cleanup_idx
  ON tenant_email_google_oauth_transactions (expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX tenant_email_google_oauth_transactions_owner_idx
  ON tenant_email_google_oauth_transactions (client_id, auth_session_id, endpoint_id);

COMMIT;
