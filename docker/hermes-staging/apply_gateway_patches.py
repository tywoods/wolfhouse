#!/usr/bin/env python3
"""Apply Wolfhouse staging patches to Hermes gateway runtime.

Patches:
- gateway.run Staff Portal inbox mirror / fresh-start runner hook.
- gateway.platforms.base WhatsApp Cloud auto-reply anchor suppression, so
  Luna's guest-facing replies are normal messages instead of quoted replies.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

INBOUND_MIRROR = '''
            try:
                import importlib.util as _wwm_iu
                _wwm_spec = _wwm_iu.spec_from_file_location(
                    "wolfhouse_whatsapp_mirror",
                    "/etc/hermes-staging/wolfhouse_whatsapp_mirror.py",
                )
                _wwm = _wwm_iu.module_from_spec(_wwm_spec)
                _wwm_spec.loader.exec_module(_wwm)
                # Burst coalescer already mirrored each raw inbound wamid.
                # Skip the combined agent-turn event so Inbox stays 1 bubble / message.
                if not getattr(_wwm, "is_coalesced_agent_inbound", lambda _e: False)(event):
                    _wwm.mirror_whatsapp_thread(
                        source,
                        event,
                        "inbound",
                        (getattr(event, "text", None) or message_text),
                        getattr(event, "message_id", None),
                        getattr(source, "user_name", None),
                    )
            except Exception:
                pass
'''

# Outbound Inbox mirror runs only after Meta accepts the send (see POST_SEND_MIRROR_PATCH).

SANITIZE = "response = _sanitize_gateway_final_response(source.platform, response)"
# Output-guard (step 3): scrub guest-facing leaks + emit price/language telemetry
# at the turn handler, where tool results + history are in scope. All real logic is
# in the tested wolfhouse.output_guard.guard_turn_response — this injected block is
# a single defensive call so it can't break gateway.run startup.
OUTPUT_GUARD = '''
            try:
                from wolfhouse.output_guard import guard_turn_response as _wh_guard_turn
                response = _wh_guard_turn(response, agent_result, history, getattr(source, "platform", None))
            except Exception:
                pass
'''
OUTPUT_GUARD_TAG = "guard_turn_response as _wh_guard_turn"
WHATSAPP_TEXT_NORMALIZE = '''
            try:
                import importlib.util as _wwm_iu
                _wwm_spec = _wwm_iu.spec_from_file_location(
                    "wolfhouse_whatsapp_mirror",
                    "/etc/hermes-staging/wolfhouse_whatsapp_mirror.py",
                )
                _wwm = _wwm_iu.module_from_spec(_wwm_spec)
                _wwm_spec.loader.exec_module(_wwm)
                response = _wwm.normalize_whatsapp_message_text(response)
            except Exception:
                pass
'''
# Must match the text INBOUND_MIRROR actually writes (multi-line call) — the old
# single-line tag never matched a patched file, so "already applied" was invisible.
MIRROR_INBOUND_TAG = (
    '_wwm.mirror_whatsapp_thread(\n'
    '                        source,\n'
    '                        event,\n'
    '                        "inbound",'
)
POST_SEND_MIRROR_TAG = "mirror_whatsapp_outbound_after_send("
MIRROR_COALESCE_SKIP_TAG = 'is_coalesced_agent_inbound'

RUNNER_GLOBAL_VAR = "_wolfhouse_gateway_runner = None"
RUNNER_START_ANCHOR = 'logger.info("Starting Hermes Gateway...")'
RUNNER_START_PATCH = (
    'logger.info("Starting Hermes Gateway...")\n'
    '        global _wolfhouse_gateway_runner\n'
    '        _wolfhouse_gateway_runner = self'
)
SAME_LUNA_AUTHOR_START_TAG = "start_same_luna_author_listener"
SAME_LUNA_AUTHOR_START = '''
        try:
            from wolfhouse.email_draft_same_luna import start_same_luna_author_listener
            _same_luna_author = start_same_luna_author_listener()
            if not _same_luna_author.get("started"):
                logger.error("Same-Luna email author probe listener unavailable: %s", _same_luna_author.get("reason", "unknown"))
        except Exception as _same_luna_author_exc:
            logger.exception("Same-Luna email author probe listener startup failed: %s", _same_luna_author_exc)
'''
GATEWAY_RUNNER_CLASS_RE = re.compile(r"^class GatewayRunner\b", re.MULTILINE)

INTERNAL_FILTER_HELPERS = r'''

# Wolfhouse guest-channel hard filter: never send Hermes internal/self-improvement
# status messages to WhatsApp guests.
_WOLFHOUSE_WHATSAPP_SUPPRESS_STATUS_RE = re.compile(
    r"(self.?improvement|skill\s+['\"]?[-\w]+\s+(?:created|saved|updated)|skill\s+(?:created|saved|updated)|auxiliary\s+|compression\s+|compression\.|auto.?compact|hermes\s+config|caps?\s+context|before\s+summariz|preflight|retrying\s+in|rate\s+limited|auto.lowered)",
    re.IGNORECASE,
)

def _wolfhouse_is_whatsapp_internal_status_text(text):
    return bool(_WOLFHOUSE_WHATSAPP_SUPPRESS_STATUS_RE.search(str(text or "").strip()))
'''
INTERNAL_FILTER_TAG = "_wolfhouse_is_whatsapp_internal_status_text"

SET_SESSION_ENV_OLD = '''        from gateway.session_context import set_session_vars
        return set_session_vars(
            platform=context.source.platform.value,
            chat_id=context.source.chat_id,
            chat_name=context.source.chat_name or "",
            thread_id=str(context.source.thread_id) if context.source.thread_id else "",
            user_id=str(context.source.user_id) if context.source.user_id else "",
            user_name=str(context.source.user_name) if context.source.user_name else "",
            session_key=context.session_key,
            message_id=str(context.source.message_id) if context.source.message_id else "",
        )'''

SET_SESSION_ENV_NEW = '''        from gateway.session_context import set_session_vars
        if __import__("os").environ.get("HERMES_ROLE") == "sunset-luna":
            from sunset_tenant_routing import bind_gateway_location
            _sunset_location = bind_gateway_location(context.source)
            # Tool execution can cross a ContextVar boundary. Keep a turn-scoped
            # fallback, cleared in _clear_session_env below.
            __import__("os").environ["SUNSET_INGRESS_LOCATION_ID"] = _sunset_location
        # Wolfhouse WhatsApp tools need the guest phone. ContextVars can be lost
        # across some tool execution paths, so also expose a per-turn process-env
        # fallback while this turn is running.
        if context.source.platform.value in {"whatsapp", "whatsapp_cloud"}:
            import os as _wolfhouse_os
            _wolfhouse_digits = "".join(ch for ch in str(context.source.user_id or context.source.chat_id or "") if ch.isdigit())
            if _wolfhouse_digits:
                _wolfhouse_phone = "+" + _wolfhouse_digits
                _wolfhouse_os.environ["WOLFHOUSE_WHATSAPP_GUEST_PHONE"] = _wolfhouse_phone
                _wolfhouse_os.environ["WHATSAPP_GUEST_PHONE"] = _wolfhouse_phone
                _wolfhouse_os.environ["HERMES_SESSION_USER_ID"] = str(context.source.user_id or "")
                _wolfhouse_os.environ["HERMES_SESSION_CHAT_ID"] = str(context.source.chat_id or "")
        return set_session_vars(
            platform=context.source.platform.value,
            chat_id=context.source.chat_id,
            chat_name=context.source.chat_name or "",
            thread_id=str(context.source.thread_id) if context.source.thread_id else "",
            user_id=str(context.source.user_id) if context.source.user_id else "",
            user_name=str(context.source.user_name) if context.source.user_name else "",
            session_key=context.session_key,
            message_id=str(context.source.message_id) if context.source.message_id else "",
        )'''

CLEAR_SESSION_ENV_OLD = '''        from gateway.session_context import clear_session_vars
        clear_session_vars(tokens)'''

CLEAR_SESSION_ENV_NEW = '''        from gateway.session_context import clear_session_vars
        if __import__("os").environ.get("HERMES_ROLE") == "sunset-luna":
            from sunset_tenant_routing import clear_current_location
            clear_current_location()
        try:
            import os as _wolfhouse_os
            # Clear only turn-scoped guest phone fallbacks. The Sunset ingress
            # binding is runtime-scoped (one WhatsApp number = one school) and must
            # survive every turn; deleting it caused the first quote to work and
            # every later tool call to lose location_id.
            for _wolfhouse_key in ("WOLFHOUSE_WHATSAPP_GUEST_PHONE", "WHATSAPP_GUEST_PHONE"):
                _wolfhouse_os.environ.pop(_wolfhouse_key, None)
        except Exception:
            pass
        clear_session_vars(tokens)'''

# Agent turn handler — patch only this site (not other sanitize calls in gateway.run).
# The first pass (image build) inserts the output-guard block between the normalize
# and sanitize calls. bootstrap.sh re-runs this script on every container start, and
# cleanup_stale_patches() strips only the _wwm mirror blocks — so on the re-run the
# guard block still sits between the two calls. The anchor must therefore tolerate
# an optional, already-inserted guard block, otherwise the boot re-run dies with
# "turn-handler anchor not found" (bootstrap exit 1) even though every patch is in
# place. The guard block is captured so an existing (possibly newer) _wh_guard_turn
# call survives re-patching verbatim instead of being downgraded.
TURN_ANCHOR_RE = re.compile(
    r"response = _normalize_empty_agent_response\(\s*"
    r"agent_result, response, history_len=len\(history\),\s*\)\s*"
    r"(?P<guard>try:\s*"
    r"from wolfhouse\.output_guard import guard_turn_response as _wh_guard_turn\s*"
    r"response = _wh_guard_turn\([^\n]*\)\s*"
    r"except Exception:\s*pass)?\s*"
    r"response = _sanitize_gateway_final_response\(source\.platform, response\)",
    re.MULTILINE,
)

BASE_REPLY_ANCHOR_OLD = '    if platform == "feishu" and thread_id and getattr(event, "reply_to_message_id", None):\n        return getattr(event, "reply_to_message_id", None)\n    return getattr(event, "message_id", None)\n'

BASE_REPLY_ANCHOR_NEW = '    if platform == "feishu" and thread_id and getattr(event, "reply_to_message_id", None):\n        return getattr(event, "reply_to_message_id", None)\n    # WhatsApp Cloud renders ``context.message_id`` as a quoted reply block\n    # ("You / <guest message>") above Luna\'s answer. For guest-facing chats\n    # that feels noisy and robotic; route replies as normal messages unless a\n    # caller explicitly passes reply_to to the adapter.\n    if platform in {"whatsapp", "whatsapp_cloud"}:\n        return None\n    return getattr(event, "message_id", None)\n'

WHATSAPP_SEND_ANCHOR = '        if not content or not content.strip():\n            return SendResult(success=True, message_id=None)\n'
WHATSAPP_SEND_FILTER = '        if _wolfhouse_is_whatsapp_internal_status_text(content):\n            return SendResult(success=True, message_id=None, raw_response={"suppressed_internal_status": True})\n        if not content or not content.strip():\n            return SendResult(success=True, message_id=None)\n'
LUNA_PLAIN_REPLY_SEND_TAG = "# Wolfhouse Luna: normal WhatsApp replies without quote blocks."
LUNA_PLAIN_REPLY_CHUNK_TAG = "# Wolfhouse Luna: skip WhatsApp quote context unless interactive."
LUNA_PLAIN_REPLY_SEND_BLOCK = '''
        # Wolfhouse: plain WhatsApp replies unless caller sets wolfhouse_quote_reply.
        _wh_meta = metadata if isinstance(metadata, dict) else {}
        _wh_allow_quote = bool(_wh_meta.get("wolfhouse_quote_reply") or _wh_meta.get("quote_reply"))
        if not _wh_allow_quote:
            reply_to = None
'''
WHATSAPP_SEND_FORMATTED_ANCHOR = (
    '        if not content or not content.strip():\n'
    '            return SendResult(success=True, message_id=None)\n\n'
    '        formatted = self.format_message(content)'
)
WHATSAPP_SEND_FORMATTED_PATCH = (
    '        if not content or not content.strip():\n'
    '            return SendResult(success=True, message_id=None)\n'
    + LUNA_PLAIN_REPLY_SEND_BLOCK
    + '\n        formatted = self.format_message(content)'
)
# Guest send guard injects suppress_guest_whatsapp_text_send immediately before
# format_message; plain-reply must still apply when that block is already present.
GUEST_SEND_GUARD_BLOCK = """
        try:
            from wolfhouse.guest_send_guard import suppress_guest_whatsapp_text_send
            if suppress_guest_whatsapp_text_send(content, metadata):
                return SendResult(success=True, message_id=None, raw_response={"suppressed_guest_system_send": True})
        except Exception:
            pass
