#!/bin/bash
set -e
cd /opt/wolfhouse/WH
git checkout captain/sunset-admin-empty-sections
python3 /tmp/fix-upsert-price-patch.py
node --check scripts/lib/tenant-admin-writes.js
git add scripts/lib/tenant-admin-writes.js
git commit -m "fix(sunset): map period_window to item_code in cfg price upsert"
SHA=$(git rev-parse --short HEAD)
TAG="${SHA}-sunset-admin-price-upsert"
echo "BUILD_TAG=${TAG}"
az acr build --registry whstagingacr \
  --file Dockerfile.luna-sunset-staff-api \
  --image "luna-sunset-staff-api:${TAG}" .
az containerapp update -g luna-sunset-staging-rg -n luna-sunset-staging-staff-api \
  --image "whstagingacr.azurecr.io/luna-sunset-staff-api:${TAG}"
git push origin captain/sunset-admin-empty-sections
echo "DEPLOYED=${TAG}"
