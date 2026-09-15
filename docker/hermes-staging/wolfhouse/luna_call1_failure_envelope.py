"""Default-off, capture-only LR3.2 call-1 failure envelope.

Admission is server-owned and exact-run bound.  The sink is a fixed host-mounted
path, and every hook is best effort: diagnostics can never affect dispatch.
"""
from __future__ import annotations

import contextvars
import hashlib
import json
import os
import re
import stat
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from wolfhouse.luna_capture_identity_trace import current_trace
from wolfhouse.luna_append_body_receipt import snapshot_append_body, _redact_frozen

ENABLE_ENV = "LUNA_LR32_CALL1_FAILURE_ENVELOPE_ENABLED"
APPROVED_RUN_ENV = "LUNA_LR32_CALL1_APPROVED_RUN_ID"
ARTIFACT_DIR_ENV = "LUNA_LR32_CALL1_ARTIFACT_DIR"
ARTIFACT_DIR = Path("/tmp/lr32-call1-failure-envelopes")
TARGET_TOOL = "get_sunset_lesson_catalog"
MAX_APPEND_BYTES = 2048
MAX_ENVELOPE_BYTES = 16 * 1024
_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_LOCK = threading.RLock()
_PENDING: contextvars.ContextVar[tuple["CallCapture", ...]] = contextvars.ContextVar("lr32_call1_pending", default=())


@dataclass
class CallCapture:
    run_id: str
    attempt_id: str
    expected_call_id: str
    adapter_entry: dict[str, Any]
    transport: dict[str, Any] = field(default_factory=lambda: {
        "attempted": False, "transport_attempt_id": None, "outcome": "not_observed",
        "http_status": None, "body_class": None, "exception_class": None,
        # There is currently no Staff producer for this receipt: remain explicit.
        "staff_receipt_observed": None, "staff_receipt_dependency": "producer_unavailable",
    })
    plugin_return: dict[str, Any] = field(default_factory=lambda: {"classification": "not_observed"})
    capture_incomplete: bool = False
    capture_failure: str | None = None


def approved_server_run_id() -> str | None:
    """Return an operator-configured run id; no request input is consulted."""
    try:
        value = os.getenv(APPROVED_RUN_ENV, "")
        return value if os.getenv(ENABLE_ENV) == "1" and _RUN_ID.fullmatch(value) else None
    except BaseException:
        return None


def _current_capture() -> Any:
    try:
        from wolfhouse.luna_personality_isolation import current_isolated_turn
        return current_isolated_turn()
    except BaseException:
        return None


def _metadata_call1(capture: Any) -> tuple[Any, str] | None:
    """Prove the active provider request and first tool-call id are call ordinal 1."""
    metadata = getattr(capture, "metadata_capture", None)
    calls = getattr(metadata, "calls", None)
    if not isinstance(calls, list) or len(calls) != 1 or not isinstance(calls[0], dict):
        return None
    call = calls[0]
    if call.get("call_index") != 1:
        return None
    response = call.get("response")
    tool_calls = response.get("tool_calls") if isinstance(response, dict) else None
    if not isinstance(tool_calls, list) or not tool_calls or not isinstance(tool_calls[0], dict):
        return None
    first = tool_calls[0]
    function = first.get("function") if isinstance(first.get("function"), dict) else first
    if function.get("name") != TARGET_TOOL or first.get("id") is None:
        return None
    return call, str(first["id"])[:128]


def _admitted(tool_name: str) -> tuple[Any, Any, str] | None:
    if tool_name != TARGET_TOOL:
        return None
    identity, capture, approved = current_trace(), _current_capture(), approved_server_run_id()
    if identity is None or capture is None or approved is None or approved != identity.run_id:
        return None
    if getattr(capture, "_lr32_server_validated_synthetic", False) is not True:
        return None
    if (os.getenv("HERMES_ROLE") != "sunset-luna" or os.getenv("LUNA_CLIENT_SLUG") != "sunset" or
            os.getenv("SUNSET_INGRESS_LOCATION_ID") != "sunset-somo"):
        return None
    proven = _metadata_call1(capture)
    return (identity, capture, proven[1]) if proven is not None else None


