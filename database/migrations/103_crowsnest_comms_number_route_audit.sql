BEGIN;
CREATE SCHEMA IF NOT EXISTS crowsnest_comms;

CREATE TABLE IF NOT EXISTS crowsnest_comms.number_route_operations (
  operation_id uuid PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('flip_to_sunset','rollback_to_wolfhouse')),
  expected_revision text NOT NULL CHECK (expected_revision ~ '^[0-9a-fA-F]{64}$'),
  actor_account_id text NOT NULL CHECK (actor_account_id IN ('earthling','monshies')),
  actor_username text NOT NULL,
  state text NOT NULL CHECK (state IN ('requested','succeeded','rejected','indeterminate')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS crowsnest_comms.number_route_events (
  event_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES crowsnest_comms.number_route_operations(operation_id),
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
CREATE INDEX IF NOT EXISTS number_route_events_operation_idx ON crowsnest_comms.number_route_events(operation_id, sequence_no);

CREATE OR REPLACE FUNCTION crowsnest_comms.reject_number_route_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'number_route_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS number_route_events_append_only ON crowsnest_comms.number_route_events;
CREATE TRIGGER number_route_events_append_only BEFORE UPDATE OR DELETE ON crowsnest_comms.number_route_events
FOR EACH ROW EXECUTE FUNCTION crowsnest_comms.reject_number_route_event_mutation();

DO $$
DECLARE
  runtime_login name := COALESCE(NULLIF(current_setting('crowsnest.runtime_login', true), ''), current_user);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crowsnest_api') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolcreaterole)) THEN
      RAISE EXCEPTION 'migration prerequisite: executor must have CREATEROLE to provision NOLOGIN role crowsnest_api';
    END IF;
    EXECUTE 'CREATE ROLE crowsnest_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_login) THEN
    RAISE EXCEPTION 'configured crowsnest.runtime_login role % does not exist', runtime_login;
  END IF;
  EXECUTE format('GRANT crowsnest_api TO %I', runtime_login);
END $$;
REVOKE ALL ON SCHEMA crowsnest_comms FROM PUBLIC;
REVOKE ALL ON crowsnest_comms.number_route_events, crowsnest_comms.number_route_operations FROM PUBLIC;
GRANT USAGE ON SCHEMA crowsnest_comms TO crowsnest_api;
GRANT SELECT, INSERT ON crowsnest_comms.number_route_events TO crowsnest_api;
GRANT SELECT, INSERT, UPDATE (state, response, updated_at) ON crowsnest_comms.number_route_operations TO crowsnest_api;
COMMIT;
