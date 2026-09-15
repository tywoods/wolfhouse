"""Offline-only LR3.2 ordinary-entrypoint provider-boundary sentinels.

These fixtures are intentionally test doubles. They do not diagnose or repair the
serving gateway. They give the offline harness one sharp question to answer:
did the ordinary entrypoint reach the provider boundary, or did it return before
model dispatch?
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional

from wolfhouse.luna_group_lesson_live_eval import (
    EXPECTED_MODEL,
    REQUIRED_CASE_09_STAFF_PATHS,
    REQUIRED_CASE_09_TOOL_SEQUENCE,
)
from wolfhouse.luna_personality_isolation import (
    IsolatedTurnCapture,
    IsolationAbort,
    capture_send_if_isolated,
    deny_journal_if_isolated,
    deny_post_bot_if_isolated,
    deny_tool_if_isolated,
    observe_provider_invocation,
)

SENTINEL_PROVIDER_MARK = "LR3.2_OFFLINE_PROVIDER_BOUNDARY_SENTINEL"
SENTINEL_REPLY = "BLOCKED: offline provider-boundary sentinel reached."


@dataclass(frozen=True)
class SentinelObservation:
    """Tiny capture-only observation; no payloads, no production claims."""

    label: str
    provider_boundary_reached: bool
    model_calls: int
    model: Optional[str]
    external_effects_denied: bool
    external_effects_completed: bool
    error: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "label": self.label,
            "provider_boundary_reached": self.provider_boundary_reached,
            "model_calls": self.model_calls,
            "model": self.model,
            "external_effects_denied": self.external_effects_denied,
            "external_effects_completed": self.external_effects_completed,
            "error": self.error,
            "offline_only": True,
        }


def assert_no_external_effects_completed(cap: IsolatedTurnCapture) -> None:
    """Fail if the isolated turn completed a send, write, or prohibited tool.

    Attempts may be present because the sentinel deliberately pokes the denied
    boundaries. Completed effects must stay at zero/empty.
    """

    if cap.sends_completed:
        raise AssertionError(f"send completed inside offline isolation: {cap.sends_completed}")
    if cap.journal_writes_completed:
        raise AssertionError(f"journal write completed inside offline isolation: {cap.journal_writes_completed}")
    if cap.persistence_effects_completed:
        raise AssertionError(
            f"persistence effects completed inside offline isolation: {cap.persistence_effects_completed}"
        )
    if cap.tools_invoked:
        raise AssertionError(f"prohibited tool completed inside offline isolation: {cap.tools_invoked}")


def _complete_required_read_sequence(cap: IsolatedTurnCapture) -> None:
    args = {"tenant_id": "sunset", "location_id": "sunset-somo"}
    for name in REQUIRED_CASE_09_TOOL_SEQUENCE:
        blocked = deny_tool_if_isolated(name, args)
        if blocked:
            raise IsolationAbort("sentinel_read_tool_denied")
        cap.read_tools_completed.append(name)

    # The contract only requires set equality for Staff paths, so keep this
    # sorted/stable for deterministic offline receipts.
    for path in sorted(REQUIRED_CASE_09_STAFF_PATHS):
        blocked = deny_post_bot_if_isolated(path, args)
        if blocked:
            raise IsolationAbort("sentinel_staff_path_denied")
        cap.read_staff_paths_completed.append(path)


def poke_denied_external_boundaries(cap: IsolatedTurnCapture) -> None:
    """Attempt denied external effects so the fixture proves the guard is armed."""

    capture_send_if_isolated("offline sentinel must not send")
    deny_journal_if_isolated("offline-sentinel-journal")
    if deny_tool_if_isolated("create_sunset_booking", {"tenant_id": "sunset"}) is None:
        raise IsolationAbort("sentinel_write_tool_not_denied")
    denied = deny_post_bot_if_isolated("/bookings", {"tenant_id": "sunset", "location_id": "sunset-somo"})
    if not (isinstance(denied, dict) and denied.get("simulate_write_blocked")):
        raise IsolationAbort("sentinel_staff_write_not_denied")
    assert_no_external_effects_completed(cap)


async def provider_boundary_sentinel_invoke(_message: str, cap: IsolatedTurnCapture, _context: Mapping[str, Any]) -> str:
    """Offline ON fixture: reaches provider boundary, then completes read-only evidence."""

    poke_denied_external_boundaries(cap)
    observe_provider_invocation(EXPECTED_MODEL, f"{SENTINEL_PROVIDER_MARK} model={EXPECTED_MODEL}")
    _complete_required_read_sequence(cap)
    assert_no_external_effects_completed(cap)
    return SENTINEL_REPLY


async def pre_provider_early_return_invoke(_message: str, cap: IsolatedTurnCapture, _context: Mapping[str, Any]) -> str:
    """Offline OFF fixture: simulates startup/admission swallow before provider dispatch.

    This is not a production diagnosis. It intentionally stops before
    observe_provider_invocation so the harness must classify model_not_invoked.
    """

    poke_denied_external_boundaries(cap)
    return "early return before provider boundary"


def observation_from_abort(label: str, exc: IsolationAbort) -> SentinelObservation:
    counters = exc.counters if isinstance(exc.counters, dict) else {}
    raw_model_calls = counters.get("model_calls")
    model_calls = raw_model_calls if type(raw_model_calls) is int else 0
    capture = counters.get("capture")
    capture_model = capture.get("model") if isinstance(capture, dict) else None
    completed_effects = bool(
        (counters.get("sends_completed") or 0)
        or (counters.get("journal_writes_completed") or 0)
        or counters.get("persistence_effects_completed")
    )
    return SentinelObservation(
        label=label,
        provider_boundary_reached=model_calls >= 1,
        model_calls=model_calls,
        model=capture_model if isinstance(capture_model, str) else None,
        external_effects_denied=not completed_effects,
        external_effects_completed=completed_effects,
        error=exc.reason,
    )


async def run_off_on_matrix(
    runner: Callable[[str, Callable[..., Awaitable[str]]], Awaitable[Mapping[str, Any]]]
) -> List[Dict[str, Any]]:
    """Run OFF then ON fixtures through a caller-owned offline harness runner.

    The runner must be an offline test helper; this module performs no HTTP,
    Staff writes, live probes, sends, or production mutation.
    """

    rows: List[Dict[str, Any]] = []
    for label, invoke in (
        ("OFF_pre_provider_early_return", pre_provider_early_return_invoke),
        ("ON_provider_boundary_sentinel", provider_boundary_sentinel_invoke),
    ):
        try:
            row = await runner(label, invoke)
            rows.append({"label": label, "error": None, "row": dict(row), "offline_only": True})
        except IsolationAbort as exc:
            rows.append(observation_from_abort(label, exc).as_dict())
    return rows
