BEGIN;

-- This migration intentionally requires an executor with CREATEROLE (or superuser).
-- Runtime LOGIN membership is provisioned separately; migration owners are never granted API access.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolcreaterole)) THEN
    RAISE EXCEPTION 'migration prerequisite: executor must have CREATEROLE to provision crowsnest roles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crowsnest_comms_owner') THEN
    CREATE ROLE crowsnest_comms_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crowsnest_api') THEN
    CREATE ROLE crowsnest_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('crowsnest_comms_owner','crowsnest_api') AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'crowsnest role attributes are unsafe';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS crowsnest_comms AUTHORIZATION crowsnest_comms_owner;
ALTER SCHEMA crowsnest_comms OWNER TO crowsnest_comms_owner;

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
ALTER TABLE crowsnest_comms.number_route_operations OWNER TO crowsnest_comms_owner;
ALTER TABLE crowsnest_comms.number_route_events OWNER TO crowsnest_comms_owner;
CREATE INDEX IF NOT EXISTS number_route_events_operation_idx ON crowsnest_comms.number_route_events(operation_id, sequence_no);

CREATE OR REPLACE FUNCTION crowsnest_comms.reject_number_route_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'number_route_events is append-only'; END; $$;
ALTER FUNCTION crowsnest_comms.reject_number_route_event_mutation() OWNER TO crowsnest_comms_owner;
DROP TRIGGER IF EXISTS number_route_events_append_only ON crowsnest_comms.number_route_events;
CREATE TRIGGER number_route_events_append_only BEFORE UPDATE OR DELETE ON crowsnest_comms.number_route_events
FOR EACH ROW EXECUTE FUNCTION crowsnest_comms.reject_number_route_event_mutation();

REVOKE ALL ON SCHEMA crowsnest_comms FROM PUBLIC;
REVOKE ALL ON crowsnest_comms.number_route_events, crowsnest_comms.number_route_operations FROM PUBLIC;
REVOKE ALL ON FUNCTION crowsnest_comms.reject_number_route_event_mutation() FROM PUBLIC;
GRANT USAGE ON SCHEMA crowsnest_comms TO crowsnest_api;
GRANT SELECT, INSERT ON crowsnest_comms.number_route_events TO crowsnest_api;
GRANT SELECT, INSERT, UPDATE (state, response, updated_at) ON crowsnest_comms.number_route_operations TO crowsnest_api;
COMMIT;
