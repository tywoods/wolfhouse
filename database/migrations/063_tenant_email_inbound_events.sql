-- 063_tenant_email_inbound_events.sql
-- Inbound email event store: durable atomic idempotent persistence of already-
-- canonical inbound envelopes. Empty on migrate (no backfill/seed).
--
-- Authority columns match delegated-read DTO + OAuth transaction pattern:
--   location_id UUID = tenant_locations.id (NOT the text kebab location_id on
--   tenant_channel_endpoints / UNIQUE(client_id, location_id TEXT)).
-- Composite FKs reuse existing parent uniques from 059/060:
--   tenant_locations (client_id, id)
--   tenant_channel_endpoints (client_id, id)
--
-- Canonical identity (DB-enforced unique): (provider, provider_mailbox_id,
-- provider_message_id). internet_message_id is metadata only — nullable,
-- never part of identity/dedup. No UPDATE path; insert-or-no-op only.
--
-- No bodies, previews, recipients, headers, attachments, tokens, or raw
-- provider payloads. No routes/activation/poller in this migration.
--
-- Rollback: 063_tenant_email_inbound_events_down.sql

BEGIN;

CREATE TABLE tenant_email_inbound_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               UUID NOT NULL,
  location_id             UUID NOT NULL,
  endpoint_id             UUID NOT NULL,

  provider                TEXT NOT NULL,
  provider_mailbox_id     TEXT NOT NULL,
  provider_message_id     TEXT NOT NULL,

  received_at             TIMESTAMPTZ NOT NULL,
  subject                 TEXT NULL,
  sender_display_name     TEXT NULL,
  sender_address          TEXT NULL,
  is_read                 BOOLEAN NOT NULL,
  conversation_id         TEXT NULL,
  internet_message_id     TEXT NULL,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT tenant_email_inbound_events_location_fk
    FOREIGN KEY (client_id, location_id)
    REFERENCES tenant_locations (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT tenant_email_inbound_events_endpoint_fk
    FOREIGN KEY (client_id, endpoint_id)
    REFERENCES tenant_channel_endpoints (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT tenant_email_inbound_events_provider_values
    CHECK (provider IN ('microsoft_graph', 'gmail_api', 'imap_smtp')),

  CONSTRAINT tenant_email_inbound_events_mailbox_shape
    CHECK (
      provider_mailbox_id = btrim(provider_mailbox_id)
      AND char_length(provider_mailbox_id) BETWEEN 1 AND 2048
    ),

  CONSTRAINT tenant_email_inbound_events_message_shape
    CHECK (
      provider_message_id = btrim(provider_message_id)
      AND char_length(provider_message_id) BETWEEN 1 AND 2048
    ),

  -- Optional strings: length bounds only (contract does not force trim equality).
  CONSTRAINT tenant_email_inbound_events_subject_shape
    CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 2048),

  CONSTRAINT tenant_email_inbound_events_sender_display_shape
    CHECK (
      sender_display_name IS NULL
      OR char_length(sender_display_name) BETWEEN 1 AND 2048
    ),

  CONSTRAINT tenant_email_inbound_events_sender_address_shape
    CHECK (
      sender_address IS NULL
      OR char_length(sender_address) BETWEEN 1 AND 2048
    ),

  CONSTRAINT tenant_email_inbound_events_conversation_shape
    CHECK (
      conversation_id IS NULL
      OR char_length(conversation_id) BETWEEN 1 AND 2048
    ),

  CONSTRAINT tenant_email_inbound_events_internet_message_shape
    CHECK (
      internet_message_id IS NULL
      OR char_length(internet_message_id) BETWEEN 1 AND 2048
    ),

  -- DB-enforced unique canonical identity (internet_message_id excluded).
  CONSTRAINT tenant_email_inbound_events_identity_uq
    UNIQUE (provider, provider_mailbox_id, provider_message_id)
);

COMMENT ON TABLE tenant_email_inbound_events IS
  'Durable canonical inbound email envelopes. Empty on migrate. Identity=(provider,provider_mailbox_id,provider_message_id); internet_message_id metadata only. location_id is tenant_locations.id UUID (authority DTO), not text kebab location_id.';

COMMENT ON COLUMN tenant_email_inbound_events.location_id IS
  'tenant_locations.id UUID (matches delegated-read authority locationId / OAuth transactions). NOT tenant_channel_endpoints.location_id text.';

COMMENT ON COLUMN tenant_email_inbound_events.internet_message_id IS
  'RFC Message-ID metadata only. Never part of unique identity; null and duplicates across distinct identities allowed.';

COMMENT ON COLUMN tenant_email_inbound_events.provider_message_id IS
  'Provider durable message id (Microsoft: ImmutableId-required before persistence). Part of unique identity.';

COMMENT ON CONSTRAINT tenant_email_inbound_events_identity_uq ON tenant_email_inbound_events IS
  'Canonical inbound identity. Concurrent insert race → one row; losers ON CONFLICT DO NOTHING. internet_message_id excluded.';

CREATE INDEX idx_tenant_email_inbound_events_client_endpoint_received
  ON tenant_email_inbound_events (client_id, endpoint_id, received_at DESC);

COMMIT;
