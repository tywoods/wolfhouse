#!/bin/bash
set -euo pipefail
cd /opt/wolfhouse/WH
SHA=$(git rev-parse --short HEAD)
TAG="${SHA}-admin-portal-fix8-$(date +%Y%m%d%H%M%S)"
echo "BUILD_TAG=${TAG}"
az acr build --registry whstagingacr \
  --file Dockerfile.luna-sunset-staff-api \
  --image "luna-sunset-staff-api:${TAG}" . \
  --build-arg BUILDKIT_INLINE_CACHE=1
az containerapp update -g luna-sunset-staging-rg -n luna-sunset-staging-staff-api \
  --image "whstagingacr.azurecr.io/luna-sunset-staff-api:${TAG}" \
  -o none
echo "DEPLOYED=${TAG}"
