-- Deckhand Lunabot lane: durable supervisor event inbox/outbox.
-- Kill switch is env SUPERVISOR_EVENTS_ENABLED (off unless literal 1).
-- Does not resend from confirmation_possibly_owed; that kind is a wake hint only.

BEGIN;

CREATE TABLE IF NOT EXISTS supervisor_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID,
  conversation_id UUID,
  booking_id UUID,
  booking_code TEXT,
  kind TEXT NOT NULL,
  reason TEXT,
  obligation TEXT NOT NULL CHECK (obligation IN ('silence', 'confirmation', 'handoff')),
  source_key TEXT NOT NULL,
  cause_incident_id UUID,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  last_error TEXT,
  dispatch_worker_id TEXT,
  dispatch_lease_until TIMESTAMPTZ,
  acked_at TIMESTAMPTZ,
  outcome TEXT,
  outcome_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT supervisor_events_source_key_key UNIQUE (source_key)
);

CREATE INDEX IF NOT EXISTS supervisor_events_dispatch_idx
  ON supervisor_events (delivery_status, next_retry_at, created_at)
  WHERE delivery_status IN ('pending', 'dispatched');

CREATE TABLE IF NOT EXISTS supervisor_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  event_id UUID REFERENCES supervisor_events(id),
  obligation TEXT,
  after_message_id TEXT,
  lease_token TEXT NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL,
  staff_user_id UUID,
  pause_permit_transition_id UUID,
  status TEXT NOT NULL DEFAULT 'open',
  closed_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS supervisor_incidents_open_conv_idx
  ON supervisor_incidents (conversation_id)
  WHERE status = 'open';

CREATE UNIQUE INDEX IF NOT EXISTS supervisor_incidents_one_open_conv
  ON supervisor_incidents (conversation_id)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS supervisor_catchup_checkpoints (
  source_name TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supervisor_lifecycle (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  halted BOOLEAN NOT NULL DEFAULT FALSE,
  expired BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
