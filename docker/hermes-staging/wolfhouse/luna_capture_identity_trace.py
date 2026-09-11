"""Default-off, no-payload capture identity tracing for the closed LR3.2 eval.

Records are bounded in memory and on disk. Every public operation is best effort
so diagnostics can never alter turn behaviour. Each process owns an exclusive
sink; inherited descriptors are never used after fork.
"""
from __future__ import annotations

import asyncio
import contextvars
import fcntl
import json
import os
import re
import stat
import threading
from pathlib import Path
from typing import Any, Optional

TRACE_PATH_ENV = "LUNA_LR32_CAPTURE_IDENTITY_TRACE_PATH"
# This exact value is the enablement token, not an output pathname.
TRACE_PATH = Path("/tmp/lr32-capture-identity-trace.jsonl")
TRACE_PATH_PREFIX = "/tmp/lr32-capture-identity-trace."
TRACE_PATH_PATTERN = "/tmp/lr32-capture-identity-trace.<pid>.<start>.jsonl"
TRACE_LIMIT = 256
TRACE_FILE_MAX_BYTES = 1024 * 1024

_SINK_LOCK = threading.RLock()
_SINK_FD: Optional[int] = None
_SINK_IDENTITY: Optional[tuple[int, int]] = None
_SINK_PATH: Optional[Path] = None
_SINK_OWNER_PID: Optional[int] = None
_SINK_INITIALIZED = False
_PROCESS_PID: Optional[int] = None
_PROCESS_START: Optional[str] = None
_TRACE_NAME = re.compile(r"^lr32-capture-identity-trace\.[0-9]+\.(?:[0-9]{1,32}|unavailable)\.jsonl$")


def _read_process_start_token() -> str:
    try:
        fields = Path("/proc/self/stat").read_text(encoding="ascii").rsplit(")", 1)[1].split()
        starttime = fields[19]
        if starttime.isascii() and starttime.isdigit() and len(starttime) <= 32:
            return starttime
    except BaseException:
        pass
    return "unavailable"


def _worker_identity() -> tuple[int, str]:
    global _PROCESS_PID, _PROCESS_START
    pid = os.getpid()
    if _PROCESS_PID != pid or _PROCESS_START is None:
        _PROCESS_PID = pid
        _PROCESS_START = _read_process_start_token()
    return pid, _PROCESS_START


def trace_path() -> Path:
    """Return the fixed, non-caller-selectable output path for this worker."""
    pid, start = _worker_identity()
    return Path(f"{TRACE_PATH_PREFIX}{pid}.{start}.jsonl")


def trace_paths() -> tuple[Path, ...]:
    """List preserved worker evidence. This helper never removes files."""
    try:
        return tuple(sorted(path for path in Path("/tmp").glob("lr32-capture-identity-trace.*.*.jsonl")
                            if _TRACE_NAME.fullmatch(path.name)))
    except BaseException:
        return ()


def _clear_sink_state(*, close: bool) -> None:
    global _SINK_FD, _SINK_IDENTITY, _SINK_PATH, _SINK_OWNER_PID, _SINK_INITIALIZED
    fd = _SINK_FD
    _SINK_FD = None
    _SINK_IDENTITY = None
    _SINK_PATH = None
    _SINK_OWNER_PID = None
    _SINK_INITIALIZED = False
    if close and fd is not None:
        try:
            os.close(fd)
        except BaseException:
            pass


def _validate_sink_owner_locked() -> None:
    if _SINK_OWNER_PID is not None and _SINK_OWNER_PID != os.getpid():
        _clear_sink_state(close=True)


