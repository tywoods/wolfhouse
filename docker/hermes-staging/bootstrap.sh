#!/bin/sh
# Staging bootstrap: write Hermes config per role on every container startup.
# HERMES_ROLE=luna         → guest WhatsApp Luna (default for ACA backward compat)
# HERMES_ROLE=sunset-luna  → Sunset guest WhatsApp Luna (tenant-gated)
# HERMES_ROLE=sunset-email-luna → Sunset Staff email draft-only runtime (no gateway)
# HERMES_ROLE=orchestrator → operator Discord/SSH profile (VM Skipper)
# HERMES_ROLE=seadog       → light Discord persona (legacy: same guest bootstrap path)
# HERMES_ROLE=deckhand     → Discord engineering worker (xAI; never Luna guest path)
# Unknown roles fail closed — they must not silently inherit Luna guest bootstrap.
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
SUNSET_LUNA_SOUL="/etc/hermes-sunset/SOUL.md"
STAGING_ORCH_SOUL="/etc/hermes-staging/orchestrator-SOUL.md"
STAGING_DECKHAND_SOUL="/etc/hermes-staging/deckhand-SOUL.md"
STAGING_PLUGINS="/etc/hermes-staging/plugins"
LUNA_SOUL_MARKER="$HERMES_HOME/.luna-guest-soul.version"
LUNA_SOUL_VERSION="33"

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
# Messaging-platform tool selection is separate from the top-level toolsets list.
# WhatsApp guests must never receive shell/code approval cards or access general
# operator tools; Luna only needs the tenant-scoped Staff API plugin.
platform_toolsets:
  whatsapp_cloud:
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
      # Skipper / Chief jobs thread — respond without @mention.
      free_response_channels:
        - "1537038069343981618"
      # Human ops "Chief of Staff" thread — never auto-wake Skipper.
      ignored_channels:
        - "1537017482748100678"
EOF
}

