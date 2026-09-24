"""Deterministic explicit human-request handoff for Hermes Luna.

When a guest clearly asks to transfer to a human teammate:

1. Send exactly one deterministic transfer acknowledgement (while automation is
   still active — ack-before-persist).
2. Persist ``flag_needs_human`` / ``human_requested`` / open handoff / pause.
3. Short-circuit the agent (no LLM).

The successful tool result remains authoritative for Inbox state. The ordinary
outbound pause guard is NOT weakened; we simply send the ack before pause is
persisted.
"""

from __future__ import annotations

import asyncio
from contextvars import ContextVar
import json
import logging
import os
import re
import threading
from types import SimpleNamespace
from typing import Any, Dict, Optional, Set

logger = logging.getLogger(__name__)

HUMAN_REQUESTED = "human_requested"

# Dispatch-owned context is copied into the ordinary synchronous worker and its
# tools. Never store an adapter/phone in process environment or a global map.
_ORDINARY_TURN = ContextVar("luna_handoff_notice_turn", default=None)
_SENDING_ACK = ContextVar("luna_sending_handoff_ack", default=False)


def install_ordinary_handoff_patch():
    """Own the complete background turn, independently of burst coalescing.

    handle_message still schedules and returns immediately; never extend the
    webhook lifetime across a model turn. The background task owns revocation.
    """
    from gateway.platforms.whatsapp_cloud import WhatsAppCloudAdapter
    cls = WhatsAppCloudAdapter
    if getattr(cls, "_wolfhouse_ordinary_handoff", False):
        return True
    original = cls._process_message_background

    async def process(self, event, *args, **kwargs):
        async def dispatch(message):
            return await original(self, message, *args, **kwargs)
        return await dispatch_with_handoff_notice(
            event, SimpleNamespace(adapter=self, dispatch_fn=dispatch))

    cls._process_message_background = process
    cls._wolfhouse_ordinary_handoff = True
    return True


async def dispatch_with_handoff_notice(event, adapter_dispatch):
    tenant = os.getenv("LUNA_CLIENT_SLUG", "")
    role = os.getenv("HERMES_ROLE", "")
    if (tenant, role) not in {("wolfhouse-somo", "luna"), ("sunset", "sunset-luna")}:
        return await adapter_dispatch.dispatch_fn(event)
    turn = SimpleNamespace(
        tenant=tenant, origin=os.getenv("WOLFHOUSE_STAFF_API_BASE_URL", ""),
        phone=_event_chat_id(event), event=event, adapter=adapter_dispatch.adapter,
        loop=asyncio.get_running_loop(), thread=threading.get_ident(),
        task=asyncio.current_task(),
        lock=threading.Lock(), closed=False, requested=False, result=None,
        ack_attempted=False, ack_sent=False, correction_attempted=False,
    )
    token = _ORDINARY_TURN.set(turn)
    try:
        return await adapter_dispatch.dispatch_fn(event)
    finally:
        turn.closed = True
        _ORDINARY_TURN.reset(token)


def ordinary_handoff_phone():
    turn = _ORDINARY_TURN.get()
    return turn.phone if turn is not None else ""


def suppress_ordinary_handoff_reply(chat_id):
    turn = _ORDINARY_TURN.get()
    return bool(turn and turn.requested and not _SENDING_ACK.get()
                and turn.tenant == os.getenv("LUNA_CLIENT_SLUG", "")
                and _digits(chat_id) == _digits(turn.phone))


