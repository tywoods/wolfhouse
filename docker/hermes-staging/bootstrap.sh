#!/bin/sh
# Staging bootstrap: force OpenAI API + persist key into /opt/data before gateway starts.
set -eu
HERMES_HOME="${HERMES_HOME:-/opt/data}"

if [ -n "${OPENAI_API_KEY:-}" ]; then
  if [ ! -f "$HERMES_HOME/.env" ] || ! grep -q '^OPENAI_API_KEY=' "$HERMES_HOME/.env" 2>/dev/null; then
    printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY" >> "$HERMES_HOME/.env"
  fi
fi

cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: gpt-4o-mini
  provider: openai-api
  api_mode: chat_completions
agent:
  reasoning_effort: none
EOF

chown hermes:hermes "$HERMES_HOME/config.yaml" 2>/dev/null || true
chmod 640 "$HERMES_HOME/config.yaml" 2>/dev/null || true
if [ -f "$HERMES_HOME/.env" ]; then
  chown hermes:hermes "$HERMES_HOME/.env" 2>/dev/null || true
  chmod 600 "$HERMES_HOME/.env" 2>/dev/null || true
fi
