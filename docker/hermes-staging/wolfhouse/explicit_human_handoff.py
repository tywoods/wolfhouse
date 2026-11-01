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
import urllib.request
from types import SimpleNamespace
from typing import Any, Dict, Optional, Set

logger = logging.getLogger(__name__)

HUMAN_REQUESTED = "human_requested"
# Both tenant SOULs use this context when a successful status read has not
# resolved the guest's payment report. It is not a failed operation/charge.
PAYMENT_REPORTED_UNRESOLVED = "business_tool_error: payment_reported_unresolved"

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
    install_booking_save_receipt_patch()
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


def install_booking_save_receipt_patch():
    """Observe the real Staff create result without changing the Staff plugin."""
    try:
        import wolfhouse_staff_api as staff_api
    except Exception:
        return False
    original = getattr(staff_api, "create_booking_from_plan", None)
    if original is None or getattr(original, "_wolfhouse_booking_receipt", False):
        return original is not None

    def create_booking_from_plan(*args, **kwargs):
        result = original(*args, **kwargs)
        note_successful_booking_create(result)
        return result

    create_booking_from_plan._wolfhouse_booking_receipt = True
    staff_api.create_booking_from_plan = create_booking_from_plan
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
        booking_saved=False, booking_reference="",
        handoff_pause_id="", handoff_pause_created=False,
        handoff_existing_staff_owned=False,
        persisted_reason="",
        saved_reply_exception_consumed=False,
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


def note_successful_booking_create(raw_result):
    """Record only Staff's authoritative receipt that this call saved a booking."""
    turn = _ORDINARY_TURN.get()
    if turn is None:
        return False
    if isinstance(raw_result, str):
        try:
            result = json.loads(raw_result)
        except json.JSONDecodeError:
            return False
    elif isinstance(raw_result, dict):
        result = raw_result
    else:
        return False
    reference = str(result.get("booking_code") or result.get("booking_id") or "").strip()
    saved = bool(
        result.get("success") is True
        and result.get("write_performed") is True
        and reference
    )
    if saved:
        turn.booking_saved = True
        turn.booking_reference = reference
    return saved


def is_saved_booking_turn(chat_id):
    turn = _ORDINARY_TURN.get()
    return bool(
        turn and turn.booking_saved
        and turn.tenant == os.getenv("LUNA_CLIENT_SLUG", "")
        and _digits(chat_id) == _digits(turn.phone)
    )