def persist_ordinary_handoff(payload, persist):
    """Synchronous tool: bounded ack on the adapter loop, then persist immediately.

    No delayed write depends on the model returning a final answer. Failed or
    suppressed sends still persist the safety handoff; they never claim delivery.
    """
    turn = _ORDINARY_TURN.get()
    if turn is None:
        return None  # explicit/draft/manual callers keep their existing path
    def authorized():
        # The adapter catches cancellation and awaits cleanup before our finally.
        # Its task is already cancelling then; a late receipt cannot renew authority.
        return (not turn.closed and turn.task is not None and not turn.task.cancelling()
                and turn.tenant == os.getenv("LUNA_CLIENT_SLUG", "")
                and turn.origin == os.getenv("WOLFHOUSE_STAFF_API_BASE_URL", "")
                and _digits(payload.get("phone")) == _digits(turn.phone))

    if not authorized():
        return {"success": False, "needs_human": False, "error": "handoff_scope_closed"}
    from wolfhouse.luna_personality_isolation import deny_tool_if_isolated
    denied = deny_tool_if_isolated("flag_needs_human", payload)
    if denied:
        return {"success": False, "needs_human": False, "error": denied}

    async def acknowledge(text):
        token = _SENDING_ACK.set(True)
        try:
            result = await turn.adapter.send(
                turn.phone, text,
                metadata={"wolfhouse_guest_reply": True},
            )
            raw = getattr(result, "raw_response", None) or {}
            return bool(getattr(result, "success", False)
                        and getattr(result, "message_id", None)
                        and not any(str(k).startswith("suppressed_") and v for k, v in raw.items()))
        finally:
            _SENDING_ACK.reset(token)

    def send_notice(text):
        # The ordinary agent is a worker thread. Never deadlock the adapter loop
        # if an unsupported caller invokes this synchronous tool on that loop.
        if threading.get_ident() != turn.thread and not turn.closed:
            future = asyncio.run_coroutine_threadsafe(asyncio.wait_for(acknowledge(text), 8), turn.loop)
            try:
                return bool(future.result(timeout=10))
            except Exception:
                future.cancel()
                logger.warning("handoff_notice_send_failed")
        return False

    with turn.lock:
        if not authorized():
            return {"success": False, "needs_human": False, "error": "handoff_scope_closed"}
        if turn.result is not None:
            return dict(turn.result)
        turn.requested = True
        if not turn.ack_attempted:
            turn.ack_attempted = True
            turn.ack_sent = send_notice(acknowledgement_for(_event_text(turn.event)))
        # Cancellation closes the dispatch while a worker may still be waiting
        # for the provider receipt. A receipt does not renew write authority.
        if not authorized():
            if turn.ack_sent:
                mark_local_automation_blocked(turn.phone)
                logger.warning("%s", {"event": "ordinary_handoff_revoked_after_ack",
                                      "needs_operator_reconciliation": True})
            return {"success": False, "needs_human": False, "error": "handoff_scope_closed",
                    "ack_sent": turn.ack_sent, "ack_send_failed": not turn.ack_sent,
                    "local_fail_closed": turn.ack_sent,
                    "needs_operator_reconciliation": turn.ack_sent}
        # Persistence remains in the tool's context (including simulate guards).
        try:
            data = persist()
        except Exception:
            data = {"success": False, "needs_human": False, "error": "handoff_persist_failed"}
        persisted = bool(data.get("success") and data.get("needs_human"))
        result = dict(data, ack_sent=turn.ack_sent, ack_send_failed=not turn.ack_sent,
                      local_fail_closed=not persisted, needs_operator_reconciliation=not persisted)
        if persisted:
            clear_local_automation_blocked(turn.phone)
            turn.result = result  # Only successful persistence is idempotent.
        else:
            correction = ("I couldn’t confirm the handoff. Please contact reception directly; "
                          "I can’t promise a teammate will see this chat.")
            result["guest_safe_next_action"] = correction
            # Correct an already-delivered promise while normal outbound guards
            # still allow it, then block automation until operator reconciliation.
            # Never claim the correction was delivered if guards/provider deny it.
            if turn.ack_sent and not turn.correction_attempted:
                turn.correction_attempted = True
                result["failure_notice_sent"] = send_notice(correction)
            mark_local_automation_blocked(turn.phone)
            logger.warning("%s", {"event": "ordinary_handoff_persist_failed",
                                  "ack_sent": turn.ack_sent,
                                  "needs_operator_reconciliation": True})
        return result