def _initialize_sink() -> Optional[int]:
    global _SINK_FD, _SINK_IDENTITY, _SINK_PATH, _SINK_OWNER_PID, _SINK_INITIALIZED
    with _SINK_LOCK:
        _validate_sink_owner_locked()
        if _SINK_INITIALIZED:
            return _SINK_FD
        _SINK_INITIALIZED = True
        pid, _start = _worker_identity()
        path = trace_path()
        flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND |
                 os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOFOLLOW)
        fd: Optional[int] = None
        try:
            fd = os.open(path, flags, 0o600)
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                    info.st_nlink != 1):
                raise OSError("trace sink identity is unsafe")
            os.fchmod(fd, 0o600)
            _SINK_FD = fd
            _SINK_IDENTITY = (info.st_dev, info.st_ino)
            _SINK_PATH = path
            _SINK_OWNER_PID = pid
            return fd
        except BaseException:
            if fd is not None:
                try:
                    os.close(fd)
                except BaseException:
                    pass
            return None


def _after_fork_in_child() -> None:
    global _PROCESS_PID, _PROCESS_START
    # register_at_fork runs while other inherited threads no longer exist; do not
    # acquire an inherited lock here.
    _clear_sink_state(close=True)
    _PROCESS_PID = None
    _PROCESS_START = None


try:
    os.register_at_fork(after_in_child=_after_fork_in_child)
except (AttributeError, OSError):
    pass


def reset_trace_sink_for_tests() -> None:
    """Close process-owned test state. This helper never deletes evidence."""
    with _SINK_LOCK:
        _clear_sink_state(close=True)


_CURRENT_TRACE: contextvars.ContextVar[Optional["CaptureIdentityTrace"]] = contextvars.ContextVar(
    "luna_capture_identity_trace", default=None,
)
_ALLOWED_EVENTS = frozenset({
    "attach", "enqueue", "handler_entry", "provider_response_consumed",
    "loop", "dispatcher", "handler", "record_disposition_entry",
    "record_disposition_post_write", "serialization_finalize", "finalize",
    "sink_failure",
})
_ALLOWED_STATUS = frozenset({
    "attached", "queued", "entered", "consumed", "completed", "failed",
    "accepted", "rejected", "dispatched", "missing", "closed", "truncated",
})
_ALLOWED_REASONS = frozenset({
    "asyncio", "worker", "consumer", "stream_consumer", "gateway_handler",
    "tool_dispatcher", "safe_schedule_threadsafe", "thread_pool_executor",
    "codex_parser", "response.completed", "response.failed", "response.incomplete",
    "write_failed", "output_limit", "completed", "failed", "trace_context_missing",
    "metadata_capture_finalize",
})


