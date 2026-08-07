#!/bin/sh
# VM overlay: shared auth.json symlink + orchestrator (Skipper) model override.
#
# Luna's model config (Codex primary, Anthropic Claude fallback) is baked into
# the image by 99-wh-staging-bootstrap (bootstrap.sh). Orchestrator (Discord
# "Skipper") is OpenAI-only here (openai-codex, no Anthropic fallback).
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
# OpenAI only — no Anthropic fallback (Claude Max third-party extra-usage 400).
fallback_providers: []
# Pin aux tasks to Codex so provider:auto cannot discover Anthropic OAuth
# from the shared pool / built-in payment-fallback chain.
auxiliary:
  vision:
    provider: openai-codex
  web_extract:
    provider: openai-codex
  compression:
    provider: openai-codex
  skills_hub:
    provider: openai-codex
  approval:
    provider: openai-codex
  mcp:
    provider: openai-codex
  title_generation:
    provider: openai-codex
  background_review:
    provider: openai-codex
  curator:
    provider: openai-codex
  session_search:
    provider: openai-codex
curator:
  enabled: false
terminal:
  cwd: /opt/wolfhouse/WH
gateway:
  platforms:
    discord:
      require_mention: false
      thread_require_mention: false
EOF
  # Skipper must NOT share the multi-provider auth pool. Shared auth.json also
  # holds Anthropic + xAI; Hermes still probes exhausted Anthropic OAuth and
  # posts the "extra usage" 400 into Discord. Clone openai-codex only into a
  # real local auth.json — never symlink back to the shared pool, and never
  # copy this openai-only file over shared (would wipe Luna/Deckhand creds).
  # Shared file is mounted at /var/lib/hermes-shared (NOT $HERMES_HOME/.auth-shared).
  _SHARED_AUTH=""
  if [ -f /var/lib/hermes-shared/auth.json ]; then
    _SHARED_AUTH=/var/lib/hermes-shared/auth.json
  elif [ -f "$HERMES_HOME/.auth-shared/auth.json" ]; then
    _SHARED_AUTH="$HERMES_HOME/.auth-shared/auth.json"
  fi
  if [ -n "$_SHARED_AUTH" ]; then
    HERMES_HOME="$HERMES_HOME" SHARED_AUTH="$_SHARED_AUTH" python3 - <<'PY'
import json, os
from datetime import datetime, timezone
from pathlib import Path
home = Path(os.environ["HERMES_HOME"])
shared = json.loads(Path(os.environ["SHARED_AUTH"]).read_text())
creds = (shared.get("credential_pool") or {}).get("openai-codex")
if not creds:
    raise SystemExit("orchestrator auth isolate: shared auth missing openai-codex")
local = home / "auth.json"
if local.is_symlink() or local.exists():
    local.unlink()
local.write_text(json.dumps({
    "version": shared.get("version", 1),
    "updated_at": datetime.now(timezone.utc).isoformat(),
    "active_provider": "openai-codex",
    "credential_pool": {"openai-codex": creds},
    "providers": {},
    "suppressed_sources": {
        "anthropic": ["env:ANTHROPIC_TOKEN", "oauth", "hermes_pkce", "claude_code", "api_key"],
        "xai-oauth": ["oauth", "loopback_pkce"],
    },
}, indent=2) + "\n")
local.chmod(0o600)
# Remove stale .auth-shared symlink/dir content pointers inside HERMES_HOME so
# runtime cannot rediscover Anthropic from the multi-provider pool.
auth_shared = home / ".auth-shared"
if auth_shared.is_symlink():
    auth_shared.unlink()
elif auth_shared.is_dir():
    stale = auth_shared / "auth.json"
    if stale.is_symlink():
        stale.unlink()
    elif stale.exists() and not stale.samefile(Path(os.environ["SHARED_AUTH"])):
        # local leftover only
        pass
