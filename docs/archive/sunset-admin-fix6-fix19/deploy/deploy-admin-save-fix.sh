#!/bin/bash
cd /opt/wolfhouse/WH
SHA=$(git rev-parse --short HEAD)
TAG="${SHA}-sunset-admin-save-fix"
echo "BUILD_TAG=${TAG}"
az acr build --registry whstagingacr \
  --file Dockerfile.luna-sunset-staff-api \
  --image "luna-sunset-staff-api:${TAG}" .
az containerapp update -g luna-sunset-staging-rg -n luna-sunset-staging-staff-api \
  --image "whstagingacr.azurecr.io/luna-sunset-staff-api:${TAG}"
echo "DEPLOYED=${TAG}"
