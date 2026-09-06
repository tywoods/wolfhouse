"""Fail-open Sunset Hermes AI-usage observer; never handles conversation content."""
from __future__ import annotations

import contextlib
import contextvars
import datetime as _dt
import json
import os
import queue
import re
import socket
import threading
import urllib.error
import urllib.request
import uuid
from typing import Any, Mapping
from wolfhouse.luna_personality_isolation import deny_telemetry_if_isolated

ENV_NAMES = (
    "CROWSNEST_AI_USAGE_INGEST_URL",
    "CROWSNEST_AI_USAGE_INGEST_TOKEN",
    "CROWSNEST_AI_USAGE_CLIENT_SLUG",
    "CROWSNEST_AI_USAGE_TENANT_ID",
    "CROWSNEST_AI_USAGE_SOURCE_SERVICE",
)
INGEST_URL = "https://crowsnest.lunafrontdesk.com/api/ai-usage"
MAX_HTTP_TIMEOUT_SECONDS = 2.0
MAX_SAFE_INTEGER = 9007199254740991
QUEUE_SIZE = 128
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SAFE_LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$")
_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
_SECRET_SHAPES = (
    re.compile(r"^sk-[A-Za-z0-9]{10,}"),
    re.compile(r"^sk-ant-[A-Za-z0-9_-]{10,}"),
    re.compile(r"^Bearer\s+", re.I),
    re.compile(r"^Bearer_", re.I),
    re.compile(r"-----BEGIN (?:RSA )?PRIVATE KEY-----"),
)
_guest_reply = contextvars.ContextVar("crowsnest_guest_reply", default=False)
_queue = queue.Queue(maxsize=QUEUE_SIZE)
_worker = None
_worker_lock = threading.Lock()


def _safe_text(value: Any, pattern) -> bool:
    return isinstance(value, str) and value == value.strip() and bool(pattern.fullmatch(value)) and not any(r.search(value) for r in _SECRET_SHAPES)


def _safe_int(value: Any) -> bool:
    return type(value) is int and 0 <= value <= MAX_SAFE_INTEGER


def read_config(env: Mapping[str, str] = os.environ):
    values = {name: env.get(name) for name in ENV_NAMES}
    if values[ENV_NAMES[0]] != INGEST_URL:
        return None
    if not isinstance(values[ENV_NAMES[1]], str) or not values[ENV_NAMES[1]].strip():
        return None
    if not _safe_text(values[ENV_NAMES[2]], _SAFE_ID):
        return None
    if not _safe_text(values[ENV_NAMES[3]], _SAFE_ID):
        return None
    if not _safe_text(values[ENV_NAMES[4]], _SAFE_LABEL):
        return None
    return values


def _own(value: Any, name: str):
    if isinstance(value, dict):
        return value.get(name)
    try:
        return vars(value).get(name)
    except (TypeError, AttributeError):
        return None


def _tokens(raw: Any):
    usage = _own(raw, "usage")
    if usage is None:
        return {"availability": "unavailable"}
    inputs = _own(usage, "input_tokens")
    outputs = _own(usage, "output_tokens")
    if inputs is None:
        inputs = _own(usage, "prompt_tokens")
    if outputs is None:
        outputs = _own(usage, "completion_tokens")
    total = _own(usage, "total_tokens")
    if not all(_safe_int(v) for v in (inputs, outputs, total)) or inputs + outputs > MAX_SAFE_INTEGER or inputs + outputs != total:
        return {"availability": "unavailable"}
    return {"availability": "measured", "input_tokens": inputs, "output_tokens": outputs, "total_tokens": total}


def _base(model: str, latency_ms: int, env: Mapping[str, str]):
    cfg = read_config(env)
    if cfg is None or not _safe_text(model, _MODEL) or not _safe_int(latency_ms):
        return None
    return {
        "schema_version": "crowsnest.ai_usage.v1",
        "event_id": f"evt_{uuid.uuid4().hex}",
        "occurred_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "client_slug": cfg[ENV_NAMES[2]],
        "tenant_id": cfg[ENV_NAMES[3]],
        "source_service": cfg[ENV_NAMES[4]],
        "operation": "guest_reply",
        "provider": "openai",
        "model": model,
        "latency_ms": latency_ms,
        "cost": {"state": "unavailable"},
    }


