"""Staff Portal bot pause gate for Hermes Luna WhatsApp.

Source of truth: Staff API ``bot_pause_states`` (global + per-guest/conversation),
via ``POST /staff/bot/check-guest-automation-gate`` (bot token auth).

``needs_human`` is conversation-scoped review state. Staff API already encodes
Sunset so it does not set ``bot_paused``; this module must not re-introduce it
as an inbound mute. Wolfhouse still pauses because the gate returns ``bot_paused``.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from contextvars import ContextVar, Token
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# Cache: key -> (timestamp, paused, known_paused_ever)
_CACHE: Dict[str, Tuple[float, bool, bool]] = {}
_ACTIVE_TTL_SEC = 1.5
_PAUSED_TTL_SEC = 0.5

# Context-owned proof that this dispatch itself persisted the handoff pause.
# It cannot be supplied by model/tool parameters and disappears with the turn context.
_SAME_TURN_HANDOFF_PAUSE: ContextVar[Optional[Dict[str, Any]]] = ContextVar(
    "luna_same_turn_handoff_pause", default=None)


_PAUSE_IDENTITY_FIELDS = ("id", "conversation_id", "paused_by", "pause_reason")


def claim_same_turn_handoff_pause(chat_id: Any, identity: Dict[str, Any]) -> Token:
    owner = {
        "phone": _phone_from_chat_id(chat_id),
        "client_slug": _client_slug(),
        "identity": dict(identity) if isinstance(identity, dict) else {},
    }
    return _SAME_TURN_HANDOFF_PAUSE.set(owner)


def release_same_turn_handoff_pause(token: Token) -> None:
    _SAME_TURN_HANDOFF_PAUSE.reset(token)


def confirmation_recovery_allowed(disposition: Any, recovery: Any) -> bool:
    """Authorize only the exact Luna-owned confirmation pause in Auto mode."""
    if not isinstance(disposition, dict) or not isinstance(recovery, dict):
        return False
    booking_id = str(recovery.get("booking_id") or "").strip()
    expected = recovery.get("pause_state")
    actual = disposition.get("pause_state")
    if not booking_id or not isinstance(expected, dict) or not isinstance(actual, dict):
        return False
    if disposition.get("whatsapp_channel_mode") != "auto":
        return False
    if (disposition.get("global_paused") is not False
            or disposition.get("conversation_paused") is not True
            or disposition.get("agent_paused") is not True
            or disposition.get("send_blocked") is not True
            or disposition.get("stage_as_draft") is not False
            or disposition.get("effective_scope") != "conversation"
            or disposition.get("source") != "bot_pause_states"):
        return False
    for key in ("id", "conversation_id", "paused_by", "pause_reason"):
        if not expected.get(key) or actual.get(key) != expected.get(key):
            return False
    reason = str(actual.get("pause_reason") or "")
    return bool(
        actual.get("paused_by") == "luna_flag_needs_human"
        and reason.startswith("needs_human:saved_booking_confirmation_blocked:")
        and "provider_acceptance_stamp_failed" not in reason
        and expected.get("source") == "bot_pause_states"
        and expected.get("scope") == "conversation"
    )


def confirmation_recovery_for_event(event: Any) -> Optional[Dict[str, Any]]:
    """Resolve one exact unaccepted Staff debt before ordinary pause suppression."""
    try:
        chat_id = getattr(event, "chat_id", None) or getattr(event, "sender_id", None)
        if not chat_id and isinstance(event, dict):
            chat_id = event.get("sender_id") or event.get("chat_id") or event.get("from")
        disposition = whatsapp_outbound_disposition(chat_id, force_refresh=True)
        pause = disposition.get("pause_state")
        if not isinstance(pause, dict):
            return None
        conversation_id = str(pause.get("conversation_id") or "").strip()
        if not conversation_id:
            return None
        import wolfhouse_staff_api as staff_api
        result = staff_api._confirmation_owed_open(conversation_id=conversation_id)
        rows = result.get("owed") if isinstance(result, dict) and result.get("success") is True else None
        if not isinstance(rows, list):
            return None
        candidates = [row for row in rows if isinstance(row, dict)
                      and row.get("provider_message_id") in (None, "")
                      and str(row.get("conversation_id") or "") == conversation_id]
        if len(candidates) != 1:
            return None
        row = dict(candidates[0])
        booking_id = str(row.get("booking_id") or "").strip()
        from .accepted_quote import confirmation_provider_acceptance_pending
        pending_acceptance = confirmation_provider_acceptance_pending(booking_id)
        if not booking_id or pending_acceptance is not False:
            return None
        booking_code = str(row.get("booking_code") or "").strip()
        reason = str((pause or {}).get("pause_reason") or "")
        if not booking_code or f":booking_reference:{booking_code}" not in reason:
            return None
        expected_pause = dict(pause)
        expected_pause["source"] = disposition.get("source")
        expected_pause["scope"] = disposition.get("effective_scope")
        row["pause_state"] = expected_pause
        if not confirmation_recovery_allowed(disposition, row):
            return None
        return row
    except Exception:
        return None


def _attach_same_turn_pause_scope(disposition: Dict[str, Any], phone: str) -> Dict[str, Any]:
    result = dict(disposition)
    owner = _SAME_TURN_HANDOFF_PAUSE.get()
    expected = (owner.get("identity") if isinstance(owner, dict) else None) or {}
    actual = result.get("pause_state") if isinstance(result.get("pause_state"), dict) else {}
    identity_matches = bool(
        isinstance(expected, dict)
        and all(expected.get(key) not in (None, "") for key in _PAUSE_IDENTITY_FIELDS)
        and all(actual.get(key) == expected.get(key) for key in _PAUSE_IDENTITY_FIELDS)
        and expected.get("source") == "bot_pause_states"
        and expected.get("scope") == "conversation"
        and result.get("pause_source") == expected.get("source")
        and result.get("pause_scope") == expected.get("scope")
        and result.get("global_paused") is False
        and result.get("conversation_paused") is True
    )
    same_turn = bool(
        isinstance(owner, dict)
        and owner.get("phone") == phone
        and owner.get("client_slug") == _client_slug()
        and result.get("agent_paused") is True
        and result.get("reason") == "paused"
        and result.get("whatsapp_channel_mode") == "auto"
        and result.get("stage_as_draft") is not True
        and identity_matches
    )
    result["same_turn_handoff_pause"] = same_turn
    if isinstance(owner, dict) and not same_turn:
        missing_identity = not isinstance(actual, dict) or any(
            actual.get(key) in (None, "") for key in _PAUSE_IDENTITY_FIELDS
        )
        source_matches = result.get("pause_source") == expected.get("source")
        scope_matches = result.get("pause_scope") == expected.get("scope")
        mismatch_reason = (
            "pause_identity_missing" if missing_identity else
            "pause_source_or_scope_mismatch"
            if not (source_matches and scope_matches) else
            "pause_identity_mismatch"
        )
        logger.warning({
            "event": "same_turn_handoff_pause_mismatch",
            "reason": mismatch_reason,
            "expected_source": expected.get("source") if isinstance(expected, dict) else None,
            "actual_source": result.get("pause_source"),
            "expected_scope": expected.get("scope") if isinstance(expected, dict) else None,
            "actual_scope": result.get("pause_scope"),
            "expected_pause_id": expected.get("id") if isinstance(expected, dict) else None,
            "actual_pause_id": actual.get("id"),
        })
    return result


def _is_luna_runtime() -> bool:
    """True for Wolfhouse Luna and Sunset Luna (HERMES_ROLE ends with luna)."""
    role = (os.getenv("HERMES_ROLE") or "luna").strip().lower()
    if not role:
        return True
    return role == "luna" or role.endswith("-luna") or "luna" in role.split("-")


def _client_slug() -> str:
    """Runtime tenant — LUNA_CLIENT_SLUG only (never invent Wolfhouse)."""
    return (os.getenv("LUNA_CLIENT_SLUG") or "").strip()


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


def outbound_disposition_from_gate(data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Decide agent / Meta send / Inbox-draft from a Staff automation-gate payload.

    Tenant-global WhatsApp Auto/Draft/Off stays the only channel toggle:
      - Auto: agent runs, Meta may send (other kill switches still apply).
      - Draft: agent runs, Meta never sends, reply is persisted as an Inbox draft.
      - Off: agent does not run, nothing is sent or drafted.

    ``needs_human`` is conversation-scoped review state. Staff API already encodes
    Sunset so it does not set ``bot_paused``; this disposition must not re-introduce
    it as a mute. Wolfhouse still pauses because the gate returns ``bot_paused``.
    """
    payload = data if isinstance(data, dict) else {}
    mode = str(payload.get("whatsapp_channel_mode") or "").strip().lower()
    stage_flag = payload.get("stage_outbound_as_draft") is True or mode == "draft"
    agent_paused = bool(
        payload.get("bot_paused")
        or payload.get("can_continue_guest_automation") is False
        or payload.get("paused") is True
    )
    pause_metadata = {
        "pause_source": payload.get("source"),
        "pause_scope": payload.get("effective_scope"),
        "global_paused": payload.get("global_paused") is True,
        "conversation_paused": payload.get("conversation_paused") is True,
        "pause_state": dict(payload["pause_state"])
        if isinstance(payload.get("pause_state"), dict) else None,
    }
    if mode == "off":
        return {
            "agent_paused": True,
            "send_blocked": True,
            "stage_as_draft": False,
            "reason": "inbox_channel_mode_off",
            "whatsapp_channel_mode": "off",
            **pause_metadata,
        }
    if stage_flag and not agent_paused:
        return {
            "agent_paused": False,
            "send_blocked": True,
            "stage_as_draft": True,
            "reason": "inbox_channel_mode_draft",
            "whatsapp_channel_mode": "draft",
            **pause_metadata,
        }
    send_blocked = bool(agent_paused or payload.get("live_send_blocked"))
    reason = "paused" if agent_paused else ("live_send_blocked" if send_blocked else "send")
    return {
        "agent_paused": agent_paused,
        "send_blocked": send_blocked,
        "stage_as_draft": False,
        "reason": reason,
        "whatsapp_channel_mode": mode or None,
        **pause_metadata,
    }