write_deckhand_config() {
  # Image-baked Deckhand model. VM overlay 99z rewrites the same xAI OAuth config
  # and ensures the sandbox cwd exists; keep both in sync.
  # Provider must be xai-oauth (shared auth.json), not bare xai (API-key provider).
  cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: grok-4.6
  provider: xai-oauth
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
    _luna_webhook_port="${WHATSAPP_CLOUD_WEBHOOK_PORT:-8090}"
    printf 'WHATSAPP_CLOUD_WEBHOOK_PORT=%s\n' "$_luna_webhook_port"
    printf 'WHATSAPP_CLOUD_WEBHOOK_PATH=/whatsapp/webhook\n'
    printf 'PYTHONPATH=/etc/hermes-staging\n'
    printf 'API_SERVER_ENABLED=true\n'
    printf 'API_SERVER_HOST=0.0.0.0\n'
    # Sunset staging only: coalesce rapid WhatsApp bursts before agent runs.
    # Disabled for Wolfhouse Luna / other roles unless explicitly exported.
    if [ "${HERMES_ROLE:-}" = "sunset-luna" ]; then
      printf 'WHATSAPP_BURST_COALESCE_ENABLED=%s\n' "${WHATSAPP_BURST_COALESCE_ENABLED:-true}"
      printf 'WHATSAPP_BURST_DEBOUNCE_MS=%s\n' "${WHATSAPP_BURST_DEBOUNCE_MS:-5000}"
      printf 'WHATSAPP_BURST_MAX_MESSAGES=%s\n' "${WHATSAPP_BURST_MAX_MESSAGES:-20}"
      printf 'WHATSAPP_BURST_MAX_CHARS=%s\n' "${WHATSAPP_BURST_MAX_CHARS:-8000}"
    elif [ -n "${WHATSAPP_BURST_COALESCE_ENABLED:-}" ]; then
      printf 'WHATSAPP_BURST_COALESCE_ENABLED=%s\n' "$WHATSAPP_BURST_COALESCE_ENABLED"
      [ -n "${WHATSAPP_BURST_DEBOUNCE_MS:-}" ] && printf 'WHATSAPP_BURST_DEBOUNCE_MS=%s\n' "$WHATSAPP_BURST_DEBOUNCE_MS"
    fi
    [ -n "${WOLFHOUSE_STAFF_API_BASE_URL:-}" ]            && printf 'WOLFHOUSE_STAFF_API_BASE_URL=%s\n' "$WOLFHOUSE_STAFF_API_BASE_URL"
    [ -n "${LUNA_BOT_INTERNAL_TOKEN:-}" ]                 && printf 'LUNA_BOT_INTERNAL_TOKEN=%s\n' "$LUNA_BOT_INTERNAL_TOKEN"
    [ -n "${LUNA_CLIENT_SLUG:-}" ]                        && printf 'LUNA_CLIENT_SLUG=%s\n' "$LUNA_CLIENT_SLUG"
    [ -n "${LUNA_ALLOWED_LOCATION_IDS:-}" ]               && printf 'LUNA_ALLOWED_LOCATION_IDS=%s\n' "$LUNA_ALLOWED_LOCATION_IDS"
    [ -n "${SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID:-}" ]    && printf 'SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID=%s\n' "$SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID"
    [ -n "${SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID:-}" ] && printf 'SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID=%s\n' "$SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID"
    # Anthropic OAuth (Claude Max) for Luna's fallback provider — claude setup-token.
    if [ -n "${ANTHROPIC_TOKEN:-}" ]; then
      printf 'ANTHROPIC_TOKEN=%s\n' "$ANTHROPIC_TOKEN"
    fi
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
    # Luna Chief of Staff webhook → auto-start Skipper turns in Skipper / Chief
    # jobs thread only (not the human "Chief of Staff" ops thread).
    printf 'DISCORD_BOT_WAKE_CHANNELS=%s\n' "${DISCORD_BOT_WAKE_CHANNELS:-1537038069343981618}"
    printf 'DISCORD_BOT_WAKE_AUTHORS=%s\n' "${DISCORD_BOT_WAKE_AUTHORS:-Luna Chief of Staff}"
    printf 'DISCORD_BOT_WAKE_JSON_SOURCE=%s\n' "${DISCORD_BOT_WAKE_JSON_SOURCE:-grok-bot}"
    printf 'DISCORD_BOT_WAKE_JSON_TYPES=%s\n' "${DISCORD_BOT_WAKE_JSON_TYPES:-ping,approved_fix,status}"
    printf 'DISCORD_FREE_RESPONSE_CHANNELS=%s\n' "${DISCORD_FREE_RESPONSE_CHANNELS:-1537038069343981618}"
    # Human ops thread: collaboration chat only — never wake Skipper here.
    printf 'DISCORD_IGNORED_CHANNELS=%s\n' "${DISCORD_IGNORED_CHANNELS:-1537017482748100678}"
    [ -n "${WOLFHOUSE_STAFF_API_BASE_URL:-}" ]            && printf 'WOLFHOUSE_STAFF_API_BASE_URL=%s\n' "$WOLFHOUSE_STAFF_API_BASE_URL"
    # Anthropic OAuth (Claude Max) for Opus 4.8 — claude setup-token output.
    if [ -n "${ANTHROPIC_TOKEN:-}" ]; then
      printf 'ANTHROPIC_TOKEN=%s\n' "$ANTHROPIC_TOKEN"
    fi
  } > "$HERMES_HOME/.env"
}

write_deckhand_env() {
  # Discord only. xAI auth is OAuth via shared auth.json (provider xai-oauth),
  # not an API-key env var. Never write WhatsApp/Meta, Luna guest, or Staff-API guest tokens.
  {
    [ -n "${DISCORD_BOT_TOKEN:-}" ]                       && printf 'DISCORD_BOT_TOKEN=%s\n' "$DISCORD_BOT_TOKEN"
    [ -n "${DISCORD_ALLOWED_USERS:-}" ]                   && printf 'DISCORD_ALLOWED_USERS=%s\n' "$DISCORD_ALLOWED_USERS"
    printf 'GATEWAY_ALLOW_ALL_USERS=true\n'
    printf 'API_SERVER_ENABLED=false\n'
  } > "$HERMES_HOME/.env"
}

