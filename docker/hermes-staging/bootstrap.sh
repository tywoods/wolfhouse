#!/bin/sh
# Staging bootstrap: write Hermes config + WhatsApp Cloud env on every startup.
set -eu
HERMES_HOME="${HERMES_HOME:-/opt/data}"
STAGING_SOUL="/etc/hermes-staging/SOUL.md"
STAGING_PLUGINS="/etc/hermes-staging/plugins"
LUNA_SOUL_MARKER="$HERMES_HOME/.luna-guest-soul.version"
LUNA_SOUL_VERSION="19"

# Write config.yaml
cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: gpt-4o-mini
  provider: openai-api
  api_mode: chat_completions
agent:
  reasoning_effort: none
# Luna is a guest-facing booking agent, not a general Hermes operator.
# Only expose the Wolfhouse Staff API plugin tools in WhatsApp sessions.
# This prevents builder/self-improvement tools like skill_manage from leaking
# into real guest conversations and derailing bookings.
toolsets:
  - wolfhouse_staff_api
plugins:
  enabled:
    - wolfhouse-staff-api
curator:
  enabled: false
gateway:
  platforms:
    whatsapp_cloud:
      gateway_restart_notification: false
EOF

# Guest-facing Agent Luna identity (WhatsApp) — not generic Hermes assistant
if [ -f "$STAGING_SOUL" ]; then
  cp "$STAGING_SOUL" "$HERMES_HOME/SOUL.md"
fi

# Staff API tools for Agent Luna — thin wrappers around /staff/bot/* routes.
if [ -d "$STAGING_PLUGINS" ]; then
  mkdir -p "$HERMES_HOME/plugins"
  cp -R "$STAGING_PLUGINS"/* "$HERMES_HOME/plugins/"
fi

# WhatsApp sessions cache the system prompt; refresh when Luna guest SOUL is (re)installed.
if [ "$(cat "$LUNA_SOUL_MARKER" 2>/dev/null)" != "$LUNA_SOUL_VERSION" ]; then
  rm -rf "$HERMES_HOME/sessions" 2>/dev/null || true
  printf '%s\n' "$LUNA_SOUL_VERSION" > "$LUNA_SOUL_MARKER"
fi

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
  # Do not bind WhatsApp Cloud to 8642 here; API server owns ACA ingress port.
  printf 'GATEWAY_ALLOW_ALL_USERS=true\n'
  # Suppress Hermes operator-only /sethome notice in guest-facing WhatsApp chats.
  printf 'WHATSAPP_CLOUD_HOME_CHANNEL=wolfhouse-luna-ops\n'
  printf 'WHATSAPP_CLOUD_HOME_CHANNEL_NAME=Wolfhouse Luna Ops\n'
  # Wolfhouse Staff API base URL for Luna tool calls + inbox mirror
  [ -n "${WOLFHOUSE_STAFF_API_BASE_URL:-}" ]            && printf 'WOLFHOUSE_STAFF_API_BASE_URL=%s\n' "$WOLFHOUSE_STAFF_API_BASE_URL"
  # Luna bot token for Staff API bot endpoints
  [ -n "${LUNA_BOT_INTERNAL_TOKEN:-}" ]                 && printf 'LUNA_BOT_INTERNAL_TOKEN=%s\n' "$LUNA_BOT_INTERNAL_TOKEN"
} > "$HERMES_HOME/.env"

# Gateway patches: echo strip + Staff Portal inbox mirror (must compile cleanly).
if [ -f /etc/hermes-staging/apply_gateway_patches.py ]; then
  python /etc/hermes-staging/apply_gateway_patches.py || {
    echo "apply_gateway_patches failed — Hermes gateway may not start" >&2
    exit 1
  }
fi

if [ -f /etc/hermes-staging/apply_whatsapp_fresh_start_route.py ]; then
  python /etc/hermes-staging/apply_whatsapp_fresh_start_route.py || {
    echo "apply_whatsapp_fresh_start_route failed — Fresh Start route may be missing" >&2
    exit 1
  }
fi

chown hermes:hermes "$HERMES_HOME/config.yaml" "$HERMES_HOME/.env" 2>/dev/null || true
[ -f "$HERMES_HOME/SOUL.md" ] && chown hermes:hermes "$HERMES_HOME/SOUL.md" 2>/dev/null || true
[ -d "$HERMES_HOME/plugins" ] && chown -R hermes:hermes "$HERMES_HOME/plugins" 2>/dev/null || true
chmod 640 "$HERMES_HOME/config.yaml" 2>/dev/null || true
chmod 600 "$HERMES_HOME/.env" 2>/dev/null || true
[ -f "$HERMES_HOME/SOUL.md" ] && chmod 640 "$HERMES_HOME/SOUL.md" 2>/dev/null || true
[ -d "$HERMES_HOME/plugins" ] && chmod -R go-rwx "$HERMES_HOME/plugins" 2>/dev/null || true
