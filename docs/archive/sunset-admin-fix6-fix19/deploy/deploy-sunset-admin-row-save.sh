#!/bin/bash
set -euo pipefail
cd /opt/wolfhouse/WH
test -z "$(git status --porcelain -- scripts/staff-query-api.js scripts/lib/tenant-admin-writes.js scripts/lib/sunset-admin-location-store.js | grep -v '^??')" || { echo "dirty tree"; git status --short; exit 1; }
SHA=$(git rev-parse --short HEAD)
TAG="${SHA}-sunset-admin-row-save"
echo "BUILD_TAG=${TAG}"
az acr build --registry whstagingacr \
  --file Dockerfile.luna-sunset-staff-api \
  --image "luna-sunset-staff-api:${TAG}" .
az containerapp update -g luna-sunset-staging-rg -n luna-sunset-staging-staff-api \
  --image "whstagingacr.azurecr.io/luna-sunset-staff-api:${TAG}" \
  -o none
echo "DEPLOYED=${TAG}"
echo "WOLFHOUSE_UNTOUCHED=wh-staging-staff-api not updated"
