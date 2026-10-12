"""Revocable authority for destructive guest actions during a live gateway turn.

Hermes session ContextVars are intentionally copyable into child contexts and its
compatibility accessor can fall back to process environment. Neither property is
safe for cancellation authority. The gateway therefore binds an opaque owner
capability at turn start and revokes it globally at turn close. A copied context
retains only the opaque id; after revocation it has no authority.
"""

from __future__ import annotations

import contextvars
import secrets
import threading
from dataclasses import dataclass
from typing import Any

_MARKER = "wolfhouse_live_turn_owner_v1"
_CURRENT_OWNER_ID: contextvars.ContextVar[str] = contextvars.ContextVar(
    "WOLFHOUSE_LIVE_TURN_OWNER_ID", default=""
)
_LOCK = threading.Lock()


@dataclass(frozen=True)
class _Owner:
    platform: str
    user_id: str
    chat_id: str


_ACTIVE: dict[str, _Owner] = {}


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _phone(value: Any) -> str:
    digits = "".join(ch for ch in _clean(value) if ch.isdigit())
    return f"+{digits}" if 7 <= len(digits) <= 15 else ""


def bind_live_turn_owner(tokens: list, *, platform: str, user_id: str, chat_id: str) -> list:
    """Bind a revocable owner capability and attach its id to gateway tokens."""
    owner_id = secrets.token_urlsafe(24)
    owner = _Owner(
        platform=_clean(platform).lower(),
        user_id=_clean(user_id),
        chat_id=_clean(chat_id),
    )
    with _LOCK:
        _ACTIVE[owner_id] = owner
    _CURRENT_OWNER_ID.set(owner_id)
    tokens.append((_MARKER, owner_id))
    return tokens


def close_live_turn_owner(tokens: list) -> None:
    """Revoke every owner capability carried by this gateway turn."""
    owner_ids = [
        item[1]
        for item in (tokens or [])
        if isinstance(item, tuple) and len(item) == 2 and item[0] == _MARKER
    ]
    with _LOCK:
        for owner_id in owner_ids:
            _ACTIVE.pop(owner_id, None)
    current = _CURRENT_OWNER_ID.get()
    if current in owner_ids:
        _CURRENT_OWNER_ID.set("")


def live_turn_guest_phone() -> str:
    """Return the active WhatsApp owner phone, never environment fallback data."""
    owner_id = _CURRENT_OWNER_ID.get()
    if not owner_id:
        return ""
    with _LOCK:
        owner = _ACTIVE.get(owner_id)
    if owner is None or owner.platform not in {"whatsapp", "whatsapp_cloud"}:
        return ""
    return _phone(owner.user_id) or _phone(owner.chat_id)
