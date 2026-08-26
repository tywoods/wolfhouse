"""Narrow wrapper around the installed Hermes openai-codex composition.

Does not use the CLI. Does not stamp config.yaml, env, constants, wrapper
args, or client labels as provenance. Provider is bound only after a 2xx
Codex Responses HTTP attempt whose FINAL ``response.request.url`` is the
official HTTPS chatgpt.com ``/backend-api/codex`` transport, together with
the terminal Responses event model. Redirects are disabled and rejected.
"""

from __future__ import annotations

import concurrent.futures
import contextvars
import os
import sys
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Iterator
from urllib.parse import urlparse

from wolfhouse.email_draft_contract import (
    LIVE_ATTEMPT_SOURCE,
    MODEL,
    PROVIDER,
    AttemptResult,
)

CODEX_BACKEND_HOST = "chatgpt.com"
CODEX_BACKEND_PATH_MARKER = "/backend-api/codex"
CODEX_BACKEND_SCHEME = "https"
HERMES_PACKAGE_ROOTS = (
    os.environ.get("HERMES_PACKAGE_ROOT") or "",
    "/opt/hermes",
)
STREAM_CONTINUE_AFTER_FIRST_BYTE_S = 8.0
CONSUME_MAX_WORKERS = 4

_CAPTURE: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "wh_email_draft_codex_capture",
    default=None,
)
_WRAP_LOCK = threading.Lock()
_WRAP_STATE: dict[int, dict[str, Any]] = {}
_CONSUME_LOCK = threading.Lock()
_CONSUME_EXECUTOR: concurrent.futures.ThreadPoolExecutor | None = None
_CONSUME_SLOTS = threading.BoundedSemaphore(CONSUME_MAX_WORKERS)


class ProvenanceError(RuntimeError):
    """Exact-attempt provenance missing or mismatched."""


def _field(obj: Any, name: str) -> Any:
    if obj is None:
        return None
    value = getattr(obj, name, None)
    if value is None and isinstance(obj, dict):
        value = obj.get(name)
    return value


def is_codex_backend_url(base_url: Any) -> bool:
    if not isinstance(base_url, str) or not base_url:
        return False
    try:
        parsed = urlparse(base_url)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower().rstrip(".")
    path = (parsed.path or "").lower()
    scheme = (parsed.scheme or "").lower()
    if parsed.username or parsed.password:
        return False
    if parsed.port not in (None, 443):
        return False
    if scheme != CODEX_BACKEND_SCHEME:
        return False
    return host == CODEX_BACKEND_HOST and path.startswith(CODEX_BACKEND_PATH_MARKER)


def captured_transport_is_codex(captured: dict[str, Any] | None) -> bool:
    if not isinstance(captured, dict):
        return False
    if captured.get("error"):
        return False
    if captured.get("redirect"):
        return False
    status = captured.get("status_code")
    if not isinstance(status, int) or status < 200 or status >= 300:
        return False
    host = captured.get("host")
    path = captured.get("path")
    scheme = captured.get("scheme")
    url = captured.get("request_url")
    if not isinstance(host, str) or not isinstance(path, str):
        return False
    if scheme != CODEX_BACKEND_SCHEME:
        return False
    if host.lower().rstrip(".") != CODEX_BACKEND_HOST:
        return False
    if not path.lower().startswith(CODEX_BACKEND_PATH_MARKER):
        return False
    if not isinstance(url, str) or not is_codex_backend_url(url):
        return False
    return True


def capture_terminal_model() -> tuple[dict[str, Any], Callable[[Any], None]]:
    captured: dict[str, Any] = {
        "model": None,
        "id": None,
        "status": None,
        "event_type": None,
    }

    def on_event(event: Any) -> None:
        event_type = _field(event, "type") or ""
        if event_type not in {
            "response.completed",
            "response.incomplete",
            "response.failed",
        }:
            return
        captured["event_type"] = event_type
        response = _field(event, "response")
        captured["model"] = _field(response, "model")
        captured["id"] = _field(response, "id")
        captured["status"] = _field(response, "status")

    return captured, on_event


