#!/bin/sh
set -eu
: "${CROWSNEST_ADMIN_DSN:?set CROWSNEST_ADMIN_DSN}"
command -v psql >/dev/null || { echo 'psql is required' >&2; exit 2; }
psql "$CROWSNEST_ADMIN_DSN" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE executor oid := (SELECT oid FROM pg_roles WHERE rolname=current_user);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='crowsnest_comms_owner') THEN
    CREATE ROLE crowsnest_comms_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='crowsnest_api') THEN
    CREATE ROLE crowsnest_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('crowsnest_comms_owner','crowsnest_api')
             AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'crowsnest role attributes are unsafe';
  END IF;
  EXECUTE format('GRANT crowsnest_comms_owner TO %I WITH ADMIN OPTION', current_user);
  EXECUTE format('GRANT crowsnest_api TO %I WITH ADMIN OPTION', current_user);
  GRANT crowsnest_api TO crowsnest_comms_owner WITH ADMIN OPTION;
  IF NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid='crowsnest_comms_owner'::regrole AND member=executor AND admin_option)
     OR NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid='crowsnest_api'::regrole AND member=executor AND admin_option) THEN
    RAISE EXCEPTION 'admin-option bootstrap verification failed';
  END IF;
END $$;
SQL