def _active_handoff_pause_matches(chat_id, expected_pause_id):
    """Re-read Staff SoT and require the exact same conversation pause row."""
    slug = (os.getenv("LUNA_CLIENT_SLUG") or "").strip()
    token = (os.getenv("LUNA_BOT_INTERNAL_TOKEN") or "").strip()
    phone = "+" + _digits(chat_id)
    if not slug or not token or phone == "+":
        return False
    base = (os.getenv("WOLFHOUSE_STAFF_API_BASE_URL")
            or "https://staff-staging.lunafrontdesk.com").rstrip("/")
    body = json.dumps({
        "client_slug": slug,
        "source": "hermes_luna_whatsapp",
        "guest_phone": phone,
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{base}/staff/bot/check-guest-automation-gate",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Luna-Bot-Token": token,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=2.0) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception:
        return False
    if not isinstance(data, dict) or data.get("success") is False or data.get("lookup_error"):
        return False
    pause_state = data.get("pause_state")
    return bool(
        data.get("global_paused") is not True
        and data.get("conversation_paused") is True
        and isinstance(pause_state, dict)
        and pause_state.get("paused") is True
        and pause_state.get("paused_by") == "luna_flag_needs_human"
        and str(pause_state.get("id") or "").strip() == str(expected_pause_id or "").strip()
    )


def allow_saved_booking_reply(chat_id, content, disposition):
    """Consume one exact confirmation exception for the same Staff pause row."""
    turn = _ORDINARY_TURN.get()
    if turn is None:
        return False
    gate = disposition if isinstance(disposition, dict) else {}
    confirmation = str(content or "")
    eligible = bool(
        is_saved_booking_turn(chat_id) and turn.requested
        and not turn.saved_reply_exception_consumed
        and turn.booking_reference in confirmation
        and turn.handoff_pause_id and turn.handoff_pause_created
        and not turn.handoff_existing_staff_owned
        and turn.tenant == os.getenv("LUNA_CLIENT_SLUG", "")
        and _digits(chat_id) == _digits(turn.phone)
        and gate.get("send_blocked") is True
        and gate.get("stage_as_draft") is not True
        and gate.get("reason") == "paused"
        and gate.get("whatsapp_channel_mode") == "auto"
    )
    if not eligible or not _active_handoff_pause_matches(chat_id, turn.handoff_pause_id):
        return False
    # Consume before calling Meta: a failed send is flagged for staff and is not
    # retried by silently granting another bypass in the same turn.
    turn.saved_reply_exception_consumed = True
    return True


def flag_blocked_saved_booking_send(reason):
    """Flag an unsent saved-booking reply, trusting only Staff's receipt."""
    turn = _ORDINARY_TURN.get()
    if turn is None or not turn.booking_saved or not turn.booking_reference:
        return False
    real_reason = str(reason or "whatsapp_send_failed").strip()[:120]
    handoff_reason = (
        f"saved_booking_reply_send_failed:{real_reason}:"
        f"booking_reference:{turn.booking_reference}"
    )
    flag_needs_human = _load_flag_needs_human()
    if flag_needs_human is None:
        return False
    try:
        raw = flag_needs_human({
            "reason": handoff_reason,
            "booking_code": turn.booking_reference,
        })
        result = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
    except Exception as exc:
        logger.warning("saved booking send flag failed: %s", type(exc).__name__)
        return False
    return bool(result.get("success") is True and result.get("needs_human") is True)


def persist_ordinary_handoff(payload, persist):
    """Persist a true handoff; payment-link failures remain active and retryable."""
    reason = str((payload or {}).get("reason") or "")
    if (reason == PAYMENT_REPORTED_UNRESOLVED
            or re.fullmatch(r"business_tool_error: \w+ payment operation failed", reason)):
        return {
            "success": False,
            "needs_human": False,
            "conversation_paused": False,
            "recoverable": True,
            "retry_next_turn": True,
            "reason": reason,
        }
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
        if not isinstance(text, str) or not text.strip():
            return False
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
        if turn.result is not None and reason == turn.persisted_reason:
            return dict(turn.result)
        turn.requested = True
        if not turn.ack_attempted:
            turn.ack_attempted = True
            payment_failure = bool(re.fullmatch(
                r"business_tool_error: \w+ payment operation failed",
                str(payload.get("reason") or ""),
            ))
            turn.ack_sent = send_notice(acknowledgement_for(
                _event_text(turn.event), payment_failure=payment_failure,
                payment_reported=payload.get("reason") == PAYMENT_REPORTED_UNRESOLVED))
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
        persisted = data.get("success") is True and data.get("needs_human") is True
        result = dict(data, ack_sent=turn.ack_sent, ack_send_failed=not turn.ack_sent,
                      local_fail_closed=not persisted, needs_operator_reconciliation=not persisted)
        if persisted:
            # Preserve this turn's creation provenance only while Staff reports
            # the same pause row. A replacement row must prove creation anew.
            pause_id = str(data.get("pause_id") or "").strip()
            same_created_pause = bool(
                pause_id and pause_id == turn.handoff_pause_id
                and turn.handoff_pause_created
            )
            turn.handoff_pause_id = pause_id
            turn.handoff_pause_created = (
                data.get("created") is True or same_created_pause
            )
            turn.handoff_existing_staff_owned = data.get("existing_staff_owned") is True
            clear_local_automation_blocked(turn.phone)
            turn.result = result  # Only successful persistence is idempotent.
            turn.persisted_reason = reason
        else:
            # No deterministic fallback prose: without model wording this path
            # fails closed and sends nothing.
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


def acknowledgement_for(message_text: Any, *, payment_failure: bool = False,
                        payment_reported: bool = False) -> None:
    """Guest wording belongs to the turn model; deterministic handoff has none."""
    del message_text, payment_failure, payment_reported
    return None


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
                if reply is None:
                    raise RuntimeError("model_handoff_wording_unavailable")
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
