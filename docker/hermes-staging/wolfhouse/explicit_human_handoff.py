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
from contextlib import closing
from contextvars import ContextVar
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import threading
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
_RUNTIME_CONFIRMATION_BLOCK = ContextVar("luna_runtime_confirmation_block", default=False)
_CONFIRMATION_RECOVERY: ContextVar[Any] = ContextVar("luna_confirmation_recovery", default=None)


def arm_confirmation_recovery(recovery):
    return _CONFIRMATION_RECOVERY.set(dict(recovery or {}))


def release_confirmation_recovery(token):
    if token is not None:
        _CONFIRMATION_RECOVERY.reset(token)


def current_confirmation_recovery():
    value = _CONFIRMATION_RECOVERY.get()
    return dict(value) if isinstance(value, dict) else None


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
    recovery = current_confirmation_recovery() or {}
    recovery_booking_id = str(recovery.get("booking_id") or "").strip()
    turn = SimpleNamespace(
        tenant=tenant, origin=os.getenv("WOLFHOUSE_STAFF_API_BASE_URL", ""),
        phone=_event_chat_id(event), event=event, adapter=adapter_dispatch.adapter,
        loop=asyncio.get_running_loop(), thread=threading.get_ident(),
        task=asyncio.current_task(),
        lock=threading.Lock(), closed=False, requested=False,
        booking_saved=bool(recovery_booking_id), booking_created=False,
        booking_receipt=(dict(recovery) if recovery_booking_id else None),
        confirmation_payload=None,
        confirmation_booking_id=None,
        confirmation_provider_pending=None,
        confirmation_provider_accepted=None,
        confirmation_acceptance_failure_cause=None,
        handoff_pause_created=False, handoff_pause_identity=None,
        confirmation_owed=False,
        result=None,
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
    """The current model reply is never a duplicate merely because handoff ran."""
    del chat_id
    return False


def allow_ordinary_handoff_reply(chat_id, disposition=None):
    """Allow only the exact same-turn handoff or armed confirmation recovery."""
    turn = _ORDINARY_TURN.get()
    gate = disposition if isinstance(disposition, dict) else {}
    recovery = current_confirmation_recovery()
    if recovery:
        from .pause_gate import confirmation_recovery_allowed
        return bool(
            turn and getattr(turn, "booking_saved", False)
            and not _SENDING_ACK.get()
            and turn.tenant == os.getenv("LUNA_CLIENT_SLUG", "")
            and _digits(chat_id) == _digits(turn.phone)
            and confirmation_recovery_allowed(gate, recovery)
        )
    expected = getattr(turn, "handoff_pause_identity", None) if turn else None
    actual = gate.get("pause_state") if isinstance(gate.get("pause_state"), dict) else None
    identity_matches = bool(
        isinstance(expected, dict) and isinstance(actual, dict)
        and all(expected.get(key) not in (None, "")
                for key in ("id", "conversation_id", "paused_by", "pause_reason"))
        and all(actual.get(key) == expected.get(key)
                for key in ("id", "conversation_id", "paused_by", "pause_reason"))
    )
    return bool(
        turn and turn.requested and getattr(turn, "handoff_pause_created", False)
        and identity_matches
        and not _SENDING_ACK.get()
        and turn.tenant == os.getenv("LUNA_CLIENT_SLUG", "")
        and _digits(chat_id) == _digits(turn.phone)
        and gate.get("send_blocked") is True
        and gate.get("stage_as_draft") is not True
        and gate.get("agent_paused") is True
        and gate.get("reason") == "paused"
        and gate.get("whatsapp_channel_mode") == "auto"
        and gate.get("pause_source") == "bot_pause_states"
        and gate.get("pause_scope") == "conversation"
        and gate.get("global_paused") is False
        and gate.get("conversation_paused") is True
        and gate.get("same_turn_handoff_pause") is True
    )


def activate_same_turn_handoff_pause_scope(chat_id):
    """Mint pause-gate scope only from this runtime-owned turn state."""
    turn = _ORDINARY_TURN.get()
    if not (turn and turn.requested and getattr(turn, "handoff_pause_created", False)
            and turn.tenant == os.getenv("LUNA_CLIENT_SLUG", "")
            and _digits(chat_id) == _digits(turn.phone)):
        return None
    from wolfhouse.pause_gate import claim_same_turn_handoff_pause
    identity = getattr(turn, "handoff_pause_identity", None)
    if not isinstance(identity, dict):
        return None
    return claim_same_turn_handoff_pause(chat_id, identity)


def note_successful_booking_create(result):
    """Remember an authoritative fresh or recovered create receipt."""
    turn = _ORDINARY_TURN.get()
    saved = (turn is not None and isinstance(result, dict)
             and result.get("success") is True
             and str(result.get("booking_code") or "").strip())
    if saved:
        turn.booking_saved = True
        turn.booking_created = True  # compatibility with older in-process callers
        turn.booking_receipt = dict(result)


def note_saved_confirmation_payload(booking_id, payload):
    """Bind provider acceptance to the exact fact-checked confirmation payload."""
    turn = _ORDINARY_TURN.get()
    booking_id = str(booking_id or "").strip()
    payload = str(payload or "")
    receipt = getattr(turn, "booking_receipt", None) if turn is not None else None
    if (turn is None or not booking_id or not payload
            or str((receipt or {}).get("booking_id") or "").strip() != booking_id):
        return False
    turn.confirmation_booking_id = booking_id
    turn.confirmation_payload = payload
    return True


def saved_confirmation_payload_status(payload):
    """Return None for ordinary sends, otherwise exact confirmation payload match."""
    turn = _ORDINARY_TURN.get()
    expected = str(getattr(turn, "confirmation_payload", None) or "") if turn else ""
    if not expected:
        return None
    return bool(str(payload or "") == expected)


def _confirmation_fence_db_path():
    override = str(os.getenv("WOLFHOUSE_CONFIRMATION_FENCE_DB") or "").strip()
    if override:
        return Path(override)
    return Path(os.getenv("HERMES_HOME", "/opt/data")) / ".hermes" / "confirmation-provider-fences.sqlite3"


def _confirmation_fence_write(booking_id, provider_message_id):
    """Persist bounded provider progress; Staff remains the debt authority."""
    path = _confirmation_fence_db_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path, timeout=5)) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS confirmation_provider_fence ("
                "booking_id TEXT PRIMARY KEY, provider_message_id TEXT NOT NULL, "
                "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
            )
            row = db.execute(
                "SELECT provider_message_id FROM confirmation_provider_fence WHERE booking_id = ?",
                (booking_id,),
            ).fetchone()
            if row is not None:
                return row[0] == provider_message_id
            db.execute(
                "INSERT INTO confirmation_provider_fence (booking_id, provider_message_id) VALUES (?, ?)",
                (booking_id, provider_message_id),
            )
            db.commit()
        return True
    except Exception as exc:
        logger.warning("confirmation provider fence write failed: %s", type(exc).__name__)
        return False


