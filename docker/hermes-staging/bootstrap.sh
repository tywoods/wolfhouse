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
LUNA_SOUL_VERSION="34"

write_luna_config() {
  cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: gpt-5.5
  provider: openai-codex
agent:
  # none keeps Luna warm, chatty and emoji-rich (her surfer-girl voice). Bumping
  # to medium made gpt-5.5 terse/task-efficient — it stripped the personality and
  # batched the whole intake into one message. Keep none; steer behavior via SOUL.
  reasoning_effort: none
# A Hermes update raised gpt-5.5 auto-compaction to 85% (from 50%); that summarizes
# Luna's context — including her SOUL — and made her go terse and forget her rules.
# Opt out so her full SOUL stays in context every turn.
compression:
  codex_gpt55_autoraise: false
# Primary: ChatGPT (Codex OAuth, gpt-5.5). Fallback: Anthropic Claude Max OAuth.
# Codex is primary so guest turns don't dead-end on the Anthropic "extra usage" 400.
fallback_providers:
  - provider: anthropic
    model: anthropic/claude-sonnet-4-6
# Luna is a guest-facing booking agent, not a general Hermes operator.
toolsets:
  - wolfhouse_staff_api
plugins:
  enabled:
    - wolfhouse-staff-api
# Guest-facing front desk serves many numbers — never persist per-guest facts in
# shared agent memory (USER.md) or inject them into every new session.
memory:
  memory_enabled: false
  user_profile_enabled: false
curator:
  enabled: false
gateway:
  platforms:
    whatsapp_cloud:
      gateway_restart_notification: false
# Voice notes: STT_PROVIDER in container env overrides stt.provider (see apply_stt_patches.py).
stt:
  enabled: true
  provider: groq
EOF
}

write_orchestrator_config() {
  cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: gpt-5.5
  provider: openai-codex
agent:
  reasoning_effort: low
compression:
  codex_gpt55_autoraise: false
# Primary: ChatGPT (Codex OAuth). Fallback: Anthropic Claude OAuth.
fallback_providers:
  - provider: anthropic
    model: anthropic/claude-sonnet-4-6
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
    printf 'PYTHONPATH=/etc/hermes-staging\n'
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
  if [ -f /etc/hermes-staging/apply_whatsapp_simulate_route.py ]; then
    python /etc/hermes-staging/apply_whatsapp_simulate_route.py || {
      echo "apply_whatsapp_simulate_route failed — simulate-guest-turn route may be missing" >&2
      exit 1
    }
  fi
  if [ -f /etc/hermes-staging/apply_stt_patches.py ]; then
    python /etc/hermes-staging/apply_stt_patches.py || {
      echo "apply_stt_patches failed — STT_PROVIDER env override may be missing" >&2
      exit 1
    }
  fi
  if [ -f /etc/hermes-staging/apply_guest_send_guard_patches.py ]; then
    python /etc/hermes-staging/apply_guest_send_guard_patches.py || {
      echo "apply_guest_send_guard_patches failed — guest send guard may be missing" >&2
      exit 1
    }
  fi
}

link_shared_auth() {
  SHARED_AUTH="$HERMES_HOME/.auth-shared/auth.json"
  if [ ! -f "$SHARED_AUTH" ]; then
    return 0
  fi
  LOCAL_AUTH="$HERMES_HOME/auth.json"
  # If a previous run refreshed the OAuth token into a REAL local file (an atomic
  # rename replaces the symlink with a plain file), persist it back to the shared
  # pool before re-linking — otherwise the refresh is lost on restart and the
  # provider reports "No credentials stored" once the old token expires.
  if [ -f "$LOCAL_AUTH" ] && [ ! -L "$LOCAL_AUTH" ] && [ "$LOCAL_AUTH" -nt "$SHARED_AUTH" ]; then
    cp -f "$LOCAL_AUTH" "$SHARED_AUTH" 2>/dev/null || true
  fi
  rm -f "$LOCAL_AUTH"
  ln -sf ".auth-shared/auth.json" "$LOCAL_AUTH"
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
  link_shared_auth
else
  write_luna_config
  if [ -f "$STAGING_LUNA_SOUL" ]; then
    cp "$STAGING_LUNA_SOUL" "$HERMES_HOME/SOUL.md"
  fi
  install_luna_plugins
  if [ "$(cat "$LUNA_SOUL_MARKER" 2>/dev/null)" != "$LUNA_SOUL_VERSION" ]; then
    rm -rf "$HERMES_HOME/sessions" 2>/dev/null || true
    rm -rf "$HERMES_HOME/memories" 2>/dev/null || true
    printf '%s\n' "$LUNA_SOUL_VERSION" > "$LUNA_SOUL_MARKER"
  fi
  # Always ensure the sessions dir exists and is writable by the hermes user.
  # Ownership is the real guarantee (the bind-mounted HERMES_HOME is chowned to
  # uid 10000 by provision-hermes-vm.sh); the chmods are a belt-and-suspenders
  # fallback. All guarded with `|| true` so a non-fatal perm hiccup can't abort
  # this `set -e` script before env/patches run.
  mkdir -p "$HERMES_HOME/sessions"
  chown -R hermes:hermes "$HERMES_HOME/sessions" 2>/dev/null || true
  chmod 777 "$HERMES_HOME/sessions" 2>/dev/null || true
  touch "$HERMES_HOME/sessions/sessions.json" 2>/dev/null || true
  chown hermes:hermes "$HERMES_HOME/sessions/sessions.json" 2>/dev/null || true
  chmod 666 "$HERMES_HOME/sessions/sessions.json" 2>/dev/null || true
  write_luna_env
  apply_patches
  link_shared_auth
fi

finalize_permissions
