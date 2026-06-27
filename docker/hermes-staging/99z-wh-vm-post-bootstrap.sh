#!/bin/sh
# VM overlay: shared auth.json symlink + orchestrator (Skipper) model override.
#
# Luna's model config (Codex gpt-5.5 primary, Anthropic Claude fallback) is baked
# into the image by 99-wh-staging-bootstrap (bootstrap.sh). Orchestrator (Discord
# "Skipper") is overridden here until the image ships the same primary — so
# restarts don't snap back to Claude Opus.
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

if [ "$HERMES_ROLE" = "orchestrator" ]; then
  cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: gpt-5.5
  provider: openai-codex
agent:
  reasoning_effort: low
compression:
  codex_gpt55_autoraise: false
fallback_providers:
  - provider: anthropic
    model: anthropic/claude-sonnet-4-6
curator:
  enabled: false
terminal:
  cwd: /opt/wolfhouse/WH
gateway:
  platforms:
    discord:
      require_mention: false
EOF
fi

if [ -f "$HERMES_HOME/.auth-shared/auth.json" ]; then
  # Preserve a refreshed OAuth token (real local file from an atomic rename) back
  # to the shared pool before re-linking, so it isn't lost on restart.
  if [ -f "$HERMES_HOME/auth.json" ] && [ ! -L "$HERMES_HOME/auth.json" ] \
     && [ "$HERMES_HOME/auth.json" -nt "$HERMES_HOME/.auth-shared/auth.json" ]; then
    cp -f "$HERMES_HOME/auth.json" "$HERMES_HOME/.auth-shared/auth.json" 2>/dev/null || true
  fi
  rm -f "$HERMES_HOME/auth.json"
  ln -sf ".auth-shared/auth.json" "$HERMES_HOME/auth.json"
  chown -h hermes:hermes "$HERMES_HOME/auth.json" 2>/dev/null || true
fi

if [ "$HERMES_ROLE" = "seadog" ]; then
  # Seadog is a light Discord chat persona (no guest booking tools). Run it fully
  # on Anthropic (covered by the Claude usage credits), no OpenAI: Sonnet primary,
  # cheap Haiku as error fallback. Replaces the image-baked gpt-5.5/Codex.
  cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: anthropic/claude-sonnet-4-6
  provider: anthropic
agent:
  reasoning_effort: low
fallback_providers:
  - provider: anthropic
    model: anthropic/claude-haiku-4-5
curator:
  enabled: false
terminal:
  cwd: /opt/wolfhouse/WH
gateway:
  platforms:
    discord:
      require_mention: false
EOF
  chown hermes:hermes "$HERMES_HOME/config.yaml" 2>/dev/null || true
  chmod 640 "$HERMES_HOME/config.yaml" 2>/dev/null || true
fi

if [ "$HERMES_ROLE" = "deckhand" ]; then
  cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: anthropic/claude-sonnet-4-6
  provider: anthropic
agent:
  reasoning_effort: medium
compression:
  codex_gpt55_autoraise: false
fallback_providers:
  - provider: openai-codex
    model: gpt-5.5
curator:
  enabled: false
terminal:
  cwd: /opt/data/workspace/sandbox-repos/WH-deckhand
gateway:
  platforms:
    discord:
      require_mention: false
EOF
  if [ -f "$HERMES_HOME/deckhand-SOUL.md" ]; then
    cp "$HERMES_HOME/deckhand-SOUL.md" "$HERMES_HOME/SOUL.md"
    chown hermes:hermes "$HERMES_HOME/SOUL.md" 2>/dev/null || true
    chmod 640 "$HERMES_HOME/SOUL.md" 2>/dev/null || true
  fi
  mkdir -p "$HERMES_HOME/workspace/sandbox-repos" "$HERMES_HOME/workspace/patches" "$HERMES_HOME/workspace/notes"
  chown -R hermes:hermes "$HERMES_HOME/workspace" 2>/dev/null || true
  chown hermes:hermes "$HERMES_HOME/config.yaml" 2>/dev/null || true
fi

