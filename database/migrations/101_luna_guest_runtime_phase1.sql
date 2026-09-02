-- 101_luna_guest_runtime_phase1.sql
-- Generic Luna Guest Runtime Phase 1 durability. No provider sender and no autonomy toggle.
BEGIN;

CREATE TABLE luna_guest_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL CHECK (tenant_id = 'sunset'),
  location_key TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('http_probe','whatsapp','email','staff_draft')),
  thread_key TEXT NOT NULL,
  external_conversation_id TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  gate_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_inbound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, location_key, channel, thread_key)
);

CREATE TABLE luna_guest_inbound_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL CHECK (tenant_id = 'sunset'),
  conversation_id UUID NOT NULL REFERENCES luna_guest_conversations(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  request_payload_hash TEXT NOT NULL CHECK (request_payload_hash ~ '^[0-9a-f]{64}$'),
  channel TEXT NOT NULL,
  body JSONB NOT NULL,
  gate_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  status TEXT NOT NULL CHECK (status IN ('queued','processed','failed')),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, request_id)
);

CREATE TABLE luna_guest_work_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL CHECK (tenant_id = 'sunset'),
  inbound_event_id UUID NOT NULL UNIQUE REFERENCES luna_guest_inbound_events(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('queued','claimed','completed','failed')),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE luna_guest_reply_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL CHECK (tenant_id = 'sunset'),
  conversation_id UUID NOT NULL REFERENCES luna_guest_conversations(id) ON DELETE RESTRICT,
  inbound_event_id UUID NOT NULL REFERENCES luna_guest_inbound_events(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  intended_reply JSONB NOT NULL,
  gate_snapshot JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','blocked','cancelled')),
  send_enabled BOOLEAN NOT NULL DEFAULT FALSE CHECK (send_enabled = FALSE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (inbound_event_id)
);

CREATE INDEX idx_luna_guest_work_queue_status ON luna_guest_work_queue (tenant_id, status, created_at);
CREATE INDEX idx_luna_guest_outbox_status ON luna_guest_reply_outbox (tenant_id, status, created_at);

CREATE TRIGGER luna_guest_conversations_updated_at BEFORE UPDATE ON luna_guest_conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER luna_guest_inbound_events_updated_at BEFORE UPDATE ON luna_guest_inbound_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER luna_guest_work_queue_updated_at BEFORE UPDATE ON luna_guest_work_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER luna_guest_reply_outbox_updated_at BEFORE UPDATE ON luna_guest_reply_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE luna_guest_reply_outbox IS
  'Phase 1 intended replies only. send_enabled is schema-pinned false; no provider sender exists.';
COMMIT;
