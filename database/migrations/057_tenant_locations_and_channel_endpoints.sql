-- 057_tenant_locations_and_channel_endpoints.sql
-- Luna email Slice 1B: canonical tenant/location registry + provider-neutral
-- email channel endpoints (EMPTY tables — no backfill, no invented IDs/addresses).
--
-- Why this migration exists:
--   Slice 1A shipped application validation only. There was no authoritative
--   tenant–location parent for a composite FK, so endpoint persistence was deferred.
--   Slice 1B owns Postgres persistence for:
--     * tenant_locations       — platform location identity owned by a client
--     * tenant_channel_endpoints — email endpoints bound to (client_id, location_id)
--
-- Intentionally empty on apply:
--   No INSERT/UPDATE/DELETE product DML. Real mappings and mailboxes are supplied
--   later by an operator-controlled registration step (not this migration).
--
-- Safety defaults (endpoints):
--   inbound_enabled=false, outbound_enabled=false, default_automation_mode='off',
--   active=false. Insert alone never enables receive/send.
--
-- active vs inbound/outbound:
--   active = registry activation (eligible for routing uniqueness). Separate from
--   inbound_enabled / outbound_enabled capability toggles.
--
-- Credentials:
--   secret_ref stores opaque secret-manager references only (kv: | secret-ref:).
--   Never store secret values in product rows.
--
-- Rollback: 057_tenant_locations_and_channel_endpoints_down.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- tenant_locations — canonical parent for composite FK
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_locations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL
                  REFERENCES clients (id)
                  ON DELETE RESTRICT
                  ON UPDATE CASCADE,
  location_id     TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES staff_users (id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES staff_users (id) ON DELETE SET NULL,
  CONSTRAINT tenant_locations_location_id_canonical
    CHECK (location_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT tenant_locations_display_name_nonempty
    CHECK (char_length(btrim(display_name)) > 0),
  CONSTRAINT tenant_locations_client_location_uq
    UNIQUE (client_id, location_id),
  CONSTRAINT tenant_locations_location_id_global_uq
    UNIQUE (location_id)
);

COMMENT ON TABLE tenant_locations IS
  'Slice 1B: authoritative tenant–location registry. Empty on migrate; operator registration supplies rows. Composite UNIQUE(client_id, location_id) is the parent for tenant_channel_endpoints; location_id is also platform-global unique.';

COMMENT ON COLUMN tenant_locations.location_id IS
  'Canonical lowercase kebab location token (no whitespace). Platform-global unique identity.';

COMMENT ON COLUMN tenant_locations.active IS
  'Location registry active flag. Independent of email endpoint inbound/outbound/active.';

CREATE INDEX IF NOT EXISTS idx_tenant_locations_client_active
  ON tenant_locations (client_id, active);

CREATE TRIGGER tenant_locations_updated_at
  BEFORE UPDATE ON tenant_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- tenant_channel_endpoints — provider-neutral email endpoints
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_channel_endpoints (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                UUID NOT NULL,
  location_id              TEXT NOT NULL,
  channel                  TEXT NOT NULL DEFAULT 'email'
                           CHECK (channel = 'email'),
  provider                 TEXT NOT NULL
                           CHECK (provider IN ('microsoft_graph', 'gmail_api', 'imap_smtp')),
  public_address           TEXT NOT NULL,
  secret_ref               TEXT NOT NULL,
  provider_resource_id     TEXT NULL,
  capabilities             JSONB NOT NULL,
  inbound_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  outbound_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  default_automation_mode  TEXT NOT NULL DEFAULT 'off'
                           CHECK (default_automation_mode IN ('automatic', 'draft_only', 'off')),
  active                   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID REFERENCES staff_users (id) ON DELETE SET NULL,
  updated_by               UUID REFERENCES staff_users (id) ON DELETE SET NULL,

  CONSTRAINT tenant_channel_endpoints_location_fk
    FOREIGN KEY (client_id, location_id)
    REFERENCES tenant_locations (client_id, location_id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  -- Already-normalized lowercase email-like address; reject uppercase/untrimmed.
  CONSTRAINT tenant_channel_endpoints_public_address_shape
    CHECK (
      public_address = lower(public_address)
      AND public_address = btrim(public_address)
      AND char_length(public_address) BETWEEN 3 AND 320
      AND public_address ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    ),

  -- Opaque secret-manager ref only. Exact lowercase schemes; bounded body;
  -- reject whitespace and obvious DB-detectable raw secret shapes.
  CONSTRAINT tenant_channel_endpoints_secret_ref_shape
    CHECK (
      secret_ref ~ '^(kv|secret-ref):[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$'
      AND secret_ref !~ '[[:space:]]'
      AND substring(secret_ref from '^(?:kv|secret-ref):(.*)$') !~ '^sk-'
      AND substring(secret_ref from '^(?:kv|secret-ref):(.*)$') !~* '^password[-_]'
      AND substring(secret_ref from '^(?:kv|secret-ref):(.*)$') !~* '^bearer[._-]'
      AND substring(secret_ref from '^(?:kv|secret-ref):(.*)$') !~ '^ya29\.'
      AND substring(secret_ref from '^(?:kv|secret-ref):(.*)$') !~ 'eyJ[A-Za-z0-9_-]{10,}\.'
      AND substring(secret_ref from '^(?:kv|secret-ref):(.*)$') !~* 'client_secret='
      AND substring(secret_ref from '^(?:kv|secret-ref):(.*)$') !~* 'api[_-]?key='
      AND substring(secret_ref from '^(?:kv|secret-ref):(.*)$') !~* 'password='
    ),

  -- Exact eight boolean capability keys; no extras; no subqueries (PG CHECK rule).
  -- Presence via ?&; no-extras via key subtraction to '{}'; per-key jsonb_typeof.
  -- (Equivalent to jsonb_object_length=8 + ?&; subtraction avoids engines missing jsonb_object_length.)
  CONSTRAINT tenant_channel_endpoints_capabilities_shape
    CHECK (
      jsonb_typeof(capabilities) = 'object'
      AND capabilities ?& ARRAY[
        'push_notifications',
        'provider_threads',
        'remote_drafts',
        'reply',
        'reply_all',
        'forward',
        'attachments_metadata',
        'delivery_events'
      ]
      AND (
        capabilities
          - 'push_notifications'
          - 'provider_threads'
          - 'remote_drafts'
          - 'reply'
          - 'reply_all'
          - 'forward'
          - 'attachments_metadata'
          - 'delivery_events'
      ) = '{}'::jsonb
      AND jsonb_typeof(capabilities -> 'push_notifications') = 'boolean'
      AND jsonb_typeof(capabilities -> 'provider_threads') = 'boolean'
      AND jsonb_typeof(capabilities -> 'remote_drafts') = 'boolean'
      AND jsonb_typeof(capabilities -> 'reply') = 'boolean'
      AND jsonb_typeof(capabilities -> 'reply_all') = 'boolean'
      AND jsonb_typeof(capabilities -> 'forward') = 'boolean'
      AND jsonb_typeof(capabilities -> 'attachments_metadata') = 'boolean'
      AND jsonb_typeof(capabilities -> 'delivery_events') = 'boolean'
    )
);

COMMENT ON TABLE tenant_channel_endpoints IS
  'Slice 1B: provider-neutral email channel endpoints. Empty on migrate. Composite FK to tenant_locations guarantees client+location consistency. Defaults disable inbound/outbound/automation/registry active. secret_ref is opaque only — never secret values.';

COMMENT ON COLUMN tenant_channel_endpoints.active IS
  'Registry activation (routing uniqueness). Separate from inbound_enabled/outbound_enabled.';

COMMENT ON COLUMN tenant_channel_endpoints.secret_ref IS
  'Opaque secret-manager reference (kv:… or secret-ref:…). Never a password, token, or API key.';

COMMENT ON COLUMN tenant_channel_endpoints.public_address IS
  'Normalized lowercase public mailbox address. No default; uppercase/untrimmed rejected by CHECK.';

COMMENT ON COLUMN tenant_channel_endpoints.capabilities IS
  'Exactly the eight Slice 1A boolean capability keys; JSON booleans only; no extra keys.';

-- Active normalized public address is globally unique (registry activation).
CREATE UNIQUE INDEX IF NOT EXISTS tenant_channel_endpoints_active_public_address_uidx
  ON tenant_channel_endpoints (lower(public_address))
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_tenant_channel_endpoints_client_location
  ON tenant_channel_endpoints (client_id, location_id);

CREATE INDEX IF NOT EXISTS idx_tenant_channel_endpoints_client_active
  ON tenant_channel_endpoints (client_id, active);

CREATE TRIGGER tenant_channel_endpoints_updated_at
  BEFORE UPDATE ON tenant_channel_endpoints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
