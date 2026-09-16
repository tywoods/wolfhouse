"""Default-off, capture-only LR3.2 call-1 failure envelope.

Admission is server-owned and exact-run bound.  The sink is a fixed host-mounted
path, and every hook is best effort: diagnostics can never affect dispatch.
"""
from __future__ import annotations

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

from wolfhouse.luna_capture_identity_trace import current_trace, emit as trace_emit
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
_CAPTURE_PENDING_ATTR = "_lr32_call1_failure_envelope_pending"


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


def _admission_decision(tool_name: str) -> tuple[Any, Any, str | None, str, dict[str, bool | None]]:
    identity = current_trace()
    capture = None
    predicates: dict[str, bool | None] = {
        "identity_present": None, "capture_present": None, "approved_present": None,
        "run_ids_match": None, "server_marker": None, "scope_match": None,
        "metadata_call1": None,
    }
    if tool_name != TARGET_TOOL:
        return identity, capture, None, "tool_mismatch", predicates
    predicates["identity_present"] = identity is not None
    if identity is None:
        return identity, capture, None, "identity_missing", predicates
    capture = _current_capture()
    predicates["capture_present"] = capture is not None
    if capture is None:
        return identity, capture, None, "capture_missing", predicates
    approved = approved_server_run_id()
    predicates["approved_present"] = approved is not None
    if approved is None:
        return identity, capture, None, "approval_missing", predicates
    predicates["run_ids_match"] = approved == identity.run_id
    if not predicates["run_ids_match"]:
        return identity, capture, None, "run_mismatch", predicates
    predicates["server_marker"] = (
        getattr(capture, "_lr32_server_validated_synthetic", False) is True
    )
    if not predicates["server_marker"]:
        return identity, capture, None, "server_marker_missing", predicates
    predicates["scope_match"] = (
        os.getenv("HERMES_ROLE") == "sunset-luna"
        and os.getenv("LUNA_CLIENT_SLUG") == "sunset"
        and os.getenv("SUNSET_INGRESS_LOCATION_ID") == "sunset-somo"
    )
    if not predicates["scope_match"]:
        return identity, capture, None, "scope_mismatch", predicates
    proven = _metadata_call1(capture)
    predicates["metadata_call1"] = proven is not None
    if proven is None:
        return identity, capture, None, "metadata_call1_missing", predicates
    return identity, capture, proven[1], "accepted", predicates


def _adapter_receipt(identity: Any, capture: Any, *, call_id: str | None,
                     status: str, reason: str, predicates: dict[str, bool | None],
                     pending_created: bool = False) -> None:
    trace_emit(identity, "lr32_adapter_outcome", capture=capture, call_id=call_id,
               status=status, reason=reason, pending_created=pending_created,
               stage="adapter", **predicates)


def adapter_entry(tool_name: str, params: Any) -> CallCapture | None:
    identity = capture = None
    predicates: dict[str, bool | None] = {}
    try:
        identity, capture, expected_call_id, reason, predicates = _admission_decision(tool_name)
        if reason != "accepted" or expected_call_id is None:
            _adapter_receipt(identity, capture, call_id=expected_call_id, status="rejected",
                             reason=reason if reason != "accepted" else "metadata_call1_missing",
                             predicates=predicates)
            return None
        # Exactly one call-1 claim per request-local capture/run, including repeats.
        rejection_reason = None
        with _LOCK:
            shared_pending = getattr(capture, _CAPTURE_PENDING_ATTR, ())
            if type(shared_pending) is not tuple:
                rejection_reason = "pending_invalid"
            elif any(item.run_id == identity.run_id for item in shared_pending):
                rejection_reason = "duplicate_handle"
        if rejection_reason is not None:
            _adapter_receipt(identity, capture, call_id=expected_call_id, status="rejected",
                             reason=rejection_reason, predicates=predicates)
            return None
        mapping = type(params) is dict
        location = params.get("location_id") if mapping else None
        handle = CallCapture(identity.run_id, identity.attempt_id, expected_call_id, {
            "tool": TARGET_TOOL, "call_ordinal": 1,
            "arg_shape": {"is_mapping": mapping, "has_location_id": mapping and "location_id" in params,
                          "location_is_string": type(location) is str},
        })
        # The synchronous plugin can execute in a copied worker Context while the
        # ordinary append seam runs back in the parent Context. A ContextVar write
        # in that worker does not flow back. Bind the handle to the shared,
        # request-local isolated-turn capture as well as the local Context.
        rejection_reason = None
        with _LOCK:
            shared_pending = getattr(capture, _CAPTURE_PENDING_ATTR, ())
            if type(shared_pending) is not tuple:
                rejection_reason = "pending_invalid"
            elif any(item.run_id == identity.run_id for item in shared_pending):
                rejection_reason = "duplicate_handle"
            else:
                setattr(capture, _CAPTURE_PENDING_ATTR, shared_pending + (handle,))
        if rejection_reason is not None:
            _adapter_receipt(identity, capture, call_id=expected_call_id, status="rejected",
                             reason=rejection_reason, predicates=predicates)
            return None
        _adapter_receipt(identity, capture, call_id=expected_call_id, status="accepted",
                         reason="handle_created", predicates=predicates, pending_created=True)
        return handle
    except BaseException:
        _adapter_receipt(identity, capture, call_id=None, status="rejected",
                         reason="internal_error", predicates=predicates)
        return None