def adapter_entry(tool_name: str, params: Any) -> CallCapture | None:
    try:
        admitted = _admitted(tool_name)
        if admitted is None:
            return None
        identity, _capture, expected_call_id = admitted
        # Exactly one call-1 claim per request context/run, including repeats.
        if any(item.run_id == identity.run_id for item in _PENDING.get()):
            return None
        mapping = type(params) is dict
        location = params.get("location_id") if mapping else None
        handle = CallCapture(identity.run_id, identity.attempt_id, expected_call_id, {
            "tool": TARGET_TOOL, "call_ordinal": 1,
            "arg_shape": {"is_mapping": mapping, "has_location_id": mapping and "location_id" in params,
                          "location_is_string": type(location) is str},
        })
        _PENDING.set(_PENDING.get() + (handle,))
        return handle
    except BaseException:
        return None


def current_handle() -> CallCapture | None:
    try:
        pending = _PENDING.get()
        return pending[-1] if pending else None
    except BaseException:
        return None


def staff_receipt_from_headers(_headers: Any) -> None:
    """No Staff-side producer exists in this scope, so a header cannot be trusted."""
    return None


def transport_attempt(handle: CallCapture | None) -> str | None:
    try:
        if not isinstance(handle, CallCapture): return None
        transport_id = str(uuid.uuid4())
        handle.transport.update(attempted=True, transport_attempt_id=transport_id, outcome="attempted")
        return transport_id
    except BaseException:
        return None


def _body_class(body: Any) -> str:
    if not isinstance(body, (bytes, bytearray)): return "missing"
    try: value = json.loads(bytes(body).decode("utf-8", errors="strict") or "null")
    except Exception: return "malformed"
    return {dict: "json_object", list: "json_array"}.get(type(value), "json_scalar")


def transport_result(handle: CallCapture | None, *, transport_id: Any, http_status: Any = None,
                     body: Any = None, exception: BaseException | None = None,
                     staff_receipt: bool | None = None) -> None:
    try:
        if not isinstance(handle, CallCapture) or transport_id != handle.transport["transport_attempt_id"]: return
        if exception is not None:
            outcome, status, body_class, exc_class = "transport_exception", None, None, type(exception).__name__[:64]
        else:
            status = http_status if type(http_status) is int and 100 <= http_status <= 599 else None
            body_class = _body_class(body)
            outcome = "http_error" if status is not None and status >= 400 else ("malformed_body" if body_class == "malformed" else "success_http")
            exc_class = None
        handle.transport.update(outcome=outcome, http_status=status, body_class=body_class,
                                exception_class=exc_class, staff_receipt_observed=None)
    except BaseException:
        return


def plugin_return(handle: CallCapture | None, value: Any, exception: BaseException | None = None) -> None:
    try:
        if not isinstance(handle, CallCapture): return
        if exception is not None: classification = f"transform_exception:{type(exception).__name__[:64]}"
        elif type(value) is str:
            try:
                parsed = json.loads(value)
                classification = "json_success" if isinstance(parsed, dict) and parsed.get("success") is True else "json_failure"
            except Exception: classification = "malformed_plugin_return"
        elif type(value) is dict: classification = "mapping_success" if value.get("success", value.get("ok")) is True else "mapping_failure"
        else: classification = f"{type(value).__name__}_return"
        handle.plugin_return = {"classification": classification}
    except BaseException:
        return


def _safe_append(value: Any) -> tuple[str | None, bool, str | None]:
    capture_value = value
    if type(value) is str:
        try: capture_value = json.loads(value)
        except Exception: pass
    snap = snapshot_append_body(capture_value)
    if snap.capture_failure: return None, False, snap.capture_failure
    try:
        text = json.dumps(_redact_frozen(snap.frozen_value), ensure_ascii=True, separators=(",", ":"))
        encoded = text.encode()
        if len(encoded) > MAX_APPEND_BYTES:
            return encoded[:MAX_APPEND_BYTES].decode("utf-8", errors="ignore"), False, "append_truncated"
        return text, True, None
    except BaseException:
        return None, False, "append_serialization_failed"


