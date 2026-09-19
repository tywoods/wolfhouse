#!/bin/sh
set -eu
: "${CROWSNEST_ADMIN_DSN:?set CROWSNEST_ADMIN_DSN}"
: "${CROWSNEST_RUNTIME_ROLE:?set CROWSNEST_RUNTIME_ROLE}"
case "$CROWSNEST_RUNTIME_ROLE" in *[!A-Za-z0-9_]*) echo 'unsafe runtime role' >&2; exit 2;; esac
[ "$CROWSNEST_RUNTIME_ROLE" != crowsnest_api ] && [ "$CROWSNEST_RUNTIME_ROLE" != crowsnest_comms_owner ] || { echo 'runtime role must be distinct' >&2; exit 2; }
command -v psql >/dev/null || { echo 'psql is required' >&2; exit 2; }
psql "$CROWSNEST_ADMIN_DSN" -v ON_ERROR_STOP=1 -v runtime_role="$CROWSNEST_RUNTIME_ROLE" <<'SQL'
SELECT set_config('crowsnest.provision_runtime_role', :'runtime_role', false);
DO $$
DECLARE r name := current_setting('crowsnest.provision_runtime_role'); attrs record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication INTO attrs FROM pg_roles WHERE rolname=r;
  IF NOT FOUND THEN RAISE EXCEPTION 'runtime LOGIN % does not exist', r; END IF;
  IF NOT attrs.rolcanlogin OR attrs.rolsuper OR attrs.rolcreatedb OR attrs.rolcreaterole OR attrs.rolreplication THEN RAISE EXCEPTION 'runtime role attributes are unsafe'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE o.rolname=r)
     OR EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles o ON o.oid=n.nspowner WHERE o.rolname=r) THEN RAISE EXCEPTION 'runtime role directly owns database objects'; END IF;
  EXECUTE format('GRANT crowsnest_api TO %I', r);
END $$;
SQL