def _agent_paused_from_gate(data: Dict[str, Any]) -> bool:
    """True when the agent must not run.

    Draft mode sets live_send_blocked without pausing the agent — Luna still
    drafts; Meta send is suppressed separately via whatsapp_send_blocked.
    """
    return bool(outbound_disposition_from_gate(data).get("agent_paused"))


def _send_blocked_from_gate(data: Dict[str, Any]) -> bool:
    """True when Meta/Cloud outbound must not leave Hermes."""
    return bool(outbound_disposition_from_gate(data).get("send_blocked"))


def _lookup_guest_automation_gate(
    guest_phone: str,
    *,
    client_slug: Optional[str] = None,
    conversation_id: Optional[str] = None,
) -> Tuple[str, Optional[Dict[str, Any]], bool]:
    """Return (cache_key, gate_data_or_None, fail_closed_paused)."""
    phone = _normalize_phone(guest_phone)
    slug = (client_slug or _client_slug()).strip()
    cache_key = f"{slug}|{phone or conversation_id or 'unknown'}"
    if not slug:
        logger.warning("%s", {"event": "pause_gate_missing_client_slug", "paused": True})
        return cache_key, None, True

    token = _bot_token()
    if not token:
        logger.warning(
            "%s",
            {"event": "pause_gate_missing_token", "client_slug": slug, "paused": True},
        )
        return cache_key, None, True

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
    try:
        with urllib.request.urlopen(req, timeout=2.0) as res:
            raw = res.read().decode("utf-8")
            data = json.loads(raw)
        if not isinstance(data, dict) or data.get("lookup_error") or data.get("success") is False:
            logger.warning(
                "%s",
                {"event": "pause_gate_lookup_error_response", "client_slug": slug, "paused": True},
            )
            return cache_key, None, True
        return cache_key, data, False
    except Exception as exc:
        logger.warning(
            "%s",
            {
                "event": "pause_gate_lookup_failed",
                "client_slug": slug,
                "error_type": type(exc).__name__,
                "paused": True,
                "had_prior_paused": _cache_last_known_paused(cache_key),
            },
        )
        return cache_key, None, True


