-- 125_luna_v3_prepare_attempts.sql
-- Exactly one terminal prepare lifecycle per authenticated session + inbound event.
BEGIN;
CREATE TABLE luna_v3_prepare_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES luna_v3_sessions(id) ON DELETE CASCADE,
  inbound_event_id uuid NOT NULL REFERENCES luna_v3_runtime_events(id) ON DELETE CASCADE,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started','applied','rejected','unknown')),
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(client_id,session_id,inbound_event_id),
  CHECK ((outcome='started' AND receipt IS NULL AND completed_at IS NULL)
      OR (outcome<>'started' AND receipt IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX luna_v3_prepare_attempts_session_created_idx
  ON luna_v3_prepare_attempts(client_id,session_id,created_at DESC);
COMMIT;
