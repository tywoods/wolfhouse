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

OUTBOUND_MIRROR = '''
            try:
                import importlib.util as _wwm_iu
                _wwm_spec = _wwm_iu.spec_from_file_location(
                    "wolfhouse_whatsapp_mirror",
                    "/etc/hermes-staging/wolfhouse_whatsapp_mirror.py",
                )
                _wwm = _wwm_iu.module_from_spec(_wwm_spec)
                _wwm_spec.loader.exec_module(_wwm)
                _wwm.mirror_whatsapp_thread(source, event, "outbound", response, None)
            except Exception:
                pass
'''

SANITIZE = "response = _sanitize_gateway_final_response(source.platform, response)"
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
MIRROR_INBOUND_TAG = '_wwm.mirror_whatsapp_thread(source, event, "inbound"'
MIRROR_OUTBOUND_TAG = '_wwm.mirror_whatsapp_thread(source, event, "outbound"'

RUNNER_GLOBAL_VAR = "_wolfhouse_gateway_runner = None"
RUNNER_START_ANCHOR = 'logger.info("Starting Hermes Gateway...")'
RUNNER_START_PATCH = (
    'logger.info("Starting Hermes Gateway...")\n'
    '        global _wolfhouse_gateway_runner\n'
    '        _wolfhouse_gateway_runner = self'
)
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
        try:
            import os as _wolfhouse_os
            for _wolfhouse_key in ("WOLFHOUSE_WHATSAPP_GUEST_PHONE", "WHATSAPP_GUEST_PHONE"):
                _wolfhouse_os.environ.pop(_wolfhouse_key, None)
        except Exception:
            pass
        clear_session_vars(tokens)'''

# Agent turn handler — patch only this site (not other sanitize calls in gateway.run).
TURN_ANCHOR_RE = re.compile(
    r"response = _normalize_empty_agent_response\(\s*"
    r"agent_result, response, history_len=len\(history\),\s*\)\s*"
    r"response = _sanitize_gateway_final_response\(source\.platform, response\)",
    re.MULTILINE,
)

BASE_REPLY_ANCHOR_OLD = '    if platform == "feishu" and thread_id and getattr(event, "reply_to_message_id", None):\n        return getattr(event, "reply_to_message_id", None)\n    return getattr(event, "message_id", None)\n'

BASE_REPLY_ANCHOR_NEW = '    if platform == "feishu" and thread_id and getattr(event, "reply_to_message_id", None):\n        return getattr(event, "reply_to_message_id", None)\n    # WhatsApp Cloud renders ``context.message_id`` as a quoted reply block\n    # ("You / <guest message>") above Luna\'s answer. For guest-facing chats\n    # that feels noisy and robotic; route replies as normal messages unless a\n    # caller explicitly passes reply_to to the adapter.\n    if platform in {"whatsapp", "whatsapp_cloud"}:\n        return None\n    return getattr(event, "message_id", None)\n'

WHATSAPP_SEND_ANCHOR = '        if not content or not content.strip():\n            return SendResult(success=True, message_id=None)\n'
WHATSAPP_SEND_FILTER = '        if _wolfhouse_is_whatsapp_internal_status_text(content):\n            return SendResult(success=True, message_id=None, raw_response={"suppressed_internal_status": True})\n        if not content or not content.strip():\n            return SendResult(success=True, message_id=None)\n'
WHATSAPP_SEND_HELPERS = r'''

import re as _wolfhouse_re
_WOLFHOUSE_WHATSAPP_SUPPRESS_STATUS_RE = _wolfhouse_re.compile(
    r"(self.?improvement|skill\s+['\"]?[-\w]+\s+(?:created|saved|updated)|skill\s+(?:created|saved|updated)|auxiliary\s+|compression\s+|compression\.|auto.?compact|hermes\s+config|caps?\s+context|before\s+summariz|preflight|retrying\s+in|rate\s+limited|auto.lowered)",
    _wolfhouse_re.IGNORECASE,
)

