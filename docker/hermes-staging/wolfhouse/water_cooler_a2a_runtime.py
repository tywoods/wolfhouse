"""Water-cooler A2A runtime bridge (pure, fail-closed, no side effects).

Repository-owned adapter surface for a *later* Hermes Discord hook. The caller
passes an explicit config mapping and a normalized :class:`DiscordMessageEvent`.
This module:

1. Parses config from the injected mapping only (never ambient env vars).
2. Builds the pure :class:`WaterCoolerA2APolicy` / config.
3. Classifies the message and returns a narrow action contract.

Actions
-------
- ``SUPPRESS`` — do not send the message to an agent model.
- ``DISPATCH_HUMAN_TASK`` — only the named worker's valid human task.
- ``DISPATCH_PEER_HANDOFF`` — only expected peer handoff, reviewer instance.
- ``DISPATCH_PEER_REVIEW`` — only expected peer review, worker instance.

Side-effect free: no LLM, Discord SDK, tools, network, filesystem, ambient
environment, or logging of message bodies. The caller owns all side effects
(including reading the original event content when a DISPATCH_* action is
returned). Action metadata never carries raw message bodies.

Not wired into Hermes. Not enabled by default.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping, MutableMapping, Optional

try:
    from .water_cooler_a2a_policy import (
        DEFAULT_TTL_SECONDS,
        DecisionKind,
        DiscordMessageEvent,
        PolicyDecision,
        WaterCoolerA2AConfig,
        WaterCoolerA2APolicy,
        build_config,
    )
except ImportError:  # pragma: no cover - script / importlib load path
    from water_cooler_a2a_policy import (
        DEFAULT_TTL_SECONDS,
        DecisionKind,
        DiscordMessageEvent,
        PolicyDecision,
        WaterCoolerA2AConfig,
        WaterCoolerA2APolicy,
        build_config,
    )

# ---------------------------------------------------------------------------
# Neutral config key names (no real Discord IDs or human names in source)
# ---------------------------------------------------------------------------

CFG_ENABLED = "WATER_COOLER_A2A_ENABLED"
# Preferred: parent Water-cooler + Navigation thread (exact message channel).
CFG_PARENT_CHANNEL_ID = "WATER_COOLER_A2A_PARENT_CHANNEL_ID"
CFG_THREAD_ID = "WATER_COOLER_A2A_THREAD_ID"
# Legacy alias for the exact message channel (must equal THREAD_ID when both set).
CFG_CHANNEL_ID = "WATER_COOLER_A2A_CHANNEL_ID"
CFG_LOCAL_BOT_ID = "WATER_COOLER_A2A_LOCAL_BOT_ID"
CFG_SEADOG_BOT_ID = "WATER_COOLER_A2A_SEADOG_BOT_ID"
CFG_DECKHAND_BOT_ID = "WATER_COOLER_A2A_DECKHAND_BOT_ID"
CFG_ALLOWED_HUMAN_STARTER_IDS = "WATER_COOLER_A2A_ALLOWED_HUMAN_STARTER_IDS"
CFG_TASK_TTL_SECONDS = "WATER_COOLER_A2A_TASK_TTL_SECONDS"

_TRUE_TOKENS = frozenset({"1", "true", "yes", "on"})
_FALSE_TOKENS = frozenset({"0", "false", "no", "off", ""})


# ---------------------------------------------------------------------------
# Action contract
# ---------------------------------------------------------------------------


class BridgeAction(str, Enum):
    """Narrow instruction for the adapter caller (caller owns side effects)."""

    SUPPRESS = "suppress"
    DISPATCH_HUMAN_TASK = "dispatch_human_task"
    DISPATCH_PEER_HANDOFF = "dispatch_peer_handoff"
    DISPATCH_PEER_REVIEW = "dispatch_peer_review"


@dataclass(frozen=True)
class BridgeResult:
    """Action + safe metadata only — never stores message body or peer text."""

    action: BridgeAction
    reason: str
    task_id: Optional[str] = None

    def __repr__(self) -> str:
        # Explicit safe repr (no accidental content fields).
        tid = self.task_id if self.task_id is not None else "None"
        return (
            f"BridgeResult(action={self.action!r}, reason={self.reason!r}, "
            f"task_id={tid!r})"
        )


# ---------------------------------------------------------------------------
# Config parser (injected mapping only; fail closed; no raw input leakage)
# ---------------------------------------------------------------------------


def _disabled_config() -> WaterCoolerA2AConfig:
    """Fail-closed inactive config. Carries no caller raw strings."""
    return build_config(enabled=False)


def _parse_bool(value: object) -> Optional[bool]:
    """Return True/False, or None when the value is malformed (fail closed)."""
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # Reject bare numbers — only explicit bool or known string tokens.
        return None
    if isinstance(value, str):
        token = value.strip().lower()
        if token in _TRUE_TOKENS:
            return True
        if token in _FALSE_TOKENS:
            return False
        return None
    return None


def _parse_snowflake_str(value: object) -> Optional[str]:
    """Return a stripped string candidate, or None if type is wrong.

    Validity of the snowflake shape is left to :func:`build_config` /
    ``is_active`` so this parser never embeds raw malformed text into errors.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        # Reject numeric types — IDs must be strings (Discord snowflakes as text).
        return None
    if isinstance(value, str):
        return value.strip()
    return None