def confirmation_provider_fence(booking_id):
    booking_id = str(booking_id or "").strip()
    if not booking_id:
        return None
    path = _confirmation_fence_db_path()
    try:
        if not path.exists():
            return None
        with closing(sqlite3.connect(path, timeout=5)) as db:
            row = db.execute(
                "SELECT provider_message_id FROM confirmation_provider_fence WHERE booking_id = ?",
                (booking_id,),
            ).fetchone()
        return str(row[0]) if row and row[0] else None
    except Exception as exc:
        logger.warning("confirmation provider fence read failed: %s", type(exc).__name__)
        return "__indeterminate__"


def retire_confirmation_provider_fence(booking_id, provider_message_id):
    path = _confirmation_fence_db_path()
    try:
        if not path.exists():
            return False
        with closing(sqlite3.connect(path, timeout=5)) as db:
            cursor = db.execute(
                "DELETE FROM confirmation_provider_fence "
                "WHERE booking_id = ? AND provider_message_id = ?",
                (booking_id, provider_message_id),
            )
            deleted = cursor.rowcount
            db.commit()
        return deleted == 1
    except Exception as exc:
        logger.warning("confirmation provider fence retirement failed: %s", type(exc).__name__)
        return False


def acknowledge_saved_confirmation(message_id, sent_payload):
    """Stamp provider acceptance only for the exact fact-checked confirmation."""
    turn = _ORDINARY_TURN.get()
    receipt = getattr(turn, "booking_receipt", None) if turn is not None else None
    booking_id = str((receipt or {}).get("booking_id") or "").strip()
    provider_message_id = str(message_id or "").strip()
    expected_payload = str(getattr(turn, "confirmation_payload", None) or "")
    expected_booking_id = str(getattr(turn, "confirmation_booking_id", None) or "").strip()
    if (not booking_id or not provider_message_id or not expected_payload
            or str(sent_payload or "") != expected_payload
            or expected_booking_id != booking_id):
        return None
    if not _confirmation_fence_write(booking_id, provider_message_id):
        turn.confirmation_acceptance_failure_cause = (
            "provider_acceptance_fence_not_persisted"
        )
        return False
    turn.confirmation_provider_pending = {
        "booking_id": booking_id,
        "provider_message_id": provider_message_id,
    }
    try:
        import wolfhouse_staff_api as staff_api
        result = staff_api._confirmation_owed_accepted(
            booking_id=booking_id,
            provider_message_id=provider_message_id,
        )
    except Exception as exc:
        logger.warning("saved confirmation acceptance stamp failed: %s", type(exc).__name__)
        result = {"success": False, "stamped": False,
                  "cause": "provider_acceptance_stamp_failed"}
    accepted = bool(
        isinstance(result, dict)
        and result.get("success") is True
        and result.get("stamped") is True
        and str(result.get("booking_id") or "") == booking_id
        and str(result.get("provider_message_id") or "") == provider_message_id
        and result.get("cleared") in (False, None)
    )
    if accepted and not retire_confirmation_provider_fence(booking_id, provider_message_id):
        accepted = False
        result = {
            "cause": "provider_acceptance_fence_retirement_failed",
        }
    if accepted:
        turn.confirmation_acceptance_failure_cause = None
        turn.confirmation_provider_accepted = dict(turn.confirmation_provider_pending)
        turn.confirmation_provider_pending = None
        turn.confirmation_owed = False
    else:
        cause = str((result or {}).get("cause") or "provider_acceptance_stamp_failed").strip()
        if not cause.startswith("provider_acceptance_stamp_failed"):
            cause = f"provider_acceptance_stamp_failed:{cause}"
        turn.confirmation_acceptance_failure_cause = saved_confirmation_failure_reason(cause)
    return accepted