# Non-transfer messages that mention staff/human/person — must not hand off.
_EXCLUSION_RE = re.compile(
    r"(?ix)"
    r"("
    r"human[\s\-]?sized"
    r"|reception"
    r"|check[\s\-]?in"
    r"|arrange\s+(?:a\s+)?taxi"
    r"|friend\s+is\s+a\s+staff"
    r"|staff\s+member"
    r"|are\s+there\s+staff"
    r"|is\s+someone\s+there"
    r"|what\s+time\s+is\s+reception"
    r"|staff\s+at\s+reception"
    r"|can\s+staff\s+arrange"
    r")"
)

# Clear transfer / takeover intents (EN / ES / IT + close paraphrases).
_TRANSFER_RE = re.compile(
    r"(?ix)"
    r"("
    # English
    r"(?:speak|talk)\s+to\s+(?:a\s+)?(?:human|real\s+person|person|someone|manager|teammate|staff)"
    r"|(?:want|need|like)\s+to\s+(?:speak|talk)\s+to\s+(?:a\s+)?"
    r"(?:human|real\s+person|person|someone|manager|teammate|staff)"
    r"|get\s+someone\s+from\s+the\s+team"
    r"|can\s+a\s+manager\s+contact\s+me"
    r"|(?:stop|kill)\s+the\s+bot"
    r"|i\s+need\s+staff"
    r"|transfer\s+me\s+to\s+(?:a\s+)?(?:human|person|staff|manager)"
    r"|hand\s+me\s+off"
    # Spanish
    r"|quiero\s+hablar\s+con\s+(?:una\s+)?(?:persona|alguien|un\s+humano)"
    r"|puedo\s+hablar\s+con\s+(?:una\s+)?(?:persona|alguien)"
    r"|hablar\s+con\s+alguien\s+del\s+equipo"
    r"|hablar\s+con\s+(?:una\s+)?persona(?:\s+real)?"
    # Italian
    r"|vorrei\s+parlare\s+con\s+(?:una\s+)?(?:persona|qualcuno)"
    r"|posso\s+parlare\s+con\s+(?:una\s+)?(?:persona|qualcuno)"
    r"|parlare\s+con\s+qualcuno\s+dello\s+staff"
    r"|parlare\s+con\s+(?:una\s+)?persona(?:\s+reale)?"
    r")"
)

# Ack already delivered for this inbound WhatsApp message id (duplicate webhooks).
_ACKED_WAMIDS: Set[str] = set()
# After ack-sent + persist failure: block only this runtime tenant/origin/phone
# until authoritative pause/handoff can be reconciled.
_LOCAL_AUTOMATION_BLOCKED: Set[tuple[str, str, str]] = set()


def _digits(raw: Any) -> str:
    return "".join(ch for ch in str(raw or "") if ch.isdigit())


def _local_block_key(phone: Any) -> tuple[str, str, str]:
    # Late copied workers retain their dispatch owner even if runtime authority
    # changed while awaiting the provider. Never block a different tenant.
    turn = _ORDINARY_TURN.get()
    tenant = turn.tenant if turn is not None else os.getenv("LUNA_CLIENT_SLUG", "")
    origin = turn.origin if turn is not None else os.getenv("WOLFHOUSE_STAFF_API_BASE_URL", "")
    return tenant, origin.rstrip("/"), _digits(phone)


def is_local_automation_blocked(phone: Any) -> bool:
    key = _local_block_key(phone)
    return bool(key[2] and key in _LOCAL_AUTOMATION_BLOCKED)


def mark_local_automation_blocked(phone: Any) -> None:
    key = _local_block_key(phone)
    if key[2]:
        _LOCAL_AUTOMATION_BLOCKED.add(key)


def clear_local_automation_blocked(phone: Any) -> None:
    key = _local_block_key(phone)
    if key[2]:
        _LOCAL_AUTOMATION_BLOCKED.discard(key)


def is_explicit_human_request(message_text: Any) -> bool:
    """True only when the guest asks to transfer to a human teammate."""
    text = str(message_text or "").strip()
    if not text:
        return False
    if _EXCLUSION_RE.search(text):
        return False
    return bool(_TRANSFER_RE.search(text))


