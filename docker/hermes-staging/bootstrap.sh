#!/bin/sh
# Staging bootstrap: write Hermes config per role on every container startup.
# HERMES_ROLE=luna     → guest WhatsApp Luna (default for ACA backward compat)
# HERMES_ROLE=orchestrator → operator Discord/SSH profile (VM)
set -eu

# s6-overlay legacy cont-init scripts run without the container environment.
# Import it so HERMES_ROLE and secret env vars are visible to this script.
if [ -d /run/s6/container_environment ]; then
  for _envf in /run/s6/container_environment/*; do
    [ -f "$_envf" ] || continue
    _name="$(basename "$_envf")"
    export "$_name=$(cat "$_envf")"
  done
fi

HERMES_HOME="${HERMES_HOME:-/opt/data}"
mkdir -p "$HERMES_HOME/sessions" "$HERMES_HOME/plugins"
HERMES_ROLE="${HERMES_ROLE:-luna}"
STAGING_LUNA_SOUL="/etc/hermes-staging/SOUL.md"
STAGING_ORCH_SOUL="/etc/hermes-staging/orchestrator-SOUL.md"
STAGING_PLUGINS="/etc/hermes-staging/plugins"
LUNA_SOUL_MARKER="$HERMES_HOME/.luna-guest-soul.version"
LUNA_SOUL_VERSION="20"

write_luna_config() {
  cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: gpt-5.5
  provider: openai-codex
agent:
  reasoning_effort: none
# Primary: ChatGPT OAuth (gpt-5.5). Fallback: Anthropic OAuth from shared auth.json.
fallback_providers:
  - provider: anthropic
    model: anthropic/claude-sonnet-4-6
# Luna is a guest-facing booking agent, not a general Hermes operator.
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
}

write_orchestrator_config() {
  cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: anthropic/claude-opus-4.8
  provider: anthropic
agent:
  reasoning_effort: low
# Operator profile — no guest booking tools; Luna owns WhatsApp booking.
curator:
  enabled: false
terminal:
  cwd: /opt/wolfhouse/WH
gateway:
  platforms:
    discord:
      require_mention: false
EOF
}

write_luna_env() {
  {
    [ -n "${API_SERVER_KEY:-}" ]                           && printf 'API_SERVER_KEY=%s\n' "$API_SERVER_KEY"
    [ -n "${WHATSAPP_CLOUD_ACCESS_TOKEN:-}" ]             && printf 'WHATSAPP_CLOUD_ACCESS_TOKEN=%s\n' "$WHATSAPP_CLOUD_ACCESS_TOKEN"
    [ -n "${WHATSAPP_CLOUD_PHONE_NUMBER_ID:-}" ]          && printf 'WHATSAPP_CLOUD_PHONE_NUMBER_ID=%s\n' "$WHATSAPP_CLOUD_PHONE_NUMBER_ID"
    [ -n "${WHATSAPP_CLOUD_APP_SECRET:-}" ]               && printf 'WHATSAPP_CLOUD_APP_SECRET=%s\n' "$WHATSAPP_CLOUD_APP_SECRET"
    [ -n "${WHATSAPP_CLOUD_VERIFY_TOKEN:-}" ]             && printf 'WHATSAPP_CLOUD_VERIFY_TOKEN=%s\n' "$WHATSAPP_CLOUD_VERIFY_TOKEN"
    printf 'WHATSAPP_CLOUD_ALLOW_ALL_USERS=true\n'
    printf 'GATEWAY_ALLOW_ALL_USERS=true\n'
    printf 'WHATSAPP_CLOUD_HOME_CHANNEL=wolfhouse-luna-ops\n'
    printf 'WHATSAPP_CLOUD_HOME_CHANNEL_NAME=Wolfhouse Luna Ops\n'
    printf 'WHATSAPP_CLOUD_WEBHOOK_PORT=8090\n'
    printf 'WHATSAPP_CLOUD_WEBHOOK_PATH=/whatsapp/webhook\n'
    printf 'API_SERVER_ENABLED=true\n'
    printf 'API_SERVER_HOST=0.0.0.0\n'
    [ -n "${WOLFHOUSE_STAFF_API_BASE_URL:-}" ]            && printf 'WOLFHOUSE_STAFF_API_BASE_URL=%s\n' "$WOLFHOUSE_STAFF_API_BASE_URL"
    [ -n "${LUNA_BOT_INTERNAL_TOKEN:-}" ]                 && printf 'LUNA_BOT_INTERNAL_TOKEN=%s\n' "$LUNA_BOT_INTERNAL_TOKEN"
    # Anthropic OAuth (Claude Max) for Luna's fallback provider — claude setup-token.
    [ -n "${ANTHROPIC_TOKEN:-}" ]                         && printf 'ANTHROPIC_TOKEN=%s\n' "$ANTHROPIC_TOKEN"
  } > "$HERMES_HOME/.env"
}

write_orchestrator_env() {
  {
    [ -n "${DISCORD_BOT_TOKEN:-}" ]                       && printf 'DISCORD_BOT_TOKEN=%s\n' "$DISCORD_BOT_TOKEN"
    [ -n "${DISCORD_ALLOWED_USERS:-}" ]                   && printf 'DISCORD_ALLOWED_USERS=%s\n' "$DISCORD_ALLOWED_USERS"
    [ -n "${API_SERVER_KEY:-}" ]                           && printf 'API_SERVER_KEY=%s\n' "$API_SERVER_KEY"
    printf 'GATEWAY_ALLOW_ALL_USERS=true\n'
    printf 'API_SERVER_ENABLED=true\n'
    printf 'API_SERVER_HOST=0.0.0.0\n'
    printf 'API_SERVER_PORT=8642\n'
    [ -n "${WOLFHOUSE_STAFF_API_BASE_URL:-}" ]            && printf 'WOLFHOUSE_STAFF_API_BASE_URL=%s\n' "$WOLFHOUSE_STAFF_API_BASE_URL"
    # Anthropic OAuth (Claude Max) for Opus 4.8 — claude setup-token output.
    [ -n "${ANTHROPIC_TOKEN:-}" ]                         && printf 'ANTHROPIC_TOKEN=%s\n' "$ANTHROPIC_TOKEN"
  } > "$HERMES_HOME/.env"
}

install_luna_plugins() {
  if [ -d "$STAGING_PLUGINS" ]; then
    mkdir -p "$HERMES_HOME/plugins"
    cp -R "$STAGING_PLUGINS"/* "$HERMES_HOME/plugins/"
  fi
}

apply_patches() {
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
}

finalize_permissions() {
  chown hermes:hermes "$HERMES_HOME/config.yaml" "$HERMES_HOME/.env" 2>/dev/null || true
  [ -f "$HERMES_HOME/SOUL.md" ] && chown hermes:hermes "$HERMES_HOME/SOUL.md" 2>/dev/null || true
  [ -d "$HERMES_HOME/plugins" ] && chown -R hermes:hermes "$HERMES_HOME/plugins" 2>/dev/null || true
  chmod 640 "$HERMES_HOME/config.yaml" 2>/dev/null || true
  chmod 600 "$HERMES_HOME/.env" 2>/dev/null || true
  [ -f "$HERMES_HOME/SOUL.md" ] && chmod 640 "$HERMES_HOME/SOUL.md" 2>/dev/null || true
  [ -d "$HERMES_HOME/plugins" ] && chmod -R go-rwx "$HERMES_HOME/plugins" 2>/dev/null || true
}

if [ "$HERMES_ROLE" = "orchestrator" ]; then
  write_orchestrator_config
  if [ -f "$STAGING_ORCH_SOUL" ]; then
    cp "$STAGING_ORCH_SOUL" "$HERMES_HOME/SOUL.md"
  fi
  write_orchestrator_env
else
  write_luna_config
  if [ -f "$STAGING_LUNA_SOUL" ]; then
    cp "$STAGING_LUNA_SOUL" "$HERMES_HOME/SOUL.md"
  fi
  install_luna_plugins
  if [ "$(cat "$LUNA_SOUL_MARKER" 2>/dev/null)" != "$LUNA_SOUL_VERSION" ]; then
    rm -rf "$HERMES_HOME/sessions" 2>/dev/null || true
    printf '%s\n' "$LUNA_SOUL_VERSION" > "$LUNA_SOUL_MARKER"
  fi
  write_luna_env
  apply_patches
fi

finalize_permissions