class CaptureIdentityTrace:
    """Thread-safe bounded identity records, optionally copied to a worker file."""

    def __init__(self, *, run_id: str, attempt_id: str, path: Optional[Path] = None,
                 limit: int = TRACE_LIMIT) -> None:
        self.run_id = str(run_id)[:128]
        self.attempt_id = str(attempt_id)[:128]
        candidate = Path(path) if path is not None else None
        self._path_enabled = candidate == TRACE_PATH
        self._path_rejected = candidate is not None and candidate != TRACE_PATH
        self._limit = max(1, min(int(limit), TRACE_LIMIT))
        self._records: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._sink_failed = False
        self._truncated = False
        if self._path_enabled:
            _initialize_sink()

    def _record(self, event: str, *, capture: Any, call_id: Any = None,
                disposition_count: Any = None, status: Any = None,
                reason: Any = None) -> dict[str, Any]:
        try:
            task = asyncio.current_task()
        except RuntimeError:
            task = None
        pid, start = _worker_identity()
        return {
            "event": event, "worker_pid": pid, "worker_start": start,
            "thread_id": threading.get_ident(), "task_id": id(task) if task is not None else None,
            "run_id": self.run_id, "attempt_id": self.attempt_id,
            "call_id": str(call_id)[:128] if call_id is not None else None,
            "capture_present": capture is not None,
            "capture_id": id(capture) if capture is not None else None,
            "disposition_count": (disposition_count if type(disposition_count) is int
                                  and disposition_count >= 0 else None),
            "status": str(status)[:64] if status in _ALLOWED_STATUS else None,
            "reason": str(reason)[:128] if reason in _ALLOWED_REASONS else None,
        }

    def _failure_locked(self, capture: Any, *, truncated: bool = False) -> None:
        if len(self._records) >= self._limit:
            return
        if truncated:
            if self._truncated:
                return
            self._truncated = True
        else:
            if self._sink_failed:
                return
            self._sink_failed = True
        self._records.append(self._record(
            "sink_failure", capture=capture, status="truncated" if truncated else "failed",
            reason="output_limit" if truncated else "write_failed"))

    def _write_path_locked(self, payload: bytes) -> bool:
        with _SINK_LOCK:
            _validate_sink_owner_locked()
            fd = _initialize_sink()
            if fd is None or _SINK_OWNER_PID != os.getpid():
                raise OSError("trace sink unavailable")
            locked = False
            original_size = None
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                original_size = os.fstat(fd).st_size
                if original_size + len(payload) > TRACE_FILE_MAX_BYTES:
                    return False
                view = memoryview(payload)
                while view:
                    written = os.write(fd, view)
                    if written <= 0:
                        raise OSError("trace sink made no write progress")
                    view = view[written:]
                return True
            except BaseException:
                if locked and original_size is not None:
                    try:
                        os.ftruncate(fd, original_size)
                    except BaseException:
                        pass
                raise
            finally:
                if locked:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_UN)
                    except BaseException:
                        pass

    def emit(self, event: str, *, capture: Any = None, call_id: Any = None,
             disposition_count: Any = None, status: Any = None,
             reason: Any = None, **_ignored: Any) -> None:
        """Append allowlisted scalar identity only; swallow every trace failure."""
        try:
            if event not in _ALLOWED_EVENTS:
                return
            record = self._record(event, capture=capture, call_id=call_id,
                                  disposition_count=disposition_count, status=status, reason=reason)
            payload = (json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
            with self._lock:
                if len(self._records) >= self._limit:
                    return
                try:
                    if self._path_rejected:
                        self._failure_locked(capture)
                        return
                    if self._path_enabled:
                        if not self._write_path_locked(payload):
                            self._failure_locked(capture, truncated=True)
                            return
                        self._records.append(record)
                    else:
                        self._records.append(record)
                except BaseException:
                    self._failure_locked(capture)
        except BaseException:
            return

    def snapshot(self) -> list[dict[str, Any]]:
        try:
            with self._lock:
                return [dict(item) for item in self._records]
        except BaseException:
            return []


def trace_from_environment(*, run_id: str, attempt_id: str) -> Optional[CaptureIdentityTrace]:
    try:
        if os.getenv(TRACE_PATH_ENV, "") != str(TRACE_PATH):
            return None
        return CaptureIdentityTrace(path=TRACE_PATH, run_id=run_id, attempt_id=attempt_id)
    except BaseException:
        return None


def enter_trace(identity: Optional[CaptureIdentityTrace]) -> Optional[contextvars.Token]:
    try:
        return _CURRENT_TRACE.set(identity if type(identity) is CaptureIdentityTrace else None)
    except BaseException:
        return None


def exit_trace(token: Optional[contextvars.Token]) -> None:
    try:
        if token is not None:
            _CURRENT_TRACE.reset(token)
    except BaseException:
        return


def current_trace() -> Optional[CaptureIdentityTrace]:
    try:
        return _CURRENT_TRACE.get()
    except BaseException:
        return None


def emit(identity: Any, event: str, *, capture: Any = None, **fields: Any) -> None:
    try:
        if type(identity) is CaptureIdentityTrace:
            identity.emit(event, capture=capture, **fields)
    except BaseException:
        return


def finalize(identity: Any, *, capture: Any, failed: bool = False) -> None:
    if type(identity) is not CaptureIdentityTrace:
        return
    present = current_trace() is identity
    emit(identity, "finalize", capture=capture, status="closed" if present else "missing",
         reason=("failed" if failed else "completed") if present else "trace_context_missing")
