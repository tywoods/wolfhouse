"""Task-local, server-issued Luna v3 turn evidence.

This module is deliberately outside model arguments.  The simulator binds the
persisted inbound event before invoking Hermes; the Staff plugin can only read it.
"""
from contextvars import ContextVar, Token
from typing import Any

_INBOUND_EVENT_ID: ContextVar[str] = ContextVar("luna_v3_inbound_event_id", default="")
_PREPARE_DISPATCHED: ContextVar[bool] = ContextVar("luna_v3_prepare_dispatched", default=False)
_CAPABILITY_SNAPSHOT: ContextVar[Any] = ContextVar("luna_v3_capability_snapshot", default=None)


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
