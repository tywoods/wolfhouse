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


def _harness_trace_allowed(request: Any) -> bool:
    """Dual-gated evidence seam; inert unless the isolated harness is enabled."""
    if os.environ.get("LUNA_V3_AUTHENTIC_HARNESS", "") != "1":
        return False
    expected = os.environ.get("LUNA_V3_HARNESS_TRACE_TOKEN", "")
    supplied = getattr(request, "headers", {}).get("X-Luna-V3-Harness-Trace", "")
    return bool(expected) and supplied == expected


def _trace_message(message: Any) -> dict[str, Any]:
    return {
        key: _json_or_text(_value(message, key))
        for key in ("role", "content", "tool_call_id", "tool_calls")
        if _value(message, key) is not None
    }


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


def _admit_test_session_sync(session_key: str, phone: str, message_digest: str) -> dict[str, Any]:
    base_url = os.environ.get("LUNA_V3_STAFF_API_BASE_URL", "").strip().rstrip("/")
    token = os.environ.get("LUNA_V3_STAFF_API_TOKEN", "").strip()
    if not base_url.startswith("https://") or not token:
        raise RuntimeError("simulator_session_admission_not_configured")
    payload = json.dumps({
        "tenant_id": "wolfhouse-somo",
        "session_id": session_key,
        "guest_phone": phone,
        "message_digest": message_digest,
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


def _record_offer_presented_sync(session_key: str, offer_reference: str, reply: str, inbound_event_id: str) -> None:
    base_url = os.environ.get("LUNA_V3_STAFF_API_BASE_URL", "").strip().rstrip("/")
    token = os.environ.get("LUNA_V3_STAFF_API_TOKEN", "").strip()
    turn_id = "turn:" + hashlib.sha256((session_key + ":presented:" + reply).encode()).hexdigest()[:32]
    payload = json.dumps({"tenant_id": "wolfhouse-somo", "session_id": session_key,
        "offer_reference": offer_reference, "assistant_reply": reply,
        "external_send_allowed": False, "staff_alert_allowed": False}, separators=(",", ":")).encode()
    req = urllib.request.Request(base_url + "/staff/bot/luna-v3/record-offer-presentation", data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": "".join(("Be", "arer ", token)), "X-Luna-V3-Turn-Id": turn_id, "X-Luna-V3-Inbound-Event": inbound_event_id}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as response:
        body = json.loads(response.read().decode())
    if not isinstance(body, dict) or body.get("recorded") is not True:
        raise RuntimeError("offer_presentation_record_failed")


async def _admit_test_session(session_key: str, phone: str, message_digest: str) -> dict[str, Any]:
    return await asyncio.to_thread(_admit_test_session_sync, session_key, phone, message_digest)


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
        admission = await (admit_session or _admit_test_session)(session_key, phone, hashlib.sha256(text.encode()).hexdigest())
    except Exception:
        return {"status": 503, "body": {"ok": False, "code": "simulator_session_admission_failed"}}
    if not isinstance(admission, dict) or admission.get("admitted") is not True:
        return {"status": 503, "body": {"ok": False, "code": "simulator_session_admission_refused"}}
    inbound_event_id = str(admission.get("inbound_event_id") or "").strip()
    if not inbound_event_id:
        return {"status": 503, "body": {"ok": False, "code": "simulator_inbound_event_missing"}}
    try:
        from runtime.trusted_turn_context import render_capability_constraints
        capability_constraints = render_capability_constraints(admission.get("capability_snapshot"))
    except (ImportError, ValueError):
        return {"status": 503, "body": {"ok": False, "code": "simulator_capability_snapshot_missing"}}
    agent = adapter._create_agent(
        session_id=session_id,
        gateway_session_key=session_key,
        ephemeral_system_prompt=capability_constraints,
    )
    tokens = adapter._bind_api_server_session(session_key=session_key)
    from runtime.trusted_turn_context import bind_inbound_event, clear_inbound_event
    inbound_token = bind_inbound_event(inbound_event_id, admission.get("capability_snapshot"))
    ctx = copy_context()
    clear_inbound_event(inbound_token)

    def run_agent() -> Any:
        return ctx.run(
            agent.run_conversation,
            user_message=text,
            conversation_history=list(_SESSION_HISTORY.get(session_id) or []),
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
    offers = [call.get("result_summary", {}).get("offer_reference") for call in tool_calls
              if call.get("name") == "check_quote_book" and isinstance(call.get("result_summary"), dict)
              and call["result_summary"].get("state") == "offer"]
    try:
        for offer_reference in filter(None, offers):
            await asyncio.to_thread(_record_offer_presented_sync, session_key, offer_reference, reply.strip(), inbound_event_id)
    except Exception:
        return {"status": 502, "body": {"ok": False, "code": "offer_presentation_record_failed"}}
    response_body = {
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
        }
    if _harness_trace_allowed(request):
        response_body["harness_trace"] = {
            "messages": [_trace_message(message) for message in messages] if isinstance(messages, list) else [],
            "inbound_event_id": inbound_event_id,
            "admission": admission,
        }
    return {"status": 200, "body": response_body}


def register_simulator_route(app: Any, adapter: Any) -> None:
    from aiohttp import web

    async def route(request: Any) -> Any:
        result = await handle_turn(request, adapter)
        if "response" in result:
            return result["response"]
        return web.json_response(result["body"], status=result["status"])

    app.router.add_post("/wolfhouse/simulate-guest-turn", route)