def guest_automation_paused(
    guest_phone: str,
    *,
    client_slug: Optional[str] = None,
    conversation_id: Optional[str] = None,
    force_refresh: bool = False,
) -> bool:
    """Return True when pause/Off blocks the agent (not Draft, not Sunset needs_human)."""
    if not _is_luna_runtime():
        return False
    phone = _normalize_phone(guest_phone)
    if not phone and not conversation_id:
        return False
    slug = (client_slug or _client_slug()).strip()
    if not slug:
        logger.warning("%s", {"event": "pause_gate_missing_client_slug", "paused": True})
        return True
    cache_key = f"{slug}|{phone or conversation_id or 'unknown'}"
    if not force_refresh:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

    _key, data, fail_closed = _lookup_guest_automation_gate(
        phone,
        client_slug=slug,
        conversation_id=conversation_id,
    )
    if fail_closed or data is None:
        paused = True
    else:
        paused = _agent_paused_from_gate(data)

    _cache_set(cache_key, paused)
    return paused


def paused_for_webhook_body(body: bytes) -> bool:
    phones = _phones_from_webhook_body(body)
    if not phones:
        return False
    return any(guest_automation_paused(p, force_refresh=True) for p in phones)


def whatsapp_outbound_disposition(chat_id: Any, *, force_refresh: bool = True) -> Dict[str, Any]:
    """Live send/draft decision for one chat. Fail-closed on gate errors.

    ``force_refresh`` is the send-time contract: re-check immediately before
    outbound (the lookup itself is uncached).
    """
    del force_refresh
    phone = _phone_from_chat_id(chat_id)
    idle = {
        "agent_paused": False,
        "send_blocked": False,
        "stage_as_draft": False,
        "reason": "no_phone",
        "whatsapp_channel_mode": None,
    }
    try:
        from wolfhouse.explicit_human_handoff import is_local_automation_blocked

        if is_local_automation_blocked(phone):
            return {
                "agent_paused": True,
                "send_blocked": True,
                "stage_as_draft": False,
                "reason": "local_automation_blocked",
                "whatsapp_channel_mode": None,
            }
    except Exception:
        pass
    if not phone:
        return idle
    if not _is_luna_runtime():
        return idle
    _key, data, fail_closed = _lookup_guest_automation_gate(phone)
    if fail_closed or data is None:
        return {
            "agent_paused": True,
            "send_blocked": True,
            "stage_as_draft": False,
            "reason": "gate_fail_closed",
            "whatsapp_channel_mode": None,
        }
    return _attach_same_turn_pause_scope(outbound_disposition_from_gate(data), phone)


def whatsapp_send_blocked(chat_id: Any) -> bool:
    """Re-check immediately before outbound send (Draft/Off/pause suppression)."""
    return bool(whatsapp_outbound_disposition(chat_id, force_refresh=True).get("send_blocked"))


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
    try:
        from wolfhouse.explicit_human_handoff import is_local_automation_blocked

        if is_local_automation_blocked(phone):
            return True
    except Exception:
        pass
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
