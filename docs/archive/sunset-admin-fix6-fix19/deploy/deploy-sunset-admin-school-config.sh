#!/bin/bash
set -euo pipefail
ROOT=/opt/wolfhouse/WH
RG=luna-sunset-staging-rg
APP=luna-sunset-staging-staff-api
SHA=72ab639
TAG="${SHA}-sunset-school-admin-config"

cd "$ROOT"
git checkout feature/sunset-school-admin-config
git pull origin feature/sunset-school-admin-config
test "$(git rev-parse HEAD)" = "72ab63994b217c50fb63428a24edc38d02520e0a"

npm run verify:sunset-portal-v1
node scripts/verify-tenant-business-config.js

echo "=== ACR BUILD $TAG ==="
az acr build --registry whstagingacr \
  --file Dockerfile.luna-sunset-staff-api \
  --image "luna-sunset-staff-api:${TAG}" .

echo "=== DEPLOY $TAG ==="
az containerapp update -g "$RG" -n "$APP" \
  --image "whstagingacr.azurecr.io/luna-sunset-staff-api:${TAG}" \
  --set-env-vars \
  STAFF_ACTIONS_ENABLED=true \
  STRIPE_LINKS_ENABLED=true \
  SUNSET_ADMIN_DB_READ_ENABLED=true \
  SUNSET_ADMIN_WRITES_ENABLED=true \
  SUNSET_ADMIN_JSON_OVERLAY=false \
  STRIPE_CHECKOUT_SUCCESS_URL='https://sunset-staging.lunafrontdesk.com/staff/login?checkout=success&session_id={CHECKOUT_SESSION_ID}' \
  STRIPE_CHECKOUT_CANCEL_URL='https://sunset-staging.lunafrontdesk.com/staff/login?checkout=cancel'

PREV=""
for i in $(seq 1 36); do
  REV=$(az containerapp revision list -g "$RG" -n "$APP" -o json)
  echo "$REV" | python3 -c "
import json,sys
revs=json.load(sys.stdin)
revs.sort(key=lambda r:r['properties'].get('createdTime',''), reverse=True)
top=revs[0]; p=top['properties']
img=p['template']['containers'][0]['image']
print(f\"poll: {top['name']} health={p.get('healthState')} traffic={p.get('trafficWeight')} img={img}\")
if '${TAG}' in img and p.get('healthState')=='Healthy' and p.get('trafficWeight')==100:
  open('/tmp/sunset_deploy_ok','w').write(json.dumps({'revision':top['name'],'image':img,'previous':revs[1]['name'] if len(revs)>1 else None}))
"
  if [ -f /tmp/sunset_deploy_ok ]; then cat /tmp/sunset_deploy_ok; exit 0; fi
  sleep 10
done
echo "DEPLOY TIMEOUT"; exit 1
