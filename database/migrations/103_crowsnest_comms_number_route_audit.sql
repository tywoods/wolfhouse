BEGIN;
CREATE SCHEMA IF NOT EXISTS crowsnest_comms;
CREATE TABLE IF NOT EXISTS crowsnest_comms.number_route_events (
  event_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  event_type text NOT NULL CHECK (event_type IN ('requested','precondition','applied','readback','rollback')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_account_id text NOT NULL CHECK (actor_account_id IN ('earthling','monshies')),
  actor_username text NOT NULL,
  action text NOT NULL CHECK (action IN ('flip_to_sunset','rollback_to_wolfhouse')),
  expected_revision text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (operation_id, sequence_no)
);
CREATE INDEX IF NOT EXISTS number_route_events_operation_idx
  ON crowsnest_comms.number_route_events(operation_id, sequence_no);
REVOKE UPDATE, DELETE, TRUNCATE ON crowsnest_comms.number_route_events FROM PUBLIC;
COMMIT;