print("orchestrator: wrote openai-only auth.json")
PY
    chown hermes:hermes "$HERMES_HOME/auth.json" 2>/dev/null || true
  fi
fi

# Luna / Deckhand / Seadog: keep shared multi-provider auth symlink.
if [ "$HERMES_ROLE" != "orchestrator" ] && [ -f "$HERMES_HOME/.auth-shared/auth.json" ]; then
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

  # Lightweight collaborator persona. The image bootstrap installs the Luna guest
  # SOUL for role=seadog (no seadog branch there); override it here every boot so
  # Seadog is an engineering agent, not a guest receptionist. Plain @-mention
  # handoffs — the Water-cooler A2A tool is intentionally NOT loaded in this mode.
  cat > "$HERMES_HOME/SOUL.md" <<'EOF'
# Seadog — Wolfhouse Discord engineering agent

You are **Seadog**, a Discord-side engineering and operations agent for the
Wolfhouse / Luna Front Desk team on staging. You are **not** Luna and **not** a
guest-facing receptionist.

## Your job
- Help with engineering and operational chat on staging.
- Use the read-only repo at `/opt/wolfhouse/WH` for project context.
- Be direct, technical, and concise.

## Not your job
- Do not act as a guest Wolfhouse/Sunset receptionist: no bookings, quotes,
  payment links, or WhatsApp guest chat.
- Do not touch production systems or production WhatsApp numbers.

## Handing off to Deckhand in this thread — EXACT format required
- You share this thread with **Deckhand**, another engineering agent. He only
  receives your message if you mention him with his literal Discord user token.
- When you address or hand off to Deckhand you MUST output the exact characters
  `<@1520179971757310023>` (angle brackets + digits). Do NOT write "@Deckhand"
  or "Deckhand" as words — the words never reach him.
  - Correct: `<@1520179971757310023> over to you — <summary>`
  - Wrong (ignored): `@Deckhand over to you`
- When Deckhand or a teammate mentions you, respond normally and keep it brief.

## Boundaries
- Keep secrets out of chat: never paste tokens, env-file contents, or Key Vault
  values.
EOF
  chown hermes:hermes "$HERMES_HOME/SOUL.md" 2>/dev/null || true
  chmod 640 "$HERMES_HOME/SOUL.md" 2>/dev/null || true
fi

if [ "$HERMES_ROLE" = "deckhand" ]; then
  # Deckhand: isolated Discord engineering worker. xAI grok-4.5 via xai-oauth
  # (shared auth.json) — no Anthropic/OpenAI fallback, no API-key env var.
  # Distinct Discord bot via /etc/hermes-deckhand.env (never reuse Skipper's
  # discord-bot-token).
  #
  # Water-cooler A2A toolset/plugin only when WATER_COOLER_A2A_ENABLED=true.
  if [ "${WATER_COOLER_A2A_ENABLED:-}" = "true" ]; then
    cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: grok-4.5
  provider: xai-oauth
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
  fi
  if [ -f "$HERMES_HOME/deckhand-SOUL.md" ]; then
    cp "$HERMES_HOME/deckhand-SOUL.md" "$HERMES_HOME/SOUL.md"
    # Thread handoff guidance: Seadog is only reachable via a real user mention.
    # Appended to the freshly-copied SOUL each boot (no accumulation).
    cat >> "$HERMES_HOME/SOUL.md" <<'EOF'

## Handing off to Seadog in this thread — EXACT format required
- You share this thread with **Seadog**, another engineering agent. He only
  receives your message if you mention him with his literal Discord user token.
- When you address or hand off to Seadog you MUST output the exact characters
  `<@1519467061397684385>` (angle brackets + digits). Do NOT write "@Sea Dog"
  or "Sea Dog" as words — the words never reach him.
  - Correct: `<@1519467061397684385> over to you — <summary>`
  - Wrong (ignored): `@Sea Dog over to you`
- When Seadog or a teammate mentions you, respond normally and keep it brief.
EOF
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

