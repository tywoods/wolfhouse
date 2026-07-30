"""Task-scoped authorized outbound context for Water-cooler A2A.

Established by a future adapter activation when the runtime bridge returns a
``DISPATCH_*`` action. The controlled outbound tool reads this context and
must never accept destination / channel / peer / round / task_id from the
model.

Uses a process-local slot (with a lock) plus an optional ``contextvars``
mirror for concurrent turns. Default: empty (fail closed). No ambient env
reads, network, filesystem, or deployment Discord IDs in source.
"""

from __future__ import annotations

import threading
import time
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import Any, Callable, Optional

try:
    from .water_cooler_a2a_envelope import EnvelopeKind
    from .water_cooler_a2a_runtime import BridgeAction
except ImportError:  # pragma: no cover - script / importlib load path
    from water_cooler_a2a_envelope import EnvelopeKind
    from water_cooler_a2a_runtime import BridgeAction

# Narrow callable: (channel_id, content) -> result object with ok/success + optional id/error
ChannelSendFn = Callable[[str, str], Any]


@dataclass(frozen=True)
class AuthorizedOutboundContext:
    """Facts already authorized for one outbound peer envelope.

    Never carries free-form peer/model body text. Destination and task
    identity are fixed here so the model tool can only supply review/handoff
    body text.
    """

    task_id: str
    authorized_action: BridgeAction
    envelope_kind: EnvelopeKind
    channel_id: str
    recipient_bot_id: str
    recipient_bot_mention: str
    local_bot_id: str
    expires_at: float
    # Bound sender + policy advance targets (not model-visible).
    runtime: Any
    channel_send_fn: Any
    established_at: float
    used: bool = False

    def __repr__(self) -> str:
        return (
            f"AuthorizedOutboundContext(task_id={self.task_id!r}, "
            f"action={self.authorized_action!r}, kind={self.envelope_kind!r}, "
            f"channel_id={self.channel_id!r}, recipient_bot_id={self.recipient_bot_id!r}, "
            f"used={self.used!r})"
        )


_lock = threading.RLock()
_current: Optional[AuthorizedOutboundContext] = None
_ctx_var: ContextVar[Optional[AuthorizedOutboundContext]] = ContextVar(
    "water_cooler_a2a_outbound_ctx",
    default=None,
)


def clear_authorized_outbound_context() -> None:
    """Drop any current authorized outbound context (fail closed)."""
    global _current
    with _lock:
        _current = None
        try:
            _ctx_var.set(None)
        except Exception:
            pass


def get_authorized_outbound_context() -> Optional[AuthorizedOutboundContext]:
    """Return the current task-scoped authorized context, or None."""
    try:
        local = _ctx_var.get()
        if local is not None:
            return local
    except Exception:
        pass
    with _lock:
        return _current


def set_authorized_outbound_context(
    ctx: AuthorizedOutboundContext,
) -> Token:
    """Install an authorized outbound context for this turn.

    Returns the contextvar token (tests may ignore it). Replaces any prior
    context. Does not enable policy by itself.
    """
    global _current
    if not isinstance(ctx, AuthorizedOutboundContext):
        raise TypeError("ctx must be AuthorizedOutboundContext")
    with _lock:
        _current = ctx
        return _ctx_var.set(ctx)


def mark_authorized_outbound_used() -> Optional[AuthorizedOutboundContext]:
    """Mark the current context as consumed (prevents duplicate tool sends).

    Returns the updated context, or None if none was set.
    """
    global _current
    with _lock:
        cur = _ctx_var.get()
        if cur is None:
            cur = _current
        if cur is None:
            return None
        updated = AuthorizedOutboundContext(
            task_id=cur.task_id,
            authorized_action=cur.authorized_action,
            envelope_kind=cur.envelope_kind,
            channel_id=cur.channel_id,
            recipient_bot_id=cur.recipient_bot_id,
            recipient_bot_mention=cur.recipient_bot_mention,
            local_bot_id=cur.local_bot_id,
            expires_at=cur.expires_at,
            runtime=cur.runtime,
            channel_send_fn=cur.channel_send_fn,
            established_at=cur.established_at,
            used=True,
        )
        _current = updated
        _ctx_var.set(updated)
        return updated


def _coerce_bridge_action(action: object, BA: Any) -> Optional[Any]:
    """Coerce action to BridgeAction even across importlib module reloads."""
    if isinstance(action, BA):
        return action
    if isinstance(action, str):
        try:
            return BA(action)
        except (ValueError, TypeError):
            return None
    # Enum (possibly from another load of the same source file).
    value = getattr(action, "value", None)
    if isinstance(value, str):
        try:
            return BA(value)
        except (ValueError, TypeError):
            return None
    name = getattr(action, "name", None)
    if isinstance(name, str) and hasattr(BA, name):
        return getattr(BA, name)
    return None