def saved_confirmation_failure_reason(reason, raw_response=None):
    """Preserve a bounded non-guest provider cause for Staff recovery."""
    base = str(reason or "confirmation_delivery_blocked").strip()[:120]
    raw = raw_response if isinstance(raw_response, dict) else {}
    nested_error = raw.get("error")
    error = nested_error if isinstance(nested_error, dict) else {}
    code = error.get("code")
    if code is not None and re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", str(code)):
        return f"{base}:meta_code_{code}"
    error_type = raw.get("error_type")
    if error_type is not None and re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", str(error_type)):
        return f"{base}:{error_type}"
    return base


def flag_blocked_saved_confirmation(reason):
    """Keep a saved confirmation owed and make its concrete block visible to Staff."""
    turn = _ORDINARY_TURN.get()
    if turn is None or not getattr(turn, "booking_saved", False):
        return False
    concrete = str(reason or "confirmation_delivery_blocked")
    turn.confirmation_owed = True
    receipt = getattr(turn, "booking_receipt", None) or {}
    booking_code = str(receipt.get("booking_code") or "").strip()[:120]
    booking_id = str(receipt.get("booking_id") or "").strip()[:120]
    booking_reference = booking_code or booking_id
    concrete_reason = f"saved_booking_confirmation_blocked:{concrete}"
    if booking_reference:
        concrete_reason += f":booking_reference:{booking_reference}"
    logger.warning("%s", {
        "event": "saved_booking_confirmation_owed",
        "reason": concrete,
        "booking_code": booking_code or None,
        "booking_id": booking_id or None,
        "staff_review_needed": True,
    })
    try:
        import json
        import wolfhouse_staff_api as staff_api
        token = _RUNTIME_CONFIRMATION_BLOCK.set(True)
        try:
            flagged = json.loads(staff_api.flag_needs_human({
                "reason": concrete_reason,
                "phone": turn.phone,
                "booking_id": booking_id or None,
                "booking_code": booking_code or None,
            }))
        finally:
            _RUNTIME_CONFIRMATION_BLOCK.reset(token)
        ok = bool(
            flagged.get("success") is True
            and flagged.get("needs_human") is True
            and flagged.get("handoff_persisted") is True
            and str(flagged.get("staff_review_id") or "").strip()
            and flagged.get("handoff_reason") == concrete_reason
        )
        if not ok:
            logger.warning("%s", {
                "event": "saved_booking_confirmation_staff_flag_failed",
                "reason": str(flagged.get("error") or flagged.get("blocked_reasons") or concrete),
            })
        return ok
    except Exception as exc:
        logger.warning("%s", {
            "event": "saved_booking_confirmation_staff_flag_failed",
            "reason": concrete,
            "error_type": type(exc).__name__,
        })
        return False


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
    if (getattr(turn, "booking_saved", getattr(turn, "booking_created", False))
            and not _RUNTIME_CONFIRMATION_BLOCK.get()):
        logger.warning("%s", {
            "event": "ordinary_handoff_skipped",
            "reason": "successful_booking_create_requires_confirmation",
        })
        return {
            "success": False,
            "needs_human": False,
            "conversation_paused": False,
            "recoverable": True,
            "saved_booking_confirmation_required": True,
            "reason": reason,
        }
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
        if turn.result is not None and not _RUNTIME_CONFIRMATION_BLOCK.get():
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
        # Snapshot the gate before the handoff write. Only an unblocked baseline
        # followed by this successful handoff's pause may exempt the final reply.
        try:
            from wolfhouse.pause_gate import whatsapp_outbound_disposition
            baseline = whatsapp_outbound_disposition(turn.phone, force_refresh=True) or {}
        except Exception as exc:
            baseline = {"send_blocked": True, "reason": "gate_read_failed"}
            logger.warning("%s", {
                "event": "handoff_pause_baseline_failed",
                "reason": "gate_read_failed",
                "error_type": type(exc).__name__,
            })
        try:
            data = persist()
        except Exception:
            data = {"success": False, "needs_human": False, "error": "handoff_persist_failed"}
        persisted = data.get("success") is True and data.get("needs_human") is True
        pause_state = (data.get("pause_state")
                       if isinstance(data.get("pause_state"), dict) else {}) or {}
        handoff_identity = {
            "id": pause_state.get("id"),
            "conversation_id": pause_state.get("conversation_id") or data.get("conversation_id"),
            "paused_by": pause_state.get("paused_by"),
            "pause_reason": pause_state.get("pause_reason"),
            "source": pause_state.get("source"),
            "scope": "conversation",
        }
        identity_complete = all(
            handoff_identity.get(key) not in (None, "")
            for key in ("id", "conversation_id", "paused_by", "pause_reason", "source")
        )
        pause_created_by_call = (
            pause_state.get("paused") is True
            and pause_state.get("created") is True
            and pause_state.get("idempotent") is False
            and pause_state.get("existing_staff_owned") is False
        )
        turn.handoff_pause_identity = (
            handoff_identity if identity_complete and pause_created_by_call else None
        )
        turn.handoff_pause_created = bool(
            persisted
            and identity_complete
            and pause_created_by_call
            and data.get("conversation_paused") is True
            and baseline.get("send_blocked") is False
            and baseline.get("stage_as_draft") is not True
            and baseline.get("reason") in {"send", "no_phone"}
            and baseline.get("whatsapp_channel_mode") == "auto"
        )
        result = dict(data, ack_sent=turn.ack_sent, ack_send_failed=not turn.ack_sent,
                      local_fail_closed=not persisted, needs_operator_reconciliation=not persisted)
        if persisted:
            clear_local_automation_blocked(turn.phone)
            turn.result = result  # Only successful persistence is idempotent.
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
