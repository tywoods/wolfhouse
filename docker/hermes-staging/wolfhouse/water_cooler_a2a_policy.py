"""Water-cooler A2A policy foundation (pure, fail-closed, mirrored).

Deterministic state machine that classifies a Discord message as:

- ignore (casual / wrong channel / disabled / non-protocol / mirrored non-dispatch)
- reject (unauthorized, malformed, wrong role/order, duplicate, expired, limit)
- human-started task (dispatchable only on the named worker instance)
- allowed peer handoff
- allowed peer review

Seadog and Deckhand run in separate processes. Both role-local policy
instances observe the same human TASK and deterministically create the same
task id/state from the inbound Discord message (no shared memory, volume,
database, or secret). Only the worker returns HUMAN_TASK; the reviewer
records a mirror and returns a non-dispatch ignore. Both validate peer
envelopes against local mirror state.

No model calls, no tool invocation, no ambient env reads, no Discord adapter
wiring. Configuration and bot/human IDs are injected. State never stores raw
task text or peer/model output. Restart empties local state — peer envelopes
are rejected (fail closed), never replayed from Discord history.

Later runtime hook may call :meth:`WaterCoolerA2APolicy.evaluate` only.
"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, FrozenSet, Iterable, Optional, Set

# ---------------------------------------------------------------------------
# Protocol constants (markers only; identities come from config)
# ---------------------------------------------------------------------------

WATER_COOLER_CHANNEL_ID = "1530209175861199019"

HUMAN_TASK_PREFIX = "TASK"
TARGET_MARKER = "[target=seadog]"
REVIEWER_MARKER = "[reviewer=deckhand]"
HANDOFF_MARKER = "A2A-HANDOFF v1"
REVIEW_MARKER = "A2A-REVIEW v1"

ROLE_WORKER = "seadog"
ROLE_REVIEWER = "deckhand"

MAX_CONTENT_LENGTH = 4000
MAX_ID_LENGTH = 64
MAX_SNOWFLAKE_LENGTH = 32
MIN_TTL_SECONDS = 1.0
MAX_TTL_SECONDS = 86_400.0  # 24h hard bound
DEFAULT_TTL_SECONDS = 3_600.0
MAX_ROUNDS = 3

_TASK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_SNOWFLAKE_RE = re.compile(r"^[1-9][0-9]{0,31}$")
_TASK_ID_LINE_RE = re.compile(
    r"^task_id\s*[:=]\s*([A-Za-z0-9_-]{8,64})\s*$",
    re.IGNORECASE | re.MULTILINE,
)


# ---------------------------------------------------------------------------
# Enums / models
# ---------------------------------------------------------------------------


class DecisionKind(str, Enum):
    IGNORE = "ignore"
    REJECT = "reject"
    HUMAN_TASK = "human_task"
    PEER_HANDOFF = "peer_handoff"
    PEER_REVIEW = "peer_review"


class TaskStage(str, Enum):
    AWAITING_WORKER_HANDOFF = "awaiting_worker_handoff"
    AWAITING_REVIEWER_REVIEW = "awaiting_reviewer_review"
    TERMINAL = "terminal"


@dataclass(frozen=True)
class DiscordMessageEvent:
    """Minimal inbound event for the policy (no Discord SDK objects)."""

    channel_id: str
    message_id: str
    author_id: str
    content: str
    is_bot: bool
    created_at: float  # unix epoch seconds


@dataclass(frozen=True)
class TaskState:
    """Opaque task record — never holds task body or peer/model text."""

    task_id: str
    stage: TaskStage
    worker_bot_id: str
    reviewer_bot_id: str
    source_channel_id: str
    source_message_id: str
    created_at: float
    updated_at: float
    expires_at: float
    round_count: int  # completed handoff+review rounds (0..MAX_ROUNDS)


@dataclass(frozen=True)
class PolicyDecision:
    kind: DecisionKind
    reason: str
    task_id: Optional[str] = None
    task_state: Optional[TaskState] = None


def derive_task_id(channel_id: str, message_id: str) -> str:
    """Deterministic opaque task id from the human Discord message identity.

    Both Seadog and Deckhand process instances must produce the same id for
    the same inbound human message without shared memory or secrets.
    """
    material = f"{channel_id}:{message_id}".encode("utf-8")
    # 32 hex chars fit [A-Za-z0-9_-]{8,64}; stable across processes/restarts
    # of derivation (state itself remains in-memory only).
    return hashlib.sha256(material).hexdigest()[:32]


@dataclass(frozen=True)
class WaterCoolerA2AConfig:
    """Injected configuration. Default enabled=False; invalid fails closed.

    ``local_bot_id`` must be exactly the Seadog or Deckhand bot id so each
    process knows its role (worker vs reviewer) for dispatch decisions.
    """

    enabled: bool = False
    channel_id: str = WATER_COOLER_CHANNEL_ID
    allowed_human_starter_ids: FrozenSet[str] = field(default_factory=frozenset)
    seadog_bot_id: str = ""
    deckhand_bot_id: str = ""
    local_bot_id: str = ""
    task_ttl_seconds: float = DEFAULT_TTL_SECONDS
    max_content_length: int = MAX_CONTENT_LENGTH

    @property
    def is_active(self) -> bool:
        """True only when enabled and configuration is complete/valid."""
        if not self.enabled:
            return False
        return _config_valid(self)

    @property
    def local_role(self) -> Optional[str]:
        """ROLE_WORKER, ROLE_REVIEWER, or None if local_bot_id is not a peer."""
        if not self.local_bot_id:
            return None
        if self.local_bot_id == self.seadog_bot_id:
            return ROLE_WORKER
        if self.local_bot_id == self.deckhand_bot_id:
            return ROLE_REVIEWER
        return None

    @property
    def is_local_worker(self) -> bool:
        return self.local_role == ROLE_WORKER

    @property
    def is_local_reviewer(self) -> bool:
        return self.local_role == ROLE_REVIEWER


def _is_snowflake(value: str) -> bool:
    if not isinstance(value, str):
        return False
    if not value or len(value) > MAX_SNOWFLAKE_LENGTH:
        return False
    return bool(_SNOWFLAKE_RE.fullmatch(value))


def _config_valid(cfg: WaterCoolerA2AConfig) -> bool:
    if not _is_snowflake(cfg.channel_id):
        return False
    if not _is_snowflake(cfg.seadog_bot_id):
        return False
    if not _is_snowflake(cfg.deckhand_bot_id):
        return False
    if cfg.seadog_bot_id == cfg.deckhand_bot_id:
        return False
    if not _is_snowflake(cfg.local_bot_id):
        return False
    # local_bot_id must be exactly Seadog or Deckhand — no third identity.
    if cfg.local_bot_id not in (cfg.seadog_bot_id, cfg.deckhand_bot_id):
        return False
    if not cfg.allowed_human_starter_ids:
        return False
    for hid in cfg.allowed_human_starter_ids:
        if not _is_snowflake(hid):
            return False
        if hid in (cfg.seadog_bot_id, cfg.deckhand_bot_id):
            return False
    ttl = cfg.task_ttl_seconds
    if not isinstance(ttl, (int, float)) or isinstance(ttl, bool):
        return False
    if ttl < MIN_TTL_SECONDS or ttl > MAX_TTL_SECONDS:
        return False
    if cfg.max_content_length < 64 or cfg.max_content_length > MAX_CONTENT_LENGTH:
        return False
    return True


def build_config(
    *,
    enabled: bool = False,
    channel_id: str = WATER_COOLER_CHANNEL_ID,
    allowed_human_starter_ids: Optional[Iterable[str]] = None,
    seadog_bot_id: str = "",
    deckhand_bot_id: str = "",
    local_bot_id: str = "",
    task_ttl_seconds: float = DEFAULT_TTL_SECONDS,
    max_content_length: int = MAX_CONTENT_LENGTH,
) -> WaterCoolerA2AConfig:
    """Construct config from injected values (no env reads)."""
    humans = frozenset(str(x).strip() for x in (allowed_human_starter_ids or ()) if str(x).strip())
    return WaterCoolerA2AConfig(
        enabled=bool(enabled),
        channel_id=str(channel_id or "").strip(),
        allowed_human_starter_ids=humans,
        seadog_bot_id=str(seadog_bot_id or "").strip(),
        deckhand_bot_id=str(deckhand_bot_id or "").strip(),
        local_bot_id=str(local_bot_id or "").strip(),
        task_ttl_seconds=float(task_ttl_seconds) if not isinstance(task_ttl_seconds, bool) else -1.0,
        max_content_length=int(max_content_length),
    )


# ---------------------------------------------------------------------------
# Parsing (hostile input; bounded, strict markers)
# ---------------------------------------------------------------------------


def _bounded_content(raw: object, max_len: int) -> Optional[str]:
    if raw is None:
        return ""
    if not isinstance(raw, str):
        return None
    if len(raw) > max_len:
        return None
    return raw


def _parse_human_task(content: str) -> Optional[str]:
    """Return task body (caller must not persist it) or None if not a TASK."""
    # First line must be exactly: TASK [target=seadog] [reviewer=deckhand]
    # Optional trailing whitespace only on the header line.
    lines = content.split("\n", 1)
    header = lines[0].strip()
    expected = f"{HUMAN_TASK_PREFIX} {TARGET_MARKER} {REVIEWER_MARKER}"
    if header != expected:
        # Reject near-misses that look like TASK protocol (strict).
        stripped = content.lstrip()
        if stripped.upper().startswith("TASK"):
            return None  # signal malformed via separate path
        return None
    body = lines[1] if len(lines) > 1 else ""
    return body


def _looks_like_human_task_attempt(content: str) -> bool:
    head = content.lstrip()[:64].upper()
    return head.startswith("TASK")


def _parse_peer_header(content: str) -> Optional[str]:
    """Return 'handoff' | 'review' if first non-empty line is a known marker."""
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped == HANDOFF_MARKER:
            return "handoff"
        if stripped == REVIEW_MARKER:
            return "review"
        return None
    return None


def _looks_like_peer_attempt(content: str) -> bool:
    head = content.lstrip()[:32]
    return head.startswith("A2A-HANDOFF") or head.startswith("A2A-REVIEW")


def _extract_task_id(content: str) -> Optional[str]:
    match = _TASK_ID_LINE_RE.search(content)
    if not match:
        return None
    task_id = match.group(1)
    if not _TASK_ID_RE.fullmatch(task_id):
        return None
    return task_id


def _safe_ids(*values: object) -> bool:
    for v in values:
        if not isinstance(v, str) or not _is_snowflake(v):
            return False
    return True


# ---------------------------------------------------------------------------
# Policy engine
# ---------------------------------------------------------------------------


class WaterCoolerA2APolicy:
    """In-memory fail-closed A2A gate for the Water-cooler channel.

    Each process (Seadog worker / Deckhand reviewer) holds its own mirror of
    task state. Safe to call from a later Discord adapter hook. Does not touch
    sessions, models, tools, network, or shared storage.
    """

    def __init__(self, config: WaterCoolerA2AConfig) -> None:
        self._config = config
        self._tasks: Dict[str, TaskState] = {}
        self._seen_message_ids: Set[str] = set()

    @property
    def config(self) -> WaterCoolerA2AConfig:
        return self._config

    def get_task(self, task_id: str) -> Optional[TaskState]:
        return self._tasks.get(task_id)

    def active_task_ids(self) -> FrozenSet[str]:
        return frozenset(self._tasks.keys())

    def evaluate(
        self,
        event: DiscordMessageEvent,
        *,
        now: Optional[float] = None,
    ) -> PolicyDecision:
        """Classify one message and advance state only on allowed transitions."""
        clock = time.time() if now is None else float(now)
        cfg = self._config

        if not cfg.is_active:
            return PolicyDecision(DecisionKind.IGNORE, "policy_disabled_or_invalid_config")

        if not isinstance(event, DiscordMessageEvent):
            return PolicyDecision(DecisionKind.REJECT, "invalid_event")

        if not _safe_ids(event.channel_id, event.message_id, event.author_id):
            return PolicyDecision(DecisionKind.REJECT, "invalid_event_ids")

        if event.channel_id != cfg.channel_id:
            return PolicyDecision(DecisionKind.IGNORE, "wrong_channel")

        content = _bounded_content(event.content, cfg.max_content_length)
        if content is None:
            return PolicyDecision(DecisionKind.REJECT, "oversize_content")

        if event.message_id in self._seen_message_ids:
            return PolicyDecision(DecisionKind.REJECT, "duplicate_message")

        # Expiry sweep for known tasks (does not advance on expired peer events).
        self._expire_tasks(clock)

        # --- Human TASK path ---
        if not event.is_bot:
            return self._handle_human(event, content, clock)

        # --- Peer bot path ---
        return self._handle_peer(event, content, clock)

    def _handle_human(
        self,
        event: DiscordMessageEvent,
        content: str,
        clock: float,
    ) -> PolicyDecision:
        cfg = self._config
        body = _parse_human_task(content)

        if body is None:
            if _looks_like_human_task_attempt(content) or _looks_like_peer_attempt(content):
                return PolicyDecision(DecisionKind.REJECT, "malformed_human_or_peer_protocol")
            return PolicyDecision(DecisionKind.IGNORE, "casual_chat")

        if event.author_id not in cfg.allowed_human_starter_ids:
            return PolicyDecision(DecisionKind.REJECT, "unknown_human")

        # Deterministic id from the human message so worker + reviewer mirrors match.
        task_id = derive_task_id(event.channel_id, event.message_id)
        if not _TASK_ID_RE.fullmatch(task_id):
            # Defensive: derivation must always yield a protocol-safe id.
            return PolicyDecision(DecisionKind.REJECT, "unable_to_derive_task_id")

        if task_id in self._tasks:
            # Same message should be caught by seen_message_ids; other collisions fail closed.
            return PolicyDecision(
                DecisionKind.REJECT,
                "duplicate_or_conflicting_task_id",
                task_id=task_id,
                task_state=self._tasks.get(task_id),
            )

        state = TaskState(
            task_id=task_id,
            stage=TaskStage.AWAITING_WORKER_HANDOFF,
            worker_bot_id=cfg.seadog_bot_id,
            reviewer_bot_id=cfg.deckhand_bot_id,
            source_channel_id=event.channel_id,
            source_message_id=event.message_id,
            created_at=clock,
            updated_at=clock,
            expires_at=clock + float(cfg.task_ttl_seconds),
            round_count=0,
        )
        # Intentionally never store `body` / event.content.
        self._tasks[task_id] = state
        self._seen_message_ids.add(event.message_id)

        if cfg.is_local_worker:
            # Only the named worker is dispatched to its model.
            return PolicyDecision(
                DecisionKind.HUMAN_TASK,
                "human_task_accepted",
                task_id=task_id,
                task_state=state,
            )

        # Reviewer (or any non-worker local role) mirrors state but must not work the task.
        return PolicyDecision(
            DecisionKind.IGNORE,
            "mirrored_task_non_dispatch",
            task_id=task_id,
            task_state=state,
        )

    def _handle_peer(
        self,
        event: DiscordMessageEvent,
        content: str,
        clock: float,
    ) -> PolicyDecision:
        cfg = self._config
        kind = _parse_peer_header(content)

        if kind is None:
            if _looks_like_peer_attempt(content) or _looks_like_human_task_attempt(content):
                return PolicyDecision(DecisionKind.REJECT, "malformed_peer_protocol")
            # Known bots may still chat casually in-channel.
            return PolicyDecision(DecisionKind.IGNORE, "bot_casual_or_unrelated")

        # Only the configured Seadog / Deckhand bots may use peer protocol.
        if event.author_id not in (cfg.seadog_bot_id, cfg.deckhand_bot_id):
            return PolicyDecision(DecisionKind.REJECT, "unknown_bot")

        task_id = _extract_task_id(content)
        if task_id is None:
            return PolicyDecision(DecisionKind.REJECT, "missing_or_invalid_task_id")

        state = self._tasks.get(task_id)
        if state is None:
            # Restart / empty local mirror: fail closed — never replay from history.
            return PolicyDecision(DecisionKind.REJECT, "unknown_or_forged_task_id", task_id=task_id)

        if clock > state.expires_at or state.stage == TaskStage.TERMINAL:
            # Terminal or expired: never advance.
            if clock > state.expires_at and state.stage != TaskStage.TERMINAL:
                self._tasks[task_id] = _replace_state(
                    state, stage=TaskStage.TERMINAL, updated_at=clock
                )
            return PolicyDecision(
                DecisionKind.REJECT,
                "task_expired_or_terminal",
                task_id=task_id,
                task_state=self._tasks.get(task_id),
            )

        if kind == "handoff":
            return self._accept_handoff(event, state, clock)
        return self._accept_review(event, state, clock)

    def _accept_handoff(
        self,
        event: DiscordMessageEvent,
        state: TaskState,
        clock: float,
    ) -> PolicyDecision:
        if event.author_id != state.worker_bot_id:
            # Self-bot / wrong role: reviewer posting handoff, etc.
            reason = "self_bot_or_wrong_role" if event.author_id == state.reviewer_bot_id else "wrong_sender"
            return PolicyDecision(
                DecisionKind.REJECT,
                reason,
                task_id=state.task_id,
                task_state=state,
            )

        if state.stage != TaskStage.AWAITING_WORKER_HANDOFF:
            return PolicyDecision(
                DecisionKind.REJECT,
                "wrong_order_or_duplicate_handoff",
                task_id=state.task_id,
                task_state=state,
            )

        if state.round_count >= MAX_ROUNDS:
            # Should already be terminal; belt-and-suspenders.
            term = _replace_state(state, stage=TaskStage.TERMINAL, updated_at=clock)
            self._tasks[state.task_id] = term
            self._seen_message_ids.add(event.message_id)
            return PolicyDecision(
                DecisionKind.REJECT,
                "round_limit_exceeded",
                task_id=state.task_id,
                task_state=term,
            )

        new_state = _replace_state(
            state,
            stage=TaskStage.AWAITING_REVIEWER_REVIEW,
            updated_at=clock,
        )
        self._tasks[state.task_id] = new_state
        self._seen_message_ids.add(event.message_id)
        return PolicyDecision(
            DecisionKind.PEER_HANDOFF,
            "peer_handoff_accepted",
            task_id=state.task_id,
            task_state=new_state,
        )

    def _accept_review(
        self,
        event: DiscordMessageEvent,
        state: TaskState,
        clock: float,
    ) -> PolicyDecision:
        if event.author_id != state.reviewer_bot_id:
            reason = "self_bot_or_wrong_role" if event.author_id == state.worker_bot_id else "wrong_sender"
            return PolicyDecision(
                DecisionKind.REJECT,
                reason,
                task_id=state.task_id,
                task_state=state,
            )

        if state.stage != TaskStage.AWAITING_REVIEWER_REVIEW:
            return PolicyDecision(
                DecisionKind.REJECT,
                "wrong_order_or_duplicate_review",
                task_id=state.task_id,
                task_state=state,
            )

        new_round = state.round_count + 1
        if new_round >= MAX_ROUNDS:
            new_state = _replace_state(
                state,
                stage=TaskStage.TERMINAL,
                updated_at=clock,
                round_count=new_round,
            )
        else:
            new_state = _replace_state(
                state,
                stage=TaskStage.AWAITING_WORKER_HANDOFF,
                updated_at=clock,
                round_count=new_round,
            )
        self._tasks[state.task_id] = new_state
        self._seen_message_ids.add(event.message_id)
        return PolicyDecision(
            DecisionKind.PEER_REVIEW,
            "peer_review_accepted",
            task_id=state.task_id,
            task_state=new_state,
        )

    def _expire_tasks(self, clock: float) -> None:
        for tid, state in list(self._tasks.items()):
            if state.stage != TaskStage.TERMINAL and clock > state.expires_at:
                self._tasks[tid] = _replace_state(
                    state, stage=TaskStage.TERMINAL, updated_at=clock
                )


def _replace_state(
    state: TaskState,
    *,
    stage: Optional[TaskStage] = None,
    updated_at: Optional[float] = None,
    round_count: Optional[int] = None,
) -> TaskState:
    return TaskState(
        task_id=state.task_id,
        stage=stage if stage is not None else state.stage,
        worker_bot_id=state.worker_bot_id,
        reviewer_bot_id=state.reviewer_bot_id,
        source_channel_id=state.source_channel_id,
        source_message_id=state.source_message_id,
        created_at=state.created_at,
        updated_at=updated_at if updated_at is not None else state.updated_at,
        expires_at=state.expires_at,
        round_count=round_count if round_count is not None else state.round_count,
    )


# Explicit public API surface for a later adapter hook.
__all__ = [
    "WATER_COOLER_CHANNEL_ID",
    "MAX_ROUNDS",
    "MIN_TTL_SECONDS",
    "MAX_TTL_SECONDS",
    "DEFAULT_TTL_SECONDS",
    "MAX_CONTENT_LENGTH",
    "ROLE_WORKER",
    "ROLE_REVIEWER",
    "DecisionKind",
    "TaskStage",
    "DiscordMessageEvent",
    "TaskState",
    "PolicyDecision",
    "WaterCoolerA2AConfig",
    "WaterCoolerA2APolicy",
    "build_config",
    "derive_task_id",
]