# Deterministic outbound alias->mention rewrite (seadog + deckhand only).
# Bots emit plain text like "@Sea Dog" instead of a real Discord mention token,
# so peer handoffs never reach the other bot (the mentions gate needs a real
# user mention). Install a sitecustomize on /etc/hermes-staging (first on
# sys.path) that wraps discord's send to rewrite the two agent aliases to their
# real <@id> tokens on the wire. It also re-runs the shadowed system
# sitecustomize (apport hook). Fail-open: any error leaves messages untouched.
if [ "$HERMES_ROLE" = "seadog" ] || [ "$HERMES_ROLE" = "deckhand" ]; then
  cat > /etc/hermes-staging/sitecustomize.py <<'PYEOF'
"""Wolfhouse A2A-lite: outbound Discord alias->mention rewrite (seadog/deckhand).

Shadows the system sitecustomize (we are first on sys.path), so we re-run the
original apport hook first, then install the rewrite. Fail-open throughout.
"""
try:  # preserve the shadowed system sitecustomize (apport hook)
    import importlib.util as _u
    _spec = _u.spec_from_file_location(
        "_system_sitecustomize", "/usr/lib/python3.13/sitecustomize.py"
    )
    if _spec and _spec.loader:
        _m = _u.module_from_spec(_spec)
        _spec.loader.exec_module(_m)
except Exception:
    pass

try:
    import re as _re
    import discord as _discord

    # Plain-text agent aliases -> real Discord user-mention tokens.
    _WH_SUBS = [
        (_re.compile(r"@Sea\s*Dog\b", _re.IGNORECASE), "<@1519467061397684385>"),
        (_re.compile(r"@Deckhand\b", _re.IGNORECASE), "<@1520179971757310023>"),
    ]

    import time as _time
    _WH_COOLDOWN = 10.0          # seconds: at most one real peer-mention per peer
    _WH_last = {}                # token -> last monotonic ts a real mention emitted

    def _wh_rewrite(text):
        _now = _time.monotonic()
        for _rx, _tok in _WH_SUBS:
            def _repl(_m, _tok=_tok):
                # Loop breaker: emit a real mention only if we have not emitted one
                # to this peer recently; otherwise leave the plain-text alias, which
                # does NOT re-trigger the peer bot, so bot<->bot ping-pong ends.
                if _now - _WH_last.get(_tok, 0.0) < _WH_COOLDOWN:
                    return _m.group(0)
                _WH_last[_tok] = _now
                return _tok
            text = _rx.sub(_repl, text)
        return text

    _wh_orig_send = _discord.abc.Messageable.send

    async def _wh_send(self, content=None, **kwargs):
        try:
            _wh_ensure_hopcap()
        except Exception:
            pass
        try:
            if isinstance(content, str) and content:
                content = _wh_rewrite(content)
        except Exception:
            pass
        return await _wh_orig_send(self, content, **kwargs)

    if not getattr(_discord.abc.Messageable.send, "_wh_patched", False):
        _wh_send._wh_patched = True
        _discord.abc.Messageable.send = _wh_send
except Exception:
    pass

# Hard loop cap (backstop): a bot answers peer-bot messages at most _WH_MAX_HOPS
# times per channel between human messages; a human message resets the counter,
# so quick re-tests always work. The gateway loads the adapter file under a
# DYNAMIC module name, so scan sys.modules for the live DiscordAdapter class on
# first send rather than import a fixed name. Dropping in _handle_message also
# suppresses the "interrupting current task" preemption for capped messages.
_WH_MAX_HOPS = 6
_wh_hops = {}            # channel_id -> consecutive peer-bot answers since human
_wh_hopcap_done = [False]

