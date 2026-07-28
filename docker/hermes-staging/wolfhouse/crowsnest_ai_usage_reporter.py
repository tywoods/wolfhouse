"""Fail-open Sunset Hermes AI-usage observer; never handles conversation content."""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Mapping

ENV_NAMES = (
    "CROWSNEST_AI_USAGE_INGEST_URL",
    "CROWSNEST_AI_USAGE_INGEST_TOKEN",
    "CROWSNEST_AI_USAGE_CLIENT_SLUG",
    "CROWSNEST_AI_USAGE_TENANT_ID",
    "CROWSNEST_AI_USAGE_SOURCE_SERVICE",
)
MAX_HTTP_TIMEOUT_SECONDS = 2.0
_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$")


def read_config(env: Mapping[str, str] = os.environ):
    values = {name: str(env.get(name, "")).strip() for name in ENV_NAMES}
    if not all(values.values()):
        return None
    if not all(_SAFE.fullmatch(values[n]) for n in ENV_NAMES[2:]):
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
    input_tokens = _own(usage, "input_tokens")
    output_tokens = _own(usage, "output_tokens")
    if input_tokens is None:
        input_tokens = _own(usage, "prompt_tokens")
    if output_tokens is None:
        output_tokens = _own(usage, "completion_tokens")
    total_tokens = _own(usage, "total_tokens")
    valid = all(type(v) is int and 0 <= v <= 9007199254740991 for v in (input_tokens, output_tokens, total_tokens))
    if not valid or input_tokens + output_tokens != total_tokens:
        return {"availability": "unavailable"}
    return {"availability": "measured", "input_tokens": input_tokens, "output_tokens": output_tokens, "total_tokens": total_tokens}


def _base(model: str, latency_ms: int, env: Mapping[str, str], cost=None):
    cfg = read_config(env)
    if cfg is None or not isinstance(model, str) or not _SAFE.fullmatch(model):
        return None
    normalized_cost = {"state": "unavailable"}
    if isinstance(cost, dict):
        state = cost.get("state")
        if state == "unavailable" and set(cost) == {"state"}:
            normalized_cost = {"state": "unavailable"}
        elif state in ("provider_reported", "estimated") and set(cost) == {"state", "amount_micros", "currency"}:
            amount, currency = cost.get("amount_micros"), cost.get("currency")
            if type(amount) is int and amount >= 0 and isinstance(currency, str) and re.fullmatch(r"[A-Z]{3}", currency):
                normalized_cost = {"state": state, "amount_micros": amount, "currency": currency}
    return {
        "schema_version": "crowsnest.ai_usage.v1",
        "event_id": f"evt_{uuid.uuid4().hex}",
        "occurred_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "client_slug": cfg[ENV_NAMES[2]], "tenant_id": cfg[ENV_NAMES[3]],
        "source_service": cfg[ENV_NAMES[4]], "operation": "guest_reply",
        "provider": "openai", "model": model,
        "latency_ms": max(0, int(latency_ms)), "cost": normalized_cost,
    }


def build_success_event(raw_response: Any, latency_ms: int, *, cost=None, env=os.environ):
    event = _base(_own(raw_response, "model"), latency_ms, env, cost)
    if event is None: return None
    event.update(status="succeeded", tokens=_tokens(raw_response))
    return event


def build_failure_event(model: str, latency_ms: int, error_code: str, *, cost=None, env=os.environ):
    event = _base(model, latency_ms, env, {"state": "unavailable"})
    if event is None or not isinstance(error_code, str) or not _SAFE.fullmatch(error_code): return None
    event.update(status="failed", error_code=error_code, tokens={"availability": "unavailable"})
    return event


def _post(event, env):
    cfg = read_config(env)
    if cfg is None or event is None: return
    try:
        request = urllib.request.Request(cfg[ENV_NAMES[0]], data=json.dumps(event, separators=(",", ":")).encode(), headers={"Content-Type":"application/json", "Authorization":f"Bearer {cfg[ENV_NAMES[1]]}"}, method="POST")
        with urllib.request.urlopen(request, timeout=MAX_HTTP_TIMEOUT_SECONDS):
            pass
    except (Exception, socket.timeout, urllib.error.URLError):
        pass


def report_success(raw_response, latency_ms, *, cost=None, env=os.environ):
    try: _post(build_success_event(raw_response, latency_ms, cost=cost, env=env), env)
    except Exception: pass
    return None


def report_failure(model, latency_ms, error_code, *, cost=None, env=os.environ):
    try: _post(build_failure_event(model, latency_ms, error_code, cost=cost, env=env), env)
    except Exception: pass
    return None


def _daemon(target, *args, **kwargs):
    try: threading.Thread(target=target, args=args, kwargs=kwargs, daemon=True, name="crowsnest-ai-usage").start()
    except Exception: pass
    return None


def report_success_daemon(*args, **kwargs): return _daemon(report_success, *args, **kwargs)
def report_failure_daemon(*args, **kwargs): return _daemon(report_failure, *args, **kwargs)


def _classify(exc):
    if isinstance(exc, (TimeoutError, socket.timeout)): return "provider_timeout"
    status = getattr(exc, "status_code", None)
    if status == 401: return "provider_auth"
    if isinstance(status, int) and status >= 500: return "provider_unavailable"
    return "provider_error"


def observe_provider_attempt(call, *, model, env=os.environ):
    if env.get("HERMES_ROLE") != "sunset-luna": return call()
    started = time.monotonic()
    try:
        response = call()
    except Exception as exc:
        report_failure_daemon(model, round((time.monotonic()-started)*1000), _classify(exc), env=env)
        raise
    report_success_daemon(response, round((time.monotonic()-started)*1000), env=env)
    return response
