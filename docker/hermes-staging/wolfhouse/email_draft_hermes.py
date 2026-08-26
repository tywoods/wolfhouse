"""Narrow wrapper around the installed Hermes openai-codex composition.

Does not use the CLI. Does not stamp config.yaml, env, constants, wrapper
args, or client labels as provenance. Provider is bound only to the actual
OpenAI Codex Responses HTTP attempt captured under a per-call closure
(request URL host + Codex protocol path) together with the terminal
Responses event model.
"""

from __future__ import annotations

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

_CAPTURE: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "wh_email_draft_codex_capture",
    default=None,
)
_WRAP_LOCK = threading.Lock()
_WRAP_STATE: dict[int, dict[str, Any]] = {}


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
    if scheme and scheme != CODEX_BACKEND_SCHEME:
        return False
    return host == CODEX_BACKEND_HOST and CODEX_BACKEND_PATH_MARKER in path


def captured_transport_is_codex(captured: dict[str, Any] | None) -> bool:
    if not isinstance(captured, dict):
        return False
    host = captured.get("host")
    path = captured.get("path")
    scheme = captured.get("scheme")
    url = captured.get("request_url")
    if not isinstance(host, str) or not isinstance(path, str):
        return False
    if scheme not in (None, "", CODEX_BACKEND_SCHEME) and scheme != CODEX_BACKEND_SCHEME:
        return False
    if host.lower().rstrip(".") != CODEX_BACKEND_HOST:
        return False
    if CODEX_BACKEND_PATH_MARKER not in path.lower():
        return False
    if url is not None and not is_codex_backend_url(str(url)):
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
        from hermes_cli.runtime_provider import resolve_runtime_provider
    except Exception as exc:  # pragma: no cover - environment-specific
        raise ProvenanceError(f"hermes_composition_unavailable:{type(exc).__name__}") from exc
    return {
        "resolve_runtime_provider": resolve_runtime_provider,
        "resolve_provider_client": resolve_provider_client,
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


def _record_request(request: Any, sink: dict[str, Any]) -> None:
    url_obj = _field(request, "url")
    url = str(url_obj) if url_obj is not None else ""
    if not url:
        return
    if sink.get("request_url"):
        return
    try:
        parsed = urlparse(url)
    except ValueError:
        return
    sink["request_url"] = url
    sink["host"] = (parsed.hostname or "").lower().rstrip(".")
    sink["path"] = (parsed.path or "").lower()
    sink["scheme"] = (parsed.scheme or "").lower()


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


@contextmanager
def capture_codex_transport(client: Any) -> Iterator[dict[str, Any]]:
    """Instrument this call's transport client; restore after. Concurrent-safe.

    Capture is bound with a contextvar so concurrent invokes cannot cross-bind.
    The httpx ``send`` hook is refcounted per client object and restored when
    the last in-flight call on that client exits. TLS verify is not touched.
    """
    sink: dict[str, Any] = {
        "request_url": None,
        "host": None,
        "path": None,
        "scheme": None,
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
                if current is not None:
                    _record_request(request, current)
                return original(request, *args, **kwargs)

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
    with capture_codex_transport(client) as transport:
        try:
            event_stream = client.responses.create(**stream_kwargs)
        except ProvenanceError:
            raise
        except Exception as exc:
            raise ProvenanceError(f"codex_stream_create:{type(exc).__name__}") from exc
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

        if not captured_transport_is_codex(transport):
            raise ProvenanceError("not_codex_backend")

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
