"""Staff Portal bot pause gate for Hermes Luna WhatsApp.

Source of truth: Staff API ``bot_pause_states`` (global + per-guest), via
``POST /staff/bot/check-guest-automation-gate`` (bot token auth).
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple

_CACHE: Dict[str, Tuple[float, bool]] = {}
_CACHE_TTL_SEC = 5.0


def _client_slug() -> str:
    return (os.getenv("WOLFHOUSE_CLIENT_SLUG") or "wolfhouse-somo").strip()


def _base_url() -> str:
    return (os.getenv("WOLFHOUSE_STAFF_API_BASE_URL") or "https://staff-staging.lunafrontdesk.com").rstrip("/")


def _bot_token() -> str:
    return (os.getenv("LUNA_BOT_INTERNAL_TOKEN") or "").strip()


def _normalize_phone(raw: Any) -> str:
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    if not digits:
        return ""
    return f"+{digits}"


def _phone_from_chat_id(chat_id: Any) -> str:
    return _normalize_phone(chat_id)


def _phones_from_webhook_body(body: bytes) -> list[str]:
    out: list[str] = []
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        return out
    entries = payload.get("entry") or []
    for entry in entries:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            for msg in value.get("messages") or []:
                phone = _normalize_phone(msg.get("from"))
                if phone and phone not in out:
                    out.append(phone)
            for st in value.get("statuses") or []:
                phone = _normalize_phone(st.get("recipient_id"))
                if phone and phone not in out:
                    out.append(phone)
    return out


def _cache_get(key: str) -> Optional[bool]:
    row = _CACHE.get(key)
    if not row:
        return None
    ts, val = row
    if time.time() - ts > _CACHE_TTL_SEC:
        _CACHE.pop(key, None)
        return None
    return val


def _cache_set(key: str, paused: bool) -> None:
    _CACHE[key] = (time.time(), paused)


def guest_automation_paused(guest_phone: str, *, client_slug: Optional[str] = None) -> bool:
    """Return True when global or scoped pause blocks guest automation."""
    if os.getenv("HERMES_ROLE", "luna") != "luna":
        return False
    phone = _normalize_phone(guest_phone)
    if not phone:
        return False
    slug = (client_slug or _client_slug()).strip()
    cache_key = f"{slug}|{phone}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    token = _bot_token()
    if not token:
        _cache_set(cache_key, False)
        return False

    url = f"{_base_url()}/staff/bot/check-guest-automation-gate"
    body = json.dumps({
        "client_slug": slug,
        "guest_phone": phone,
        "source": "hermes_luna_whatsapp",
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Luna-Bot-Token": token,
        },
    )
    paused = False
    try:
        with urllib.request.urlopen(req, timeout=8) as res:
            data = json.loads(res.read().decode("utf-8"))
        paused = bool(data.get("bot_paused") or data.get("live_send_blocked")
                      or data.get("can_continue_guest_automation") is False)
    except Exception:
        # Fail open — do not block guests when Staff API is unreachable.
        paused = False

    _cache_set(cache_key, paused)
    return paused


def paused_for_webhook_body(body: bytes) -> bool:
    phones = _phones_from_webhook_body(body)
    if not phones:
        return False
    return any(guest_automation_paused(p) for p in phones)


def whatsapp_send_blocked(chat_id: Any) -> bool:
    return guest_automation_paused(_phone_from_chat_id(chat_id))


class _ReplayRequest:
    """Re-play a consumed aiohttp request body for the original webhook handler."""

    def __init__(self, orig, body: bytes):
        self._orig = orig
        self._body = body

    async def read(self) -> bytes:
        return self._body

    async def text(self) -> str:
        return self._body.decode("utf-8")

    async def json(self) -> Any:
        return json.loads(self._body.decode("utf-8"))

    def __getattr__(self, name: str):
        return getattr(self._orig, name)


async def handle_webhook_with_pause_gate(self, request, orig_handler):
    body = await request.read()
    if paused_for_webhook_body(body):
        try:
            from aiohttp import web  # noqa: WPS433
            return web.Response(status=200, text="OK")
        except Exception:
            return None
    replay = _ReplayRequest(request, body)
    return await orig_handler(self, replay)


def install_whatsapp_pause_webhook_patch() -> bool:
    if os.getenv("HERMES_ROLE", "luna") != "luna":
        return False
    try:
        import gateway.platforms.whatsapp_cloud as wh_mod  # noqa: WPS433
    except Exception:
        return False
    cls = wh_mod.WhatsAppCloudAdapter
    if getattr(cls, "_wolfhouse_pause_webhook", False):
        return True
    orig = cls._handle_webhook

    async def _patched_handle_webhook(adapter_self, request):
        return await handle_webhook_with_pause_gate(adapter_self, request, orig)

    cls._handle_webhook = _patched_handle_webhook
    cls._wolfhouse_pause_webhook = True
    return True
