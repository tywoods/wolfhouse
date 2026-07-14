"""Staff Portal bot pause gate for Hermes Luna WhatsApp.

Source of truth: Staff API ``bot_pause_states`` (global + per-guest/conversation),
via ``POST /staff/bot/check-guest-automation-gate`` (bot token auth).

Also honors ``needs_human`` via the Staff gate response when present.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# Cache: key -> (timestamp, paused, known_paused_ever)
_CACHE: Dict[str, Tuple[float, bool, bool]] = {}
_ACTIVE_TTL_SEC = 1.5
_PAUSED_TTL_SEC = 0.5


def _is_luna_runtime() -> bool:
    """True for Wolfhouse Luna and Sunset Luna (HERMES_ROLE ends with luna)."""
    role = (os.getenv("HERMES_ROLE") or "luna").strip().lower()
    if not role:
        return True
    return role == "luna" or role.endswith("-luna") or "luna" in role.split("-")


def _client_slug() -> str:
    """Runtime tenant — LUNA_CLIENT_SLUG owns Sunset/Wolfhouse identity."""
    for key in ("LUNA_CLIENT_SLUG", "WOLFHOUSE_CLIENT_SLUG"):
        raw = (os.getenv(key) or "").strip()
        if raw:
            return raw
    return "wolfhouse-somo"


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


def _cache_ttl(paused: bool) -> float:
    return _PAUSED_TTL_SEC if paused else _ACTIVE_TTL_SEC


def _cache_get(key: str) -> Optional[bool]:
    row = _CACHE.get(key)
    if not row:
        return None
    ts, val, _known = row
    if time.time() - ts > _cache_ttl(val):
        return None
    return val


def _cache_last_known_paused(key: str) -> bool:
    row = _CACHE.get(key)
    if not row:
        return False
    _ts, val, known = row
    return bool(val or known)


def _cache_set(key: str, paused: bool) -> None:
    prior = _CACHE.get(key)
    known = bool(paused or (prior and prior[2]))
    _CACHE[key] = (time.time(), paused, known)


def invalidate_pause_cache(guest_phone: Optional[str] = None, *, client_slug: Optional[str] = None) -> None:
    """Drop cached pause decisions (all, or one tenant/phone)."""
    if guest_phone is None and client_slug is None:
        _CACHE.clear()
        return
    slug = (client_slug or _client_slug()).strip()
    phone = _normalize_phone(guest_phone) if guest_phone else ""
    dead = []
    for key in _CACHE:
        if phone and key == f"{slug}|{phone}":
            dead.append(key)
        elif not phone and key.startswith(f"{slug}|"):
            dead.append(key)
    for key in dead:
        _CACHE.pop(key, None)


def guest_automation_paused(
    guest_phone: str,
    *,
    client_slug: Optional[str] = None,
    conversation_id: Optional[str] = None,
    force_refresh: bool = False,
) -> bool:
    """Return True when global/conversation/phone pause or needs_human blocks automation."""
    if not _is_luna_runtime():
        return False
    phone = _normalize_phone(guest_phone)
    if not phone and not conversation_id:
        return False
    slug = (client_slug or _client_slug()).strip()
    cache_key = f"{slug}|{phone or conversation_id or 'unknown'}"
    if not force_refresh:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

    token = _bot_token()
    if not token:
        # Cannot prove active without bot auth — fail closed (no send).
        paused = True
        _cache_set(cache_key, paused)
        logger.warning(
            "%s",
            {"event": "pause_gate_missing_token", "client_slug": slug, "paused": paused},
        )
        return paused

    url = f"{_base_url()}/staff/bot/check-guest-automation-gate"
    body_obj: Dict[str, Any] = {
        "client_slug": slug,
        "source": "hermes_luna_whatsapp",
    }
    if phone:
        body_obj["guest_phone"] = phone
    if conversation_id:
        body_obj["conversation_id"] = str(conversation_id).strip()
    body = json.dumps(body_obj).encode("utf-8")
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
        with urllib.request.urlopen(req, timeout=2.0) as res:
            raw = res.read().decode("utf-8")
            data = json.loads(raw)
        if not isinstance(data, dict) or data.get("lookup_error") or data.get("success") is False:
            # Never accidentally resume: prefer last-known paused, else fail closed (no send).
            paused = True if _cache_last_known_paused(cache_key) else True
            logger.warning(
                "%s",
                {"event": "pause_gate_lookup_error_response", "client_slug": slug, "paused": paused},
            )
        else:
            paused = bool(
                data.get("bot_paused")
                or data.get("live_send_blocked")
                or data.get("can_continue_guest_automation") is False
                or data.get("needs_human") is True
                or data.get("paused") is True
            )
    except Exception as exc:
        # Timeout / 401 / network: never resume a paused guest; fail closed when uncertain.
        paused = True
        logger.warning(
            "%s",
            {
                "event": "pause_gate_lookup_failed",
                "client_slug": slug,
                "error_type": type(exc).__name__,
                "paused": paused,
                "had_prior_paused": _cache_last_known_paused(cache_key),
            },
        )

    _cache_set(cache_key, paused)
    return paused


def paused_for_webhook_body(body: bytes) -> bool:
    phones = _phones_from_webhook_body(body)
    if not phones:
        return False
    return any(guest_automation_paused(p, force_refresh=True) for p in phones)


def whatsapp_send_blocked(chat_id: Any) -> bool:
    """Re-check immediately before outbound send (stale generation suppression)."""
    return guest_automation_paused(_phone_from_chat_id(chat_id), force_refresh=True)


def guest_paused_for_event(event: Any) -> bool:
    """Pause check from a gateway inbound event (coalescer flush path)."""
    phone = ""
    try:
        chat_id = getattr(event, "chat_id", None) or getattr(event, "sender_id", None)
        phone = _phone_from_chat_id(chat_id)
        if not phone and isinstance(event, dict):
            phone = _normalize_phone(event.get("sender_id") or event.get("chat_id") or event.get("from"))
    except Exception:
        phone = ""
    if not phone:
        return False
    return guest_automation_paused(phone, force_refresh=True)


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
    """Ack Meta via the normal adapter path so Inbox mirroring still runs.

    Agent execution is suppressed later (coalescer flush + WhatsApp send) when
    effective pause / needs_human is active. Historical early-return skipped
    raw inbound mirroring and is intentionally removed.
    """
    body = await request.read()
    return await orig_handler(self, _ReplayRequest(request, body))


def install_whatsapp_pause_webhook_patch() -> bool:
    if not _is_luna_runtime():
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