def establish_from_dispatch(
    *,
    runtime: Any,
    action: object,
    task_id: object,
    channel_send_fn: ChannelSendFn,
    now: Optional[float] = None,
) -> Optional[AuthorizedOutboundContext]:
    """Build and install context from an already-authorized bridge dispatch.

    Returns the context on success, or None when the action is not a
    dispatchable outbound, config is inactive, stage is wrong, or identities
    are incomplete. Never accepts model-chosen destination or channel.
    """
    try:
        from .water_cooler_a2a_runtime import BridgeAction as BA
    except ImportError:  # pragma: no cover
        from water_cooler_a2a_runtime import BridgeAction as BA

    if runtime is None or not callable(channel_send_fn):
        clear_authorized_outbound_context()
        return None

    config = getattr(runtime, "config", None)
    if config is None or not getattr(config, "is_active", False):
        clear_authorized_outbound_context()
        return None

    bridge_action = _coerce_bridge_action(action, BA)
    if bridge_action is None:
        clear_authorized_outbound_context()
        return None

    if bridge_action == BA.SUPPRESS:
        clear_authorized_outbound_context()
        return None

    if not isinstance(task_id, str) or not task_id.strip():
        clear_authorized_outbound_context()
        return None
    tid = task_id.strip()

    # Only the configured A2A channel (active config already validated snowflake).
    channel_id = str(getattr(config, "channel_id", "") or "").strip()
    if not channel_id:
        clear_authorized_outbound_context()
        return None

    seadog = str(getattr(config, "seadog_bot_id", "") or "").strip()
    deckhand = str(getattr(config, "deckhand_bot_id", "") or "").strip()
    local_bot = str(getattr(config, "local_bot_id", "") or "").strip()
    if not seadog or not deckhand or not local_bot:
        clear_authorized_outbound_context()
        return None

    # Worker emits handoff after human task or peer review; reviewer emits review after handoff.
    if bridge_action in (BA.DISPATCH_HUMAN_TASK, BA.DISPATCH_PEER_REVIEW):
        if not getattr(config, "is_local_worker", False):
            clear_authorized_outbound_context()
            return None
        kind = EnvelopeKind.HANDOFF
        recipient_id = deckhand
    elif bridge_action == BA.DISPATCH_PEER_HANDOFF:
        if not getattr(config, "is_local_reviewer", False):
            clear_authorized_outbound_context()
            return None
        kind = EnvelopeKind.REVIEW
        recipient_id = seadog
    else:
        clear_authorized_outbound_context()
        return None

    policy = getattr(runtime, "policy", None)
    if policy is None or not hasattr(policy, "get_task"):
        clear_authorized_outbound_context()
        return None
    clock = time.time() if now is None else float(now)
    state = policy.get_task(tid)
    if state is None:
        clear_authorized_outbound_context()
        return None

    stage = getattr(state, "stage", None)
    stage_val = getattr(stage, "value", stage)
    if stage_val == "terminal":
        clear_authorized_outbound_context()
        return None

    expires_at = float(getattr(state, "expires_at", 0.0) or 0.0)
    if clock > expires_at:
        clear_authorized_outbound_context()
        return None

    if kind == EnvelopeKind.HANDOFF and stage_val != "awaiting_worker_handoff":
        clear_authorized_outbound_context()
        return None
    if kind == EnvelopeKind.REVIEW and stage_val != "awaiting_reviewer_review":
        clear_authorized_outbound_context()
        return None

    mention = f"<@{recipient_id}>"
    ctx = AuthorizedOutboundContext(
        task_id=tid,
        authorized_action=bridge_action,
        envelope_kind=kind,
        channel_id=channel_id,
        recipient_bot_id=recipient_id,
        recipient_bot_mention=mention,
        local_bot_id=local_bot,
        expires_at=expires_at,
        runtime=runtime,
        channel_send_fn=channel_send_fn,
        established_at=clock,
        used=False,
    )
    set_authorized_outbound_context(ctx)
    return ctx


__all__ = [
    "AuthorizedOutboundContext",
    "ChannelSendFn",
    "clear_authorized_outbound_context",
    "establish_from_dispatch",
    "get_authorized_outbound_context",
    "mark_authorized_outbound_used",
    "set_authorized_outbound_context",
]