def _parse_human_id_list(value: object) -> Optional[frozenset]:
    """Parse allowed human starter IDs from list/tuple/set or comma-separated str.

    Returns None on malformed types (fail closed). Empty set is allowed as a
    parse result; policy ``is_active`` then fails closed when enabled.
    """
    if value is None:
        return frozenset()
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        parts = [p.strip() for p in value.split(",") if p.strip()]
        return frozenset(parts)
    if isinstance(value, (list, tuple, set, frozenset)):
        out = []
        for item in value:
            if not isinstance(item, str):
                return None
            s = item.strip()
            if s:
                out.append(s)
        return frozenset(out)
    return None


def _parse_ttl(value: object) -> Optional[float]:
    """Parse TTL seconds. None means malformed (fail closed)."""
    if value is None:
        # Missing key handled by caller; None here = use default when key absent.
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            return None
    return None


def parse_runtime_config(mapping: Optional[Mapping[str, Any]] = None) -> WaterCoolerA2AConfig:
    """Build policy config from an explicit mapping only.

    - Disabled by default when mapping is missing/empty or enable is false.
    - Malformed booleans, ID lists, or TTL fail closed (inactive config).
    - Never reads ambient environment variables, filesystem, or network.
    - Returned config never embeds raw invalid input strings for diagnostics.
    """
    if mapping is None:
        return _disabled_config()
    if not isinstance(mapping, Mapping):
        return _disabled_config()
    # Snapshot keys only; do not retain a reference to a mutable caller map.
    try:
        data: MutableMapping[str, Any] = dict(mapping)
    except Exception:
        return _disabled_config()

    enabled_raw = data.get(CFG_ENABLED, False)
    enabled = _parse_bool(enabled_raw)
    if enabled is None:
        return _disabled_config()

    # Exact message channel is the Navigation thread. Both PARENT and THREAD
    # are required. Legacy CHANNEL_ID, when present, must equal THREAD_ID.
    thread = _parse_snowflake_str(data.get(CFG_THREAD_ID, ""))
    if thread is None or not thread:
        return _disabled_config()
    legacy_channel = _parse_snowflake_str(data.get(CFG_CHANNEL_ID, ""))
    if legacy_channel is None:
        return _disabled_config()
    if legacy_channel and legacy_channel != thread:
        # Ambiguous: old channel key disagrees with Navigation thread.
        return _disabled_config()
    channel = thread

    parent = _parse_snowflake_str(data.get(CFG_PARENT_CHANNEL_ID, ""))
    if parent is None or not parent:
        return _disabled_config()

    local_bot = _parse_snowflake_str(data.get(CFG_LOCAL_BOT_ID, ""))
    if local_bot is None:
        return _disabled_config()

    seadog = _parse_snowflake_str(data.get(CFG_SEADOG_BOT_ID, ""))
    if seadog is None:
        return _disabled_config()

    deckhand = _parse_snowflake_str(data.get(CFG_DECKHAND_BOT_ID, ""))
    if deckhand is None:
        return _disabled_config()

    humans = _parse_human_id_list(data.get(CFG_ALLOWED_HUMAN_STARTER_IDS, frozenset()))
    if humans is None:
        return _disabled_config()

    if CFG_TASK_TTL_SECONDS in data:
        ttl = _parse_ttl(data.get(CFG_TASK_TTL_SECONDS))
        if ttl is None:
            return _disabled_config()
    else:
        ttl = DEFAULT_TTL_SECONDS

    # build_config + is_active apply snowflake/TTL/role bounds; no raw dump.
    return build_config(
        enabled=enabled,
        channel_id=channel,
        parent_channel_id=parent,
        allowed_human_starter_ids=humans,
        seadog_bot_id=seadog,
        deckhand_bot_id=deckhand,
        local_bot_id=local_bot,
        task_ttl_seconds=ttl,
    )


