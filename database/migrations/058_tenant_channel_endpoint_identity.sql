-- 058_tenant_channel_endpoint_identity.sql
-- Luna email Slice 2D: additive connector + mailbox binding identity on
-- tenant_channel_endpoints. No OAuth tx/nonce/pkce/code/token columns.
-- No grant_generation/grant_status (deferred to CAS/lease rotation writer).
-- No activation flip. Existing rows + Gmail/IMAP stay all-new-fields NULL.
--
-- Rollback: 058_tenant_channel_endpoint_identity_down.sql

BEGIN;

ALTER TABLE tenant_channel_endpoints
  ADD COLUMN auth_mode TEXT,
  ADD COLUMN connector_mode TEXT,
  ADD COLUMN provider_tenant_id TEXT,
  ADD COLUMN provider_principal_oid TEXT,
  ADD COLUMN mailbox_kind TEXT,
  ADD COLUMN mailbox_access_kind TEXT,
  ADD COLUMN binding_status TEXT;

COMMENT ON COLUMN tenant_channel_endpoints.auth_mode IS
  'Slice 2D: NULL=legacy unclassified; with connector_mode only supported Microsoft pairs.';
COMMENT ON COLUMN tenant_channel_endpoints.connector_mode IS
  'Slice 2D: microsoft_delegated_oauth | microsoft_app_only_enterprise; NULL-coupled with auth_mode.';
COMMENT ON COLUMN tenant_channel_endpoints.provider_tenant_id IS
  'Slice 2D: Entra tenant tid; canonical lowercase hyphenated UUID when present.';
COMMENT ON COLUMN tenant_channel_endpoints.provider_principal_oid IS
  'Slice 2D: Entra user oid for delegated only; NOT mailbox identity; NULL for app-only.';
COMMENT ON COLUMN tenant_channel_endpoints.mailbox_kind IS
  'Slice 2D: mailbox kind; frozen minimal set is user (shared deferred).';
COMMENT ON COLUMN tenant_channel_endpoints.mailbox_access_kind IS
  'Slice 2D: own_user (delegated) | application (app-only).';
COMMENT ON COLUMN tenant_channel_endpoints.binding_status IS
  'Slice 2D: unverified_offline|pending_manual_validation|verified|reauthorization_required|revoked.';

-- 1) auth_mode and connector_mode both NULL or both non-NULL.
ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_auth_connector_nulls
  CHECK ((auth_mode IS NULL) = (connector_mode IS NULL));

-- 2+3) Supported pairs only for microsoft_graph; non-graph forces all seven NULL.
ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_identity_mode_pair
  CHECK (
    (
      provider = 'microsoft_graph'
      AND (
        auth_mode IS NULL
        OR (
          auth_mode = 'delegated_authorization_code'
          AND connector_mode = 'microsoft_delegated_oauth'
        )
        OR (
          auth_mode = 'application_client_credentials'
          AND connector_mode = 'microsoft_app_only_enterprise'
        )
      )
    )
    OR (
      provider <> 'microsoft_graph'
      AND auth_mode IS NULL
      AND connector_mode IS NULL
      AND provider_tenant_id IS NULL
      AND provider_principal_oid IS NULL
      AND mailbox_kind IS NULL
      AND mailbox_access_kind IS NULL
      AND binding_status IS NULL
    )
  );

-- Identity/status fields require modes (no orphan provider-specific halves).
ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_identity_requires_modes
  CHECK (
    auth_mode IS NOT NULL
    OR (
      provider_tenant_id IS NULL
      AND provider_principal_oid IS NULL
      AND mailbox_kind IS NULL
      AND mailbox_access_kind IS NULL
      AND binding_status IS NULL
    )
  );

-- 4) binding_status allowlist.
ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_binding_status_values
  CHECK (
    binding_status IS NULL
    OR binding_status IN (
      'unverified_offline',
      'pending_manual_validation',
      'verified',
      'reauthorization_required',
      'revoked'
    )
  );

