"""Exact guest-facing WhatsApp ``Fresh Start`` command.

The command is intentionally narrow and deterministic: only the exact words
``Fresh Start`` (with optional surrounding whitespace) reset the current guest
session. The command never enters the model conversation.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from wolfhouse_guest_fresh_start import reset_session_key_only
from wolfhouse.whatsapp_burst_coalesce import reset_sender_for_adapter_event

logger = logging.getLogger(__name__)

COMMAND = "Fresh Start"
SUCCESS_REPLY = "Fresh start complete 🌊 Send me a new message and we’ll start from scratch."
FAILURE_REPLY = "I couldn’t reset our chat just now. Please try Fresh Start again in a moment."
_INSTALL_MARKER = "_wolfhouse_fresh_start_command_installed"


def _event_text(event: Any) -> str:
    value = getattr(event, "content", None)
    if value is None:
        value = getattr(event, "text", "")
    return value if isinstance(value, str) else ""


def _is_text_event(event: Any) -> bool:
    message_type = getattr(event, "message_type", None)
    value = getattr(message_type, "value", message_type)
    return str(value or "").lower() == "text"


def is_fresh_start_command(event: Any) -> bool:
    """Return true only for the exact, case-sensitive command words."""
    return _is_text_event(event) and _event_text(event).strip() == COMMAND


def _guest_phone(event: Any) -> str:
    source = getattr(event, "source", None)
    return str(
        getattr(source, "user_id", None)
        or getattr(source, "chat_id", None)
        or ""
    ).strip()


async def handle_or_delegate(
    adapter: Any,
    event: Any,
    original: Callable[[Any, Any], Awaitable[Any]],
) -> Any:
    """Handle the exact command or delegate the untouched event."""
    if not is_fresh_start_command(event):
        return await original(adapter, event)

    phone = _guest_phone(event)
    try:
        result = reset_session_key_only(phone) if phone else {"ok": False}
    except Exception:
        logger.exception("Fresh Start session reset failed")
        result = {"ok": False, "reset": False, "scope": "session_key"}
    ok = bool(
        result.get("ok") is True
        and result.get("reset") is True
        and result.get("scope") == "session_key"
        and result.get("hard_delete") is False
        and result.get("memories_cleared") is None
    )
    if ok:
        await reset_sender_for_adapter_event(adapter, event)
    reply = SUCCESS_REPLY if ok else FAILURE_REPLY
    send_result = await adapter.send(
        chat_id=getattr(getattr(event, "source", None), "chat_id", phone),
        content=reply,
        reply_to=None,
        metadata={"wolfhouse_guest_reply": True, "wolfhouse_fresh_start_ack": True},
    )
    logger.info(
        "Fresh Start command handled: reset=%s scope=%s delivered=%s",
        ok,
        str(result.get("scope") or "unknown"),
        bool(getattr(send_result, "success", False)),
    )
    return None


def install_whatsapp_fresh_start_command_patch() -> bool:
    """Install the exact command before normal agent/session dispatch."""
    from gateway.platforms.whatsapp_cloud import WhatsAppCloudAdapter

    if getattr(WhatsAppCloudAdapter, _INSTALL_MARKER, False):
        return True

    original = WhatsAppCloudAdapter.handle_message

    async def _patched_handle_message(adapter_self: Any, event: Any) -> Any:
        return await handle_or_delegate(adapter_self, event, original)

    WhatsAppCloudAdapter.handle_message = _patched_handle_message
    setattr(WhatsAppCloudAdapter, _INSTALL_MARKER, True)
    return True