# ---------------------------------------------------------------------------
# Runtime bridge
# ---------------------------------------------------------------------------


class WaterCoolerA2ARuntime:
    """Per-process A2A gate. Holds isolated policy state; restart = empty.

    Construct with :meth:`from_mapping` (preferred) or an already-built config.
    """

    def __init__(self, config: WaterCoolerA2AConfig) -> None:
        if not isinstance(config, WaterCoolerA2AConfig):
            config = _disabled_config()
        self._config = config
        self._policy = WaterCoolerA2APolicy(config)

    @classmethod
    def from_mapping(
        cls,
        mapping: Optional[Mapping[str, Any]] = None,
    ) -> "WaterCoolerA2ARuntime":
        """Create a bridge from an explicit config mapping (not the environment)."""
        return cls(parse_runtime_config(mapping))

    @property
    def config(self) -> WaterCoolerA2AConfig:
        return self._config

    @property
    def policy(self) -> WaterCoolerA2APolicy:
        return self._policy

    def handle_event(
        self,
        event: DiscordMessageEvent,
        *,
        now: Optional[float] = None,
    ) -> BridgeResult:
        """Classify one normalized Discord event; return the action contract.

        Always runs local policy evaluation (state may advance). Maps the pure
        policy decision onto SUPPRESS / DISPATCH_* for the local role.
        """
        if not isinstance(event, DiscordMessageEvent):
            return BridgeResult(BridgeAction.SUPPRESS, "invalid_event")

        decision = self._policy.evaluate(event, now=now)
        return self._map_decision(decision)

    def _map_decision(self, decision: PolicyDecision) -> BridgeResult:
        kind = decision.kind
        reason = decision.reason if isinstance(decision.reason, str) else "unknown"
        task_id = decision.task_id if isinstance(decision.task_id, str) else None
        cfg = self._config

        if kind == DecisionKind.HUMAN_TASK:
            # Policy only emits HUMAN_TASK on the worker instance.
            return BridgeResult(BridgeAction.DISPATCH_HUMAN_TASK, reason, task_id)

        if kind == DecisionKind.PEER_HANDOFF:
            # Expected consumer: reviewer (Deckhand) processes worker handoff.
            if cfg.is_local_reviewer:
                return BridgeResult(BridgeAction.DISPATCH_PEER_HANDOFF, reason, task_id)
            return BridgeResult(
                BridgeAction.SUPPRESS,
                "peer_handoff_non_local_consumer",
                task_id,
            )

        if kind == DecisionKind.PEER_REVIEW:
            # Expected consumer: worker (Seadog) processes reviewer feedback.
            if cfg.is_local_worker:
                return BridgeResult(BridgeAction.DISPATCH_PEER_REVIEW, reason, task_id)
            return BridgeResult(
                BridgeAction.SUPPRESS,
                "peer_review_non_local_consumer",
                task_id,
            )

        # IGNORE and REJECT (and any unexpected kind) → never dispatch.
        return BridgeResult(BridgeAction.SUPPRESS, reason, task_id)


# Explicit public API for a later adapter hook.
__all__ = [
    "CFG_ENABLED",
    "CFG_PARENT_CHANNEL_ID",
    "CFG_THREAD_ID",
    "CFG_CHANNEL_ID",
    "CFG_LOCAL_BOT_ID",
    "CFG_SEADOG_BOT_ID",
    "CFG_DECKHAND_BOT_ID",
    "CFG_ALLOWED_HUMAN_STARTER_IDS",
    "CFG_TASK_TTL_SECONDS",
    "BridgeAction",
    "BridgeResult",
    "WaterCoolerA2ARuntime",
    "parse_runtime_config",
]
