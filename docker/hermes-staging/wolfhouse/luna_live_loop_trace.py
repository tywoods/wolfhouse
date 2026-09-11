"""Default-off LR3.2 live-loop metadata probes.

This module deliberately records only bounded, allowlisted scalars. It is active
only for the closed synthetic evaluator (both trace and isolated capture context)
and only when LUNA_LIVE_LOOP_TRACE_ENABLED is exactly ``1``.
"""
from __future__ import annotations

import json
import os
from typing import Any

from wolfhouse.luna_capture_identity_trace import current_trace

ENABLE_ENV = "LUNA_LIVE_LOOP_TRACE_ENABLED"
_MAX = 128


def _current_capture() -> Any:
    try:
        from wolfhouse.luna_personality_isolation import current_isolated_turn
        return current_isolated_turn()
    except BaseException:
        return None


def _active() -> tuple[Any, Any]:
    if os.getenv(ENABLE_ENV, "0") != "1":
        return None, None
    identity = current_trace()
    capture = _current_capture()
    if identity is None or capture is None:
        return None, None
    return identity, capture


def _get(obj: Any, name: str, default: Any = None) -> Any:
    return obj.get(name, default) if isinstance(obj, dict) else getattr(obj, name, default)


def _present(obj: Any, name: str) -> bool:
    return name in obj if isinstance(obj, dict) else hasattr(obj, name)


def _text(value: Any) -> str | None:
    return value[:_MAX] if isinstance(value, str) else None


def _arguments_valid(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return isinstance(json.loads(value), dict)
    except (ValueError, TypeError):
        return False


def _call_fields(call: Any) -> dict[str, Any]:
    function = _get(call, "function")
    arguments = _get(function, "arguments")
    return {
        "call_id": _text(_get(call, "id") or _get(call, "call_id")),
        "call_name": _text(_get(function, "name")),
        "input_item_id": _text(_get(call, "response_item_id")),
        "arguments_valid": _arguments_valid(arguments),
    }


def _emit(event: str, **fields: Any) -> None:
    try:
        identity, capture = _active()
        if identity is not None:
            identity.emit(event, capture=capture, **fields)
    except BaseException:
        pass


def observe_output_item_done(item: Any, response_id: Any = None) -> None:
    """Observe the literal done item before the upstream filter/append branch."""
    try:
        item_type = _text(_get(item, "type"))
        status_literal = "absent" if not _present(item, "status") else ("null" if _get(item, "status") is None else _text(_get(item, "status")))
        arguments = _get(item, "arguments") if item_type == "function_call" else _get(item, "input")
        # Upstream's literal assembly predicate is only ``done_item is not None``.
        # Status is observed but never interpreted as an exclusion condition.
        excluded = False
        _emit("live_output_item_done", response_id=_text(response_id), item_type=item_type,
              status_literal=status_literal, item_id=_text(_get(item, "id")),
              call_id=_text(_get(item, "call_id")), arguments_present=arguments is not None,
              arguments_valid=_arguments_valid(arguments), excluded=excluded,
              branch="exclude" if excluded else "assemble")
    except BaseException:
        pass


def observe_normalized_return(response: Any, assistant_message: Any, finish_reason: Any) -> None:
    """Observe only the calls on the actual normalized return object."""
    try:
        calls = _get(assistant_message, "tool_calls", [])
        calls = calls if isinstance(calls, list) else []
        common = {"response_id": _text(_get(response, "id")), "returned_call_count": len(calls),
                  "finish_reason": _text(finish_reason)}
        if calls:
            for call in calls:
                _emit("live_normalized_return", **common, **_call_fields(call))
        else:
            _emit("live_normalized_return", **common)
    except BaseException:
        pass


def observe_assistant_tool_calls(assistant_message: Any, tool_calls: Any, history: Any,
                                 *, branch: str, reason: str) -> None:
    """Observe actual assistant calls and the immediately preceding history shape."""
    try:
        calls = tool_calls if isinstance(tool_calls, list) else []
        prior = history[-1] if isinstance(history, list) and history else None
        common = {
            "actual_call_count": len(calls), "predicate": bool(calls),
            "branch": _text(branch), "reason_code": _text(reason),
            "history_role": _text(_get(prior, "role")), "history_type": _text(_get(prior, "type")),
            "history_call_id": _text(_get(prior, "tool_call_id") or _get(prior, "call_id")),
        }
        if calls:
            for call in calls:
                _emit("live_assistant_tool_calls", **common, **_call_fields(call))
        else:
            _emit("live_assistant_tool_calls", **common)
    except BaseException:
        pass


def observe_conversation_branch(call: Any, history: Any, *, branch: str,
                                reason: str, predicate: bool) -> None:
    """Observe branch calls at execution and their then-current history."""
    try:
        calls = call if isinstance(call, list) else ([] if call is None else [call])
        prior = history[-1] if isinstance(history, list) and history else None
        fields = {
            "actual_call_count": len(calls),
            "predicate": predicate,
            "branch": _text(branch), "reason_code": _text(reason),
            "history_role": _text(_get(prior, "role")),
            "history_type": _text(_get(prior, "type")),
            "history_call_id": _text(_get(prior, "tool_call_id") or _get(prior, "call_id")),
        }
        if calls:
            for selected_call in calls:
                _emit("live_assistant_tool_calls", **fields, **_call_fields(selected_call))
        else:
            _emit("live_assistant_tool_calls", **fields)
    except BaseException:
        pass