def load_installed_hermes() -> dict[str, Any]:
    for root in HERMES_PACKAGE_ROOTS:
        if root and os.path.isdir(root) and root not in sys.path:
            sys.path.insert(0, root)
    try:
        from agent.auxiliary_client import resolve_provider_client
        from agent.codex_runtime import _consume_codex_event_stream
        from hermes_cli.auth import resolve_codex_runtime_credentials
        from hermes_cli.runtime_provider import resolve_runtime_provider
    except Exception as exc:  # pragma: no cover - environment-specific
        raise ProvenanceError(f"hermes_composition_unavailable:{type(exc).__name__}") from exc
    return {
        "resolve_runtime_provider": resolve_runtime_provider,
        "resolve_provider_client": resolve_provider_client,
        "resolve_codex_runtime_credentials": resolve_codex_runtime_credentials,
        "consume_codex_event_stream": _consume_codex_event_stream,
    }


def _extract_content(final: Any) -> str:
    def item_get(obj: Any, key: str) -> Any:
        value = getattr(obj, key, None)
        if value is None and isinstance(obj, dict):
            value = obj.get(key)
        return value

    parts: list[str] = []
    output_text = item_get(final, "output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()
    for item in item_get(final, "output") or []:
        if item_get(item, "type") != "message":
            continue
        for part in item_get(item, "content") or []:
            ptype = item_get(part, "type")
            if ptype in {"output_text", "text"}:
                text = item_get(part, "text") or ""
                if text:
                    parts.append(str(text))
    return "".join(parts).strip()


def _record_final_url(request: Any, sink: dict[str, Any]) -> None:
    url_obj = _field(request, "url")
    url = str(url_obj) if url_obj is not None else ""
    if not url:
        return
    try:
        parsed = urlparse(url)
    except ValueError:
        sink["error"] = "not_codex_backend"
        return
    sink["request_url"] = url
    sink["host"] = (parsed.hostname or "").lower().rstrip(".")
    sink["path"] = (parsed.path or "").lower()
    sink["scheme"] = (parsed.scheme or "").lower()


def _bind_final_response(response: Any, sink: dict[str, Any]) -> None:
    if response is None:
        sink["error"] = "codex_response_missing"
        return
    status = _field(response, "status_code")
    sink["status_code"] = status
    if isinstance(status, int) and 300 <= status < 400:
        sink["redirect"] = True
        sink["error"] = "codex_redirect_forbidden"
        return
    request = _field(response, "request")
    if request is None:
        sink["error"] = "codex_response_missing"
        return
    _record_final_url(request, sink)
    if not isinstance(status, int) or status < 200 or status >= 300:
        if not sink.get("error"):
            sink["error"] = "not_codex_backend"


def _httpx_client_of(client: Any) -> Any | None:
    if client is None:
        return None
    real = getattr(client, "_real_client", None)
    for candidate in (
        getattr(real, "_client", None) if real is not None else None,
        getattr(client, "_client", None),
    ):
        if candidate is not None and callable(getattr(candidate, "send", None)):
            return candidate
    return None


def _consume_executor() -> concurrent.futures.ThreadPoolExecutor:
    global _CONSUME_EXECUTOR
    with _CONSUME_LOCK:
        if _CONSUME_EXECUTOR is None:
            _CONSUME_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
                max_workers=CONSUME_MAX_WORKERS,
                thread_name_prefix="wh-codex-consume",
            )
        return _CONSUME_EXECUTOR


def bounded_executor_stats() -> dict[str, int]:
    executor = _CONSUME_EXECUTOR
    queued = 0
    if executor is not None:
        queued = getattr(getattr(executor, "_work_queue", None), "qsize", lambda: 0)()
    held = CONSUME_MAX_WORKERS - _CONSUME_SLOTS._value  # noqa: SLF001
    return {
        "max_workers": CONSUME_MAX_WORKERS,
        "held_slots": max(0, held),
        "queued": int(queued or 0),
    }


def run_bounded_provider_call(fn: Callable[[], Any], timeout_s: float) -> Any:
    """Run create+consume off the request thread. Slots stay held until the worker exits."""
    if not isinstance(timeout_s, (int, float)) or timeout_s <= 0:
        raise ProvenanceError("codex_stream_deadline")
    if not _CONSUME_SLOTS.acquire(timeout=0.05):
        raise ProvenanceError("codex_worker_exhausted")
    released = False

    def _run() -> Any:
        nonlocal released
        try:
            return fn()
        finally:
            if not released:
                released = True
                _CONSUME_SLOTS.release()

    ctx = contextvars.copy_context()
    future = _consume_executor().submit(ctx.run, _run)
    try:
        return future.result(timeout=float(timeout_s))
    except concurrent.futures.TimeoutError as exc:
        raise ProvenanceError("codex_stream_deadline") from exc
    except ProvenanceError:
        raise
    except Exception as exc:
        raise ProvenanceError(f"codex_stream_consume:{type(exc).__name__}") from exc