def build_success_event(raw_response: Any, latency_ms: int, *, env=os.environ):
    if _own(raw_response, "status") != "completed":
        return None
    event = _base(_own(raw_response, "model"), latency_ms, env)
    if event is None:
        return None
    event.update(status="succeeded", tokens=_tokens(raw_response))
    return event


def build_failure_event(model: str, latency_ms: int, error_code: str, *, env=os.environ):
    event = _base(model, latency_ms, env)
    if event is None or not _safe_text(error_code, _SAFE_ID):
        return None
    event.update(status="failed", error_code=error_code, tokens={"availability": "unavailable"})
    return event


def build_attempt_event(*, response: Any, configured_model: str, latency_ms: int, env=os.environ):
    status = _own(response, "status")
    terminal_event_type = _own(response, "terminal_event_type")
    if status == "completed" and terminal_event_type == "response.completed":
        return build_success_event(response, latency_ms, env=env)
    if terminal_event_type is None:
        code = "provider_response_no_terminal"
    else:
        code = "provider_response_incomplete" if status == "incomplete" else "provider_response_failed"
    model = _own(response, "model")
    if not _safe_text(model, _MODEL):
        model = configured_model
    return build_failure_event(model, latency_ms, code, env=env)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _post(event, env):
    cfg = read_config(env)
    if cfg is None or event is None:
        return None
    try:
        request = urllib.request.Request(
            INGEST_URL,
            data=json.dumps(event, separators=(",", ":")).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {cfg[ENV_NAMES[1]]}"},
            method="POST",
        )
        opener = urllib.request.build_opener(_NoRedirect())
        with opener.open(request, timeout=MAX_HTTP_TIMEOUT_SECONDS):
            pass
    except Exception:
        pass
    return None


def _worker_loop():
    while True:
        event, env = _queue.get()
        try:
            _post(event, env)
        finally:
            _queue.task_done()


def enqueue_event(event, *, env=os.environ):
    if deny_telemetry_if_isolated():
        return None
    global _worker
    cfg = read_config(env)
    if cfg is None or event is None:
        return None
    try:
        _queue.put_nowait((event, cfg))
    except queue.Full:
        return None
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            try:
                _worker = threading.Thread(target=_worker_loop, daemon=True, name="crowsnest-ai-usage")
                _worker.start()
            except Exception:
                _worker = None
    return None


def _eligible(provider: str, env) -> bool:
    return _guest_reply.get() and env.get("HERMES_ROLE") == "sunset-luna" and str(provider).lower() in {"openai", "openai-codex"}


@contextlib.contextmanager
def guest_reply_context():
    token = _guest_reply.set(True)
    try:
        yield
    finally:
        _guest_reply.reset(token)


def observe_attempt_result(response, configured_model, latency_ms, *, provider, env=os.environ):
    if deny_telemetry_if_isolated():
        return None
    if _eligible(provider, env):
        enqueue_event(build_attempt_event(response=response, configured_model=configured_model, latency_ms=latency_ms, env=env), env=env)
    return None


def _classify(exc):
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return "provider_timeout"
    status = getattr(exc, "status_code", None)
    if status == 401:
        return "provider_auth"
    if type(status) is int and status >= 500:
        return "provider_unavailable"
    return "provider_error"


def observe_attempt_failure(exc, configured_model, latency_ms, *, provider, env=os.environ):
    if deny_telemetry_if_isolated():
        return None
    if _eligible(provider, env):
        enqueue_event(build_failure_event(configured_model, latency_ms, _classify(exc), env=env), env=env)
    return None


def _reset_worker_for_tests():
    global _worker, _queue
    _worker = None
    _queue = queue.Queue(maxsize=QUEUE_SIZE)
