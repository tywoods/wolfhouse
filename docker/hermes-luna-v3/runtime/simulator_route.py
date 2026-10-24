"""Crow's Nest-only HTTP bridge for the isolated Luna v3 API server."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from contextvars import copy_context
from typing import Any

_RESERVED_PHONE = re.compile(r"^\+346999\d{5,6}$")
_SESSION_HISTORY: dict[str, list[dict[str, Any]]] = {}


def _value(source: Any, name: str, default: Any = None) -> Any:
    return source.get(name, default) if isinstance(source, dict) else getattr(source, name, default)


def _json_or_text(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value


def _project_tool_calls(messages: Any) -> list[dict[str, Any]]:
    if not isinstance(messages, list):
        return []
    start = max(
        (index for index, message in enumerate(messages) if _value(message, "role") == "user"),
        default=-1,
    )
    current = messages[start + 1:]
    results = {
        _value(message, "tool_call_id"): _json_or_text(_value(message, "content"))
        for message in current
        if _value(message, "role") == "tool" and _value(message, "tool_call_id")
    }
    projected: list[dict[str, Any]] = []
    for message in current:
        if _value(message, "role") != "assistant":
            continue
        for call in _value(message, "tool_calls", []) or []:
            function = _value(call, "function", {}) or {}
            call_id = _value(call, "id")
            name = _value(function, "name") or _value(call, "name")
            if not name:
                continue
            projected.append({
                "name": name,
                "args": _json_or_text(_value(function, "arguments", _value(call, "arguments", {}))) or {},
                "result_summary": results.get(call_id),
            })
    return projected


def _normalize_phone(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    return f"+{digits}" if digits else ""


def _admit_test_session_sync(session_key: str, phone: str) -> dict[str, Any]:
    base_url = os.environ.get("LUNA_V3_STAFF_API_BASE_URL", "").strip().rstrip("/")
    token = os.environ.get("LUNA_V3_STAFF_API_TOKEN", "").strip()
    if not base_url.startswith("https://") or not token:
        raise RuntimeError("simulator_session_admission_not_configured")
    payload = json.dumps({
        "tenant_id": "wolfhouse-somo",
        "session_id": session_key,
        "guest_phone": phone,
        "external_send_allowed": False,
        "staff_alert_allowed": False,
    }, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        base_url + "/staff/bot/luna-v3/admit-simulator-session",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": "".join(("Be", "arer ", token)),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise RuntimeError("simulator_session_admission_failed") from exc
    if not isinstance(body, dict) or body.get("ok") is not True or body.get("admitted") is not True:
        raise RuntimeError("simulator_session_admission_refused")
    return body


async def _admit_test_session(session_key: str, phone: str) -> dict[str, Any]:
    return await asyncio.to_thread(_admit_test_session_sync, session_key, phone)


async def handle_turn(request: Any, adapter: Any, admit_session: Any = None) -> dict[str, Any]:
    auth_error = adapter._check_auth(request)
    if auth_error is not None:
        return {"status": getattr(auth_error, "status", 401), "response": auth_error}
    try:
        body = await request.json()
    except Exception:
        return {"status": 400, "body": {"ok": False, "code": "invalid_json"}}
    if not isinstance(body, dict):
        return {"status": 400, "body": {"ok": False, "code": "invalid_payload"}}
    if body.get("allow_writes") is True or body.get("external_send_allowed") is True:
        return {"status": 400, "body": {"ok": False, "code": "caller_write_authority_denied"}}

    phone = _normalize_phone(body.get("thread") or body.get("guest_phone"))
    if not _RESERVED_PHONE.fullmatch(phone):
        return {"status": 400, "body": {"ok": False, "code": "clone_phone_out_of_range"}}
    text = str(body.get("text") or body.get("message_text") or "").strip()
    if not text:
        return {"status": 400, "body": {"ok": False, "code": "message_required"}}

    digest = hashlib.sha256(phone.encode()).hexdigest()[:24]
    session_key = f"luna-v3:{digest}"
    session_id = f"luna-v3-{digest}"
    try:
        admission = await (admit_session or _admit_test_session)(session_key, phone)
    except Exception:
        return {"status": 503, "body": {"ok": False, "code": "simulator_session_admission_failed"}}
    if not isinstance(admission, dict) or admission.get("admitted") is not True:
        return {"status": 503, "body": {"ok": False, "code": "simulator_session_admission_refused"}}
    agent = adapter._create_agent(
        session_id=session_id,
        gateway_session_key=session_key,
    )
    tokens = adapter._bind_api_server_session(session_key=session_key)
    ctx = copy_context()

    def run_agent() -> Any:
        return ctx.run(
            agent.run_conversation,
            user_message=text,
            conversation_history=_SESSION_HISTORY.get(session_id),
            task_id=session_id,
        )

    try:
        result = await asyncio.get_running_loop().run_in_executor(None, run_agent)
    finally:
        try:
            from gateway.session_context import clear_session_vars

            clear_session_vars(tokens)
        except ImportError:
            pass
    failed = result.get("failed") if isinstance(result, dict) else getattr(result, "failed", False)
    error = result.get("error") if isinstance(result, dict) else getattr(result, "error", None)
    if failed:
        return {"status": 502, "body": {"ok": False, "code": "agent_failed", "error": str(error or "agent failed")}}
    reply = result.get("final_response", "") if isinstance(result, dict) else getattr(result, "final_response", "")
    if not reply.strip():
        return {"status": 502, "body": {"ok": False, "code": "missing_reply"}}
    messages = _value(result, "messages", [])
    if isinstance(messages, list):
        _SESSION_HISTORY[session_id] = messages
    tool_calls = _project_tool_calls(messages)
    return {
        "status": 200,
        "body": {
            "ok": True,
            "reply_text": reply.strip(),
            "thread": phone,
            "guest_phone": phone,
            "session_id": session_id,
            "tool_calls": tool_calls,
            "warnings": [],
            "effective_capability": {
                "capability": "wolfhouse_staging_booking_test_link",
                "admitted": True,
                "reasons": [],
                "outcome": "ADMITTED",
            },
            "whatsapp_suppressed": True,
            "external_send_allowed": False,
            "staff_alert_allowed": False,
        },
    }


def register_simulator_route(app: Any, adapter: Any) -> None:
    from aiohttp import web

    async def route(request: Any) -> Any:
        result = await handle_turn(request, adapter)
        if "response" in result:
            return result["response"]
        return web.json_response(result["body"], status=result["status"])

    app.router.add_post("/wolfhouse/simulate-guest-turn", route)
