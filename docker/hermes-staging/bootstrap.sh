#!/bin/sh
# Staging bootstrap: write Hermes config + WhatsApp Cloud env on every startup.
set -eu
HERMES_HOME="${HERMES_HOME:-/opt/data}"

# Write config.yaml
cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: gpt-4o-mini
  provider: openai-api
  api_mode: chat_completions
agent:
  reasoning_effort: none
EOF

# Write .env from Container App environment variables (injected at runtime)
# This runs on every startup so the .env stays current with KV secret rotations
{
  # OpenAI
  [ -n "${OPENAI_API_KEY:-}" ]                         && printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY"
  # WhatsApp Cloud
  [ -n "${WHATSAPP_CLOUD_ACCESS_TOKEN:-}" ]             && printf 'WHATSAPP_CLOUD_ACCESS_TOKEN=%s\n' "$WHATSAPP_CLOUD_ACCESS_TOKEN"
  [ -n "${WHATSAPP_CLOUD_PHONE_NUMBER_ID:-}" ]          && printf 'WHATSAPP_CLOUD_PHONE_NUMBER_ID=%s\n' "$WHATSAPP_CLOUD_PHONE_NUMBER_ID"
  [ -n "${WHATSAPP_CLOUD_APP_SECRET:-}" ]               && printf 'WHATSAPP_CLOUD_APP_SECRET=%s\n' "$WHATSAPP_CLOUD_APP_SECRET"
  [ -n "${WHATSAPP_CLOUD_VERIFY_TOKEN:-}" ]             && printf 'WHATSAPP_CLOUD_VERIFY_TOKEN=%s\n' "$WHATSAPP_CLOUD_VERIFY_TOKEN"
  # Allowlist + port (webhook shares gateway port 8642)
  printf 'WHATSAPP_CLOUD_ALLOW_ALL_USERS=true\n'
  printf 'WHATSAPP_CLOUD_WEBHOOK_PORT=8642\n'
  printf 'GATEWAY_ALLOW_ALL_USERS=true\n'
  # Wolfhouse Staff API base URL for Luna tool calls
  [ -n "${WOLFHOUSE_STAFF_API_BASE_URL:-}" ]            && printf 'WOLFHOUSE_STAFF_API_BASE_URL=%s\n' "$WOLFHOUSE_STAFF_API_BASE_URL"
  # Luna bot token for Staff API bot endpoints
  [ -n "${LUNA_BOT_INTERNAL_TOKEN:-}" ]                 && printf 'LUNA_BOT_INTERNAL_TOKEN=%s\n' "$LUNA_BOT_INTERNAL_TOKEN"
} > "$HERMES_HOME/.env"

chown hermes:hermes "$HERMES_HOME/config.yaml" "$HERMES_HOME/.env" 2>/dev/null || true
chmod 640 "$HERMES_HOME/config.yaml" 2>/dev/null || true
chmod 600 "$HERMES_HOME/.env" 2>/dev/null || true
