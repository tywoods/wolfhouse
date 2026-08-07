-- 064_tenant_email_inbound_delta_states.sql
-- Microsoft Graph messages-delta durable state + sealed cursor custody.
-- Empty on migrate (no backfill/seed). Offline prerequisite only.
--
-- State identity binds trusted client/location/endpoint + provider
-- microsoft_graph + provider_tenant_id UUID + authoritative mailbox UUID.
-- ingestion_generation is independent of OAuth grant_generation.
-- query_version is an exact text query-shape identifier (not BIGINT):
--   advances/changes on rebind or messages-delta query contract change.
-- phase: initial | tracking | reset_required | paused.
-- state_version is monotonic CAS fencing.
-- Lease owner/token/until use DB clock_timestamp() only (separate from grant lease).
--
-- Graph nextLink/deltaLink are confidential provider capabilities: never plaintext
-- in DB. Sealed cursor envelope (v1 AES-256-GCM + wrapped DEK + version-pinned KEK)
-- is all-null OR all-present; cursor_kind pairs with envelope.
--
-- Current-generation invariant: partial unique (client_id, endpoint_id)
-- WHERE is_current — at-most-one current row per endpoint. Owner operations
-- demote-then-insert so one current remains (never leave zero current except
-- that there is no public delete API). Old generations remain for audit.
-- Composite FKs match 063 authority: tenant_locations / tenant_channel_endpoints.
--
-- Generations/state_version are bounded to JS Number.MAX_SAFE_INTEGER so app
-- fencing never relies on bigint-beyond-safe-integer precision.
--
-- No routes/activation/poller/network in this migration.
-- Rollback: 064_tenant_email_inbound_delta_states_down.sql

BEGIN;