def acknowledgement_for(message_text: Any) -> str:
    """One short, warm handoff ack — no question."""
    t = str(message_text or "").lower()
    if re.search(r"[áéíóúñ¿¡]|quiero|puedo|hablar|persona|equipo", t):
        return "Claro — te paso con alguien del equipo y te atienden enseguida."
    if re.search(r"vorrei|posso|parlare|persona|qualcuno|staff", t):
        return "Certo — ti passo al team e ti rispondono al più presto."
    return "Of course — I’m looping in a teammate now and they’ll take over from here."


def _load_flag_needs_human():
    """Resolve flag_needs_human across Hermes plugin load paths.

    PYTHONPATH is often only ``/etc/hermes-staging``; plugins live under
    ``/etc/hermes-staging/plugins`` and ``$HERMES_HOME/plugins``.
    """
    import importlib
    import os
    import sys

    try:
        return getattr(importlib.import_module("wolfhouse_staff_api"), "flag_needs_human")
    except Exception:
        pass

    roots = [
        "/etc/hermes-staging/plugins",
        os.path.join((os.getenv("HERMES_HOME") or "/opt/data").rstrip("/"), "plugins"),
    ]
    for root in roots:
        if root and root not in sys.path and os.path.isdir(root):
            sys.path.insert(0, root)
        try:
            return getattr(importlib.import_module("wolfhouse_staff_api"), "flag_needs_human")
        except Exception:
            continue
    return None


def execute_explicit_human_handoff(*, reason: str = HUMAN_REQUESTED) -> Dict[str, Any]:
    """Call flag_needs_human via the Staff plugin (runtime tenant + session phone)."""
    reason_code = str(reason or HUMAN_REQUESTED).strip() or HUMAN_REQUESTED
    flag_needs_human = _load_flag_needs_human()
    if flag_needs_human is None:
        logger.warning(
            "%s",
            {"event": "explicit_human_handoff_import_failed", "error_type": "ModuleNotFoundError"},
        )
        return {
            "success": False,
            "tool": "flag_needs_human",
            "reason": reason_code,
            "needs_human": False,
            "error": "flag_needs_human_unavailable",
        }

    raw = flag_needs_human({"reason": reason_code})
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {"success": False, "raw": raw[:200]}
    else:
        data = dict(raw or {})
    data.setdefault("tool", "flag_needs_human")
    data["reason"] = reason_code
    data["explicit_human_request"] = True
    return data


def _event_text(event: Any) -> str:
    try:
        text = str(getattr(event, "text", None) or getattr(event, "message_text", None) or "")
        if not text and isinstance(event, dict):
            text = str(event.get("text") or event.get("message_text") or "")
        return text
    except Exception:
        return ""


def _event_chat_id(event: Any) -> str:
    try:
        source = event.get("source") if isinstance(event, dict) else getattr(event, "source", None)
        chat_id = source.get("chat_id") if isinstance(source, dict) else getattr(source, "chat_id", None)
        # Hermes MessageEvent carries trusted identity on source. Root fields
        # are retained only for older adapter/dict event forms.
        chat_id = chat_id or getattr(event, "chat_id", None) or getattr(event, "sender_id", None)
        if not chat_id and isinstance(event, dict):
            chat_id = event.get("chat_id") or event.get("sender_id") or event.get("from")
        return str(chat_id or "")
    except Exception:
        return ""


def _event_wamid(event: Any) -> str:
    try:
        mid = getattr(event, "message_id", None) or getattr(event, "whatsapp_message_id", None)
        if not mid and isinstance(event, dict):
            mid = event.get("message_id") or event.get("whatsapp_message_id")
        return str(mid or "").strip()
    except Exception:
        return ""


#: Every ``raw_response`` marker that means "the adapter returned success but the
#: guest received nothing". Missing one makes the ack path record an acknowledgement
#: that was never delivered.
_SUPPRESSED_MARKERS = ("suppressed_guest_automation_paused", "suppressed_guest_send_flag")


