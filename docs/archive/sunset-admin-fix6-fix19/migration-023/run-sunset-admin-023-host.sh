#!/bin/bash
set -euo pipefail
ROOT=/opt/wolfhouse/WH
cd "$ROOT"
git checkout feature/sunset-school-admin-config
git pull origin feature/sunset-school-admin-config

export WOLFHOUSE_DATABASE_URL
WOLFHOUSE_DATABASE_URL=$(az keyvault secret show \
  --vault-name luna-sunset-staging-kv \
  --name sunset-database-url \
  --query value -o tsv)

PHASE=${1:-preflight}
node "$ROOT/_work/sunset-admin-023-host.js" "$PHASE" "$ROOT/database/migrations/023_sunset_admin_location_id_PROPOSED.sql"