CREATE TABLE tenant_email_inbound_delta_states (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                  UUID NOT NULL,
  location_id                UUID NOT NULL,
  endpoint_id                UUID NOT NULL,

  provider                   TEXT NOT NULL,
  provider_tenant_id         TEXT NOT NULL,
  provider_mailbox_id        TEXT NOT NULL,

  ingestion_generation       BIGINT NOT NULL,
  query_version              TEXT NOT NULL,
  is_current                 BOOLEAN NOT NULL DEFAULT true,

  phase                      TEXT NOT NULL,
  state_version              BIGINT NOT NULL,

  lease_owner                TEXT NULL,
  lease_token                UUID NULL,
  lease_until                TIMESTAMPTZ NULL,

  cursor_kind                TEXT NULL,
  envelope_version           TEXT NULL,
  aead_alg                   TEXT NULL,
  kek_wrap_alg               TEXT NULL,
  kek_key_name               TEXT NULL,
  kek_key_version            TEXT NULL,
  nonce                      BYTEA NULL,
  ciphertext                 BYTEA NULL,
  auth_tag                   BYTEA NULL,
  wrapped_dek                BYTEA NULL,
  cursor_operation_id        UUID NULL,

  reset_reason               TEXT NULL,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT tenant_email_inbound_delta_states_location_fk
    FOREIGN KEY (client_id, location_id)
    REFERENCES tenant_locations (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT tenant_email_inbound_delta_states_endpoint_fk
    FOREIGN KEY (client_id, endpoint_id)
    REFERENCES tenant_channel_endpoints (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT tenant_email_inbound_delta_states_provider_values
    CHECK (provider = 'microsoft_graph'),

  CONSTRAINT tenant_email_inbound_delta_states_tenant_shape
    CHECK (
      provider_tenant_id = btrim(provider_tenant_id)
      AND provider_tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),

  CONSTRAINT tenant_email_inbound_delta_states_mailbox_shape
    CHECK (
      provider_mailbox_id = btrim(provider_mailbox_id)
      AND provider_mailbox_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),

  -- JS Number.MAX_SAFE_INTEGER (9007199254740991) upper bound — no bigint fencing risk.
  CONSTRAINT tenant_email_inbound_delta_states_generation_bounds
    CHECK (
      ingestion_generation >= 1
      AND ingestion_generation <= 9007199254740991
    ),

  CONSTRAINT tenant_email_inbound_delta_states_query_version_shape
    CHECK (
      query_version = btrim(query_version)
      AND char_length(query_version) BETWEEN 1 AND 64
      AND query_version ~ '^[a-z][a-z0-9_]*$'
    ),

  CONSTRAINT tenant_email_inbound_delta_states_state_version_bounds
    CHECK (
      state_version >= 1
      AND state_version <= 9007199254740991
    ),

  CONSTRAINT tenant_email_inbound_delta_states_phase_values
    CHECK (phase IN ('initial', 'tracking', 'reset_required', 'paused')),

  CONSTRAINT tenant_email_inbound_delta_states_generation_uq
    UNIQUE (client_id, endpoint_id, ingestion_generation),

  CONSTRAINT tenant_email_inbound_delta_states_lease_coherence
    CHECK (
      (
        lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_until IS NULL
      )
      OR (
        lease_owner IS NOT NULL
        AND lease_token IS NOT NULL
        AND lease_until IS NOT NULL
      )
    ),

  CONSTRAINT tenant_email_inbound_delta_states_lease_owner_shape
    CHECK (
      lease_owner IS NULL
      OR (
        lease_owner = btrim(lease_owner)
        AND char_length(lease_owner) BETWEEN 1 AND 128
        AND lease_owner !~ '[[:space:]]'
      )
    ),

  -- Sealed cursor: all-null OR all-present (cursor_kind + full envelope v1).
  CONSTRAINT tenant_email_inbound_delta_states_cursor_coherence
    CHECK (
      (
        cursor_kind IS NULL
        AND envelope_version IS NULL
        AND aead_alg IS NULL
        AND kek_wrap_alg IS NULL
        AND kek_key_name IS NULL
        AND kek_key_version IS NULL
        AND nonce IS NULL
        AND ciphertext IS NULL
        AND auth_tag IS NULL
        AND wrapped_dek IS NULL
        AND cursor_operation_id IS NULL
      )
      OR (
        cursor_kind IN ('nextLink', 'deltaLink')
        AND envelope_version = 'v1'
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
        AND cursor_operation_id IS NOT NULL
      )
    ),

  CONSTRAINT tenant_email_inbound_delta_states_reset_reason_shape
    CHECK (
      reset_reason IS NULL
      OR (
        reset_reason = btrim(reset_reason)
        AND char_length(reset_reason) BETWEEN 1 AND 128
        AND reset_reason ~ '^[a-z][a-z0-9_]*$'
      )
    ),

  -- reset_required requires a reason; other phases clear it.
  CONSTRAINT tenant_email_inbound_delta_states_reset_reason_coupling
    CHECK (
      (
        phase = 'reset_required'
        AND reset_reason IS NOT NULL
      )
      OR (
        phase <> 'reset_required'
        AND reset_reason IS NULL
      )
    )
);

COMMENT ON TABLE tenant_email_inbound_delta_states IS
  'Durable Microsoft Graph messages-delta state per endpoint generation. Empty on migrate. Sealed nextLink/deltaLink only (never plaintext). ingestion_generation independent of OAuth grant_generation. query_version is exact text query-shape id. Partial unique is_current = at-most-one current; owner ops never leave zero current (no delete API).';

COMMENT ON COLUMN tenant_email_inbound_delta_states.location_id IS
  'tenant_locations.id UUID (authority DTO), not text kebab location_id.';

COMMENT ON COLUMN tenant_email_inbound_delta_states.ingestion_generation IS
  'Independent of tenant_email_delegated_grants.grant_generation. Grant refresh/rotation must not advance this. Bounded to JS MAX_SAFE_INTEGER.';

COMMENT ON COLUMN tenant_email_inbound_delta_states.query_version IS
  'Exact text identifier of the messages-delta query contract (e.g. messages_delta_v1). Not a BIGINT counter. Exact string match for fencing.';

COMMENT ON COLUMN tenant_email_inbound_delta_states.ciphertext IS
  'AEAD ciphertext of sealed Graph cursor capability only. Never a plaintext nextLink/deltaLink.';

COMMENT ON COLUMN tenant_email_inbound_delta_states.is_current IS
  'At-most-one true row per (client_id, endpoint_id) via partial unique. Owner demote+insert preserves exactly one current. Old generations remain for audit. No public delete API.';

-- At-most-one current generation per endpoint (ambiguous-current prevention).
CREATE UNIQUE INDEX tenant_email_inbound_delta_states_current_uq
  ON tenant_email_inbound_delta_states (client_id, endpoint_id)
  WHERE is_current = true;

CREATE INDEX idx_tenant_email_inbound_delta_states_lease_until
  ON tenant_email_inbound_delta_states (lease_until)
  WHERE lease_token IS NOT NULL;

CREATE INDEX idx_tenant_email_inbound_delta_states_client_phase
  ON tenant_email_inbound_delta_states (client_id, phase)
  WHERE is_current = true;

CREATE TRIGGER tenant_email_inbound_delta_states_updated_at
  BEFORE UPDATE ON tenant_email_inbound_delta_states
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
