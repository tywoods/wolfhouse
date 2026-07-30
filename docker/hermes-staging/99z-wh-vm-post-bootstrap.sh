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
  default: gpt-5.6-sol
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
  # Seadog is a light Discord chat persona (no guest booking tools). Runs on
  # openai-codex/gpt-5.5 — the same provider as the orchestrator (Skipper) and the
  # active_provider in the shared auth store. The Anthropic OAuth subscription path
  # was tried (to use Claude credits) but Anthropic now rejects Hermes' agent turns
  # as third-party usage: "Third-party apps now draw from your extra usage... add
  # more at claude.ai/settings/usage" (HTTP 400), and Hermes auto-suppressed the
  # anthropic source. The token still works for raw API calls, but not via Hermes.
  # To move seadog back onto Claude: top up extra usage at claude.ai/settings/usage,
  # then set provider: anthropic + a claude model here.
  #
  # Water-cooler A2A toolset/plugin is included only when explicitly enabled for
  # this container (WATER_COOLER_A2A_ENABLED=true). Default remains no plugins.
  if [ "${WATER_COOLER_A2A_ENABLED:-}" = "true" ]; then
    cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: gpt-5.6-terra
  provider: openai-codex
agent:
  reasoning_effort: low
curator:
  enabled: false
terminal:
  cwd: /opt/wolfhouse/WH
toolsets:
  - water_cooler_a2a
plugins:
  enabled:
    - water-cooler-a2a
gateway:
  platforms:
    discord:
      require_mention: false
EOF
  else
    cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: gpt-5.6-terra
  provider: openai-codex
agent:
  reasoning_effort: low
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
  chown hermes:hermes "$HERMES_HOME/config.yaml" 2>/dev/null || true
  chmod 640 "$HERMES_HOME/config.yaml" 2>/dev/null || true
fi

if [ "$HERMES_ROLE" = "deckhand" ]; then
  # Deckhand: isolated Discord engineering worker. xAI grok-4.5 only — no
  # Anthropic/OpenAI fallback. Distinct Discord bot + XAI_API_KEY via
  # /etc/hermes-deckhand.env (never reuse Skipper's discord-bot-token).
  #
  # Water-cooler A2A toolset/plugin only when WATER_COOLER_A2A_ENABLED=true.
  if [ "${WATER_COOLER_A2A_ENABLED:-}" = "true" ]; then
    cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: grok-4.5
  provider: xai
agent:
  reasoning_effort: medium
curator:
  enabled: false
terminal:
  cwd: /opt/data/workspace/sandbox-repos/WH-deckhand
toolsets:
  - water_cooler_a2a
plugins:
  enabled:
    - water-cooler-a2a
gateway:
  platforms:
    discord:
      enabled: true
      require_mention: false
EOF
  else
    cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: grok-4.5
  provider: xai
agent:
  reasoning_effort: medium
curator:
  enabled: false
terminal:
  cwd: /opt/data/workspace/sandbox-repos/WH-deckhand
gateway:
  platforms:
    discord:
      enabled: true
      require_mention: false
EOF
  fi
  if [ -f "$HERMES_HOME/deckhand-SOUL.md" ]; then
    cp "$HERMES_HOME/deckhand-SOUL.md" "$HERMES_HOME/SOUL.md"
    chown hermes:hermes "$HERMES_HOME/SOUL.md" 2>/dev/null || true
    chmod 640 "$HERMES_HOME/SOUL.md" 2>/dev/null || true
  fi
  mkdir -p "$HERMES_HOME/workspace/sandbox-repos/WH-deckhand" \
    "$HERMES_HOME/workspace/patches" \
    "$HERMES_HOME/workspace/notes"
  chown -R hermes:hermes "$HERMES_HOME/workspace" 2>/dev/null || true
  chown hermes:hermes "$HERMES_HOME/config.yaml" 2>/dev/null || true
  chmod 640 "$HERMES_HOME/config.yaml" 2>/dev/null || true
fi