@contextmanager
def capture_codex_transport(client: Any) -> Iterator[dict[str, Any]]:
    """Instrument this call's transport client; restore after. Concurrent-safe.

    Capture is bound with a contextvar so concurrent invokes cannot cross-bind.
    The httpx ``send`` hook is refcounted per client object and restored when
    the last in-flight call on that client exits. TLS verify is not touched.
    Redirects are disabled for the captured call. Provenance is bound to the
    FINAL ``response.request.url`` after a 2xx, never the first outbound URL.
    """
    sink: dict[str, Any] = {
        "request_url": None,
        "host": None,
        "path": None,
        "scheme": None,
        "status_code": None,
        "redirect": False,
        "error": None,
    }
    http_client = _httpx_client_of(client)
    if http_client is None:
        raise ProvenanceError("transport_client_unavailable")
    token = _CAPTURE.set(sink)
    key = id(http_client)
    with _WRAP_LOCK:
        state = _WRAP_STATE.get(key)
        if state is None:
            original = http_client.send
            instance_override = "send" in getattr(http_client, "__dict__", {})

            def hooked_send(request: Any, *args: Any, **kwargs: Any) -> Any:
                current = _CAPTURE.get()
                send_kwargs = dict(kwargs)
                if current is not None:
                    send_kwargs["follow_redirects"] = False
                try:
                    response = original(request, *args, **send_kwargs)
                except ProvenanceError:
                    raise
                except Exception:
                    if current is not None and not current.get("request_url"):
                        current["error"] = "codex_response_missing"
                    raise
                if current is not None:
                    _bind_final_response(response, current)
                    if current.get("error") == "codex_redirect_forbidden":
                        raise ProvenanceError("codex_redirect_forbidden")
                return response

            http_client.send = hooked_send
            _WRAP_STATE[key] = {
                "original": original,
                "instance_override": instance_override,
                "count": 1,
                "client": http_client,
            }
        else:
            state["count"] += 1
    try:
        yield sink
    finally:
        _CAPTURE.reset(token)
        with _WRAP_LOCK:
            state = _WRAP_STATE.get(key)
            if state is not None:
                state["count"] -= 1
                if state["count"] <= 0:
                    try:
                        if state.get("instance_override"):
                            http_client.send = state["original"]
                        elif "send" in getattr(http_client, "__dict__", {}):
                            del http_client.send
                        else:
                            http_client.send = state["original"]
                    except Exception:
                        try:
                            http_client.send = state["original"]
                        except Exception:
                            pass
                    _WRAP_STATE.pop(key, None)


class DeadlineStream:
    """Bound consume after first byte so a hung SSE iterator cannot stall."""

    def __init__(
        self,
        inner: Any,
        *,
        total_s: float,
        continue_s: float = STREAM_CONTINUE_AFTER_FIRST_BYTE_S,
    ) -> None:
        if not isinstance(total_s, (int, float)) or total_s <= 0:
            raise ProvenanceError("codex_stream_deadline")
        self._inner = inner
        self._total_s = float(total_s)
        self._continue_s = float(continue_s)
        self._closed = False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        close_fn = getattr(self._inner, "close", None)
        if callable(close_fn):
            try:
                close_fn()
            except Exception:
                pass

    def __iter__(self) -> Iterator[Any]:
        start = time.monotonic()
        deadline = start + self._total_s
        first = True
        timer: threading.Timer | None = None

        def force_close() -> None:
            self.close()

        try:
            timer = threading.Timer(self._total_s, force_close)
            timer.daemon = True
            timer.start()
            for event in self._inner:
                now = time.monotonic()
                if now >= deadline:
                    self.close()
                    raise ProvenanceError("codex_stream_deadline")
                if first:
                    first = False
                    deadline = min(deadline, now + self._continue_s)
                    remaining = max(0.05, deadline - now)
                    if timer is not None:
                        timer.cancel()
                    timer = threading.Timer(remaining, force_close)
                    timer.daemon = True
                    timer.start()
                yield event
        finally:
            if timer is not None:
                timer.cancel()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def _refresh_codex_credentials(loaded: dict[str, Any]) -> dict[str, Any]:
    resolve_creds = loaded.get("resolve_codex_runtime_credentials")
    if not callable(resolve_creds):
        raise ProvenanceError("codex_refresh_failed")
    try:
        creds = resolve_creds(refresh_if_expiring=True)
    except ProvenanceError:
        raise
    except Exception as exc:
        raise ProvenanceError(f"codex_refresh_failed:{type(exc).__name__}") from exc
    if not isinstance(creds, dict):
        raise ProvenanceError("codex_refresh_failed")
    api_key = creds.get("api_key")
    if not isinstance(api_key, str) or not api_key.strip():
        raise ProvenanceError("codex_refresh_failed")
    provider = creds.get("provider")
    if provider not in (None, PROVIDER):
        raise ProvenanceError("codex_refresh_failed")
    base_url = creds.get("base_url")
    if base_url is not None and not is_codex_backend_url(str(base_url)):
        raise ProvenanceError("not_codex_backend")
    return creds


