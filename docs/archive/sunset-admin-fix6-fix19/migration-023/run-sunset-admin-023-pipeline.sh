#!/bin/bash
set -euo pipefail
ROOT=/opt/wolfhouse/WH
RG=luna-sunset-staging-rg
PG=luna-sunset-staging-pg-app
FW_RULE=lunabox-operator-023-$(date +%Y%m%d)
LUNABOX_IP=$(curl -s ifconfig.me)

cd "$ROOT"
git checkout feature/sunset-school-admin-config
git pull origin feature/sunset-school-admin-config
test "$(git rev-parse HEAD)" = "72ab63994b217c50fb63428a24edc38d02520e0a"

echo "=== PREFLIGHT verifiers ==="
npm run verify:sunset-portal-v1
node scripts/verify-tenant-business-config.js

echo "=== POSTGRES FIREWALL $LUNABOX_IP ==="
az postgres flexible-server firewall-rule create \
  -g "$RG" -s "$PG" -n "$FW_RULE" \
  --start-ip-address "$LUNABOX_IP" --end-ip-address "$LUNABOX_IP" -o none

cleanup() {
  az postgres flexible-server firewall-rule delete -g "$RG" -s "$PG" -n "$FW_RULE" -y -o none 2>/dev/null || true
}
trap cleanup EXIT

export WOLFHOUSE_DATABASE_URL
WOLFHOUSE_DATABASE_URL=$(az keyvault secret show \
  --vault-name luna-sunset-staging-kv \
  --name sunset-database-url \
  --query value -o tsv)

MIG="$ROOT/database/migrations/023_sunset_admin_location_id_PROPOSED.sql"
for phase in preflight migrate seed verify; do
  echo "=== DB $phase ==="
  node "$ROOT/_work/sunset-admin-023-host.js" "$phase" "$MIG"
done

echo "=== DEPLOY ==="
bash "$ROOT/_work/deploy-sunset-admin-school-config.sh"

echo "=== POST-DEPLOY verifiers ==="
npm run verify:sunset-portal-v1
node scripts/verify-tenant-business-config.js

echo "=== ADMIN QA probe ==="
export SUNSET_STAGING_PORTAL_PASSWORD
SUNSET_STAGING_PORTAL_PASSWORD=$(az keyvault secret show \
  --vault-name luna-sunset-staging-kv \
  --name sunset-staging-portal-password \
  --query value -o tsv 2>/dev/null || true)
if [ -z "${SUNSET_STAGING_PORTAL_PASSWORD:-}" ] && [ -f /opt/wolfhouse/.sunset-staging-portal-password ]; then
  SUNSET_STAGING_PORTAL_PASSWORD=$(cat /opt/wolfhouse/.sunset-staging-portal-password)
fi
node "$ROOT/_work/probe-sunset-admin-school-isolation-qa.js"

echo "=== CHECK 022 UNAPPLIED ==="
node -e "
const {Client}=require('pg');
const url=process.env.WOLFHOUSE_DATABASE_URL;
const c=new Client({connectionString:url,ssl:{rejectUnauthorized:false}});
c.connect().then(async()=>{
  const r=await c.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='bookings' AND column_name='location_id'\");
  console.log(JSON.stringify({migration_022_location_id_column: r.rows.length>0}));
  await c.end();
}).catch(e=>{console.error(e.message);process.exit(1);});
"

echo "=== DONE ==="