def current_handle() -> CallCapture | None:
    try:
        capture = _current_capture()
        if capture is None:
            return None
        shared = getattr(capture, _CAPTURE_PENDING_ATTR, ())
        return shared[-1] if type(shared) is tuple and shared else None
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
    identity, capture = current_trace(), _current_capture()
    if capture is None:
        trace_emit(identity, "lr32_append_outcome", capture=capture, call_id=call_key,
                   status="rejected", reason="capture_missing", exact_match_count=0,
                   same_request_capture=False, handle_match=False, consumed=False, stage="append_match")
        return None
    shared_pending = getattr(capture, _CAPTURE_PENDING_ATTR, ())
    if type(shared_pending) is not tuple:
        trace_emit(identity, "lr32_append_outcome", capture=capture, call_id=call_key,
                   status="rejected", reason="pending_invalid", exact_match_count=0,
                   same_request_capture=True, handle_match=False, consumed=False, stage="append_match")
        return None
    pending = shared_pending
    matches = [item for item in pending if item.expected_call_id == call_key]
    if len(matches) != 1:
        expected = pending[0].expected_call_id if len(pending) == 1 else None
        trace_emit(identity, "lr32_append_outcome", capture=capture, call_id=call_key,
                   status="rejected",
                   reason="no_exact_match" if not matches else "ambiguous_match",
                   expected_call_id=expected, exact_match_count=len(matches),
                   same_request_capture=True, handle_match=False, consumed=False, stage="append_match")
        return None
    handle = matches[0]
    rejection_count = None
    with _LOCK:
        current = getattr(capture, _CAPTURE_PENDING_ATTR, ())
        current_count = (sum(item is handle for item in current)
                         if type(current) is tuple else 0)
        if type(current) is not tuple or current_count != 1:
            rejection_count = current_count
        else:
            setattr(capture, _CAPTURE_PENDING_ATTR,
                    tuple(item for item in current if item is not handle))
    if rejection_count is not None:
        trace_emit(identity, "lr32_append_outcome", capture=capture, call_id=call_key,
                   status="rejected", reason="handle_not_current",
                   expected_call_id=handle.expected_call_id,
                   exact_match_count=rejection_count,
                   same_request_capture=True, handle_match=False, consumed=False,
                   stage="append_match")
        return None
    trace_emit(identity, "lr32_append_outcome", capture=capture, call_id=call_key,
               status="consumed", reason="exact_match",
               expected_call_id=handle.expected_call_id, exact_match_count=1,
               same_request_capture=True, handle_match=True, consumed=True,
               stage="append_match")
    stage = "append_capture"
    try:
        result, complete, failure = _safe_append(value)
        stage = "metadata_projection"
        metadata = getattr(capture, "metadata_capture", None)
        call1 = (getattr(metadata, "calls", None) or [{}])[0]
        if response_id is None and isinstance(call1, dict): response_id = call1.get("response_id")
        if dispatcher_disposition is None: dispatcher_disposition = _disposition(capture, call_key)
        handle.capture_incomplete, handle.capture_failure = not complete, failure
        stage = "envelope_assembly"
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
        stage = "sink_validation"
        directory = _sink_directory()
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", handle.run_id)[:128]
        destination = f"lr32-call1-{safe}.json"
        stage = "publication"
        with _LOCK:
            # One fixed final object per run makes the aggregate run budget 16 KiB.
            published = _atomic_write(directory, destination, payload)
        trace_emit(identity, "lr32_publication_outcome", capture=capture, call_id=call_key,
                   status="completed", reason="published", expected_call_id=handle.expected_call_id,
                   stage="publication", capture_complete=complete, capture_failure=failure)
        return published
    except BaseException:
        failure_reason = f"{stage}_failed"
        handle.capture_incomplete, handle.capture_failure = True, "persistence_failed"
        trace_emit(identity, "lr32_publication_outcome", capture=capture, call_id=call_key,
                   status="failed", reason=failure_reason,
                   expected_call_id=handle.expected_call_id, stage=stage,
                   capture_complete=False, capture_failure=handle.capture_failure)
        return None


def reset_for_tests() -> None:
    try:
        capture = _current_capture()
        if capture is not None and hasattr(capture, _CAPTURE_PENDING_ATTR):
            delattr(capture, _CAPTURE_PENDING_ATTR)
    except BaseException:
        pass
