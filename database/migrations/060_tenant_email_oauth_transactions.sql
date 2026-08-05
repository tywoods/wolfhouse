-- Stage 6: short-lived, server-owned Microsoft OAuth authorization transactions.
-- No tokens, grants, mailbox activation, or provider responses belong in this table.
BEGIN;

ALTER TABLE staff_users
  ADD CONSTRAINT staff_users_client_id_id_uq UNIQUE (client_id, id);
ALTER TABLE auth_sessions
  ADD CONSTRAINT auth_sessions_client_id_id_staff_user_id_uq UNIQUE (client_id, id, staff_user_id);
ALTER TABLE tenant_locations
  ADD CONSTRAINT tenant_locations_client_id_id_uq UNIQUE (client_id, id);

CREATE TABLE tenant_email_oauth_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  location_id UUID NOT NULL,
  staff_user_id UUID NOT NULL,
  auth_session_id UUID NOT NULL,
  state_hash BYTEA NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  CONSTRAINT tenant_email_oauth_transactions_staff_fk
    FOREIGN KEY (client_id, staff_user_id) REFERENCES staff_users (client_id, id) ON DELETE CASCADE,
  CONSTRAINT tenant_email_oauth_transactions_session_fk
    FOREIGN KEY (client_id, auth_session_id, staff_user_id)
    REFERENCES auth_sessions (client_id, id, staff_user_id) ON DELETE CASCADE,
  CONSTRAINT tenant_email_oauth_transactions_location_fk
    FOREIGN KEY (client_id, location_id) REFERENCES tenant_locations (client_id, id) ON DELETE CASCADE,
  CONSTRAINT tenant_email_oauth_transactions_state_hash_shape CHECK (octet_length(state_hash) = 32),
  CONSTRAINT tenant_email_oauth_transactions_verifier_shape CHECK (
    char_length(code_verifier) BETWEEN 43 AND 128 AND code_verifier ~ '^[A-Za-z0-9._~-]+$'
  ),
  CONSTRAINT tenant_email_oauth_transactions_nonce_shape CHECK (
    char_length(nonce) BETWEEN 43 AND 128 AND nonce ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT tenant_email_oauth_transactions_ttl CHECK (
    expires_at > issued_at AND expires_at <= issued_at + interval '600 seconds'
  ),
  CONSTRAINT tenant_email_oauth_transactions_consumed_shape CHECK (
    consumed_at IS NULL OR consumed_at >= issued_at
  )
);

COMMENT ON TABLE tenant_email_oauth_transactions IS
  'Single-use Microsoft delegated OAuth starts. State is SHA-256 only; verifier and nonce remain server-confined. Never stores access/refresh tokens.';
CREATE INDEX tenant_email_oauth_transactions_cleanup_idx
  ON tenant_email_oauth_transactions (expires_at) WHERE consumed_at IS NULL;
CREATE INDEX tenant_email_oauth_transactions_owner_idx
  ON tenant_email_oauth_transactions (client_id, auth_session_id, location_id);

COMMIT;
