#!/bin/sh
# VM overlay: shared auth symlink + Luna gpt-5.5 Codex primary.
set -eu

if [ -d /run/s6/container_environment ]; then
  for _envf in /run/s6/container_environment/*; do
    [ -f "$_envf" ] || continue
    _name="$(basename "$_envf")"
    export "$_name=$(cat "$_envf")"
  done
fi

HERMES_HOME="${HERMES_HOME:-/opt/data}"
HERMES_ROLE="${HERMES_ROLE:-luna}"

if [ -f "$HERMES_HOME/.auth-shared/auth.json" ]; then
  rm -f "$HERMES_HOME/auth.json"
  ln -sf ".auth-shared/auth.json" "$HERMES_HOME/auth.json"
  chown -h hermes:hermes "$HERMES_HOME/auth.json" 2>/dev/null || true
fi

if [ "$HERMES_ROLE" = "orchestrator" ]; then
  exit 0
fi

cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: gpt-5.5
  provider: openai-codex
agent:
  reasoning_effort: none
fallback_providers:
  - provider: anthropic
    model: anthropic/claude-sonnet-4-6
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
chown hermes:hermes "$HERMES_HOME/config.yaml" 2>/dev/null || true
chmod 640 "$HERMES_HOME/config.yaml" 2>/dev/null || true
