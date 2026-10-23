"""Crow's Nest-only HTTP bridge for the isolated Luna v3 API server."""

from __future__ import annotations

import asyncio
import hashlib
import re
from contextvars import copy_context
from typing import Any

_RESERVED_PHONE = re.compile(r"^\+346999\d{5,6}$")


def _normalize_phone(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    return f"+{digits}" if digits else ""


async def handle_turn(request: Any, adapter: Any) -> dict[str, Any]:
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
            conversation_history=None,
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
    return {
        "status": 200,
        "body": {
            "ok": True,
            "reply_text": reply.strip(),
            "thread": phone,
            "guest_phone": phone,
            "session_id": session_id,
            "tool_calls": [],
            "warnings": [],
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