"""
GUEST_SEND_GUARD_BLOCK_ANCHOR = "        try:\n            from wolfhouse.guest_send_guard import suppress_guest_whatsapp_text_send"
_FORMAT_LINE = "        formatted = self.format_message(content)"
WHATSAPP_SEND_GUARDED_FORMAT_ANCHOR = (
    '        if not content or not content.strip():\n'
    '            return SendResult(success=True, message_id=None)\n\n'
    + GUEST_SEND_GUARD_BLOCK.strip()
    + "\n"
    + _FORMAT_LINE
)
WHATSAPP_SEND_GUARDED_FORMAT_PATCH = (
    '        if not content or not content.strip():\n'
    '            return SendResult(success=True, message_id=None)\n'
    + LUNA_PLAIN_REPLY_SEND_BLOCK
    + "\n"
    + GUEST_SEND_GUARD_BLOCK
    + "\n"
    + _FORMAT_LINE
)
WHATSAPP_SEND_POST_FILTER_GUARD_ANCHOR = (
    '        if _wolfhouse_is_whatsapp_internal_status_text(content):\n'
    '            return SendResult(success=True, message_id=None, raw_response={"suppressed_internal_status": True})\n'
    '        if not content or not content.strip():\n'
    '            return SendResult(success=True, message_id=None)\n\n'
    + GUEST_SEND_GUARD_BLOCK.strip()
    + "\n"
    + _FORMAT_LINE
)
WHATSAPP_SEND_POST_FILTER_GUARD_PATCH = (
    '        if _wolfhouse_is_whatsapp_internal_status_text(content):\n'
    '            return SendResult(success=True, message_id=None, raw_response={"suppressed_internal_status": True})\n'
    '        if not content or not content.strip():\n'
    '            return SendResult(success=True, message_id=None)\n'
    + LUNA_PLAIN_REPLY_SEND_BLOCK
    + "\n"
    + GUEST_SEND_GUARD_BLOCK
    + "\n"
    + _FORMAT_LINE
)
WHATSAPP_SEND_POST_FILTER_ANCHOR = (
    '        if _wolfhouse_is_whatsapp_internal_status_text(content):\n'
    '            return SendResult(success=True, message_id=None, raw_response={"suppressed_internal_status": True})\n'
    '        if not content or not content.strip():\n'
    '            return SendResult(success=True, message_id=None)\n\n'
    '        formatted = self.format_message(content)'
)
WHATSAPP_SEND_POST_FILTER_PATCH = (
    '        if _wolfhouse_is_whatsapp_internal_status_text(content):\n'
    '            return SendResult(success=True, message_id=None, raw_response={"suppressed_internal_status": True})\n'
    '        if not content or not content.strip():\n'
    '            return SendResult(success=True, message_id=None)\n'
    + LUNA_PLAIN_REPLY_SEND_BLOCK
    + '\n        formatted = self.format_message(content)'
)
WHATSAPP_CHUNK_CONTEXT_ANCHOR = (
    '            if reply_to and idx == 0:\n'
    '                # Quote the user\'s message on the first chunk only.\n'
    '                payload["context"] = {"message_id": reply_to}'
)
WHATSAPP_CHUNK_CONTEXT_PATCH = '''            if reply_to and idx == 0:
                _wh_meta = metadata if isinstance(metadata, dict) else {}
                _wh_allow_quote = bool(_wh_meta.get("wolfhouse_quote_reply") or _wh_meta.get("quote_reply"))
                if _wh_allow_quote:
                    # Quote the user's message on the first chunk only.
                    payload["context"] = {"message_id": reply_to}'''
STREAM_CONSUMER_HELPER_TAG = "def _wolfhouse_stream_reply_anchor("
STREAM_CONSUMER_HELPERS = '''

def _wolfhouse_whatsapp_platform_name(adapter):
    if adapter is None:
        return ""
    plat = getattr(adapter, "platform", None)
    return str(getattr(plat, "value", plat) or getattr(adapter, "name", "") or "").lower()


def _wolfhouse_stream_reply_anchor(outbound_message_id, initial_reply_to_id, adapter=None):
    """WhatsApp guest chat: never quote the inbound guest message."""
    if outbound_message_id:
        return outbound_message_id
    if _wolfhouse_whatsapp_platform_name(adapter) in ("whatsapp", "whatsapp_cloud"):
        return None
    return initial_reply_to_id
'''
STREAM_REPLY_TO_ANCHOR_OLD = "reply_to = self._message_id or self._initial_reply_to_id"
STREAM_REPLY_TO_ANCHOR_NEW = "reply_to = _wolfhouse_stream_reply_anchor(self._message_id, self._initial_reply_to_id, self.adapter)"
STREAM_FIRST_SEND_ANCHOR_OLD = "reply_to=self._initial_reply_to_id,"
STREAM_FIRST_SEND_ANCHOR_NEW = "reply_to=_wolfhouse_stream_reply_anchor(self._message_id, self._initial_reply_to_id, self.adapter),"
STREAM_SEND_CHUNK_ANCHOR_OLD = "            reply_to=reply_to_id,"
STREAM_SEND_CHUNK_ANCHOR_NEW = "            reply_to=_wolfhouse_stream_reply_anchor(None, reply_to_id, self.adapter),"
STREAM_INITIAL_REPLY_OLD = "initial_reply_to_id=event_message_id,"
STREAM_INITIAL_REPLY_NEW = '''initial_reply_to_id=(
                None
                if str(getattr(source.platform, "value", source.platform or "")).lower() in ("whatsapp", "whatsapp_cloud")
                else event_message_id
            ),'''
WHATSAPP_SEND_HELPERS = r'''

import re as _wolfhouse_re
_WOLFHOUSE_WHATSAPP_SUPPRESS_STATUS_RE = _wolfhouse_re.compile(
    r"(self.?improvement|skill\s+['\"]?[-\w]+\s+(?:created|saved|updated)|skill\s+(?:created|saved|updated)|auxiliary\s+|compression\s+|compression\.|auto.?compact|hermes\s+config|caps?\s+context|before\s+summariz|preflight|retrying\s+in|rate\s+limited|auto.lowered)",
    _wolfhouse_re.IGNORECASE,
)

def _wolfhouse_is_whatsapp_internal_status_text(text):
    return bool(_WOLFHOUSE_WHATSAPP_SUPPRESS_STATUS_RE.search(str(text or "").strip()))
'''

SESSION_STALE_TAG = "# Wolfhouse: stale routing when SQLite session row was deleted/pruned."
SESSION_STALE_TAG_OLD = "# Wolfhouse: stale routing when SQLite session was deleted or ended."
SESSION_STALE_PATCH = '''
            # Wolfhouse: stale routing when SQLite session row was deleted/pruned.
            # Do NOT treat ended_at as stale — agent_close sets ended_at after every
            # gateway turn; reusing the same session_key/session_id is normal.
            if not force_new and session_key in self._entries and self._db:
                _wh_e = self._entries[session_key]
                if _wh_e and getattr(_wh_e, "session_id", None):
                    try:
                        _wh_row = self._db.get_session(_wh_e.session_id)
                    except Exception:
                        _wh_row = None
                    if _wh_row is None:
                        del self._entries[session_key]
                        self._save()
                        force_new = True
'''
SESSION_STALE_ENDED_AT_OLD = "                    if _wh_row is None or _wh_row.get(\"ended_at\"):"
SESSION_STALE_ENDED_AT_NEW = "                    if _wh_row is None:"

LUNA_PERSONALITY_BIND_TAG = "bind_whatsapp_turn_personality"
LUNA_PERSONALITY_BIND_PATCH = '''
        # Wolfhouse Luna Personality: bind WhatsApp style pack once per turn.
        try:
            from wolfhouse.luna_personality import bind_whatsapp_turn_personality as _wh_bind_lp
            _wh_bind_lp(source)
        except Exception:
            pass
'''
LUNA_PERSONALITY_CLEAR_TAG = "clear_bound_personality"
LUNA_SOUL_RELOAD_TAG = "# Wolfhouse Luna: rebuild agent each turn so SOUL.md changes apply."
LUNA_SOUL_RELOAD_PATCH = '''
        # Wolfhouse Luna: rebuild agent each turn so SOUL.md changes apply.
        import os as _wolfhouse_soul_os
        from wolfhouse.luna_personality import should_rebuild_cached_agent as _wh_lp_rebuild
        _wolfhouse_plat = getattr(source.platform, "value", str(source.platform or ""))
        if _wh_lp_rebuild(_wolfhouse_soul_os.getenv("HERMES_ROLE"), _wolfhouse_plat):
            self._evict_cached_agent(session_key)
'''
LUNA_SOUL_RELOAD_PATCH_12 = '''
            # Wolfhouse Luna: rebuild agent each turn so SOUL.md changes apply.
            import os as _wolfhouse_soul_os
            from wolfhouse.luna_personality import should_rebuild_cached_agent as _wh_lp_rebuild
            _wolfhouse_plat = getattr(source.platform, "value", str(source.platform or ""))
            if _wh_lp_rebuild(_wolfhouse_soul_os.getenv("HERMES_ROLE"), _wolfhouse_plat):
                self._evict_cached_agent(session_key)
'''
SOUL_RELOAD_ANCHORS = (
    (
        "        agent = None\n"
        "        _cache_lock = getattr(self, \"_agent_cache_lock\", None)\n"
        "        _cache = getattr(self, \"_agent_cache\", None)",
        LUNA_SOUL_RELOAD_PATCH,
    ),
    (
        "            agent = None\n"
        "            _cache_lock = getattr(self, \"_agent_cache_lock\", None)\n"
        "            _cache = getattr(self, \"_agent_cache\", None)",
        LUNA_SOUL_RELOAD_PATCH_12,
    ),
)

RUNTIME_PATCH_HOOK_TAG = "# Wolfhouse: install runtime WhatsApp patches when gateway loads."
RUNTIME_PATCH_HOOK = '''
# Wolfhouse: install runtime WhatsApp patches when gateway loads.
try:
    import importlib.util as _wh_patch_iu
    _wh_patch_spec = _wh_patch_iu.spec_from_file_location(
        "wolfhouse_apply_gateway_patches",
        "/etc/hermes-staging/apply_gateway_patches.py",
    )
    if _wh_patch_spec and _wh_patch_spec.loader:
        _wh_patch_mod = _wh_patch_iu.module_from_spec(_wh_patch_spec)
        _wh_patch_spec.loader.exec_module(_wh_patch_mod)
        _wh_patch_mod.install_runtime_whatsapp_patches()
except Exception:
    pass
'''


# --- Anthropic OAuth login token-endpoint fix ---------------------------------
# Hermes v0.16.0's CLI OAuth *login* path (run_hermes_oauth_login_pure in
# agent/anthropic_adapter.py) POSTs the authorization-code exchange to a single
# hardcoded endpoint, _OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token".
# Anthropic moved the Claude Max/Code token endpoint to platform.claude.com, so
# that exchange now 404s and login fails ("Token exchange failed: HTTP Error 404").
# The *refresh* path in the same file already tries platform.claude.com first and
# falls back to console.anthropic.com — the login path was simply never updated.
# This patch rewrites the single-endpoint exchange into the same ordered fallback
# loop so `hermes auth add anthropic --type oauth` succeeds. Idempotent.
ANTHROPIC_OAUTH_LOGIN_OLD = '''        req = urllib.request.Request(
            _OAUTH_TOKEN_URL,
            data=exchange_data,
            headers={
                "Content-Type": "application/json",
                "User-Agent": f"claude-cli/{_get_claude_code_version()} (external, cli)",
            },
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode())
    except Exception as e:
        print(f"Token exchange failed: {e}")
        return None'''

ANTHROPIC_OAUTH_LOGIN_NEW = '''        _login_token_endpoints = [
            "https://platform.claude.com/v1/oauth/token",
            "https://console.anthropic.com/v1/oauth/token",
        ]
        result = None
        _last_err = None
        for _endpoint in _login_token_endpoints:
            try:
                req = urllib.request.Request(
                    _endpoint,
                    data=exchange_data,
                    headers={
                        "Content-Type": "application/json",
                        "User-Agent": f"claude-cli/{_get_claude_code_version()} (external, cli)",
                    },
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    result = json.loads(resp.read().decode())
                break
            except Exception as _e:
                _last_err = _e
                continue
        if result is None:
            print(f"Token exchange failed: {_last_err}")
            return None
    except Exception as e:
        print(f"Token exchange failed: {e}")
        return None'''

ANTHROPIC_OAUTH_PATCH_TAG = "_login_token_endpoints = ["


def apply_anthropic_oauth_patch(adapter_path: Path) -> dict:
    s = adapter_path.read_text(encoding="utf-8")
    already = ANTHROPIC_OAUTH_PATCH_TAG in s
    if not already:
        if ANTHROPIC_OAUTH_LOGIN_OLD not in s:
            # Upstream may have fixed this themselves; don't hard-fail the boot.
            return {
                "path": str(adapter_path),
                "anthropic_oauth_login_fallback": False,
                "note": "login-exchange anchor not found (already fixed upstream?)",
            }
        s = s.replace(ANTHROPIC_OAUTH_LOGIN_OLD, ANTHROPIC_OAUTH_LOGIN_NEW, 1)
        adapter_path.write_text(s, encoding="utf-8")
    _compile_check(adapter_path)
    return {
        "path": str(adapter_path),
        "anthropic_oauth_login_fallback": ANTHROPIC_OAUTH_PATCH_TAG in s,
    }


def _compile_check(path: Path) -> None:
    compile(path.read_text(encoding="utf-8"), str(path), "exec")


def cleanup_stale_patches(s: str) -> str:
    s = re.sub(
        r"\ndef _strip_whatsapp_exact_echo\b.*?(?=\ndef [a-zA-Z_])",
        "",
        s,
        flags=re.DOTALL,
    )
    s = re.sub(
        r"\n\s*response = _strip_whatsapp_exact_echo\([^\n]+\)",
        "",
        s,
    )
    s = re.sub(
        r"\n\s*try:\s*\n\s*import importlib\.util as _wwm_iu.*?except Exception:\s*\n\s*pass",
        "",
        s,
        flags=re.DOTALL,
    )
    return s


def apply_base_platform_patch(base_path: Path) -> dict:
    s = base_path.read_text(encoding="utf-8")
    if BASE_REPLY_ANCHOR_NEW not in s:
        if BASE_REPLY_ANCHOR_OLD not in s:
            raise RuntimeError("gateway.platforms.base reply-anchor anchor not found")
        s = s.replace(BASE_REPLY_ANCHOR_OLD, BASE_REPLY_ANCHOR_NEW, 1)
        base_path.write_text(s, encoding="utf-8")
    _compile_check(base_path)
    return {
        "path": str(base_path),
        "whatsapp_auto_reply_anchor_disabled": BASE_REPLY_ANCHOR_NEW in s,
    }


def apply_session_store_patch(session_path: Path) -> dict:
    s = session_path.read_text(encoding="utf-8")
    anchor = (
        "        with self._lock:\n"
        "            self._ensure_loaded_locked()\n\n"
        "            if session_key in self._entries and not force_new:"
    )
    replacement = (
        "        with self._lock:\n"
        "            self._ensure_loaded_locked()\n"
        + SESSION_STALE_PATCH
        + "\n            if session_key in self._entries and not force_new:"
    )
    upgraded_ended_at = False
    if SESSION_STALE_ENDED_AT_OLD in s:
        s = s.replace(SESSION_STALE_ENDED_AT_OLD, SESSION_STALE_ENDED_AT_NEW, 1)
        session_path.write_text(s, encoding="utf-8")
        upgraded_ended_at = True
        s = session_path.read_text(encoding="utf-8")
    if SESSION_STALE_TAG_OLD in s:
        s = s.replace(SESSION_STALE_TAG_OLD, SESSION_STALE_TAG, 1)
        session_path.write_text(s, encoding="utf-8")
        s = session_path.read_text(encoding="utf-8")
    if SESSION_STALE_TAG not in s:
        if anchor not in s:
            raise RuntimeError("gateway.session get_or_create_session anchor not found")
        s = s.replace(anchor, replacement, 1)
        session_path.write_text(s, encoding="utf-8")
    _compile_check(session_path)
    final = session_path.read_text(encoding="utf-8")
    return {
        "path": str(session_path),
        "session_stale_routing_skip": SESSION_STALE_TAG in final,
        "session_stale_ignores_agent_close": SESSION_STALE_ENDED_AT_OLD not in final,
        "session_stale_upgraded_ended_at": upgraded_ended_at,
    }


def apply_whatsapp_cloud_patch(whatsapp_path: Path) -> dict:
    s = whatsapp_path.read_text(encoding="utf-8")
    if "_wolfhouse_is_whatsapp_internal_status_text" not in s:
        if "from __future__ import annotations\n" in s:
            s = s.replace("from __future__ import annotations\n", "from __future__ import annotations\n" + WHATSAPP_SEND_HELPERS, 1)
        else:
            s = WHATSAPP_SEND_HELPERS + "\n" + s
    if WHATSAPP_SEND_FILTER not in s:
        if WHATSAPP_SEND_ANCHOR not in s:
            raise RuntimeError("whatsapp_cloud send anchor not found for Wolfhouse internal filter")
        s = s.replace(WHATSAPP_SEND_ANCHOR, WHATSAPP_SEND_FILTER, 1)
    if LUNA_PLAIN_REPLY_SEND_TAG not in s:
        if WHATSAPP_SEND_POST_FILTER_ANCHOR in s:
            s = s.replace(WHATSAPP_SEND_POST_FILTER_ANCHOR, WHATSAPP_SEND_POST_FILTER_PATCH, 1)
        elif WHATSAPP_SEND_POST_FILTER_GUARD_ANCHOR in s:
            s = s.replace(WHATSAPP_SEND_POST_FILTER_GUARD_ANCHOR, WHATSAPP_SEND_POST_FILTER_GUARD_PATCH, 1)
        elif WHATSAPP_SEND_FORMATTED_ANCHOR in s:
            s = s.replace(WHATSAPP_SEND_FORMATTED_ANCHOR, WHATSAPP_SEND_FORMATTED_PATCH, 1)
        elif WHATSAPP_SEND_GUARDED_FORMAT_ANCHOR in s:
            s = s.replace(WHATSAPP_SEND_GUARDED_FORMAT_ANCHOR, WHATSAPP_SEND_GUARDED_FORMAT_PATCH, 1)
        elif GUEST_SEND_GUARD_BLOCK_ANCHOR in s:
            s = s.replace(
                GUEST_SEND_GUARD_BLOCK_ANCHOR,
                LUNA_PLAIN_REPLY_SEND_BLOCK.strip() + "\n" + GUEST_SEND_GUARD_BLOCK_ANCHOR,
                1,
            )
    else:
        old_send = "if _wolfhouse_wa_send_os.getenv(\"HERMES_ROLE\") == \"luna\" and not _wh_allow_quote:"
        if old_send in s:
            s = s.replace(
                '''        # Wolfhouse Luna: normal WhatsApp replies without quote blocks.
        import os as _wolfhouse_wa_send_os
        _wh_meta = metadata if isinstance(metadata, dict) else {}
        _wh_allow_quote = bool(_wh_meta.get("wolfhouse_quote_reply") or _wh_meta.get("quote_reply"))
        if _wolfhouse_wa_send_os.getenv("HERMES_ROLE") == "luna" and not _wh_allow_quote:
            reply_to = None''',
                LUNA_PLAIN_REPLY_SEND_BLOCK.strip(),
            )
    if WHATSAPP_CHUNK_CONTEXT_PATCH not in s and WHATSAPP_CHUNK_CONTEXT_ANCHOR in s:
        s = s.replace(WHATSAPP_CHUNK_CONTEXT_ANCHOR, WHATSAPP_CHUNK_CONTEXT_PATCH, 1)
    # Upgrade older Wolfhouse chunk patch that still quoted unless HERMES_ROLE=luna.
    old_chunk = "if _wh_allow_quote or _wolfhouse_wa_ctx_os.getenv(\"HERMES_ROLE\") not in (\"luna\",):"
    if old_chunk in s:
        s = s.replace(
            '''            if reply_to and idx == 0:
            # Wolfhouse Luna: skip WhatsApp quote context unless interactive.
            import os as _wolfhouse_wa_ctx_os
            _wh_meta = metadata if isinstance(metadata, dict) else {}
            _wh_allow_quote = bool(_wh_meta.get("wolfhouse_quote_reply") or _wh_meta.get("quote_reply"))
            if _wh_allow_quote or _wolfhouse_wa_ctx_os.getenv("HERMES_ROLE") not in ("luna",):
                # Quote the user's message on the first chunk only.
                payload["context"] = {"message_id": reply_to}''',
            WHATSAPP_CHUNK_CONTEXT_PATCH,
            1,
        )
    whatsapp_path.write_text(s, encoding="utf-8")
    _compile_check(whatsapp_path)
    return {
        "path": str(whatsapp_path),
        "internal_status_send_filter": WHATSAPP_SEND_FILTER in s,
        "luna_plain_reply_send": "if not _wh_allow_quote" in s,
        "luna_plain_reply_chunk_context": "if _wh_allow_quote" in s and "wolfhouse_quote_reply" in s,
    }


def apply_stream_consumer_patch(stream_path: Path) -> dict:
    s = stream_path.read_text(encoding="utf-8")
    # Upgrade prior Wolfhouse helper to adapter-aware version.
    if "_wolfhouse_whatsapp_platform_name" not in s:
        old_helper = re.compile(
            r"\ndef _wolfhouse_stream_reply_anchor\(outbound_message_id, initial_reply_to_id\):.*?"
            r"\n    return outbound_message_id or initial_reply_to_id\n",
            re.DOTALL,
        )
        if old_helper.search(s):
            s = old_helper.sub(STREAM_CONSUMER_HELPERS, s, count=1)
        elif STREAM_CONSUMER_HELPER_TAG not in s:
            anchor = 'logger = logging.getLogger("gateway.stream_consumer")\n'
            if anchor not in s:
                raise RuntimeError("gateway.stream_consumer logger anchor not found")
            s = s.replace(anchor, anchor + STREAM_CONSUMER_HELPERS, 1)
    if "self._initial_reply_to_id, self.adapter)" not in s:
        s = s.replace(
            "reply_to = _wolfhouse_stream_reply_anchor(self._message_id, self._initial_reply_to_id)",
            STREAM_REPLY_TO_ANCHOR_NEW,
        )
        s = s.replace(
            "reply_to=_wolfhouse_stream_reply_anchor(None, self._initial_reply_to_id),",
            STREAM_FIRST_SEND_ANCHOR_NEW,
        )
    if STREAM_REPLY_TO_ANCHOR_OLD in s:
        s = s.replace(STREAM_REPLY_TO_ANCHOR_OLD, STREAM_REPLY_TO_ANCHOR_NEW, 1)
    if STREAM_FIRST_SEND_ANCHOR_OLD in s:
        s = s.replace(STREAM_FIRST_SEND_ANCHOR_OLD, STREAM_FIRST_SEND_ANCHOR_NEW, 1)
    if STREAM_SEND_CHUNK_ANCHOR_NEW not in s and STREAM_SEND_CHUNK_ANCHOR_OLD in s:
        s = s.replace(STREAM_SEND_CHUNK_ANCHOR_OLD, STREAM_SEND_CHUNK_ANCHOR_NEW, 1)
    stream_path.write_text(s, encoding="utf-8")
    _compile_check(stream_path)
    return {
        "path": str(stream_path),
        "stream_reply_anchor_helper": STREAM_CONSUMER_HELPER_TAG in s,
        "stream_reply_to_patch": STREAM_REPLY_TO_ANCHOR_NEW in s,
        "stream_first_send_patch": STREAM_FIRST_SEND_ANCHOR_NEW in s,
        "stream_send_chunk_patch": STREAM_SEND_CHUNK_ANCHOR_NEW in s,
    }


def apply_run_plain_reply_patch(run_path: Path) -> dict:
    """Idempotent run.py hooks for Luna plain WhatsApp replies (no inbox mirror)."""
    s = run_path.read_text(encoding="utf-8")
    logger_anchor = "logger = logging.getLogger(__name__)\n"
    if RUNTIME_PATCH_HOOK_TAG not in s and logger_anchor in s:
        s = s.replace(logger_anchor, logger_anchor + RUNTIME_PATCH_HOOK, 1)
    if STREAM_INITIAL_REPLY_NEW not in s:
        if 'HERMES_ROLE") == "luna"' in s and "initial_reply_to_id=(" in s:
            s = re.sub(
                r"initial_reply_to_id=\(\s*\n\s*None\s*\n\s*if __import__\(\"os\"\)\.getenv\(\"HERMES_ROLE\"\) == \"luna\"\s*\n\s*and str\(getattr\(source\.platform, \"value\", source\.platform or \"\"\)\)\.lower\(\) in \(\"whatsapp\", \"whatsapp_cloud\"\)\s*\n\s*else event_message_id\s*\n\s*\),",
                STREAM_INITIAL_REPLY_NEW.strip(),
                s,
                count=2,
            )
        elif STREAM_INITIAL_REPLY_OLD in s:
            s = s.replace(STREAM_INITIAL_REPLY_OLD, STREAM_INITIAL_REPLY_NEW)
    run_path.write_text(s, encoding="utf-8")
    _compile_check(run_path)
    return {
        "path": str(run_path),
        "runtime_whatsapp_patch_hook": RUNTIME_PATCH_HOOK_TAG in s,
        "stream_initial_reply_luna": STREAM_INITIAL_REPLY_NEW.split("\n", 1)[0] in s,
    }


def apply_patches(run_path: Path) -> dict:
    s = cleanup_stale_patches(run_path.read_text(encoding="utf-8"))

    if RUNNER_GLOBAL_VAR not in s:
        match = GATEWAY_RUNNER_CLASS_RE.search(s)
        if not match:
            raise RuntimeError("GatewayRunner class anchor not found for fresh-start hook")
        s = s[:match.start()] + RUNNER_GLOBAL_VAR + "\n\n" + s[match.start():]

    if RUNNER_START_PATCH not in s and RUNNER_START_ANCHOR in s:
        s = s.replace(RUNNER_START_ANCHOR, RUNNER_START_PATCH, 1)
    if SAME_LUNA_AUTHOR_START_TAG not in s and "_wolfhouse_gateway_runner = self" in s:
        s = s.replace(
            "        _wolfhouse_gateway_runner = self",
            "        _wolfhouse_gateway_runner = self" + SAME_LUNA_AUTHOR_START,
            1,
        )

    if INTERNAL_FILTER_TAG not in s:
        if "\nimport re\n" not in s and "\nimport re\r\n" not in s:
            raise RuntimeError("gateway.run import re anchor not found for Wolfhouse internal filter")
        s = s.replace("\nimport re\n", "\nimport re\n" + INTERNAL_FILTER_HELPERS, 1)

    if SET_SESSION_ENV_OLD in s:
        s = s.replace(SET_SESSION_ENV_OLD, SET_SESSION_ENV_NEW, 1)
    if CLEAR_SESSION_ENV_OLD in s:
        s = s.replace(CLEAR_SESSION_ENV_OLD, CLEAR_SESSION_ENV_NEW, 1)

    prepare_marker = '    if _gateway_platform_value(platform) != "telegram":\n        return text'
    prepare_replacement = '    if _gateway_platform_value(platform) in {"whatsapp", "whatsapp_cloud"} and _wolfhouse_is_whatsapp_internal_status_text(text):\n        return None\n    if _gateway_platform_value(platform) != "telegram":\n        return text'
    if prepare_marker in s and prepare_replacement not in s:
        s = s.replace(prepare_marker, prepare_replacement, 1)

    if MIRROR_INBOUND_TAG not in s:
        turn_match = TURN_ANCHOR_RE.search(s)
        if turn_match:
            existing_guard = turn_match.group("guard")
            guard_block = (
                "\n            " + existing_guard + "\n" if existing_guard else OUTPUT_GUARD
            )
            replacement = (
                "response = _normalize_empty_agent_response(\n"
                " agent_result, response, history_len=len(history),\n"
                " )\n"
                + guard_block
                + INBOUND_MIRROR
                + WHATSAPP_TEXT_NORMALIZE
                + "\n            "
                + SANITIZE
            )
            # Splice by index (not re.sub) so backslashes in the captured guard
            # block can never be misread as regex group references.
            s = s[: turn_match.start()] + replacement + s[turn_match.end():]
        elif MIRROR_INBOUND_TAG not in s:
            raise RuntimeError("gateway.run turn-handler anchor not found for inbox mirror")

    # Idempotent fallback: if the mirror block was already applied on a prior pass
    # (so the anchor above no longer matches) but the output-guard isn't present,
    # insert it right after the normalize call.
    if OUTPUT_GUARD_TAG not in s:
        _norm_marker = (
            "response = _normalize_empty_agent_response(\n"
            " agent_result, response, history_len=len(history),\n"
            " )\n"
        )
        if _norm_marker in s:
            s = s.replace(_norm_marker, _norm_marker + OUTPUT_GUARD, 1)

    _old_guard_call = "response = _wh_guard_turn(response, agent_result, history)"
    _new_guard_call = (
        "response = _wh_guard_turn(response, agent_result, history, "
        "getattr(source, \"platform\", None))"
    )
    if _old_guard_call in s and _new_guard_call not in s:
        s = s.replace(_old_guard_call, _new_guard_call, 1)

    if LUNA_PERSONALITY_BIND_TAG not in s:
        for soul_anchor, _soul_patch in SOUL_RELOAD_ANCHORS:
            if soul_anchor not in s:
                continue
            s = s.replace(soul_anchor, LUNA_PERSONALITY_BIND_PATCH + "\n" + soul_anchor, 1)
            break
    if LUNA_PERSONALITY_CLEAR_TAG not in s:
        clear_anchor = (
            '            for _wolfhouse_key in ("WOLFHOUSE_WHATSAPP_GUEST_PHONE", "WHATSAPP_GUEST_PHONE"):\n'
            '                _wolfhouse_os.environ.pop(_wolfhouse_key, None)\n'
            '        except Exception:\n'
            '            pass\n'
            '        clear_session_vars(tokens)'
        )
        if clear_anchor in s:
            s = s.replace(
                clear_anchor,
                '            for _wolfhouse_key in ("WOLFHOUSE_WHATSAPP_GUEST_PHONE", "WHATSAPP_GUEST_PHONE"):\n'
                '                _wolfhouse_os.environ.pop(_wolfhouse_key, None)\n'
                '            from wolfhouse.luna_personality import clear_bound_personality as _wh_clear_lp\n'
                '            _wh_clear_lp()\n'
                '        except Exception:\n'
                '            pass\n'
                '        clear_session_vars(tokens)',
                1,
            )
    soul_note = None
    if LUNA_SOUL_RELOAD_TAG not in s:
        applied_soul = False
        for soul_anchor, soul_patch in SOUL_RELOAD_ANCHORS:
            if soul_anchor not in s:
                continue
            s = s.replace(soul_anchor, soul_patch + "\n" + soul_anchor, 1)
            applied_soul = True
            break
        if not applied_soul:
            soul_note = "agent-cache anchor not found (SOUL reload skipped)"

    run_path.write_text(s, encoding="utf-8")
    plain = apply_run_plain_reply_patch(run_path)
    final = run_path.read_text(encoding="utf-8")
    return {
        "ok": True,
        "path": str(run_path),
        "inbound_mirror": MIRROR_INBOUND_TAG in final,
        "outbound_mirror": POST_SEND_MIRROR_TAG in Path(__file__).read_text(encoding="utf-8"),
        "fresh_start_runner_hook": RUNNER_GLOBAL_VAR in final and RUNNER_START_PATCH in final,
        "luna_soul_reload": LUNA_SOUL_RELOAD_TAG in final,
        "luna_soul_reload_note": soul_note,
        "runtime_whatsapp_patch_hook": plain["runtime_whatsapp_patch_hook"],
        "stream_initial_reply_luna": plain["stream_initial_reply_luna"],
    }



_WHATSAPP_SUPPRESS_STATUS_RE = re.compile(
    r"("
    r"[Ss]elf.?improvement"
    r"|[Ss]kill\s+['\"]?[-\w]+\s+(?:created|saved|updated)"
    r"|[Ss]kill\s+created"
    r"|[Ss]kill\s+saved"
    r"|[Ss]kill\s+updated"
    r"|auxiliary\s+"
    r"|compression\s+"
    r"|compression\."
    r"|auto.?compact"
    r"|hermes\s+config"
    r"|caps?\s+context"
    r"|before\s+summariz"
    r"|preflight"
    r"|retrying\s+in"
    r"|rate\s+limited"
    r"|auto.lowered"
    r")",
    re.IGNORECASE,
)

def _is_whatsapp_internal_status_text(text):
    return bool(_WHATSAPP_SUPPRESS_STATUS_RE.search(str(text or "").strip()))

def _patched_prepare_gateway_status_message(platform, event_type, message):
    text = str(message or "").strip()
    if not text:
        return None
    plat = getattr(platform, "value", str(platform))
    if plat in ("whatsapp", "whatsapp_cloud"):
        if _is_whatsapp_internal_status_text(text):
            return None
    return _orig_prepare_gateway_status_message(platform, event_type, message)

async def _patched_whatsapp_cloud_send(self, chat_id, content, reply_to=None, metadata=None):
    try:
        from wolfhouse.guest_send_guard import suppress_guest_whatsapp_text_send
        if suppress_guest_whatsapp_text_send(content, metadata):
            try:
                from gateway.platforms.base import SendResult
                return SendResult(success=True, message_id=None, raw_response={"suppressed_guest_system_send": True})
            except Exception:
                return None
    except Exception:
        pass
    if _is_whatsapp_internal_status_text(content):
        try:
            from gateway.platforms.base import SendResult
            return SendResult(success=True, message_id=None, raw_response={"suppressed_internal_status": True})
        except Exception:
            return None
    # WhatsApp kill switches — WHATSAPP_DRY_RUN / LUNA_AUTO_SEND_ENABLED. All logic
    # lives in the tested wolfhouse.send_flags module; this block only calls it.
    # Unlike every other guard here, the except does NOT fall through to the send:
    # if the kill switch cannot be evaluated, nothing reaches a guest. A kill switch
    # that fails open is not a kill switch.
    try:
        from wolfhouse.send_flags import (
            flag_block_raw_response,
            guest_whatsapp_send_flag_block,
            log_flag_block,
        )
        _wh_flag_block = guest_whatsapp_send_flag_block(chat_id)
        _wh_flag_line = log_flag_block(_wh_flag_block)
        _wh_flag_raw = flag_block_raw_response(_wh_flag_block)
    except Exception as _wh_flag_exc:
        _wh_flag_block = {"blocked_reason": "send_flag_guard_error"}
        _wh_flag_line = (
            "[wolfhouse] send blocked (send_flag_guard_error) — the WhatsApp kill-switch "
            f"guard could not be loaded ({type(_wh_flag_exc).__name__}); failing closed, nothing sent"
        )
        _wh_flag_raw = {
            "suppressed_guest_send_flag": True,
            "blocked_reason": "send_flag_guard_error",
        }
    if _wh_flag_block:
        try:
            import sys as _sys
            print(_wh_flag_line, file=_sys.stderr)
        except Exception:
            pass
        try:
            from gateway.platforms.base import SendResult
            return SendResult(success=True, message_id=None, raw_response=_wh_flag_raw)
        except Exception:
            return None
    # Staff Portal pause gate — block outbound guest replies when Luna is paused.
    # Draft is persistence, not a Meta send.
    try:
        from wolfhouse.pause_gate import whatsapp_outbound_disposition
        _wh_disp = whatsapp_outbound_disposition(chat_id, force_refresh=True) or {}
        if _wh_disp.get("stage_as_draft"):
            try:
                import sys as _sys
                print("[wolfhouse] draft mode — staging Inbox draft, suppressing WhatsApp send", file=_sys.stderr)
            except Exception:
                pass
            _wh_draft_staged = False
            _wh_draft_reason = "draft_stage_failed"
            try:
                import importlib.util as _wwm_draft_iu
                _wwm_draft_spec = _wwm_draft_iu.spec_from_file_location(
                    "wolfhouse_whatsapp_mirror",
                    "/etc/hermes-staging/wolfhouse_whatsapp_mirror.py",
                )
                _wwm_draft = _wwm_draft_iu.module_from_spec(_wwm_draft_spec)
                _wwm_draft_spec.loader.exec_module(_wwm_draft)
                _wh_draft_result = _wwm_draft.mirror_whatsapp_outbound_as_draft(
                    chat_id,
                    content,
                    metadata if isinstance(metadata, dict) else {},
                )
                if isinstance(_wh_draft_result, dict) and _wh_draft_result.get("staged") is True:
                    _wh_draft_staged = True
                elif isinstance(_wh_draft_result, dict) and _wh_draft_result.get("reason"):
                    _wh_draft_reason = str(_wh_draft_result.get("reason"))
                else:
                    _wh_draft_reason = "draft_not_staged"
            except Exception as _wh_draft_exc:
                _wh_draft_staged = False
                _wh_draft_reason = "draft_stage_exception"
                try:
                    import sys as _sys
                    print(
                        "[wolfhouse] draft stage failed "
                        f"({type(_wh_draft_exc).__name__}); blocking Meta send",
                        file=_sys.stderr,
                    )
                except Exception:
                    pass
            try:
                from gateway.platforms.base import SendResult
                if _wh_draft_staged:
                    return SendResult(
                        success=True,
                        message_id=None,
                        raw_response={"suppressed_draft_mode": True, "draft_staged": True},
                    )
                return SendResult(
                    success=False,
                    message_id=None,
                    raw_response={
                        "suppressed_draft_mode": True,
                        "draft_staged": False,
                        "blocked_reason": _wh_draft_reason,
                    },
                )
            except Exception:
                return None
        if _wh_disp.get("send_blocked"):
            try:
                import sys as _sys
                print("[wolfhouse] guest automation paused — suppressing WhatsApp send", file=_sys.stderr)
            except Exception:
                pass
            try:
                from gateway.platforms.base import SendResult
                return SendResult(success=True, message_id=None, raw_response={"suppressed_guest_automation_paused": True})
            except Exception:
                return None
    except Exception:
        try:
            from wolfhouse.pause_gate import whatsapp_send_blocked
            if whatsapp_send_blocked(chat_id):
                try:
                    import sys as _sys
                    print("[wolfhouse] guest automation paused — suppressing WhatsApp send", file=_sys.stderr)
                except Exception:
                    pass
                try:
                    from gateway.platforms.base import SendResult
                    return SendResult(success=True, message_id=None, raw_response={"suppressed_guest_automation_paused": True})
                except Exception:
                    return None
        except Exception:
            pass
    # Guest output-guard (step 3): a backend/tool leak ("il sistema…", "the quote
    # tool…") must never reach a guest. Replace the whole reply with a warm,
    # localized fallback. Defensive: if the guard module can't import in the gateway
    # process, fall through to the original behavior (never break the send path).
    try:
        from wolfhouse.output_guard import find_leaks, safe_fallback_for, is_provider_error, outage_fallback_for
        if is_provider_error(content):
            try:
                import sys as _sys
                print(f"[wolfhouse] output-guard: provider-error suppressed -> outage fallback: {str(content)[:120]}", file=_sys.stderr)
            except Exception:
                pass
            content = outage_fallback_for(content)
        else:
            _leaks = find_leaks(content)
            if _leaks:
                try:
                    import sys as _sys
                    print(f"[wolfhouse] output-guard: leak suppressed -> safe fallback {_leaks}", file=_sys.stderr)
                except Exception:
                    pass
                content = safe_fallback_for(content)
    except Exception:
        pass
    import os as _wolfhouse_wa_os
    _wh_meta = metadata if isinstance(metadata, dict) else {}
    _wh_allow_quote = bool(_wh_meta.get("wolfhouse_quote_reply") or _wh_meta.get("quote_reply"))
    if not _wh_allow_quote:
        reply_to = None
    _wh_send_result = await _orig_whatsapp_cloud_send(self, chat_id, content, reply_to=reply_to, metadata=metadata)
    try:
        _wh_mid = getattr(_wh_send_result, "message_id", None) if _wh_send_result is not None else None
        _wh_raw = getattr(_wh_send_result, "raw_response", None) if _wh_send_result is not None else None
        _wh_suppressed = isinstance(_wh_raw, dict) and any(
            str(k).startswith("suppressed_") for k in _wh_raw
        )
        if _wh_mid and not _wh_suppressed:
            import importlib.util as _wwm_iu
            _wwm_spec = _wwm_iu.spec_from_file_location(
                "wolfhouse_whatsapp_mirror",
                "/etc/hermes-staging/wolfhouse_whatsapp_mirror.py",
            )
            _wwm = _wwm_iu.module_from_spec(_wwm_spec)
            _wwm_spec.loader.exec_module(_wwm)
            _wh_meta = metadata if isinstance(metadata, dict) else {}
            _wwm.mirror_whatsapp_outbound_after_send(chat_id, content, _wh_mid, _wh_meta)
    except Exception:
        pass
    return _wh_send_result


def install_runtime_whatsapp_patches() -> dict:
    """Apply in-process WhatsApp patches (gateway process, not bootstrap-only)."""
    applied = {
        "status_filter": False,
        "plain_reply_send": False,
        "pause_webhook": False,
        "pause_send": False,
        "send_flags": False,
        "burst_coalesce": False,
        "luna_personality": False,
    }
    try:
        import gateway.run as _gw_run_mod
        if not getattr(_gw_run_mod, "_wh_status_filter_applied", False):
            _gw_run_mod._orig_prepare_gateway_status_message = _gw_run_mod._prepare_gateway_status_message
            _gw_run_mod._WHATSAPP_SUPPRESS_STATUS_RE = _WHATSAPP_SUPPRESS_STATUS_RE
            _gw_run_mod._prepare_gateway_status_message = _patched_prepare_gateway_status_message
            _gw_run_mod._wh_status_filter_applied = True
            applied["status_filter"] = True
    except Exception:
        pass
    try:
        import gateway.platforms.whatsapp_cloud as _wh_cloud_mod
        if not getattr(_wh_cloud_mod.WhatsAppCloudAdapter, "_wolfhouse_internal_status_send_filter", False):
            global _orig_whatsapp_cloud_send
            _orig_whatsapp_cloud_send = _wh_cloud_mod.WhatsAppCloudAdapter.send
            _wh_cloud_mod.WhatsAppCloudAdapter.send = _patched_whatsapp_cloud_send
            _wh_cloud_mod.WhatsAppCloudAdapter._wolfhouse_internal_status_send_filter = True
            applied["plain_reply_send"] = True
            applied["pause_send"] = True
            applied["send_flags"] = True
    except Exception:
        pass
    try:
        from wolfhouse.pause_gate import install_whatsapp_pause_webhook_patch
        applied["pause_webhook"] = bool(install_whatsapp_pause_webhook_patch())
    except Exception:
        pass
    try:
        from wolfhouse.whatsapp_burst_coalesce import install_whatsapp_burst_coalesce_patch
        applied["burst_coalesce"] = bool(install_whatsapp_burst_coalesce_patch())
    except Exception:
        pass
    try:
        from wolfhouse.luna_personality import install_soul_append_runtime_patch
        applied["luna_personality"] = bool(install_soul_append_runtime_patch())
    except Exception:
        pass
    return applied

def main() -> int:
    spec = importlib.util.find_spec("gateway.run")
    if not spec or not spec.origin:
        print("gateway.run not found", file=sys.stderr)
        return 1
    base_spec = importlib.util.find_spec("gateway.platforms.base")
    if not base_spec or not base_spec.origin:
        print("gateway.platforms.base not found", file=sys.stderr)
        return 1
    whatsapp_spec = importlib.util.find_spec("gateway.platforms.whatsapp_cloud")
    if not whatsapp_spec or not whatsapp_spec.origin:
        print("gateway.platforms.whatsapp_cloud not found", file=sys.stderr)
        return 1
    adapter_spec = importlib.util.find_spec("agent.anthropic_adapter")
    session_spec = importlib.util.find_spec("gateway.session")
    run_path = Path(spec.origin)
    base_path = Path(base_spec.origin)
    whatsapp_path = Path(whatsapp_spec.origin)
    try:
        result: dict = {}
        result["base_platform"] = apply_base_platform_patch(base_path)
        result["whatsapp_cloud"] = apply_whatsapp_cloud_patch(whatsapp_path)
        stream_spec = importlib.util.find_spec("gateway.stream_consumer")
        if stream_spec and stream_spec.origin:
            result["stream_consumer"] = apply_stream_consumer_patch(Path(stream_spec.origin))
        else:
            result["stream_consumer"] = {"stream_reply_to_patch": False, "note": "gateway.stream_consumer not found"}
        if session_spec and session_spec.origin:
            result["session_store"] = apply_session_store_patch(Path(session_spec.origin))
        else:
            result["session_store"] = {"session_stale_routing_skip": False, "note": "gateway.session not found"}
        result.update(apply_patches(run_path))
        # Fix Anthropic OAuth login token endpoint (platform.claude.com fallback)
        if adapter_spec and adapter_spec.origin:
            result["anthropic_oauth"] = apply_anthropic_oauth_patch(Path(adapter_spec.origin))
        else:
            result["anthropic_oauth"] = {"anthropic_oauth_login_fallback": False, "note": "agent.anthropic_adapter not found"}
        result["runtime_whatsapp"] = install_runtime_whatsapp_patches()
        print(result)
        return 0
    except Exception as exc:
        print(f"apply_gateway_patches failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
