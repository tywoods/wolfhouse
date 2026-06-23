#!/bin/bash
set -euo pipefail
ROOT=/opt/wolfhouse/WH
RG=luna-sunset-staging-rg
APP=luna-sunset-staging-staff-api
PHASE=${1:-preflight}

cd "$ROOT"
python3 "$ROOT/_work/gen-sunset-admin-023-container.py" >/dev/null
GEN="$ROOT/_work/sunset-admin-023-container-generated.js"
B64=$(base64 -w0 "$GEN")
REPLICA=$(az containerapp replica list -g "$RG" -n "$APP" --query "[0].name" -o tsv)
echo "=== container exec phase: $PHASE replica=$REPLICA (script bytes $(wc -c < "$GEN")) ==="
script -q -c "az containerapp exec -g \"$RG\" -n \"$APP\" --replica \"$REPLICA\" --command \"sh -c 'echo $B64 | base64 -d > /tmp/sunset-admin-023.js && cd /app && node /tmp/sunset-admin-023.js $PHASE'\"" /dev/null