def _suppression_marker(result: Any) -> str:
    raw = getattr(result, "raw_response", None)
    if not isinstance(raw, dict) and isinstance(result, dict):
        raw = result.get("raw_response") or {}
    if not isinstance(raw, dict):
        return ""
    for marker in _SUPPRESSED_MARKERS:
        if raw.get(marker):
            return str(raw.get("blocked_reason") or marker)
    return ""


async def maybe_short_circuit_explicit_human(
    event: Any,
    adapter_dispatch: Any,
) -> Optional[Dict[str, Any]]:
    """Ack-before-persist short-circuit for explicit human requests.

    Lifecycle:
      detect → send deterministic ack (while conversation still active)
      → persist handoff/pause → skip agent
    """
    text = _event_text(event)
    if not is_explicit_human_request(text):
        return None

    chat_id = _event_chat_id(event)
    wamid = _event_wamid(event)
    phone_digits = _digits(chat_id)
    reply = acknowledgement_for(text)

    already_acked = bool(wamid and wamid in _ACKED_WAMIDS)
    already_blocked = is_local_automation_blocked(phone_digits)
    already_paused = False
    try:
        from wolfhouse import pause_gate as pause_gate_mod

        # Only treat as already-paused when runtime tenant is configured and the
        # gate positively reports paused. Missing LUNA_CLIENT_SLUG fails closed
        # for *ordinary* automation, but must not suppress the first handoff
        # acknowledgement (ack-before-persist).
        if pause_gate_mod._client_slug():
            already_paused = bool(pause_gate_mod.guest_paused_for_event(event))
    except Exception:
        already_paused = False

    # Later inbound on an already-paused / fail-closed thread: no second ack, no agent.
    skip_ack = already_acked or already_paused or already_blocked

    ack_sent = False
    ack_send_failed = False
    if not skip_ack:
        try:
            adapter = getattr(adapter_dispatch, "adapter", None)
            if adapter is not None and chat_id and hasattr(adapter, "send"):
                result = await adapter.send(chat_id, reply)
                _suppressed_by = _suppression_marker(result)
                if _suppressed_by:
                    ack_send_failed = True
                    logger.warning(
                        "%s",
                        {
                            "event": "handoff_ack_send_failed",
                            "error_type": _suppressed_by,
                        },
                    )
                else:
                    ack_sent = True
                    if wamid:
                        _ACKED_WAMIDS.add(wamid)
            else:
                ack_send_failed = True
                logger.warning(
                    "%s",
                    {"event": "handoff_ack_send_failed", "error_type": "adapter_unavailable"},
                )
        except Exception as exc:
            ack_send_failed = True
            logger.warning(
                "%s",
                {
                    "event": "handoff_ack_send_failed",
                    "error_type": type(exc).__name__,
                },
            )

    # Persist synchronously after the acknowledgement attempt (or immediately when
    # skipping ack on an already-paused/idempotent path). Human safety first: even
    # if the ack send failed, still open the handoff and pause automation.
    tool_result = execute_explicit_human_handoff(reason=HUMAN_REQUESTED)
    persisted = bool(tool_result.get("needs_human")) and bool(tool_result.get("success", True))

    if persisted:
        clear_local_automation_blocked(phone_digits)
    else:
        # Ack may have already told the guest a teammate will take over — never
        # continue booking automation until staff/reconciling can take over.
        mark_local_automation_blocked(phone_digits)
        logger.warning(
            "%s",
            {
                "event": "explicit_human_handoff_persist_failed",
                "ack_sent": ack_sent,
                "ack_send_failed": ack_send_failed,
                "needs_operator_reconciliation": True,
            },
        )

    return {
        "short_circuited": True,
        "tool": "flag_needs_human",
        "reason": HUMAN_REQUESTED,
        "tool_result": tool_result,
        "reply": reply,
        "ack_sent": ack_sent,
        "ack_send_failed": ack_send_failed,
        "ack_skipped_idempotent": skip_ack,
        "needs_human": bool(tool_result.get("needs_human")),
        "conversation_paused": bool(tool_result.get("conversation_paused")),
        "persist_ok": persisted,
        "local_fail_closed": (not persisted),
    }
