#!/usr/bin/env bash
set -euo pipefail

if [ -d /run/s6/container_environment ]; then
  for env_file in /run/s6/container_environment/*; do
    [ -f "$env_file" ] || continue
    name="${env_file##*/}"
    value="$(cat "$env_file")"
    export "$name=$value"
  done
fi

HERMES_HOME="${HERMES_HOME:-/opt/data}"
python /etc/hermes-luna-v3/bootstrap.py
install -d -m 0700 "$HERMES_HOME/plugins/luna_v3_staff_api" "$HERMES_HOME/sessions"
install -m 0600 /etc/hermes-luna-v3/SOUL.md "$HERMES_HOME/SOUL.md"
install -m 0600 /etc/hermes-luna-v3/plugins/luna_v3_staff_api/__init__.py "$HERMES_HOME/plugins/luna_v3_staff_api/__init__.py"

cat > "$HERMES_HOME/config.yaml" <<'YAML'
model:
  default: gpt-5.5
  provider: openai-codex
agent:
  reasoning_effort: low
compression:
  codex_gpt55_autoraise: false
toolsets:
  - luna_v3_staff_api
platform_toolsets:
  api_server:
    - luna_v3_staff_api
plugins:
  enabled:
    - luna-v3-staff-api
memory:
  memory_enabled: false
  user_profile_enabled: false
curator:
  enabled: false
gateway:
  platforms:
    api_server:
      enabled: true
YAML
chmod 0600 "$HERMES_HOME/config.yaml"

# Never persist or synthesize messaging credentials in the clone home.
for forbidden in WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_CLOUD_APP_SECRET WHATSAPP_CLOUD_VERIFY_TOKEN WHATSAPP_CLOUD_PHONE_NUMBER_ID META_ACCESS_TOKEN SMTP_PASSWORD; do
  if printenv "$forbidden" >/dev/null 2>&1 && [ -n "$(printenv "$forbidden")" ]; then
    echo "refusing Luna v3 startup: forbidden transport credential $forbidden is present" >&2
    exit 1
  fi
done