# Address-aware routing: each agent's Discord role id + bot user id. If a HUMAN
# message explicitly @mentions a specific agent (role or user) that isn't me and
# not me, stay silent — so a message aimed at Deckhand doesn't wake Sea Dog.
import os as _os
_WH_AGENTS = {
    "deckhand": {1520336647818838119, 1520179971757310023},
    "seadog": {1519629455297876090, 1519467061397684385},
}
_WH_ROLE = (_os.environ.get("HERMES_ROLE", "") or "").strip().lower()
_WH_MINE = _WH_AGENTS.get(_WH_ROLE, set())
_WH_ALL_AGENTS = set().union(*_WH_AGENTS.values()) if _WH_AGENTS else set()
# Per-bot policy (env WH_REQUIRE_MENTION): true => answer a human only when
# explicitly tagged (Sea Dog); false/unset => read everything except messages
# aimed only at the OTHER agent (Deckhand).
_WH_REQUIRE_MENTION = (_os.environ.get("WH_REQUIRE_MENTION", "") or "").strip().lower() in {"1", "true", "yes", "on"}


def _wh_should_skip_human(message):
    if not _WH_MINE:
        return False
    _addr = set()
    for _u in getattr(message, "mentions", []) or []:
        _i = getattr(_u, "id", None)
        if _i in _WH_ALL_AGENTS:
            _addr.add(_i)
    for _r in getattr(message, "role_mentions", []) or []:
        _i = getattr(_r, "id", None)
        if _i in _WH_ALL_AGENTS:
            _addr.add(_i)
    _me = bool(_addr & _WH_MINE)
    if _WH_REQUIRE_MENTION:
        return not _me                  # mention-required: answer only if tagged
    return bool(_addr) and not _me      # read-all: skip only if aimed at the other


def _wh_make_hm(_orig):
    async def _hm(self, message, role_authorized=False):
        try:
            _ch = str(getattr(getattr(message, "channel", None), "id", ""))
            _abot = bool(getattr(getattr(message, "author", None), "bot", False))
            _me = getattr(getattr(self, "_client", None), "user", None)
            _is_self = _me is not None and message.author == _me
            if not _is_self:
                if not _abot:
                    _wh_hops[_ch] = 0                    # human resets the chain
                    if _wh_should_skip_human(message):
                        return                           # not for me (policy/routing)
                else:
                    _n = _wh_hops.get(_ch, 0) + 1        # peer-bot hop cap
                    _wh_hops[_ch] = _n
                    if _n > _WH_MAX_HOPS:
                        return
        except Exception:
            pass
        return await _orig(self, message, role_authorized)
    return _hm


def _wh_ensure_hopcap():
    if _wh_hopcap_done[0]:
        return
    import sys as _sys
    _patched = False
    for _mod in list(_sys.modules.values()):
        try:
            _c = getattr(_mod, "DiscordAdapter", None)
            if _c is None or getattr(_c, "_wh_hopcap", False):
                continue
            _orig = getattr(_c, "_handle_message", None)
            if _orig is None:
                continue
            _c._handle_message = _wh_make_hm(_orig)
            _c._wh_hopcap = True
            _patched = True
            print("wh-a2a: hop-cap installed on",
                  getattr(_mod, "__name__", "?"), file=_sys.stderr, flush=True)
        except Exception:
            continue
    if _patched:
        _wh_hopcap_done[0] = True


def _wh_poll_hopcap():
    # Install at STARTUP, before messages flow. The gateway loads the adapter a
    # moment after this interpreter starts (under a dynamic module name), so poll
    # briefly until the class appears, then patch and stop.
    import time as _t
    for _ in range(600):
        try:
            _wh_ensure_hopcap()
            if _wh_hopcap_done[0]:
                return
        except Exception:
            pass
        _t.sleep(0.1)


try:
    import threading as _thr
    _thr.Thread(target=_wh_poll_hopcap, name="wh-hopcap", daemon=True).start()
except Exception:
    pass
PYEOF
  chmod 644 /etc/hermes-staging/sitecustomize.py 2>/dev/null || true
fi
