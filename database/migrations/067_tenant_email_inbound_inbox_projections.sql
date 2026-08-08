-- 067_tenant_email_inbound_inbox_projections.sql
-- Exactly-once projection journal: durable tenant_email_inbound_events →
-- conversations/messages Inbox rows (channel=email, location preserved).
-- Empty on migrate (no backfill/seed). No routes/runtime/worker/send/Luna.
--
-- Identity matches inbound event store (063): (provider, provider_mailbox_id,
-- provider_message_id). One projection row per inbound identity. Replay returns
-- the journaled conversation_id/message_id with zero conversation/message mutation.
--
-- Authority columns match 063: location_id = tenant_locations.id UUID.
-- Tenant-consistent composite FKs:
--   (client_id, inbound_event_id) → tenant_email_inbound_events(client_id, id)
--   (client_id, conversation_id)  → conversations(client_id, id)
--   (client_id, conversation_id, message_id) → messages(client_id, conversation_id, id)
-- Supporting parent uniques are created here when missing.
--
-- Deletion/retention:
--   Journal rows CASCADE when the projected conversation or message is deleted
--   (compatible with messages.conversation_id ON DELETE CASCADE cleanup).
--   inbound_event remains RESTRICT (refuse silent loss of the source event while
--   a projection row still points at it). Explicit purge = delete conversation
--   (cascades messages + journal) or delete journal rows first.
--
-- Customer / phone-namespace isolation:
--   Email-channel conversation identity keys use the opaque prefix emailv1:
--   (never raw sender email in conversations.phone). The customers sync trigger
--   skips phone values matching ^(emailv1|email): so email projections never
--   create/update customers.phone or merge with WhatsApp telephone customers.
--
-- No bodies, tokens, raw provider payloads, or free-form JSON.
-- Rollback: 067_tenant_email_inbound_inbox_projections_down.sql (fail-closed
-- when any projection rows exist).

BEGIN;

-- Supporting parent uniques for tenant-consistent composite FKs.
ALTER TABLE tenant_email_inbound_events
  ADD CONSTRAINT tenant_email_inbound_events_client_id_id_uq
  UNIQUE (client_id, id);

ALTER TABLE conversations
  ADD CONSTRAINT conversations_client_id_id_uq
  UNIQUE (client_id, id);

ALTER TABLE messages
  ADD CONSTRAINT messages_client_id_id_uq
  UNIQUE (client_id, id);

ALTER TABLE messages
  ADD CONSTRAINT messages_client_id_conversation_id_id_uq
  UNIQUE (client_id, conversation_id, id);

-- Email-channel identity keys must never enter customers.phone / WhatsApp merge.
-- Preserves E.164 telephone customer sync for real phone conversations.
CREATE OR REPLACE FUNCTION sync_customer_from_touch() RETURNS trigger AS $$
DECLARE
  v_phone text;
  v_name  text;
  v_email text;
  v_loc   text;
  v_cid   uuid;
