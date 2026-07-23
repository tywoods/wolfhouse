#!/bin/sh
set -eu

HERMES_HOME="${HERMES_HOME:-/opt/data}"
HERMES_ROLE="${HERMES_ROLE:-}"
LUNA_TENANT_ID="${LUNA_TENANT_ID:-}"
[ "$HERMES_ROLE" = "sunset-luna" ] || { echo 'Sunset bootstrap requires HERMES_ROLE=sunset-luna' >&2; exit 1; }
[ "$LUNA_TENANT_ID" = "sunset" ] || { echo 'Sunset bootstrap requires LUNA_TENANT_ID=sunset' >&2; exit 1; }
[ -n "${SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID:-}" ] || { echo 'missing Somo phone_number_id' >&2; exit 1; }
[ -n "${SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID:-}" ] || { echo 'missing Sardinero phone_number_id' >&2; exit 1; }
[ "$SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID" != "$SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID" ] || { echo 'phone_number_id mappings must be unique' >&2; exit 1; }

mkdir -p "$HERMES_HOME/sessions"
cp /etc/hermes-sunset/SOUL.md "$HERMES_HOME/SOUL.md"
cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: gpt-5.5
  provider: openai-codex
agent:
  reasoning_effort: none
memory:
  memory_enabled: false
  user_profile_enabled: false
curator:
  enabled: false
gateway:
  platforms:
    whatsapp_cloud:
      gateway_restart_notification: false
EOF
{
  printf 'LUNA_TENANT_ID=sunset\nLUNA_CLIENT_SLUG=sunset\n'
  printf 'WHATSAPP_CLOUD_WEBHOOK_PORT=8092\nWHATSAPP_CLOUD_WEBHOOK_PATH=/whatsapp/webhook\n'
  printf 'SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID=%s\n' "$SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID"
  printf 'SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID=%s\n' "$SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID"
  # Crowsnest AI-usage identity (B1): forward only when set; never invent values.
  [ -n "${CROWSNEST_AI_USAGE_CLIENT_SLUG:-}" ] && printf 'CROWSNEST_AI_USAGE_CLIENT_SLUG=%s\n' "$CROWSNEST_AI_USAGE_CLIENT_SLUG"
  [ -n "${CROWSNEST_AI_USAGE_TENANT_ID:-}" ] && printf 'CROWSNEST_AI_USAGE_TENANT_ID=%s\n' "$CROWSNEST_AI_USAGE_TENANT_ID"
} > "$HERMES_HOME/.env"
chmod 600 "$HERMES_HOME/.env"
