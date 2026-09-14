"""Fail-open, default-off LR3.2 receipt for the ordinary tool-result append seam."""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
import re
from typing import Any
from urllib.parse import quote, unquote

from wolfhouse.luna_capture_identity_trace import current_trace

ENABLE_ENV = "LUNA_APPEND_BODY_RECEIPT_ENABLED"
ORDINARY_APPEND_SITE = "agent.tool_executor:ordinary_tool_result_append"
_MAX_CAPTURE = 1024
_MAX_DEPTH = 16
_REDACTED = "[REDACTED]"
_SENSITIVE_KEY = re.compile(r"(?i)(?:^|[_-])(?:authorization|auth|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|credential|cookie)(?:$|[_-])")
_BEARER = re.compile(r"(?i)\bbearer(?:\s|\\[rnt])+[^\s\\\"',;]+")
_AUTHORIZATION_VALUE = re.compile(
    r"(?i)(\bauthorization\b(?:\s|\\[rnt])*[:=](?:\s|\\[rnt])*)([^\r\n,;]+)"
)
_INLINE_CREDENTIAL = re.compile(
    r"(?is)(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|credential|cookie)\b"
    r"(?:\s|\\[rnt])*[:=](?:\s|\\[rnt])*(?:[\"']?))([^\s,;\"'}]+)"
)
_QUERY_CREDENTIAL = re.compile(
    r"(?i)([?&](?:authorization|auth|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|credential|signature|sig)=)([^&#]*)"
)
_GENERIC_SECRET = re.compile(
    r"^(?:eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?|"
    r"(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}|"
    r"(?=[A-Za-z0-9_+/=-]{24,}$)(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9_+/=-]+)$"
)


@dataclass(frozen=True)
class AppendBodySnapshot:
    result_class: str
    frozen_value: Any
    capture_failure: str | None = None


def _freeze(value: Any, depth: int = 0, seen: frozenset[int] = frozenset()) -> Any:
    """Copy JSON-shaped data into immutable tagged tuples without invoking user code."""
    if depth > _MAX_DEPTH:
        raise ValueError("capture_depth_exceeded")
    if value is None or type(value) in (bool, int, float, str):
        return value
    if type(value) not in (dict, list, tuple):
        raise TypeError("unsupported_result_object")
    marker = id(value)
    if marker in seen:
        raise ValueError("cyclic_result_object")
    nested_seen = seen | {marker}
    if type(value) is dict:
        rows = []
        for key, item in value.items():
            if type(key) is not str:
                raise TypeError("non_string_mapping_key")
            rows.append((key, _freeze(item, depth + 1, nested_seen)))
        return ("__dict__", tuple(rows))
    return ("__list__", tuple(_freeze(item, depth + 1, nested_seen) for item in value))


def snapshot_append_body(value: Any) -> AppendBodySnapshot:
    """Return an immutable defensive snapshot; unsafe shapes become incomplete capture."""
    try:
        return AppendBodySnapshot(type(value).__name__, _freeze(value))
    except Exception as exc:
        reason = str(exc) if str(exc) in {
            "capture_depth_exceeded", "unsupported_result_object", "cyclic_result_object", "non_string_mapping_key"
        } else "snapshot_failed"
        return AppendBodySnapshot(type(value).__name__, None, reason)


def _redact_string(value: str) -> str:
    # Authorization values are opaque credentials regardless of scheme.
    value = _AUTHORIZATION_VALUE.sub(lambda match: match.group(1) + _REDACTED, value)
    value = _BEARER.sub("Bearer " + _REDACTED, value)
    value = _INLINE_CREDENTIAL.sub(lambda match: match.group(1) + _REDACTED, value)
    value = _QUERY_CREDENTIAL.sub(lambda match: match.group(1) + quote(_REDACTED), value)
    # Decode once to catch escaped URL query credentials, but never broaden a safe string.
    if "%" in value:
        decoded = unquote(value)
        scrubbed = _QUERY_CREDENTIAL.sub(lambda match: match.group(1) + quote(_REDACTED), decoded)
        if scrubbed != decoded:
            value = scrubbed
    if _GENERIC_SECRET.fullmatch(value.strip()):
        return _REDACTED
    return value


def _redact_frozen(value: Any, sensitive: bool = False) -> Any:
    if sensitive:
        return _REDACTED
    if type(value) is str:
        return _redact_string(value)
    if type(value) is tuple and len(value) == 2 and value[0] == "__dict__":
        return {key: _redact_frozen(item, bool(_SENSITIVE_KEY.search(key))) for key, item in value[1]}
    if type(value) is tuple and len(value) == 2 and value[0] == "__list__":
        return [_redact_frozen(item) for item in value[1]]
    return value


def _current_capture() -> Any:
    try:
        from wolfhouse.luna_personality_isolation import current_isolated_turn
        return current_isolated_turn()
    except Exception:
        return None


def is_enabled() -> bool:
    """Cheap seam guard: default-off execution performs no result snapshot."""
    return os.getenv(ENABLE_ENV, "0") == "1"


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
    except Exception:
        pass
    return None


def observe_append_body(snapshot: AppendBodySnapshot, *, call_id: Any, producer: str,
                        api_request_id: Any, response_id: Any = None,
                        append_site: str = ORDINARY_APPEND_SITE) -> None:
    """Observe only a frozen snapshot from an admitted synthetic isolated turn."""
    try:
        if not is_enabled():
            return
        identity = current_trace()
        capture = _current_capture()
        # The isolated-turn capture is the mandatory synthetic-request admission gate.
        if identity is None or capture is None or not isinstance(snapshot, AppendBodySnapshot):
            return
        complete = snapshot.capture_failure is None
        failure = snapshot.capture_failure
        serialized = None
        if complete:
            try:
                safe_value = _redact_frozen(snapshot.frozen_value)
                serialized = json.dumps(safe_value, ensure_ascii=True, separators=(",", ":"))
                if len(serialized) > _MAX_CAPTURE:
                    serialized = serialized[:_MAX_CAPTURE]
                    complete = False
                    failure = "capture_truncated"
            except Exception:
                complete = False
                failure = "serialization_or_redaction_failed"
                serialized = None
        identity.emit(
            "live_append_body_receipt", capture=capture, call_id=call_id,
            api_request_id=str(api_request_id) if api_request_id is not None else None,
            response_id=str(response_id) if response_id is not None else None,
            producer=producer, append_site=append_site, result_class=snapshot.result_class,
            result_capture=serialized, capture_complete=complete, capture_failure=failure,
            dispatcher_disposition=_disposition(capture, call_id), authoritative_read_proven=False,
        )
    except Exception:
        return
