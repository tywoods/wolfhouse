"""Controlled peer-envelope builder for Water-cooler A2A (fail-closed).

Builds outbound peer messages only from an already-authorized runtime action
plus exact channel / recipient / task_id constraints. Never constructs an
envelope from a plain model reply automatically.

Emits either ``A2A-HANDOFF v1`` or ``A2A-REVIEW v1`` with a leading exact
recipient bot mention (required for ``DISCORD_ALLOW_BOTS=mentions`` admission
on the peer) and a single ``task_id:`` line.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional

try:
    from .water_cooler_a2a_policy import (
        HANDOFF_MARKER,
        MAX_CONTENT_LENGTH,
        REVIEW_MARKER,
        WATER_COOLER_CHANNEL_ID,
    )
    from .water_cooler_a2a_runtime import BridgeAction
except ImportError:  # pragma: no cover - script / importlib load path
    from water_cooler_a2a_policy import (
        HANDOFF_MARKER,
        MAX_CONTENT_LENGTH,
        REVIEW_MARKER,
        WATER_COOLER_CHANNEL_ID,
    )
    from water_cooler_a2a_runtime import BridgeAction

# Leave headroom for mention + markers + task_id line within Discord / policy bounds.
DEFAULT_MAX_BODY_LENGTH = 3500
MAX_MENTION_LENGTH = 48
MAX_TASK_ID_LENGTH = 64
MAX_SNOWFLAKE_LENGTH = 32

# Exact Discord user mention: <@digits> or <@!digits>
_MENTION_RE = re.compile(r"^<@!?(?P<id>[1-9][0-9]{0,31})>$")
_TASK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_SNOWFLAKE_RE = re.compile(r"^[1-9][0-9]{0,31}$")


def _is_snowflake(value: str) -> bool:
    if not isinstance(value, str) or not value or len(value) > MAX_SNOWFLAKE_LENGTH:
        return False
    return bool(_SNOWFLAKE_RE.fullmatch(value))


class EnvelopeKind(str, Enum):
    HANDOFF = "handoff"
    REVIEW = "review"


@dataclass(frozen=True)
class EnvelopeBuildResult:
    """Outcome of a controlled envelope build attempt (no raw rejection dumps)."""

    ok: bool
    kind: Optional[EnvelopeKind] = None
    content: Optional[str] = None
    reason: str = ""

    def __repr__(self) -> str:
        body = self.content
        # Never print full content in repr (may contain peer notes).
        content_note = "None" if body is None else f"<{len(body)} chars>"
        kind = self.kind.value if self.kind is not None else "None"
        return (
            f"EnvelopeBuildResult(ok={self.ok!r}, kind={kind!r}, "
            f"content={content_note}, reason={self.reason!r})"
        )


def _coerce_action(action: object) -> Optional[BridgeAction]:
    if isinstance(action, BridgeAction):
        return action
    if isinstance(action, str):
        try:
            return BridgeAction(action)
        except ValueError:
            return None
    return None


def _action_to_kind(action: BridgeAction) -> Optional[EnvelopeKind]:
    """Map already-authorized runtime dispatch actions to outbound envelope kinds.

    - Worker was authorized for human task or peer review → may emit handoff.
    - Reviewer was authorized for peer handoff → may emit review.
    - SUPPRESS and any other action → not authorized to emit peer envelopes.
    """
    if action in (BridgeAction.DISPATCH_HUMAN_TASK, BridgeAction.DISPATCH_PEER_REVIEW):
        return EnvelopeKind.HANDOFF
    if action == BridgeAction.DISPATCH_PEER_HANDOFF:
        return EnvelopeKind.REVIEW
    return None


def _valid_mention(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or len(text) > MAX_MENTION_LENGTH:
        return None
    match = _MENTION_RE.fullmatch(text)
    if not match:
        return None
    if not _is_snowflake(match.group("id")):
        return None
    return text


def _valid_task_id(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or len(text) > MAX_TASK_ID_LENGTH:
        return None
    if not _TASK_ID_RE.fullmatch(text):
        return None
    return text


def _valid_body(value: object, max_body_length: int) -> Optional[str]:
    if value is None:
        return ""
    if not isinstance(value, str):
        return None
    if len(value) > max_body_length:
        return None
    # Reject nested protocol markers as the body first line (fail closed).
    first = ""
    for line in value.splitlines():
        if line.strip():
            first = line.strip()
            break
    if first in (HANDOFF_MARKER, REVIEW_MARKER):
        return None
    if first.startswith("A2A-HANDOFF") or first.startswith("A2A-REVIEW"):
        return None
    return value


def build_peer_envelope(
    *,
    authorized_action: object,
    channel_id: object,
    recipient_bot_mention: object,
    task_id: object,
    body: object,
    expected_channel_id: object = WATER_COOLER_CHANNEL_ID,
    expected_recipient_mention: object = "",
    max_body_length: int = DEFAULT_MAX_BODY_LENGTH,
) -> EnvelopeBuildResult:
    """Build a peer envelope only under exact authorized constraints.

    Rejects wrong channel, wrong/inexact recipient mention, unauthorized
    actions (including SUPPRESS), invalid task ids, and oversized bodies.
    Never builds from a plain model reply without an authorized action.
    """
    if not isinstance(max_body_length, int) or isinstance(max_body_length, bool):
        return EnvelopeBuildResult(ok=False, reason="invalid_max_body_length")
    if max_body_length < 0 or max_body_length > MAX_CONTENT_LENGTH:
        return EnvelopeBuildResult(ok=False, reason="invalid_max_body_length")

    action = _coerce_action(authorized_action)
    if action is None:
        return EnvelopeBuildResult(ok=False, reason="unauthorized_or_unknown_action")
    if action == BridgeAction.SUPPRESS:
        return EnvelopeBuildResult(ok=False, reason="suppress_action_not_authorized")

    kind = _action_to_kind(action)
    if kind is None:
        return EnvelopeBuildResult(ok=False, reason="unauthorized_or_unknown_action")

    if not isinstance(expected_channel_id, str) or not _is_snowflake(expected_channel_id.strip()):
        return EnvelopeBuildResult(ok=False, reason="invalid_expected_channel")
    expected_ch = expected_channel_id.strip()

    if not isinstance(channel_id, str) or channel_id.strip() != expected_ch:
        return EnvelopeBuildResult(ok=False, reason="channel_mismatch")

    expected_mention = _valid_mention(expected_recipient_mention)
    if expected_mention is None:
        return EnvelopeBuildResult(ok=False, reason="invalid_expected_recipient_mention")

    recipient = _valid_mention(recipient_bot_mention)
    if recipient is None:
        return EnvelopeBuildResult(ok=False, reason="invalid_recipient_mention")
    if recipient != expected_mention:
        return EnvelopeBuildResult(ok=False, reason="recipient_mismatch")

    tid = _valid_task_id(task_id)
    if tid is None:
        return EnvelopeBuildResult(ok=False, reason="invalid_task_id")

    bounded_body = _valid_body(body, max_body_length)
    if bounded_body is None:
        return EnvelopeBuildResult(ok=False, reason="invalid_or_oversized_body")

    marker = HANDOFF_MARKER if kind == EnvelopeKind.HANDOFF else REVIEW_MARKER
    # Leading exact mention so peer DISCORD_ALLOW_BOTS=mentions can admit this.
    parts = [recipient, marker, f"task_id: {tid}"]
    if bounded_body:
        parts.append(bounded_body)
    content = "\n".join(parts)

    if len(content) > MAX_CONTENT_LENGTH:
        return EnvelopeBuildResult(ok=False, reason="envelope_exceeds_max_content")

    return EnvelopeBuildResult(ok=True, kind=kind, content=content, reason="ok")


def build_peer_envelope_from_model_reply(*_args: Any, **_kwargs: Any) -> EnvelopeBuildResult:
    """Hard rejection: envelopes must never be auto-built from plain model replies."""
    return EnvelopeBuildResult(ok=False, reason="plain_model_reply_not_authorized")


__all__ = [
    "DEFAULT_MAX_BODY_LENGTH",
    "EnvelopeBuildResult",
    "EnvelopeKind",
    "build_peer_envelope",
    "build_peer_envelope_from_model_reply",
]
