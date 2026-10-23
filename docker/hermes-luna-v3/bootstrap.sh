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
install -m 0600 /etc/hermes-luna-v3/plugins/luna_v3_staff_api/plugin.yaml "$HERMES_HOME/plugins/luna_v3_staff_api/plugin.yaml"

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

# Resolve the generated config through Hermes' authentic environment override
# path, then fail closed unless API server is the only enabled platform.
python /etc/hermes-luna-v3/bootstrap.py --validate-platforms

# Never persist or synthesize messaging credentials in the clone home.
for forbidden in TELEGRAM_BOT_TOKEN WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_CLOUD_APP_SECRET WHATSAPP_CLOUD_VERIFY_TOKEN WHATSAPP_CLOUD_PHONE_NUMBER_ID META_ACCESS_TOKEN SMTP_PASSWORD EMAIL_ADDRESS EMAIL_PASSWORD EMAIL_IMAP_HOST EMAIL_SMTP_HOST; do
  if printenv "$forbidden" >/dev/null 2>&1 && [ -n "$(printenv "$forbidden")" ]; then
    echo "refusing Luna v3 startup: forbidden transport credential $forbidden is present" >&2
    exit 1
  fi
done

case "${WHATSAPP_ENABLED:-}" in
  true|TRUE|True|1|yes|YES|Yes)
    echo "refusing Luna v3 startup: forbidden transport activation WHATSAPP_ENABLED is present" >&2
    exit 1
    ;;
esac
