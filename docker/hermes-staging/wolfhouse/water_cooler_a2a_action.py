"""Controlled Water-cooler A2A outbound action (fail-closed).

Model-facing surface accepts only bounded review/handoff body text. All
destination, channel, peer, task_id, envelope kind, and authorized action
values are retrieved from the task-scoped runtime context established after
a valid bridge ``DISPATCH_*`` — never from the model.

Sends only through a Water-cooler-scoped sender (rejects any other channel).
Advances local policy state only after a successful send. Does not perform
HTTP, filesystem, shell, staff/booking/customer/payment actions, or convert
plain model replies into A2A envelopes.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, List, Optional, Tuple

try:
    from .water_cooler_a2a_action_context import (
        AuthorizedOutboundContext,
        clear_authorized_outbound_context,
        get_authorized_outbound_context,
        mark_authorized_outbound_used,
    )
    from .water_cooler_a2a_envelope import (
        DEFAULT_MAX_BODY_LENGTH,
        EnvelopeKind,
        build_peer_envelope,
        build_peer_envelope_from_model_reply,
    )
    from .water_cooler_a2a_policy import (
        DecisionKind,
        WATER_COOLER_CHANNEL_ID,
    )
    from .water_cooler_a2a_runtime import BridgeAction
except ImportError:  # pragma: no cover - script / importlib load path
    from water_cooler_a2a_action_context import (
        AuthorizedOutboundContext,
        clear_authorized_outbound_context,
        get_authorized_outbound_context,
        mark_authorized_outbound_used,
    )
    from water_cooler_a2a_envelope import (
        DEFAULT_MAX_BODY_LENGTH,
        EnvelopeKind,
        build_peer_envelope,
        build_peer_envelope_from_model_reply,
    )
    from water_cooler_a2a_policy import (
        DecisionKind,
        WATER_COOLER_CHANNEL_ID,
    )
    from water_cooler_a2a_runtime import BridgeAction


@dataclass(frozen=True)
class ChannelSendResult:
    """Minimal send outcome (no raw content in repr)."""

    ok: bool
    message_id: Optional[str] = None
    error: str = ""
    channel_id: Optional[str] = None

    def __repr__(self) -> str:
        return (
            f"ChannelSendResult(ok={self.ok!r}, message_id={self.message_id!r}, "
            f"error={self.error!r}, channel_id={self.channel_id!r})"
        )


@dataclass
class FakeChannelSender:
    """Test double: records sends; can be preconfigured to fail."""

    fail: bool = False
    fail_error: str = "send_failed"
    next_message_id: str = "900000000000000001"
    sent: List[Tuple[str, str]] = field(default_factory=list)

    def send_to_channel(self, channel_id: str, content: str) -> ChannelSendResult:
        self.sent.append((str(channel_id), str(content) if content is not None else ""))
        if self.fail:
            return ChannelSendResult(
                ok=False, error=self.fail_error, channel_id=str(channel_id)
            )
        mid = self.next_message_id
        # Bump for subsequent sends so IDs stay unique in multi-call tests.
        try:
            self.next_message_id = str(int(mid) + 1)
        except ValueError:
            self.next_message_id = mid + "x"
        return ChannelSendResult(ok=True, message_id=mid, channel_id=str(channel_id))


class WaterCoolerScopedSender:
    """Strictly scoped sender: only the Water-cooler channel is allowed.

    Wraps an underlying ``send_to_channel(channel_id, content)`` callable or
    object. Rejects any other channel before the underlying send runs.
    """

    def __init__(
        self,
        underlying: Any,
        *,
        allowed_channel_id: str = WATER_COOLER_CHANNEL_ID,
    ) -> None:
        self._underlying = underlying
        self._allowed = str(allowed_channel_id or "").strip()

    @property
    def allowed_channel_id(self) -> str:
        return self._allowed

    def send(self, channel_id: object, content: object) -> ChannelSendResult:
        if not isinstance(channel_id, str) or not channel_id.strip():
            return ChannelSendResult(ok=False, error="invalid_channel_id")
        ch = channel_id.strip()
        if not self._allowed or ch != self._allowed:
            return ChannelSendResult(
                ok=False,
                error="channel_not_water_cooler",
                channel_id=ch,
            )
        if not isinstance(content, str):
            return ChannelSendResult(
                ok=False, error="invalid_content", channel_id=ch
            )

        try:
            result = self._invoke(ch, content)
        except Exception:
            return ChannelSendResult(ok=False, error="send_exception", channel_id=ch)

        return self._normalize(result, ch)

    def _invoke(self, channel_id: str, content: str) -> Any:
        u = self._underlying
        if callable(u) and not hasattr(u, "send_to_channel"):
            return u(channel_id, content)
        if hasattr(u, "send_to_channel"):
            return u.send_to_channel(channel_id, content)
        if hasattr(u, "send"):
            # Discord-style adapter: send(chat_id, content)
            return u.send(channel_id, content)
        raise TypeError("underlying sender has no send_to_channel/send")

    @staticmethod
    def _normalize(result: Any, channel_id: str) -> ChannelSendResult:
        if isinstance(result, ChannelSendResult):
            return result
        if result is None:
            return ChannelSendResult(ok=False, error="empty_send_result", channel_id=channel_id)
        if isinstance(result, bool):
            return ChannelSendResult(
                ok=result,
                error="" if result else "send_failed",
                channel_id=channel_id,
            )
        # Duck-type common adapter results.
        ok = bool(getattr(result, "success", getattr(result, "ok", False)))
        mid = getattr(result, "message_id", None)
        if mid is None:
            ids = getattr(result, "message_ids", None)
            if isinstance(ids, (list, tuple)) and ids:
                mid = str(ids[0])
        err = str(getattr(result, "error", "") or "")
        if mid is not None:
            mid = str(mid)
        return ChannelSendResult(
            ok=ok,
            message_id=mid,
            error=err if not ok else "",
            channel_id=channel_id,
        )


@dataclass(frozen=True)
class ControlledActionResult:
    """Outcome of the controlled outbound action (no body dump in repr)."""

    ok: bool
    reason: str
    task_id: Optional[str] = None
    envelope_kind: Optional[str] = None
    message_id: Optional[str] = None

    def __repr__(self) -> str:
        return (
            f"ControlledActionResult(ok={self.ok!r}, reason={self.reason!r}, "
            f"task_id={self.task_id!r}, envelope_kind={self.envelope_kind!r}, "
            f"message_id={self.message_id!r})"
        )

    def as_tool_dict(self) -> dict:
        """JSON-friendly payload for Hermes tool handlers."""
        return {
            "success": self.ok,
            "reason": self.reason,
            "task_id": self.task_id,
            "envelope_kind": self.envelope_kind,
            "message_id": self.message_id,
        }


def _coerce_action(action: object) -> Optional[BridgeAction]:
    """Coerce to BridgeAction across importlib module reloads."""
    if isinstance(action, BridgeAction):
        return action
    if isinstance(action, str):
        try:
            return BridgeAction(action)
        except ValueError:
            return None
    value = getattr(action, "value", None)
    if isinstance(value, str):
        try:
            return BridgeAction(value)
        except ValueError:
            return None
    name = getattr(action, "name", None)
    if isinstance(name, str) and hasattr(BridgeAction, name):
        return getattr(BridgeAction, name)
    return None


def _coerce_send_fn(send_fn: Any, expected_channel: str) -> WaterCoolerScopedSender:
    if isinstance(send_fn, WaterCoolerScopedSender):
        # Re-wrap only if already scoped to the expected channel.
        if send_fn.allowed_channel_id == expected_channel:
            return send_fn
        return WaterCoolerScopedSender(
            send_fn, allowed_channel_id=expected_channel
        )
    return WaterCoolerScopedSender(send_fn, allowed_channel_id=expected_channel)


def execute_controlled_outbound(
    *,
    body: object,
    now: Optional[float] = None,
    max_body_length: int = DEFAULT_MAX_BODY_LENGTH,
) -> ControlledActionResult:
    """Send one authorized peer envelope; body is the only model input.

    Fail-closed when context is missing/used/expired, policy disabled, wrong
    role/stage, body oversize, adapter/sender missing, send fails, or
    envelope build rejects. Advances local policy only after successful send.
    """
    clock = time.time() if now is None else float(now)
    ctx = get_authorized_outbound_context()
    if ctx is None or not isinstance(ctx, AuthorizedOutboundContext):
        return ControlledActionResult(ok=False, reason="no_authorized_task_context")

    if ctx.used:
        return ControlledActionResult(
            ok=False,
            reason="duplicate_tool_use",
            task_id=ctx.task_id,
        )

    if clock > float(ctx.expires_at):
        clear_authorized_outbound_context()
        return ControlledActionResult(
            ok=False,
            reason="task_expired_or_terminal",
            task_id=ctx.task_id,
        )

    runtime = ctx.runtime
    if runtime is None:
        return ControlledActionResult(
            ok=False, reason="adapter_or_runtime_missing", task_id=ctx.task_id
        )
    config = getattr(runtime, "config", None)
    if config is None or not getattr(config, "is_active", False):
        return ControlledActionResult(
            ok=False, reason="policy_disabled_or_invalid_config", task_id=ctx.task_id
        )

    # Channel must remain the authorized Water-cooler channel for this config.
    expected_channel = str(getattr(config, "channel_id", "") or "").strip()
    if not expected_channel or ctx.channel_id != expected_channel:
        return ControlledActionResult(
            ok=False, reason="channel_mismatch", task_id=ctx.task_id
        )
    # Absolute bound: never send outside the protocol Water-cooler constant
    # when config still points at the pilot channel; if config channel differs
    # from constant, still only allow the authorized context channel (which
    # was taken from active config). Scoped sender enforces expected_channel.
    if ctx.channel_id != expected_channel:
        return ControlledActionResult(
            ok=False, reason="channel_mismatch", task_id=ctx.task_id
        )

    action = _coerce_action(ctx.authorized_action)
    if action is None or action == BridgeAction.SUPPRESS:
        return ControlledActionResult(
            ok=False, reason="unauthorized_or_unknown_action", task_id=ctx.task_id
        )

    # Role check (belt-and-suspenders with establish_from_dispatch).
    action_value = getattr(action, "value", str(action))
    if action_value in (
        BridgeAction.DISPATCH_HUMAN_TASK.value,
        BridgeAction.DISPATCH_PEER_REVIEW.value,
    ):
        if not getattr(config, "is_local_worker", False):
            return ControlledActionResult(
                ok=False, reason="wrong_role", task_id=ctx.task_id
            )
        outbound_kind = "handoff"
    elif action_value == BridgeAction.DISPATCH_PEER_HANDOFF.value:
        if not getattr(config, "is_local_reviewer", False):
            return ControlledActionResult(
                ok=False, reason="wrong_role", task_id=ctx.task_id
            )
        outbound_kind = "review"
    else:
        return ControlledActionResult(
            ok=False, reason="unauthorized_or_unknown_action", task_id=ctx.task_id
        )

    if not callable(ctx.channel_send_fn) and not hasattr(
        ctx.channel_send_fn, "send_to_channel"
    ) and not hasattr(ctx.channel_send_fn, "send"):
        return ControlledActionResult(
            ok=False, reason="adapter_or_runtime_missing", task_id=ctx.task_id
        )

    # Body bound (type + length). Envelope builder also enforces.
    if body is None:
        body_text = ""
    elif not isinstance(body, str):
        return ControlledActionResult(
            ok=False, reason="invalid_or_oversized_body", task_id=ctx.task_id
        )
    else:
        body_text = body
    if len(body_text) > max_body_length:
        return ControlledActionResult(
            ok=False, reason="invalid_or_oversized_body", task_id=ctx.task_id
        )

    built = build_peer_envelope(
        authorized_action=action_value,
        channel_id=ctx.channel_id,
        recipient_bot_mention=ctx.recipient_bot_mention,
        task_id=ctx.task_id,
        body=body_text,
        expected_channel_id=expected_channel,
        expected_recipient_mention=ctx.recipient_bot_mention,
        max_body_length=max_body_length,
    )
    if not built.ok or not built.content:
        return ControlledActionResult(
            ok=False,
            reason=built.reason or "envelope_build_failed",
            task_id=ctx.task_id,
        )

    sender = _coerce_send_fn(ctx.channel_send_fn, expected_channel)
    # Refuse any attempt to send elsewhere (even if a buggy caller rebinds).
    send_result = sender.send(ctx.channel_id, built.content)
    if not send_result.ok:
        return ControlledActionResult(
            ok=False,
            reason=send_result.error or "send_failed",
            task_id=ctx.task_id,
            envelope_kind=(
                built.kind.value if isinstance(built.kind, EnvelopeKind) else outbound_kind
            ),
        )

    # Successful send → advance local policy; mark context used (no repeat).
    policy = getattr(runtime, "policy", None)
    if policy is None or not hasattr(policy, "record_local_outbound"):
        mark_authorized_outbound_used()
        return ControlledActionResult(
            ok=False,
            reason="policy_advance_unavailable",
            task_id=ctx.task_id,
            envelope_kind=outbound_kind,
            message_id=send_result.message_id,
        )

    decision = policy.record_local_outbound(
        ctx.task_id,
        kind=outbound_kind,
        now=clock,
        outbound_message_id=send_result.message_id,
    )
    mark_authorized_outbound_used()

    if decision.kind not in (DecisionKind.PEER_HANDOFF, DecisionKind.PEER_REVIEW):
        # Send already happened; surface advance failure without allowing resend.
        return ControlledActionResult(
            ok=False,
            reason=decision.reason or "policy_advance_failed",
            task_id=ctx.task_id,
            envelope_kind=outbound_kind,
            message_id=send_result.message_id,
        )

    return ControlledActionResult(
        ok=True,
        reason="sent",
        task_id=ctx.task_id,
        envelope_kind=outbound_kind,
        message_id=send_result.message_id,
    )


def reject_plain_model_reply_as_a2a(*_args: Any, **_kwargs: Any) -> ControlledActionResult:
    """Hard rejection: plain model replies never become A2A envelopes."""
    _ = build_peer_envelope_from_model_reply(*_args, **_kwargs)
    return ControlledActionResult(ok=False, reason="plain_model_reply_not_authorized")


def water_cooler_a2a_send(body: str = "", **_ignored: Any) -> dict:
    """Hermes tool entrypoint — only ``body`` is accepted from the model.

    Extra kwargs (task_id, channel_id, recipient, etc.) are ignored so the
    model cannot steer destination. Returns a small JSON-friendly dict.
    """
    # Explicitly ignore any destination-steering kwargs the model might invent.
    _ = _ignored
    result = execute_controlled_outbound(body=body if body is not None else "")
    return result.as_tool_dict()


__all__ = [
    "ChannelSendResult",
    "ControlledActionResult",
    "FakeChannelSender",
    "WaterCoolerScopedSender",
    "execute_controlled_outbound",
    "reject_plain_model_reply_as_a2a",
    "water_cooler_a2a_send",
]
