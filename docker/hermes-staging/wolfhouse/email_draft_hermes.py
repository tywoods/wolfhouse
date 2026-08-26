"""Narrow wrapper around the installed Hermes openai-codex composition.

Does not use the CLI. Does not stamp config.yaml or caller labels as
provenance. The live terminal Responses event's ``model`` plus
``resolve_runtime_provider()`` for this attempt are the only accepted
provider/model source.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Callable
from urllib.parse import urlparse

from wolfhouse.email_draft_contract import (
    LIVE_ATTEMPT_SOURCE,
    MODEL,
    PROVIDER,
    AttemptResult,
)

CODEX_BACKEND_HOST = "chatgpt.com"
CODEX_BACKEND_PATH_MARKER = "/backend-api/codex"
HERMES_PACKAGE_ROOTS = (
    os.environ.get("HERMES_PACKAGE_ROOT") or "",
    "/opt/hermes",
)


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
    return host == CODEX_BACKEND_HOST and CODEX_BACKEND_PATH_MARKER in path


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


def invoke_installed_hermes(
    system: str,
    user: str,
    *,
    composition: dict[str, Any] | None = None,
    timeout_s: float = 20,
) -> AttemptResult:
    """Call the installed Hermes openai-codex composition for one attempt."""
    if not isinstance(system, str) or not isinstance(user, str):
        raise ProvenanceError("invalid_prompt")
    loaded = composition or load_installed_hermes()
    resolve_runtime = loaded.get("resolve_runtime_provider")
    resolve_client = loaded.get("resolve_provider_client")
    consume = loaded.get("consume_codex_event_stream")
    if not callable(resolve_runtime) or not callable(resolve_client) or not callable(consume):
        raise ProvenanceError("hermes_composition_unavailable")

    runtime = resolve_runtime()
    if not isinstance(runtime, dict):
        raise ProvenanceError("runtime_resolution_invalid")
    selected_provider = runtime.get("provider")
    if selected_provider != PROVIDER:
        raise ProvenanceError("runtime_provider_mismatch")

    client_pair = resolve_client(selected_provider, MODEL, raw_codex=True)
    if not isinstance(client_pair, tuple) or len(client_pair) != 2:
        raise ProvenanceError("codex_client_unavailable")
    client, selected_model = client_pair
    if client is None:
        raise ProvenanceError("codex_client_unavailable")
    if selected_model != MODEL:
        raise ProvenanceError("runtime_model_mismatch")
    base_url = getattr(client, "base_url", None)
    if not is_codex_backend_url(base_url):
        raise ProvenanceError("not_codex_backend")

    captured, on_event = capture_terminal_model()
    stream_kwargs = {
        "model": MODEL,
        "instructions": system,
        "input": [{"role": "user", "content": user}],
        "store": False,
        "stream": True,
        "timeout": timeout_s,
    }
    try:
        event_stream = client.responses.create(**stream_kwargs)
    except Exception as exc:
        raise ProvenanceError(f"codex_stream_create:{type(exc).__name__}") from exc
    try:
        final = consume(event_stream, model=MODEL, on_event=on_event)
    except ProvenanceError:
        raise
    except Exception as exc:
        raise ProvenanceError(f"codex_stream_consume:{type(exc).__name__}") from exc
    finally:
        close_fn = getattr(event_stream, "close", None)
        if callable(close_fn):
            try:
                close_fn()
            except Exception:
                pass

    live_model = captured.get("model")
    if not isinstance(live_model, str) or not live_model.strip():
        raise ProvenanceError("live_model_unavailable")
    live_model = live_model.strip()
    if live_model != MODEL:
        raise ProvenanceError("live_model_mismatch")
    if captured.get("event_type") != "response.completed":
        raise ProvenanceError("codex_stream_incomplete")

    content = _extract_content(final)
    if not content:
        raise ProvenanceError("empty_completion")

    return AttemptResult(
        content=content,
        provider=selected_provider,
        model=live_model,
        source=LIVE_ATTEMPT_SOURCE,
    )
