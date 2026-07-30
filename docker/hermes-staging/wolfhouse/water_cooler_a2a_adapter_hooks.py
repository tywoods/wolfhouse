"""Water-cooler A2A adapter seams (gated activation).

Injected by ``apply_water_cooler_a2a_adapter_patch.py`` into the Hermes Discord
adapter. Behaviour is fail-closed unless:

1. ``HERMES_ROLE`` is ``seadog`` or ``deckhand``, and
2. ``WATER_COOLER_A2A_ENABLED=true`` (exact), and
3. ``WATER_COOLER_A2A_*`` IDs/config validate.

When inactive: mention bypass and pre-dispatch always return False (no effect).
When active: only the configured Navigation thread (under the Water-cooler
parent) is gated; other channels/threads pass through to normal Discord
handling. Valid human TASK / peer events route via the pure runtime bridge;
invalid/casual/reject/mirror are suppressed before model dispatch. Never logs
raw task/review content or env values.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

_log = logging.getLogger("wolfhouse.water_cooler_a2a")

# Process-local runtime (built once from validated A2A env mapping).
_lock = threading.RLock()
_runtime: Any = None
_runtime_ready: bool = False
_activation_active: bool = False
_init_attempted: bool = False

_PROTOCOL_TASK_RE = re.compile(
    r"(?m)^\s*TASK\s+\[target=seadog\]\s+\[reviewer=deckhand\]\s*$"
)
_PROTOCOL_PEER_RE = re.compile(
    r"(?m)^\s*(?:<@!?[1-9][0-9]{0,31}>\s*)?A2A-(?:HANDOFF|REVIEW)\s+v1\s*$"
)

# Reasons where SUPPRESS must not swallow normal Discord traffic.
_PASSTHROUGH_SUPPRESS_REASONS = frozenset(
    {
        "wrong_channel",
        "policy_disabled_or_invalid_config",
    }
)
# Thread-parent mismatches on the Navigation thread itself are suppressed
# (not passthrough) so protocol traffic with a moved/wrong parent fails closed.


def _safe_log(level: int, msg: str, *args: Any) -> None:
    """Log only structural reasons — never content or env values."""
    try:
        _log.log(level, msg, *args)
    except Exception:
        pass


def _reset_activation_state_for_tests() -> None:
    """Test-only: clear process-local runtime singleton."""
    global _runtime, _runtime_ready, _activation_active, _init_attempted
    with _lock:
        _runtime = None
        _runtime_ready = False
        _activation_active = False
        _init_attempted = False
        try:
            from .water_cooler_a2a_action_context import clear_authorized_outbound_context
        except ImportError:  # pragma: no cover
            try:
                from water_cooler_a2a_action_context import (  # type: ignore
                    clear_authorized_outbound_context,
                )
            except ImportError:
                clear_authorized_outbound_context = None  # type: ignore
        if clear_authorized_outbound_context is not None:
            clear_authorized_outbound_context()


def _ensure_runtime() -> bool:
    """Lazily build runtime from env under the activation gate. Fail closed."""
    global _runtime, _runtime_ready, _activation_active, _init_attempted
    with _lock:
        if _init_attempted:
            return _activation_active and _runtime_ready and _runtime is not None
        _init_attempted = True
        try:
            from .water_cooler_a2a_activation import (
                extract_a2a_env_mapping,
                runtime_mapping_from_validated,
                should_activate_a2a,
                validate_activation_ids,
            )
            from .water_cooler_a2a_runtime import WaterCoolerA2ARuntime
        except ImportError:  # pragma: no cover
            try:
                from water_cooler_a2a_activation import (  # type: ignore
                    extract_a2a_env_mapping,
                    runtime_mapping_from_validated,
                    should_activate_a2a,
                    validate_activation_ids,
                )
                from water_cooler_a2a_runtime import WaterCoolerA2ARuntime  # type: ignore
            except ImportError:
                _safe_log(logging.WARNING, "a2a_hooks_import_failed")
                return False

        role = os.environ.get("HERMES_ROLE", "")
        enabled = os.environ.get("WATER_COOLER_A2A_ENABLED", "")
        if not should_activate_a2a(role=role, enabled_value=enabled):
            _activation_active = False
            _runtime_ready = False
            _runtime = None
            return False

        try:
            mapping = extract_a2a_env_mapping(os.environ)
            mapping.setdefault("WATER_COOLER_A2A_ENABLED", enabled)
            validated = validate_activation_ids(role=role, mapping=mapping)
            rt_map = runtime_mapping_from_validated(validated)
            _runtime = WaterCoolerA2ARuntime.from_mapping(rt_map)
            if not getattr(_runtime.config, "is_active", False):
                _safe_log(logging.WARNING, "a2a_hooks_config_inactive")
                _runtime = None
                _activation_active = False
                _runtime_ready = False
                return False
            _activation_active = True
            _runtime_ready = True
            _safe_log(logging.INFO, "a2a_hooks_active role=%s", role)
            return True
        except Exception:
            _safe_log(logging.WARNING, "a2a_hooks_activation_failed")
            _runtime = None
            _activation_active = False
            _runtime_ready = False
            return False


def is_a2a_adapter_hooks_active() -> bool:
    """True only when role+enable gate passes and config validates."""
    return _ensure_runtime()


def _looks_like_a2a_protocol(content: str) -> bool:
    if not isinstance(content, str) or not content:
        return False
    if _PROTOCOL_TASK_RE.search(content):
        return True
    # Peer markers (optional leading mention line).
    lines = [ln.strip() for ln in content.splitlines() if ln.strip()]
    if not lines:
        return False
    first = lines[0]
    if first in ("A2A-HANDOFF v1", "A2A-REVIEW v1"):
        return True
    if re.fullmatch(r"<@!?[1-9][0-9]{0,31}>", first) and len(lines) > 1:
        return lines[1] in ("A2A-HANDOFF v1", "A2A-REVIEW v1")
    return bool(_PROTOCOL_PEER_RE.search(content))


def a2a_allow_mention_bypass(
    *,
    channel_id: str,
    content: str,
    author_is_bot: bool,
    parent_channel_id: str = "",
) -> bool:
    """Narrow mention-bypass for Navigation-thread protocol messages only.

    Does not change require_mention defaults, free-response channels, or
    DISCORD_ALLOW_BOTS. Returns True only when A2A is active, the message is
    in the configured Navigation thread whose parent is Water-cooler, and
    content looks like protocol. Does not broaden the parent channel.
    """
    if not _ensure_runtime() or _runtime is None:
        return False
    try:
        cfg = _runtime.config
        ch = str(channel_id or "").strip()
        if not ch or ch != str(getattr(cfg, "channel_id", "") or ""):
            return False
        parent = str(parent_channel_id or "").strip()
        expected_parent = str(getattr(cfg, "parent_channel_id", "") or "")
        if not parent or not expected_parent or parent != expected_parent:
            return False
        body = content if isinstance(content, str) else ""
        if not _looks_like_a2a_protocol(body):
            return False
        # author_is_bot reserved for future narrowing; both human TASK and
        # peer envelopes may need bypass depending on mention shape.
        _ = bool(author_is_bot)
        return True
    except Exception:
        return False


def _timestamp_to_epoch(value: Any) -> float:
    if value is None:
        return time.time()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    # Discord may expose created_at as datetime; reject unknown types.
    return time.time()


def _normalize_from_raw_message(message: Any) -> Optional[Any]:
    """Build DiscordMessageEvent from the explicit raw Discord message object.

    Does not guess attributes on MessageEvent — requires the raw message.
    Captures thread ``parent_id`` when present so policy can require the
    Navigation thread under Water-cooler (not parent-channel posts).
    """
    if message is None:
        return None
    try:
        from .water_cooler_a2a_policy import DiscordMessageEvent
    except ImportError:  # pragma: no cover
        from water_cooler_a2a_policy import DiscordMessageEvent  # type: ignore

    try:
        author = getattr(message, "author", None)
        channel = getattr(message, "channel", None)
        if author is None or channel is None:
            return None
        author_id = getattr(author, "id", None)
        channel_id = getattr(channel, "id", None)
        message_id = getattr(message, "id", None)
        if author_id is None or channel_id is None or message_id is None:
            return None
        content = getattr(message, "content", None)
        if content is None:
            content = ""
        if not isinstance(content, str):
            content = str(content)
        author_is_bot = bool(getattr(author, "bot", False))
        created = getattr(message, "created_at", None)
        # Discord Thread: channel.parent_id is the parent text channel snowflake.
        # Direct channel posts have no parent_id (None) → empty string.
        parent_raw = getattr(channel, "parent_id", None)
        if parent_raw is None:
            parent_channel_id = ""
        else:
            parent_channel_id = str(parent_raw).strip()
        return DiscordMessageEvent(
            channel_id=str(channel_id),
            message_id=str(message_id),
            author_id=str(author_id),
            content=content,
            is_bot=author_is_bot,
            created_at=_timestamp_to_epoch(created),
            parent_channel_id=parent_channel_id,
        )
    except Exception:
        return None


def _bind_channel_send_fn(adapter: Any):
    """Sync wrapper around adapter.send(chat_id, content) (async-safe)."""

    def send_to_channel(channel_id: str, content: str) -> Any:
        if adapter is None or not hasattr(adapter, "send"):
            return _SendResult(ok=False, error="adapter_missing")

        async def _do():
            return await adapter.send(str(channel_id), str(content))

        try:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            if loop is None:
                result = asyncio.run(_do())
            else:
                # Tool handler may run on the gateway loop thread — use a
                # worker thread with its own loop to avoid deadlock.
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    result = pool.submit(lambda: asyncio.run(_do())).result(
                        timeout=60
                    )
            return _normalize_send_result(result)
        except Exception:
            return _SendResult(ok=False, error="send_exception")

    return send_to_channel


class _SendResult:
    __slots__ = ("ok", "success", "message_id", "error")

    def __init__(
        self,
        *,
        ok: bool,
        message_id: Optional[str] = None,
        error: str = "",
    ) -> None:
        self.ok = ok
        self.success = ok
        self.message_id = message_id
        self.error = error


def _normalize_send_result(result: Any) -> _SendResult:
    if result is None:
        return _SendResult(ok=False, error="empty_send_result")
    if isinstance(result, _SendResult):
        return result
    ok = bool(getattr(result, "success", getattr(result, "ok", False)))
    mid = getattr(result, "message_id", None)
    if mid is None:
        ids = getattr(result, "message_ids", None)
        if isinstance(ids, (list, tuple)) and ids:
            mid = str(ids[0])
    err = str(getattr(result, "error", "") or "")
    return _SendResult(
        ok=ok,
        message_id=str(mid) if mid is not None else None,
        error=err if not ok else "",
    )


def a2a_pre_dispatch_intercept(
    event: Any,
    *,
    adapter: Any = None,
    message: Any = None,
) -> bool:
    """Pre-model-dispatch seam.

    Returns True when the event was fully handled / suppressed and must not
    reach the agent model. Requires the raw Discord ``message`` (explicit
    kwarg from the patch) so policy sees author id, bot flag, channel id,
    message id, raw content, and timestamp — never guessed from event fields.
    """
    if not _ensure_runtime() or _runtime is None:
        return False

    # Prefer explicit message= from the patched call site; fall back only to
    # event.raw_message when that is the documented Hermes field (not guessing
    # author/channel on the event itself).
    raw = message
    if raw is None and event is not None:
        raw = getattr(event, "raw_message", None)
    if raw is None:
        # Cannot normalize safely — fail closed only inside Water-cooler would
        # require channel; without raw message, do not intercept (passthrough).
        return False

    normalized = _normalize_from_raw_message(raw)
    if normalized is None:
        return False

    try:
        from .water_cooler_a2a_runtime import BridgeAction
        from .water_cooler_a2a_action_context import (
            clear_authorized_outbound_context,
            establish_from_dispatch,
        )
    except ImportError:  # pragma: no cover
        from water_cooler_a2a_runtime import BridgeAction  # type: ignore
        from water_cooler_a2a_action_context import (  # type: ignore
            clear_authorized_outbound_context,
            establish_from_dispatch,
        )

    try:
        result = _runtime.handle_event(normalized, now=normalized.created_at)
    except Exception:
        _safe_log(logging.WARNING, "a2a_pre_dispatch_eval_failed")
        return False

    action = result.action
    reason = result.reason if isinstance(result.reason, str) else "unknown"

    if action == BridgeAction.SUPPRESS:
        if reason in _PASSTHROUGH_SUPPRESS_REASONS:
            # Other channels / inactive: leave normal Discord handling alone.
            return False
        # Water-cooler casual/invalid/reject/mirror/terminal/replay: suppress.
        clear_authorized_outbound_context()
        _safe_log(logging.INFO, "a2a_suppress reason=%s", reason)
        return True

    # DISPATCH_* — establish task-scoped outbound context, then let model run.
    try:
        send_fn = _bind_channel_send_fn(adapter)
        established = establish_from_dispatch(
            runtime=_runtime,
            action=action,
            task_id=result.task_id,
            channel_send_fn=send_fn,
            now=normalized.created_at,
        )
        if established is None:
            _safe_log(logging.WARNING, "a2a_dispatch_context_failed reason=%s", reason)
            # Fail closed: do not dispatch model without authorized context
            # for peer/handoff paths that need the tool. For human task the
            # worker still needs context to reply with the tool — suppress if
            # context failed.
            return True
        _safe_log(
            logging.INFO,
            "a2a_dispatch action=%s",
            getattr(action, "value", str(action)),
        )
        return False
    except Exception:
        _safe_log(logging.WARNING, "a2a_dispatch_setup_failed")
        clear_authorized_outbound_context()
        return True


__all__ = [
    "a2a_allow_mention_bypass",
    "a2a_pre_dispatch_intercept",
    "is_a2a_adapter_hooks_active",
]
