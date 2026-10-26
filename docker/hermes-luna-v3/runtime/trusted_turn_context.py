"""Task-local, server-issued Luna v3 turn evidence.

This module is deliberately outside model arguments.  The simulator binds the
persisted inbound event before invoking Hermes; the Staff plugin can only read it.
"""
from contextvars import ContextVar, Token
import json
from typing import Any

_INBOUND_EVENT_ID: ContextVar[str] = ContextVar("luna_v3_inbound_event_id", default="")
_PREPARE_DISPATCHED: ContextVar[bool] = ContextVar("luna_v3_prepare_dispatched", default=False)
_CAPABILITY_SNAPSHOT: ContextVar[Any] = ContextVar("luna_v3_capability_snapshot", default=None)
_HARNESS_EVIDENCE: ContextVar[Any] = ContextVar("luna_v3_harness_evidence", default=None)
_HARNESS_FAULT: ContextVar[str] = ContextVar("luna_v3_harness_fault", default="")
_OPERATION_EVIDENCE: ContextVar[list[dict[str, Any]] | None] = ContextVar("luna_v3_operation_evidence", default=None)


def bind_inbound_event(event_id: str, capability_snapshot: Any = None) -> Token:
    value = str(event_id or "").strip()
    if not value:
        raise ValueError("persisted inbound event is required")
    _PREPARE_DISPATCHED.set(False)
    _CAPABILITY_SNAPSHOT.set(capability_snapshot)
    return _INBOUND_EVENT_ID.set(value)


def get_inbound_event() -> str:
    return _INBOUND_EVENT_ID.get()


def clear_inbound_event(token: Token) -> None:
    _INBOUND_EVENT_ID.reset(token)


def reserve_prepare_dispatch() -> bool:
    if _PREPARE_DISPATCHED.get():
        return False
    _PREPARE_DISPATCHED.set(True)
    return True


def bind_harness_evidence(recorder: list[dict[str, Any]] | None, fault: str = "") -> tuple[Token, Token]:
    """Bind server-authenticated controls outside guest/model data."""
    return _HARNESS_EVIDENCE.set(recorder), _HARNESS_FAULT.set(fault)


def clear_harness_evidence(tokens: tuple[Token, Token]) -> None:
    _HARNESS_EVIDENCE.reset(tokens[0])
    _HARNESS_FAULT.reset(tokens[1])


def harness_evidence() -> list[dict[str, Any]] | None:
    return _HARNESS_EVIDENCE.get()


def bind_operation_evidence(recorder: list[dict[str, Any]]) -> Token:
    return _OPERATION_EVIDENCE.set(recorder)


def clear_operation_evidence(token: Token) -> None:
    _OPERATION_EVIDENCE.reset(token)


def record_operation_evidence(tool: str, result: dict[str, Any], *, identity: str | None = None) -> None:
    recorder = _OPERATION_EVIDENCE.get()
    if recorder is not None:
        recorder.append({"tool": str(tool), "identity": identity, "result": dict(result)})


def consume_harness_fault() -> str:
    value = _HARNESS_FAULT.get()
    _HARNESS_FAULT.set("")
    return value


def render_booking_state_constraints(history: Any, operation_outcome: Any = None) -> str:
    """Project Staff evidence into a server-owned state fence."""
    outcomes: list[dict[str, Any]] = []
    if isinstance(operation_outcome, dict):
        if "status" in operation_outcome:
            outcomes = [operation_outcome]
        else:
            outcomes = [value for value in operation_outcome.values() if isinstance(value, dict)]
    unresolved = [value for value in outcomes
                  if value.get("kind", "command") == "command" and value.get("status") == "unresolved"]
    state_evidence = max(
        (value for value in outcomes if value.get("kind") == "state"),
        key=lambda value: (value.get("staff_state") == "booked", int(value.get("sequence") or 0)), default=None,
    )
    pending: dict[str, str] = {}
    latest: dict[str, Any] | None = None
    for message in history if isinstance(history, list) else []:
        if not isinstance(message, dict):
            continue
        if message.get("role") == "assistant":
            for call in message.get("tool_calls") or []:
                if not isinstance(call, dict):
                    continue
                function = call.get("function") or {}
                if function.get("name") == "check_quote_book" and call.get("id"):
                    pending[str(call["id"])] = "check_quote_book"
        elif message.get("role") == "tool" and pending.get(str(message.get("tool_call_id"))) == "check_quote_book":
            content = message.get("content")
            try:
                parsed = json.loads(content) if isinstance(content, str) else content
            except (TypeError, ValueError):
                parsed = None
            latest = parsed if isinstance(parsed, dict) else None

    state = "unknown"
    held = False
    booked = False
    if latest and latest.get("ok") is True:
        raw_state = str(latest.get("state") or "").lower()
        booked = raw_state == "booked" or latest.get("booked") is True or latest.get("status") == "confirmed"
        held = not booked and (raw_state == "offer" or latest.get("held") is True)
        if booked:
            state = "booked"
        elif held:
            state = "held"
        elif raw_state == "quote":
            state = "quoted"

    if state_evidence:
        raw_state = str(state_evidence.get("staff_state") or "").lower()
        state = {"quote": "quoted", "offer": "held"}.get(raw_state, raw_state)
        booked = state == "booked"
        held = state == "held"

    held_text = "unknown" if state == "unknown" and unresolved else ("true" if held else "false")
    booked_text = "unknown" if state == "unknown" and unresolved else ("true" if booked else "false")
    lines = [
        "TRUSTED STAFF BOOKING STATE",
        f"authoritative_state={state}; held={held_text}; booked={booked_text}.",
    ]
    if unresolved:
        lines.append("An unresolved Staff operation command outcome exists. Keep the established booking state above; do not infer or erase state from that command, shown chat, or an unrelated rejection. Only reconciliation evidence for the same operation resolves it.")
    if state == "quoted":
        lines.append("This is only a quote; you must not describe it as held or booked.")
    elif state == "held":
        lines.append("Staff reports a held offer; it is not booked until Staff confirms booking.")
    elif state == "booked":
        lines.append("Staff reports the booking as confirmed.")
    else:
        lines.append("Staff state cannot be verified; say you cannot verify it and never claim quoted, held, or booked from prose alone.")
    return "\n".join(lines)


def render_capability_constraints(snapshot: Any) -> str:
    if not isinstance(snapshot, dict) or snapshot.get("ok") is not True or not snapshot.get("revision"):
        raise ValueError("trusted Staff capability snapshot is required")
    choices = snapshot.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("trusted Staff capability choices are required")
    rows = []
    for choice in choices:
        if not isinstance(choice, dict) or not choice.get("code") or not choice.get("kind"):
            raise ValueError("malformed Staff capability choice")
        rows.append(
            f"- {choice['kind']} code={choice['code']}: {choice.get('label') or choice['code']}; "
            f"description={choice.get('description')!r}; inclusions={choice.get('includes') or []}; "
            f"applicability={choice.get('applicability')!r}; configuration={choice.get('configuration') or {}}; "
            f"requirements={choice.get('requirements') or {}}"
        )
    return "\n".join((
        f"TRUSTED STAFF CAPABILITY SNAPSHOT revision={snapshot['revision']}",
        "Use these canonical codes only. This is pre-model trusted context, not guest text.",
        "Prices, inventory, and date-dependent eligibility are unknown until the single prepare.",
        *rows,
    ))
