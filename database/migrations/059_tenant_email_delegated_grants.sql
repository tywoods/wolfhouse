-- 059_tenant_email_delegated_grants.sql
-- Slice 2F-A: dedicated delegated refresh-grant custody. Owner-approved AES-256-GCM
-- envelope (ciphertext + wrapped DEK + version-pinned KEK). Raw refresh tokens are
-- FORBIDDEN in PostgreSQL. Not on tenant_channel_endpoints. No OAuth/Graph/activation.
-- Atomic unit: grant_generation + envelope in ONE PG transaction. Lease expiry uses
-- DB clock_timestamp() only. Down: 059_tenant_email_delegated_grants_down.sql
-- (destructive of sealed grants; operational reauth after use).

BEGIN;

-- Parent uniqueness for tenant-safe composite FK (id already globally unique).
ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_client_id_id_uq
  UNIQUE (client_id, id);

CREATE TABLE tenant_email_delegated_grants (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                  UUID NOT NULL,
  endpoint_id                UUID NOT NULL,

  grant_generation           BIGINT NOT NULL,
  grant_status               TEXT NOT NULL,

  grant_lease_owner          TEXT NULL,
  grant_lease_token          UUID NULL,
  grant_lease_until          TIMESTAMPTZ NULL,

  last_operation_id          UUID NOT NULL,

  reconcile_state            TEXT NOT NULL DEFAULT 'clean',
  reconcile_detail_code      TEXT NULL,

  envelope_version           TEXT NOT NULL,
  aead_alg                   TEXT NOT NULL,
  kek_wrap_alg               TEXT NOT NULL,
  kek_key_name               TEXT NOT NULL,
  kek_key_version            TEXT NOT NULL,
  nonce                      BYTEA NOT NULL,
  ciphertext                 BYTEA NOT NULL,
  auth_tag                   BYTEA NOT NULL,
  wrapped_dek                BYTEA NOT NULL,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                 UUID NULL REFERENCES staff_users (id) ON DELETE SET NULL,
  updated_by                 UUID NULL REFERENCES staff_users (id) ON DELETE SET NULL,

  CONSTRAINT tenant_email_delegated_grants_endpoint_fk
    FOREIGN KEY (client_id, endpoint_id)
    REFERENCES tenant_channel_endpoints (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT tenant_email_delegated_grants_endpoint_uq
    UNIQUE (endpoint_id),

  CONSTRAINT tenant_email_delegated_grants_client_endpoint_uq
    UNIQUE (client_id, endpoint_id),

  CONSTRAINT tenant_email_delegated_grants_generation_min
    CHECK (grant_generation >= 1),

  CONSTRAINT tenant_email_delegated_grants_status_values
    CHECK (grant_status IN (
      'active', 'lease_held', 'reauthorization_required', 'revoked'
    )),

  CONSTRAINT tenant_email_delegated_grants_lease_coherence
    CHECK (
      (
        grant_lease_owner IS NULL
        AND grant_lease_token IS NULL
        AND grant_lease_until IS NULL
      )
      OR (
        grant_lease_owner IS NOT NULL
        AND grant_lease_token IS NOT NULL
        AND grant_lease_until IS NOT NULL
        AND grant_status = 'lease_held'
      )
    ),

  CONSTRAINT tenant_email_delegated_grants_lease_held_requires_lease
    CHECK (
      grant_status <> 'lease_held'
      OR (
        grant_lease_token IS NOT NULL
        AND grant_lease_until IS NOT NULL
        AND grant_lease_owner IS NOT NULL
      )
    ),

  CONSTRAINT tenant_email_delegated_grants_terminal_clears_lease
    CHECK (
      grant_status NOT IN ('reauthorization_required', 'revoked')
      OR (
        grant_lease_owner IS NULL
        AND grant_lease_token IS NULL
        AND grant_lease_until IS NULL
      )
    ),

  CONSTRAINT tenant_email_delegated_grants_lease_owner_shape
    CHECK (
      grant_lease_owner IS NULL
      OR (
        grant_lease_owner = btrim(grant_lease_owner)
        AND char_length(grant_lease_owner) BETWEEN 1 AND 128
        AND grant_lease_owner !~ '[[:space:]]'
      )
    ),

  CONSTRAINT tenant_email_delegated_grants_envelope_v1
    CHECK (
      envelope_version = 'v1'
      AND aead_alg = 'AES-256-GCM'
      AND kek_wrap_alg IN ('RSA-OAEP-256', 'A256KW')
      AND kek_key_name = btrim(kek_key_name)
      AND char_length(kek_key_name) BETWEEN 1 AND 200
      AND kek_key_name !~ '[[:space:]]'
      AND kek_key_version = btrim(kek_key_version)
      AND char_length(kek_key_version) BETWEEN 1 AND 200
      AND kek_key_version !~ '[[:space:]]'
      AND lower(kek_key_version) NOT IN ('latest', 'current')
      AND octet_length(nonce) = 12
      AND octet_length(auth_tag) = 16
      AND octet_length(ciphertext) BETWEEN 1 AND 65536
      AND octet_length(wrapped_dek) BETWEEN 16 AND 2048
    ),

  CONSTRAINT tenant_email_delegated_grants_reconcile_state
    CHECK (reconcile_state IN (
      'clean', 'ms_response_uncertain', 'rewrap_pending', 'needs_operator'
    )),

  -- Coupling: clean => detail NULL; non-clean => bounded detail required.
  CONSTRAINT tenant_email_delegated_grants_reconcile_detail_coupling
    CHECK (
      (
        reconcile_state = 'clean'
        AND reconcile_detail_code IS NULL
      )
      OR (
        reconcile_state <> 'clean'
        AND reconcile_detail_code IS NOT NULL
        AND reconcile_detail_code = btrim(reconcile_detail_code)
        AND char_length(reconcile_detail_code) BETWEEN 1 AND 64
        AND reconcile_detail_code ~ '^[a-z][a-z0-9_]*$'
      )
    )
);

COMMENT ON TABLE tenant_email_delegated_grants IS
  'Slice 2F-A: one delegated MS refresh-grant custody row per endpoint. Owner-approved envelope (AES-256-GCM + wrapped DEK + version-pinned KEK). Raw refresh tokens forbidden. Empty on migrate.';

COMMENT ON COLUMN tenant_email_delegated_grants.ciphertext IS
  'AEAD ciphertext only (no tag). Not a raw token. Open via injected envelope provider with AAD from trusted columns.';

COMMENT ON COLUMN tenant_email_delegated_grants.kek_key_version IS
  'Exact Key Vault wrapping-key version pin. Never latest/current/unversioned.';

CREATE INDEX idx_tenant_email_delegated_grants_lease_until
  ON tenant_email_delegated_grants (grant_lease_until)
  WHERE grant_lease_token IS NOT NULL;

CREATE INDEX idx_tenant_email_delegated_grants_client_status
  ON tenant_email_delegated_grants (client_id, grant_status);

CREATE TRIGGER tenant_email_delegated_grants_updated_at
  BEFORE UPDATE ON tenant_email_delegated_grants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- DB-enforced endpoint mode guard: only microsoft_graph + delegated OAuth.
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

CREATE TRIGGER tenant_email_delegated_grants_mode_guard
  BEFORE INSERT OR UPDATE OF client_id, endpoint_id
  ON tenant_email_delegated_grants
  FOR EACH ROW
  EXECUTE FUNCTION tenant_email_delegated_grants_require_delegated_endpoint();

-- Reject endpoint mode pairing changes under an existing grant.
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

CREATE TRIGGER tenant_channel_endpoints_protect_delegated_grant_mode
  BEFORE UPDATE OF provider, auth_mode, connector_mode, client_id
  ON tenant_channel_endpoints
  FOR EACH ROW
  EXECUTE FUNCTION tenant_channel_endpoints_protect_delegated_grant_mode();

COMMIT;