BEGIN
  v_phone := NULLIF(TRIM(COALESCE(NEW.phone, '')), '');
  IF v_phone IS NULL THEN
    RETURN NEW;
  END IF;

  -- Opaque email-channel conversation keys (emailv1:… / legacy email:…) are not
  -- telephone identities. Skip customer upsert entirely.
  IF v_phone ~ '^(emailv1|email):' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'conversations' THEN
    v_name  := NULLIF(TRIM(COALESCE(NEW.display_name, '')), '');
    v_email := NULLIF(TRIM(COALESCE(NEW.email, '')), '');
    v_loc   := NULL;
  ELSE -- bookings
    v_name  := NULLIF(TRIM(COALESCE(NEW.guest_name, '')), '');
    v_email := NULLIF(TRIM(COALESCE(NEW.email, '')), '');
    v_loc   := NULLIF(TRIM(COALESCE(NEW.metadata->>'location_id', '')), '');
  END IF;

  INSERT INTO customers (client_id, phone, full_name, email, location_id, first_seen, last_seen)
  VALUES (NEW.client_id, v_phone, v_name, v_email, v_loc, NOW(), NOW())
  ON CONFLICT (client_id, phone) DO UPDATE SET
    full_name   = COALESCE(EXCLUDED.full_name, customers.full_name),
    email       = COALESCE(EXCLUDED.email, customers.email),
    location_id = COALESCE(EXCLUDED.location_id, customers.location_id),
    last_seen   = NOW(),
    updated_at  = NOW()
  RETURNING id INTO v_cid;

  NEW.customer_id := v_cid;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE tenant_email_inbound_inbox_projections (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               UUID NOT NULL,
  location_id             UUID NOT NULL,
  endpoint_id             UUID NOT NULL,

  inbound_event_id        UUID NOT NULL,

  provider                TEXT NOT NULL,
  provider_mailbox_id     TEXT NOT NULL,
  provider_message_id     TEXT NOT NULL,

  conversation_id         UUID NOT NULL,
  message_id              UUID NOT NULL,

  projected_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT tenant_email_inbound_inbox_projections_location_fk
    FOREIGN KEY (client_id, location_id)
    REFERENCES tenant_locations (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT tenant_email_inbound_inbox_projections_endpoint_fk
    FOREIGN KEY (client_id, endpoint_id)
    REFERENCES tenant_channel_endpoints (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  -- Tenant-consistent event ownership (not id-only).
  CONSTRAINT tenant_email_inbound_inbox_projections_event_fk
    FOREIGN KEY (client_id, inbound_event_id)
    REFERENCES tenant_email_inbound_events (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  -- Tenant-consistent conversation ownership.
  CONSTRAINT tenant_email_inbound_inbox_projections_conversation_fk
    FOREIGN KEY (client_id, conversation_id)
    REFERENCES conversations (client_id, id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  -- Message belongs to the journaled conversation under the same tenant.
  CONSTRAINT tenant_email_inbound_inbox_projections_message_ownership_fk
    FOREIGN KEY (client_id, conversation_id, message_id)
    REFERENCES messages (client_id, conversation_id, id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT tenant_email_inbound_inbox_projections_provider_values
    CHECK (provider IN ('microsoft_graph', 'gmail_api', 'imap_smtp')),

  CONSTRAINT tenant_email_inbound_inbox_projections_mailbox_shape
    CHECK (char_length(provider_mailbox_id) BETWEEN 1 AND 2048),

  CONSTRAINT tenant_email_inbound_inbox_projections_message_shape
    CHECK (char_length(provider_message_id) BETWEEN 1 AND 2048),

  -- Canonical inbound identity — exactly-once projection target.
  CONSTRAINT tenant_email_inbound_inbox_projections_identity_uq
    UNIQUE (provider, provider_mailbox_id, provider_message_id),

  -- One projection row per durable inbound event.
  CONSTRAINT tenant_email_inbound_inbox_projections_event_uq
    UNIQUE (inbound_event_id),

  -- One projection row per Inbox message (no double-link).
  CONSTRAINT tenant_email_inbound_inbox_projections_message_uq
    UNIQUE (message_id)
);

COMMENT ON TABLE tenant_email_inbound_inbox_projections IS
  'Exactly-once journal projecting tenant_email_inbound_events into conversations/messages (channel=email). Empty on migrate. Identity=(provider,provider_mailbox_id,provider_message_id). Tenant-consistent composite FKs. Conversation/message delete CASCADE journal; event delete RESTRICT. location_id is tenant_locations.id UUID.';

COMMENT ON COLUMN tenant_email_inbound_inbox_projections.location_id IS
  'tenant_locations.id UUID (authority DTO). Conversation metadata stores the text kebab location_id resolved at project time.';

COMMENT ON COLUMN tenant_email_inbound_inbox_projections.conversation_id IS
  'Inbox conversations.id created or reused for opaque email-channel identity (emailv1:<location>:<sha256>) under UNIQUE(client_id, phone).';

COMMENT ON COLUMN tenant_email_inbound_inbox_projections.message_id IS
  'Inbox messages.id for this inbound email identity. Unique so one event → one message. Ownership enforced via (client_id, conversation_id, message_id).';

CREATE INDEX idx_tenant_email_inbound_inbox_projections_client_endpoint_projected
  ON tenant_email_inbound_inbox_projections (client_id, endpoint_id, projected_at DESC);

CREATE INDEX idx_tenant_email_inbound_inbox_projections_conversation
  ON tenant_email_inbound_inbox_projections (conversation_id, projected_at DESC);

COMMIT;