write_sunset_email_luna_config() {
  cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: gpt-5.6-sol
  provider: openai-codex
agent:
  reasoning_effort: none
memory:
  memory_enabled: false
  user_profile_enabled: false
curator:
  enabled: false
EOF
}

write_sunset_email_luna_env() {
  {
    [ -n "${API_SERVER_KEY:-}" ] && printf 'API_SERVER_KEY=%s\n' "$API_SERVER_KEY"
    printf 'LUNA_TENANT_ID=sunset\n'
    printf 'LUNA_CLIENT_SLUG=sunset\n'
    printf 'LUNA_ALLOWED_LOCATION_IDS=%s\n' "${LUNA_ALLOWED_LOCATION_IDS:-sunset-somo}"
    printf 'EMAIL_LUNA_DRAFT_LISTEN_HOST=%s\n' "${EMAIL_LUNA_DRAFT_LISTEN_HOST:-0.0.0.0}"
    printf 'EMAIL_LUNA_DRAFT_LISTEN_PORT=%s\n' "${EMAIL_LUNA_DRAFT_LISTEN_PORT:-8093}"
    printf 'PYTHONPATH=/etc/hermes-staging\n'
    printf 'API_SERVER_ENABLED=false\n'
    printf 'GATEWAY_ALLOW_ALL_USERS=false\n'
  } > "$HERMES_HOME/.env"
}

require_isolated_sunset_email_auth() {
  if [ -L "$HERMES_HOME/auth.json" ]; then
    echo "sunset-email-luna refuses shared auth.json symlink" >&2
    exit 1
  fi
  if [ -e "$HERMES_HOME/.auth-shared/auth.json" ]; then
    echo "sunset-email-luna refuses .auth-shared mount" >&2
    exit 1
  fi
  if [ ! -f "$HERMES_HOME/auth.json" ]; then
    echo "sunset-email-luna requires isolated operator-provisioned auth.json (openai-codex). See docs/MAIL-MVP-007-SUNSET-EMAIL-SOL-RUNBOOK.md" >&2
    exit 1
  fi
}