def checksum(document: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(document, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _sink_directory() -> Path:
    # Environment value is an enablement assertion, never a caller-selectable path.
    if os.getenv(ARTIFACT_DIR_ENV, "") != str(ARTIFACT_DIR):
        raise OSError("fixed sink not enabled")
    info = os.lstat(ARTIFACT_DIR)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise OSError("unsafe capture sink")
    return ARTIFACT_DIR


def _atomic_write(directory: Path, name: str, payload: bytes) -> Path:
    dfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    temporary = f".lr32-call1-{uuid.uuid4().hex}"
    fd = None
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
        os.write(fd, payload); os.fsync(fd); os.close(fd); fd = None
        # Same-filesystem link publication is atomic and no-replace across
        # worker processes: exactly one process can claim the run filename.
        os.link(temporary, name, src_dir_fd=dfd, dst_dir_fd=dfd,
                follow_symlinks=False)
        os.unlink(temporary, dir_fd=dfd)
        os.fsync(dfd)
        return directory / name
    except BaseException:
        if fd is not None:
            try: os.close(fd)
            except BaseException: pass
        try: os.unlink(temporary, dir_fd=dfd)
        except BaseException: pass
        raise
    finally:
        os.close(dfd)


def _disposition(capture: Any, call_id: str) -> Any:
    metadata = getattr(capture, "metadata_capture", None)
    for call in reversed(getattr(metadata, "calls", None) or []):
        rows = ((call.get("executor") or {}).get("dispositions") or []) if isinstance(call, dict) else []
        for row in reversed(rows):
            if str(row.get("provider_call_id") or row.get("id") or "") == call_id:
                return row.get("disposition") or row.get("status")
    return None


def append_result(*, call_id: Any, api_request_id: Any, response_id: Any, value: Any,
                  dispatcher_disposition: Any, producer: Any = None) -> Path | None:
    """Finalize only the handle bound to this exact provider call id."""
    call_key = str(call_id)[:128] if call_id is not None else ""
    pending = _PENDING.get()
    matches = [item for item in pending if item.expected_call_id == call_key]
    if len(matches) != 1: return None
    handle = matches[0]
    _PENDING.set(tuple(item for item in pending if item is not handle))
    try:
        result, complete, failure = _safe_append(value)
        capture = _current_capture()
        metadata = getattr(capture, "metadata_capture", None)
        call1 = (getattr(metadata, "calls", None) or [{}])[0]
        if response_id is None and isinstance(call1, dict): response_id = call1.get("response_id")
        if dispatcher_disposition is None: dispatcher_disposition = _disposition(capture, call_key)
        handle.capture_incomplete, handle.capture_failure = not complete, failure
        doc = {
            "schema": "lr32-call1-failure-envelope/v1", "capture_complete": complete, "capture_failure": failure,
            "persistence": "host_mount_required_not_proven",
            "ids": {"run_id": handle.run_id, "request_id": str(api_request_id)[:128] if api_request_id is not None else None,
                    "attempt_id": handle.attempt_id, "model_response_id": str(response_id)[:128] if response_id is not None else None,
                    "tool_call_id": call_key, "transport_attempt_id": handle.transport["transport_attempt_id"]},
            "adapter_entry": handle.adapter_entry, "transport": handle.transport, "plugin_return": handle.plugin_return,
            "append": {"producer": str(producer)[:128] if producer is not None else None,
                       "result_class": type(value).__name__, "result": result},
            "dispatcher": {"disposition": str(dispatcher_disposition)[:128] if dispatcher_disposition is not None else None},
        }
        doc["checksum_sha256"] = checksum(doc)
        payload = json.dumps(doc, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
        if len(payload) > MAX_ENVELOPE_BYTES: raise OSError("envelope oversize")
        directory = _sink_directory()
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", handle.run_id)[:128]
        destination = f"lr32-call1-{safe}.json"
        with _LOCK:
            # One fixed final object per run makes the aggregate run budget 16 KiB.
            return _atomic_write(directory, destination, payload)
    except BaseException:
        handle.capture_incomplete, handle.capture_failure = True, "persistence_failed"
        return None


def reset_for_tests() -> None:
    _PENDING.set(())
