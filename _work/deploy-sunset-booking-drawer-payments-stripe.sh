#!/bin/bash
set -euo pipefail
cd /opt/wolfhouse/WH
SHA=$(git rev-parse --short HEAD)
TAG="${SHA}-sunset-booking-drawer-payments-stripe"
echo "BUILD_TAG=${TAG}"
az acr build --registry whstagingacr \
  --file Dockerfile.luna-sunset-staff-api \
  --image "luna-sunset-staff-api:${TAG}" .
az containerapp update -g luna-sunset-staging-rg -n luna-sunset-staging-staff-api \
  --image "whstagingacr.azurecr.io/luna-sunset-staff-api:${TAG}" \
  --set-env-vars \
    STAFF_ACTIONS_ENABLED=true \
    STRIPE_LINKS_ENABLED=true \
    STRIPE_CHECKOUT_SUCCESS_URL='https://sunset-staging.lunafrontdesk.com/staff/login?checkout=success&session_id={CHECKOUT_SESSION_ID}' \
    STRIPE_CHECKOUT_CANCEL_URL='https://sunset-staging.lunafrontdesk.com/staff/login?checkout=cancel'
echo "DEPLOYED=${TAG}"