install_luna_plugins() {
  # Copy guest plugins only — never water_cooler_a2a (Seadog/Deckhand gated).
  if [ -d "$STAGING_PLUGINS" ]; then
    mkdir -p "$HERMES_HOME/plugins"
    for _plug in "$STAGING_PLUGINS"/*; do
      [ -e "$_plug" ] || continue
      _base="$(basename "$_plug")"
      if [ "$_base" = "water_cooler_a2a" ]; then
        continue
      fi
      cp -R "$_plug" "$HERMES_HOME/plugins/"
    done
  fi
}

# Water-cooler A2A: role-scoped (seadog|deckhand) AND WATER_COOLER_A2A_ENABLED=true.
# Every other role / missing / malformed enablement → no-op (never touch adapter).
# When enabled: validate IDs, install plugin, merge toolset, apply adapter patch
# after the standard gateway patch process, emit DISCORD_ALLOW_BOTS=mentions.
# Fail closed (exit 1) if enablement requested but IDs/patch fail.
maybe_activate_water_cooler_a2a() {
  if [ "$HERMES_ROLE" != "seadog" ] && [ "$HERMES_ROLE" != "deckhand" ]; then
    return 0
  fi
  if [ "${WATER_COOLER_A2A_ENABLED:-}" != "true" ]; then
    return 0
  fi
  if [ -f /etc/hermes-staging/wolfhouse/water_cooler_a2a_activation.py ]; then
    PYTHONPATH=/etc/hermes-staging python -m wolfhouse.water_cooler_a2a_activation || {
      echo "water_cooler_a2a activation failed — refusing start (explicit enable without valid IDs/patch)" >&2
      exit 1
    }
  else
    echo "water_cooler_a2a activation module missing — refusing start" >&2
    exit 1
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
  if [ -f /etc/hermes-staging/apply_crowsnest_ai_usage_patch.py ]; then
    python /etc/hermes-staging/apply_crowsnest_ai_usage_patch.py || {
      echo "apply_crowsnest_ai_usage_patch failed — refusing upstream drift" >&2
      exit 1
    }
  fi
  # Bot/webhook wake watch-list lives in the orchestrator branch (not apply_patches).
  # A2A adapter patch only after standard gateway patches; gated no-op otherwise.
  maybe_activate_water_cooler_a2a
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

ensure_sessions_dir() {
  mkdir -p "$HERMES_HOME/sessions"
  chown -R hermes:hermes "$HERMES_HOME/sessions" 2>/dev/null || true
  chmod 777 "$HERMES_HOME/sessions" 2>/dev/null || true
  touch "$HERMES_HOME/sessions/sessions.json" 2>/dev/null || true
  chown hermes:hermes "$HERMES_HOME/sessions/sessions.json" 2>/dev/null || true
  chmod 666 "$HERMES_HOME/sessions/sessions.json" 2>/dev/null || true
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
  # Chief of Staff webhook wake — orchestrator skips apply_patches (Luna-only),
  # so install the Discord bot-wake seam here.
  if [ -f /etc/hermes-staging/apply_discord_bot_wake_patch.py ]; then
    python /etc/hermes-staging/apply_discord_bot_wake_patch.py || {
      echo "apply_discord_bot_wake_patch failed — Chief of Staff auto-wake may be missing" >&2
      exit 1
    }
  fi
elif [ "$HERMES_ROLE" = "deckhand" ]; then
  # Discord engineering worker — never Luna guest bootstrap (no SOUL/plugins/WhatsApp
  # patches/env). Model is xAI grok-4.6 via xai-oauth (shared auth.json).
  write_deckhand_config
  if [ -f "$STAGING_DECKHAND_SOUL" ]; then
    cp "$STAGING_DECKHAND_SOUL" "$HERMES_HOME/SOUL.md"
  fi
  # Live volume override (optional): operator-placed deckhand-SOUL.md in HERMES_HOME.
  if [ -f "$HERMES_HOME/deckhand-SOUL.md" ]; then
    cp "$HERMES_HOME/deckhand-SOUL.md" "$HERMES_HOME/SOUL.md"
  fi
  mkdir -p "$HERMES_HOME/workspace/sandbox-repos/WH-deckhand" \
    "$HERMES_HOME/workspace/patches" \
    "$HERMES_HOME/workspace/notes"
  chown -R hermes:hermes "$HERMES_HOME/workspace" 2>/dev/null || true
  ensure_sessions_dir
  write_deckhand_env
  # Gated A2A only (not the Luna guest patch bundle). Image already has gateway
  # patches; this may install the A2A plugin + adapter seams when enabled.
  maybe_activate_water_cooler_a2a
  # xAI via shared OAuth pool (provider xai-oauth) — never an API-key env var.
  link_shared_auth
elif [ "$HERMES_ROLE" = "luna" ] \
  || [ "$HERMES_ROLE" = "sunset-luna" ] \
  || [ "$HERMES_ROLE" = "seadog" ]; then
  if [ "$HERMES_ROLE" = "sunset-luna" ]; then
    [ "${LUNA_CLIENT_SLUG:-}" = "sunset" ] || { echo "sunset-luna requires LUNA_CLIENT_SLUG=sunset" >&2; exit 1; }
    [ -n "${LUNA_ALLOWED_LOCATION_IDS:-}" ] || { echo "sunset-luna requires LUNA_ALLOWED_LOCATION_IDS" >&2; exit 1; }
    [ -n "${API_SERVER_KEY:-}" ] || { echo "sunset-luna requires API_SERVER_KEY" >&2; exit 1; }
    [ -n "${WOLFHOUSE_STAFF_API_BASE_URL:-}" ] && [ -n "${LUNA_BOT_INTERNAL_TOKEN:-}" ] || { echo "sunset-luna requires Staff API URL/token" >&2; exit 1; }
    [ -n "${WHATSAPP_CLOUD_ACCESS_TOKEN:-}" ] || { echo "sunset-luna requires Meta access token" >&2; exit 1; }
    [ -n "${SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID:-}" ] && [ -n "${SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID:-}" ] || { echo "sunset-luna requires both Meta phone IDs" >&2; exit 1; }
    [ "$SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID" != "$SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID" ] || { echo "Sunset phone IDs must be unique" >&2; exit 1; }
  fi
  write_luna_config
  if [ "$HERMES_ROLE" = "sunset-luna" ]; then
    # Sunset-only model upgrade. Keep Wolfhouse Luna and other shared-image roles
    # on their proven defaults while Sunset validates GPT-5.6 Sol in staging.
    sed -i 's/^  default: gpt-5\.5$/  default: gpt-5.6-sol/' "$HERMES_HOME/config.yaml"
  fi
  if [ "$HERMES_ROLE" = "sunset-luna" ] && [ -f "$SUNSET_LUNA_SOUL" ]; then
    cp "$SUNSET_LUNA_SOUL" "$HERMES_HOME/SOUL.md"
  elif [ -f "$STAGING_LUNA_SOUL" ]; then
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
  ensure_sessions_dir
  write_luna_env
  apply_patches
  # Seadog + A2A: use seadog SOUL (A2A tool guidance). Luna/Sunset SOUL untouched.
  if [ "$HERMES_ROLE" = "seadog" ] && [ "${WATER_COOLER_A2A_ENABLED:-}" = "true" ]; then
    if [ -f /etc/hermes-staging/seadog-SOUL.md ]; then
      cp /etc/hermes-staging/seadog-SOUL.md "$HERMES_HOME/SOUL.md"
    fi
  fi
  link_shared_auth
elif [ "$HERMES_ROLE" = "sunset-email-luna" ]; then
  [ "${LUNA_CLIENT_SLUG:-}" = "sunset" ] || { echo "sunset-email-luna requires LUNA_CLIENT_SLUG=sunset" >&2; exit 1; }
  [ "${LUNA_TENANT_ID:-}" = "sunset" ] || { echo "sunset-email-luna requires LUNA_TENANT_ID=sunset" >&2; exit 1; }
  [ "${LUNA_ALLOWED_LOCATION_IDS:-}" = "sunset-somo" ] || { echo "sunset-email-luna requires LUNA_ALLOWED_LOCATION_IDS=sunset-somo" >&2; exit 1; }
  [ -n "${API_SERVER_KEY:-}" ] || { echo "sunset-email-luna requires API_SERVER_KEY" >&2; exit 1; }
  require_isolated_sunset_email_auth
  write_sunset_email_luna_config
  if [ -f "$SUNSET_LUNA_SOUL" ]; then
    cp "$SUNSET_LUNA_SOUL" "$HERMES_HOME/SOUL.md"
  elif [ -f "$STAGING_LUNA_SOUL" ]; then
    cp "$STAGING_LUNA_SOUL" "$HERMES_HOME/SOUL.md"
  else
    echo "sunset-email-luna missing Sunset SOUL" >&2
    exit 1
  fi
  if [ -f /etc/hermes-staging/wolfhouse/email_draft_soul_overlay.md ]; then
    printf '\n' >> "$HERMES_HOME/SOUL.md"
    cat /etc/hermes-staging/wolfhouse/email_draft_soul_overlay.md >> "$HERMES_HOME/SOUL.md"
  fi
  ensure_sessions_dir
  write_sunset_email_luna_env
  # Draft-only: never WhatsApp/Discord patches, never Staff booking plugins,
  # never shared auth.json mutation.
else
  echo "unsupported HERMES_ROLE: ${HERMES_ROLE} (expected orchestrator|deckhand|luna|sunset-luna|sunset-email-luna|seadog)" >&2
  exit 1
fi

finalize_permissions