def _wolfhouse_is_whatsapp_internal_status_text(text):
    return bool(_WOLFHOUSE_WHATSAPP_SUPPRESS_STATUS_RE.search(str(text or "").strip()))
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
    whatsapp_path.write_text(s, encoding="utf-8")
    _compile_check(whatsapp_path)
    return {
        "path": str(whatsapp_path),
        "internal_status_send_filter": WHATSAPP_SEND_FILTER in s,
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

    if MIRROR_INBOUND_TAG not in s or MIRROR_OUTBOUND_TAG not in s:
        replacement = (
            "response = _normalize_empty_agent_response(\n"
            " agent_result, response, history_len=len(history),\n"
            " )\n"
            + INBOUND_MIRROR
            + WHATSAPP_TEXT_NORMALIZE
            + "\n            "
            + SANITIZE
            + OUTBOUND_MIRROR
        )
        if not TURN_ANCHOR_RE.search(s):
            raise RuntimeError("gateway.run turn-handler anchor not found for inbox mirror")
        s = TURN_ANCHOR_RE.sub(replacement, s, count=1)

    run_path.write_text(s, encoding="utf-8")
    _compile_check(run_path)
    return {
        "ok": True,
        "path": str(run_path),
        "inbound_mirror": MIRROR_INBOUND_TAG in s,
        "outbound_mirror": MIRROR_OUTBOUND_TAG in s,
        "fresh_start_runner_hook": RUNNER_GLOBAL_VAR in s and RUNNER_START_PATCH in s,
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
    if _is_whatsapp_internal_status_text(content):
        try:
            from gateway.platforms.base import SendResult
            return SendResult(success=True, message_id=None, raw_response={"suppressed_internal_status": True})
        except Exception:
            return None
    return await _orig_whatsapp_cloud_send(self, chat_id, content, reply_to=reply_to, metadata=metadata)

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
    run_path = Path(spec.origin)
    base_path = Path(base_spec.origin)
    whatsapp_path = Path(whatsapp_spec.origin)
    try:
        result = apply_patches(run_path)
        result["base_platform"] = apply_base_platform_patch(base_path)
        result["whatsapp_cloud"] = apply_whatsapp_cloud_patch(whatsapp_path)
        # Fix Anthropic OAuth login token endpoint (platform.claude.com fallback)
        if adapter_spec and adapter_spec.origin:
            result["anthropic_oauth"] = apply_anthropic_oauth_patch(Path(adapter_spec.origin))
        else:
            result["anthropic_oauth"] = {"anthropic_oauth_login_fallback": False, "note": "agent.anthropic_adapter not found"}
        # Suppress skill/internal status notifications on WhatsApp
        import gateway.run as _gw_run_mod
        if not getattr(_gw_run_mod, "_wh_status_filter_applied", False):
            _gw_run_mod._orig_prepare_gateway_status_message = _gw_run_mod._prepare_gateway_status_message
            _gw_run_mod._WHATSAPP_SUPPRESS_STATUS_RE = _WHATSAPP_SUPPRESS_STATUS_RE
            _gw_run_mod._prepare_gateway_status_message = _patched_prepare_gateway_status_message
            _gw_run_mod._wh_status_filter_applied = True
        import gateway.platforms.whatsapp_cloud as _wh_cloud_mod
        if not getattr(_wh_cloud_mod.WhatsAppCloudAdapter, "_wolfhouse_internal_status_send_filter", False):
            global _orig_whatsapp_cloud_send
            _orig_whatsapp_cloud_send = _wh_cloud_mod.WhatsAppCloudAdapter.send
            _wh_cloud_mod.WhatsAppCloudAdapter.send = _patched_whatsapp_cloud_send
            _wh_cloud_mod.WhatsAppCloudAdapter._wolfhouse_internal_status_send_filter = True
        print(result)
        return 0
    except Exception as exc:
        print(f"apply_gateway_patches failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
