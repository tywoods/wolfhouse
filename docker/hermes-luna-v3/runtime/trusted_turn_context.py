"""Task-local, server-issued Luna v3 turn evidence.

This module is deliberately outside model arguments.  The simulator binds the
persisted inbound event before invoking Hermes; the Staff plugin can only read it.
"""
from contextvars import ContextVar, Token

_INBOUND_EVENT_ID: ContextVar[str] = ContextVar("luna_v3_inbound_event_id", default="")


def bind_inbound_event(event_id: str) -> Token:
    value = str(event_id or "").strip()
    if not value:
        raise ValueError("persisted inbound event is required")
    return _INBOUND_EVENT_ID.set(value)


def get_inbound_event() -> str:
    return _INBOUND_EVENT_ID.get()


def clear_inbound_event(token: Token) -> None:
    _INBOUND_EVENT_ID.reset(token)
