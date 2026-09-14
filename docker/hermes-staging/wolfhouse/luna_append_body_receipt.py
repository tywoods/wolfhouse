"""Fail-open, default-off LR3.2 receipt for the ordinary tool-result append seam."""
from __future__ import annotations

import json
import os
import re
from typing import Any

from wolfhouse.luna_capture_identity_trace import current_trace

ENABLE_ENV = "LUNA_APPEND_BODY_RECEIPT_ENABLED"
ORDINARY_APPEND_SITE = "agent.tool_executor:ordinary_tool_result_append"
_MAX_CAPTURE = 128
_SECRET = re.compile(
    r"(?i)([\"']?(?:authorization|api[_-]?key|token|password|secret)[\"']?\s*[:=]\s*[\"']?)([^,;\s\"}]+)"
)


def _current_capture() -> Any:
    try:
        from wolfhouse.luna_personality_isolation import current_isolated_turn
        return current_isolated_turn()
    except BaseException:
        return None


def _redact(text: str) -> str:
    return _SECRET.sub(lambda match: match.group(1) + "[REDACTED]", text)


def _disposition(capture: Any, call_id: Any) -> str | None:
    try:
        owner = getattr(capture, "metadata_capture", capture)
        rows = getattr(owner, "dispositions", None)
        if rows is None:
            rows = getattr(owner, "record_dispositions", None)
        for row in reversed(rows or []):
            get = row.get if isinstance(row, dict) else lambda key, default=None: getattr(row, key, default)
            if str(get("call_id", "")) == str(call_id):
                value = get("status", None) or get("disposition", None)
                return str(value)[:128] if value is not None else None
    except BaseException:
        pass
    return None


def observe_append_body(message: Any, *, producer: str, response_id: Any,
                        append_site: str = ORDINARY_APPEND_SITE) -> None:
    """Observe exactly the value already selected for append; never mutate it."""
    try:
        if os.getenv(ENABLE_ENV, "0") != "1":
            return
        identity = current_trace()
        capture = _current_capture()
        if identity is None or capture is None:
            return
        get = message.get if isinstance(message, dict) else lambda key, default=None: getattr(message, key, default)
        value = get("content", None)
        call_id = get("tool_call_id", None) or get("call_id", None)
        complete = True
        failure = None
        serialized = None
        try:
            serialized = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
            serialized = _redact(serialized)
            if len(serialized) > _MAX_CAPTURE:
                serialized = serialized[:_MAX_CAPTURE]
                complete = False
                failure = "capture_truncated"
        except BaseException:
            complete = False
            failure = "serialization_or_redaction_failed"
        identity.emit(
            "live_append_body_receipt", capture=capture, call_id=call_id,
            request_id=identity.run_id, response_id=str(response_id) if response_id is not None else None,
            producer=producer, append_site=append_site, result_class=type(value).__name__,
            result_capture=serialized, capture_complete=complete, capture_failure=failure,
            dispatcher_disposition=_disposition(capture, call_id),
            authoritative_read_proven=False,
        )
    except BaseException:
        return