def _raise_transport_error(transport: dict[str, Any]) -> None:
    error = transport.get("error")
    if error == "codex_redirect_forbidden":
        raise ProvenanceError("codex_redirect_forbidden")
    if error == "codex_response_missing" or not transport.get("request_url"):
        raise ProvenanceError("codex_response_missing")
    if not captured_transport_is_codex(transport):
        raise ProvenanceError("not_codex_backend")


def invoke_installed_hermes(
    system: str,
    user: str,
    *,
    composition: dict[str, Any] | None = None,
    timeout_s: float = 20,
    continue_s: float = STREAM_CONTINUE_AFTER_FIRST_BYTE_S,
) -> AttemptResult:
    """Call the installed Hermes openai-codex composition for one attempt."""
    if not isinstance(system, str) or not isinstance(user, str):
        raise ProvenanceError("invalid_prompt")
    loaded = composition or load_installed_hermes()
    resolve_runtime = loaded.get("resolve_runtime_provider")
    resolve_client = loaded.get("resolve_provider_client")
    consume = loaded.get("consume_codex_event_stream")
    if not callable(resolve_client) or not callable(consume):
        raise ProvenanceError("hermes_composition_unavailable")

    if callable(resolve_runtime):
        runtime = resolve_runtime()
        if not isinstance(runtime, dict):
            raise ProvenanceError("runtime_resolution_invalid")
        selected_provider = runtime.get("provider")
        if selected_provider != PROVIDER:
            raise ProvenanceError("runtime_provider_mismatch")

    _refresh_codex_credentials(loaded)

    client_pair = resolve_client(PROVIDER, MODEL, raw_codex=True)
    if not isinstance(client_pair, tuple) or len(client_pair) != 2:
        raise ProvenanceError("codex_client_unavailable")
    client, selected_model = client_pair
    if client is None:
        raise ProvenanceError("codex_client_unavailable")
    if selected_model != MODEL:
        raise ProvenanceError("runtime_model_mismatch")

    captured_events, on_event = capture_terminal_model()
    stream_kwargs = {
        "model": MODEL,
        "instructions": system,
        "input": [{"role": "user", "content": user}],
        "store": False,
        "stream": True,
        "timeout": timeout_s,
    }

    def _create_and_consume() -> Any:
        with capture_codex_transport(client) as transport:
            try:
                event_stream = client.responses.create(**stream_kwargs)
            except ProvenanceError:
                raise
            except Exception as exc:
                if not transport.get("request_url") and not transport.get("error"):
                    transport["error"] = "codex_response_missing"
                raise ProvenanceError(f"codex_stream_create:{type(exc).__name__}") from exc
            if transport.get("error") or not captured_transport_is_codex(transport):
                _raise_transport_error(transport)
            bounded = DeadlineStream(
                event_stream,
                total_s=timeout_s,
                continue_s=continue_s,
            )
            try:
                final = consume(bounded, model=MODEL, on_event=on_event)
            except ProvenanceError:
                raise
            except Exception as exc:
                raise ProvenanceError(f"codex_stream_consume:{type(exc).__name__}") from exc
            finally:
                bounded.close()
            _raise_transport_error(transport)
            return final

    final = run_bounded_provider_call(_create_and_consume, timeout_s)

    live_model = captured_events.get("model")
    if not isinstance(live_model, str) or not live_model.strip():
        raise ProvenanceError("live_model_unavailable")
    live_model = live_model.strip()
    if live_model != MODEL:
        raise ProvenanceError("live_model_mismatch")
    if captured_events.get("event_type") != "response.completed":
        raise ProvenanceError("codex_stream_incomplete")

    content = _extract_content(final)
    if not content:
        raise ProvenanceError("empty_completion")

    return AttemptResult(
        content=content,
        provider=PROVIDER,
        model=live_model,
        source=LIVE_ATTEMPT_SOURCE,
    )