-- 5) Canonical lowercase UUID grammar for tid/oid when present.
ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_provider_tenant_id_shape
  CHECK (
    provider_tenant_id IS NULL
    OR (
      provider_tenant_id = btrim(provider_tenant_id)
      AND provider_tenant_id = lower(provider_tenant_id)
      AND provider_tenant_id
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
  );

ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_provider_principal_oid_shape
  CHECK (
    provider_principal_oid IS NULL
    OR (
      provider_principal_oid = btrim(provider_principal_oid)
      AND provider_principal_oid = lower(provider_principal_oid)
      AND provider_principal_oid
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
  );

-- Non-null provider_resource_id: exact-trimmed nonempty in every status
-- (including unverified/pending/revoked). Rejects '' / whitespace / untrimmed.
ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_provider_resource_id_shape
  CHECK (
    provider_resource_id IS NULL
    OR (
      provider_resource_id = btrim(provider_resource_id)
      AND char_length(provider_resource_id) > 0
    )
  );

-- Mailbox kind/access allowlists + trimmed nonempty when set.
ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_mailbox_kind_values
  CHECK (
    mailbox_kind IS NULL
    OR (
      mailbox_kind = btrim(mailbox_kind)
      AND char_length(mailbox_kind) > 0
      AND mailbox_kind = 'user'
    )
  );

ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_mailbox_access_kind_values
  CHECK (
    mailbox_access_kind IS NULL
    OR (
      mailbox_access_kind = btrim(mailbox_access_kind)
      AND char_length(mailbox_access_kind) > 0
      AND mailbox_access_kind IN ('own_user', 'application')
    )
  );

-- 7) Mode-coherent partial states (no impossible access/principal mixes).
ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_mode_field_coherence
  CHECK (
    (
      auth_mode IS DISTINCT FROM 'delegated_authorization_code'
      OR (
        (mailbox_kind IS NULL OR mailbox_kind = 'user')
        AND (mailbox_access_kind IS NULL OR mailbox_access_kind = 'own_user')
      )
    )
    AND (
      auth_mode IS DISTINCT FROM 'application_client_credentials'
      OR (
        provider_principal_oid IS NULL
        AND (mailbox_kind IS NULL OR mailbox_kind = 'user')
        AND (mailbox_access_kind IS NULL OR mailbox_access_kind = 'application')
      )
    )
  );

-- 6) verified | reauthorization_required requires complete ownership identity.
ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_verified_ownership_complete
  CHECK (
    binding_status IS NULL
    OR binding_status NOT IN ('verified', 'reauthorization_required')
    OR (
      provider = 'microsoft_graph'
      AND auth_mode IS NOT NULL
      AND connector_mode IS NOT NULL
      AND provider_tenant_id IS NOT NULL
      AND provider_resource_id IS NOT NULL
      AND mailbox_kind = 'user'
      AND (
        (
          auth_mode = 'delegated_authorization_code'
          AND connector_mode = 'microsoft_delegated_oauth'
          AND provider_principal_oid IS NOT NULL
          AND mailbox_access_kind = 'own_user'
        )
        OR (
          auth_mode = 'application_client_credentials'
          AND connector_mode = 'microsoft_app_only_enterprise'
          AND provider_principal_oid IS NULL
          AND mailbox_access_kind = 'application'
        )
      )
    )
  );

-- 8) Ownership uniqueness: verified + reauthorization_required reserve the
-- (provider, tid, durable mailbox resource). Conflict → SQLSTATE 23505.
-- Same-row reconnect updates in place; cross-client transfer is a future
-- authorized row-lock/update; aliases are not independent identities.
CREATE UNIQUE INDEX tenant_channel_endpoints_verified_mailbox_ownership_uidx
  ON tenant_channel_endpoints (
    provider COLLATE "C",
    provider_tenant_id COLLATE "C",
    provider_resource_id COLLATE "C"
  )
  WHERE binding_status IN ('verified', 'reauthorization_required');

COMMENT ON INDEX tenant_channel_endpoints_verified_mailbox_ownership_uidx IS
  'Slice 2D: one verified/reauth ownership per (provider,tid,resource). 23505 on conflict; reauth reserves; reconnect=same-row update; transfer=future authorized update; aliases not independent.';

COMMIT;
