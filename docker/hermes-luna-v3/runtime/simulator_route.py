"""Crow's Nest-only HTTP bridge for the isolated Luna v3 API server."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import urllib.error
import urllib.request
import secrets
import time
from pathlib import Path
from contextvars import copy_context
from typing import Any

_RESERVED_PHONE = re.compile(r"^\+346999\d{5,6}$")
_SESSION_HISTORY: dict[str, list[dict[str, Any]]] = {}
_SESSION_OPERATION_OUTCOMES: dict[str, dict[str, dict[str, Any]]] = {}
_CONTINUATIONS: dict[str, dict[str, Any]] = {}


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
    exact = {
        key: _value(message, key)
        for key in ("role", "content", "tool_call_id", "tool_calls")
        if _value(message, key) is not None
    }
    if "content" in exact:
        exact["content_parsed"] = _json_or_text(exact["content"])
    for call in exact.get("tool_calls", []) or []:
        function = _value(call, "function", {}) or {}
        if isinstance(function, dict):
            function["arguments_parsed"] = _json_or_text(function.get("arguments"))
    return exact


def _installed_plugin() -> dict[str, Any]:
    path = Path(__file__).resolve().parents[1] / "plugins" / "luna_v3_staff_api" / "__init__.py"
    raw = path.read_bytes()
    return {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}


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


def _is_write_or_unknown(result: Any) -> bool:
    return isinstance(result, dict) and (
        result.get("ok") is True and result.get("state") in {"offer", "booked", "released"}
        or result.get("outcome") == "unknown"
        or result.get("recoveryStatus") == "unknown"
        or result.get("outcome_unknown") is True
    )


def _apply_operation_evidence(session_id: str, evidence: list[dict[str, Any]], *, force_unresolved: bool = False) -> None:
    ledger = _SESSION_OPERATION_OUTCOMES.setdefault(session_id, {})
    for item in evidence:
        result = item.get("result")
        identity = item.get("identity")
        if not identity and isinstance(result, dict):
            identity = f"operation:{result.get('call_id')}" if result.get("call_id") else None
        if not isinstance(result, dict) or not isinstance(identity, str) or not identity:
            continue
        unknown = (result.get("outcome") == "unknown" or result.get("recoveryStatus") == "unknown"
                   or result.get("outcome_unknown") is True)
        answered = result.get("ok") is True or result.get("outcome") == "rejected" or result.get("recoveryStatus") == "rejected"
        if unknown or answered:
            ledger[identity] = {
                "kind": "command", "identity": identity,
                "status": "unresolved" if force_unresolved or unknown else "resolved",
                "operation": str(item.get("tool") or "staff"),
                "action": item.get("action"), "target": item.get("target"),
                "mutation": item.get("mutation") is True,
                "command_outcome": "unknown" if unknown else ("succeeded" if result.get("ok") is True else "rejected"),
                "offer_reference": result.get("offer_reference"), "sequence": time.monotonic_ns(),
            }
        state = str(result.get("state") or "").lower()
        if result.get("ok") is True and state in {"quote", "offer", "booked", "released"}:
            reference = result.get("offer_reference")
            state_identity = f"state:{reference}" if reference else f"state:{identity}"
            ledger[state_identity] = {
                "kind": "state", "identity": state_identity, "status": "resolved",
                "operation": str(item.get("tool") or "staff"), "staff_state": state,
                "target": item.get("target"),
                "offer_reference": reference, "sequence": time.monotonic_ns(),
            }
    if not ledger:
        _SESSION_OPERATION_OUTCOMES.pop(session_id, None)


def _record_cleanup_truth(session_id: str, offer_reference: str) -> None:
    _apply_operation_evidence(session_id, [{
        "tool": "check_quote_book", "identity": f"operation:cleanup:{offer_reference}",
        "action": "decline", "target": f"offer:{offer_reference}", "mutation": True,
        "result": {"ok": True, "state": "released", "offer_reference": offer_reference},
    }])


def _normalize_phone(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    return f"+{digits}" if digits else ""


def _admit_test_session_sync(session_key: str, phone: str, message_digest: str) -> dict[str, Any]:
    base_url = os.environ.get("LUNA_V3_STAFF_API_BASE_URL", "").strip().rstrip("/")
    token = os.environ.get("LUNA_V3_STAFF_API_TOKEN", "").strip()
    local_harness = os.environ.get("LUNA_V3_AUTHENTIC_HARNESS") == "1" and base_url == "http://staff:3036"
    if (not base_url.startswith("https://") and not local_harness) or not token:
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


def _decline_offer_sync(session_key: str, offer_reference: str, inbound_event_id: str) -> None:
    base_url = os.environ.get("LUNA_V3_STAFF_API_BASE_URL", "").strip().rstrip("/")
    token = os.environ.get("LUNA_V3_STAFF_API_TOKEN", "").strip()
    turn_id = "turn:" + hashlib.sha256((session_key + ":failed-presentation:" + offer_reference).encode()).hexdigest()[:32]
    payload = json.dumps({"tenant_id": "wolfhouse-somo", "session_id": session_key,
        "action": "decline", "offer_reference": offer_reference,
        "external_send_allowed": False, "staff_alert_allowed": False}, separators=(",", ":")).encode()
    req = urllib.request.Request(base_url + "/staff/bot/luna-v3/check-quote-book", data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": "".join(("Be", "arer ", token)), "X-Luna-V3-Turn-Id": turn_id, "X-Luna-V3-Inbound-Event": inbound_event_id}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as response:
        body = json.loads(response.read().decode())
    if not isinstance(body, dict) or body.get("ok") is not True or body.get("state") != "released":
        raise RuntimeError("offer_cleanup_failed")


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

    trace_allowed = _harness_trace_allowed(request)
    fault = getattr(request, "headers", {}).get("X-Luna-V3-Harness-Fault", "") if trace_allowed else ""
    if fault not in {"", "non-json", "malformed", "http-422", "exception", "timeout"}:
        return {"status": 400, "body": {"ok": False, "code": "invalid_harness_fault"}}
    continuation_consumed = False
    continuation_ref = str(body.get("continuation_ref") or "")
    if continuation_ref:
        captured = _CONTINUATIONS.pop(continuation_ref, None)
        if not trace_allowed or not captured or captured["phone"] != phone or captured["expires"] < time.time():
            return {"status": 403, "body": {"ok": False, "code": "continuation_forbidden"}}
        _SESSION_HISTORY[captured["session_id"]] = captured["messages"]
        continuation_consumed = True

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
        from runtime.trusted_turn_context import render_booking_state_constraints, render_capability_constraints
        history = list(_SESSION_HISTORY.get(session_id) or [])
        capability_constraints = "\n\n".join((
            render_capability_constraints(admission.get("capability_snapshot")),
            render_booking_state_constraints(history, _SESSION_OPERATION_OUTCOMES.get(session_id)),
        ))
    except (ImportError, ValueError):
        return {"status": 503, "body": {"ok": False, "code": "simulator_capability_snapshot_missing"}}
    agent = adapter._create_agent(
        session_id=session_id,
        gateway_session_key=session_key,
        ephemeral_system_prompt=capability_constraints,
    )
    tokens = adapter._bind_api_server_session(session_key=session_key)
    from runtime.trusted_turn_context import (bind_inbound_event, clear_inbound_event,
        bind_harness_evidence, clear_harness_evidence, bind_operation_evidence, clear_operation_evidence)
    inbound_token = bind_inbound_event(inbound_event_id, admission.get("capability_snapshot"), session_id)
    staff_exchanges: list[dict[str, Any]] = []
    operation_evidence: list[dict[str, Any]] = []
    harness_tokens = bind_harness_evidence(staff_exchanges if trace_allowed else None, fault)
    operation_token = bind_operation_evidence(operation_evidence)
    ctx = copy_context()
    clear_inbound_event(inbound_token)
    clear_harness_evidence(harness_tokens)
    clear_operation_evidence(operation_token)

    def run_agent() -> Any:
        return ctx.run(
            agent.run_conversation,
            user_message=text,
            conversation_history=history,
            task_id=session_id,
        )

    try:
        try:
            result = await asyncio.get_running_loop().run_in_executor(None, run_agent)
        except Exception:
            writes = [item for item in operation_evidence
                      if item.get("tool") == "check_quote_book"
                      and _is_write_or_unknown(item.get("result"))]
            if writes:
                _apply_operation_evidence(session_id, writes, force_unresolved=True)
                return {"status": 502, "body": {"ok": False, "code": "agent_failed_after_staff_write"}}
            return {"status": 502, "body": {"ok": False, "code": "agent_failed"}}
    finally:
        try:
            from gateway.session_context import clear_session_vars

            clear_session_vars(tokens)
        except ImportError:
            pass
    failed = result.get("failed") if isinstance(result, dict) else getattr(result, "failed", False)
    if failed:
        writes = [item for item in operation_evidence if _is_write_or_unknown(item.get("result"))]
        if writes:
            _apply_operation_evidence(session_id, writes, force_unresolved=True)
            return {"status": 502, "body": {"ok": False, "code": "agent_failed_after_staff_write"}}
        return {"status": 502, "body": {"ok": False, "code": "agent_failed"}}
    reply = str(_value(result, "final_response", "") or "")
    messages = _value(result, "messages", [])
    tool_calls = _project_tool_calls(messages)
    if not reply.strip():
        writes = [item for item in operation_evidence if _is_write_or_unknown(item.get("result"))]
        if writes:
            _apply_operation_evidence(session_id, writes, force_unresolved=True)
            return {"status": 502, "body": {"ok": False, "code": "formatter_failed_after_staff_write"}}
        return {"status": 502, "body": {"ok": False, "code": "missing_reply"}}
    offers = [call.get("result_summary", {}).get("offer_reference") for call in tool_calls
              if call.get("name") == "check_quote_book" and isinstance(call.get("result_summary"), dict)
              and call["result_summary"].get("state") == "offer"]
    try:
        for offer_reference in filter(None, offers):
            await asyncio.to_thread(_record_offer_presented_sync, session_key, offer_reference, reply.strip(), inbound_event_id)
    except Exception:
        try:
            for offer_reference in dict.fromkeys(offers):
                await asyncio.to_thread(_decline_offer_sync, session_key, offer_reference, inbound_event_id)
                _record_cleanup_truth(session_id, offer_reference)
        except Exception:
            reference = next(iter(dict.fromkeys(offers)), None)
            if reference:
                _apply_operation_evidence(session_id, [{
                    "tool": "check_quote_book", "identity": f"operation:cleanup:{reference}",
                    "action": "decline", "target": f"offer:{reference}", "mutation": True,
                    "result": {"outcome": "unknown", "offer_reference": reference},
                }])
            return {"status": 502, "body": {"ok": False, "code": "offer_state_unknown"}}
        return {"status": 502, "body": {"ok": False, "code": "offer_presentation_record_failed"}}
    if isinstance(messages, list):
        _SESSION_HISTORY[session_id] = messages
    _apply_operation_evidence(session_id, operation_evidence)
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
            "untruncated": True,
            "final_response": reply.strip(),
            "staff_http_exchanges": staff_exchanges,
            "installed_plugin": _installed_plugin(),
            "runtime_readback": {"provider": os.environ.get("HERMES_MODEL_PROVIDER"),
                "model": os.environ.get("HERMES_MODEL"), "reasoning": os.environ.get("HERMES_REASONING_EFFORT"),
                "temperature": os.environ.get("HERMES_TEMPERATURE", "provider-default"),
                "fallback": os.environ.get("HERMES_FALLBACK_MODEL", "")},
            "continuation_consumed": continuation_consumed,
            "inbound_event_id": inbound_event_id,
            "admission": admission,
        }
        if body.get("capture_continuation") is True:
            reference = secrets.token_urlsafe(32)
            _CONTINUATIONS[reference] = {"phone": phone, "session_id": session_id,
                "messages": list(messages), "expires": time.time() + 900}
            response_body["continuation_ref"] = reference
    return {"status": 200, "body": response_body}


def register_simulator_route(app: Any, adapter: Any) -> None:
    from aiohttp import web

    async def route(request: Any) -> Any:
        result = await handle_turn(request, adapter)
        if "response" in result:
            return result["response"]
        return web.json_response(result["body"], status=result["status"])

    async def preflight(request: Any) -> Any:
        if adapter._check_auth(request) is not None or not _harness_trace_allowed(request):
            return web.json_response({"ok": False, "code": "harness_forbidden"}, status=403)
        body = await request.json()
        sha = str(body.get("candidate_sha") or "")
        phone = "+34699999999"
        key = "luna-v3:" + hashlib.sha256(phone.encode()).hexdigest()[:24]
        try:
            admission = await _admit_test_session(key, phone, hashlib.sha256(("preflight:" + sha).encode()).hexdigest())
        except Exception:
            return web.json_response({"ok": False, "code": "staff_preflight_failed"}, status=503)
        settings = {"provider": os.environ.get("HERMES_MODEL_PROVIDER"), "model": os.environ.get("HERMES_MODEL"),
            "reasoning": os.environ.get("HERMES_REASONING_EFFORT"), "temperature": os.environ.get("HERMES_TEMPERATURE", "provider-default"),
            "fallback": os.environ.get("HERMES_FALLBACK_MODEL", "")}
        plugin = _installed_plugin()
        return web.json_response({"ok": True, "effective_model": settings, "fallback_possible": settings["fallback"] != "",
            "staff_admission": admission, "pins": {"candidate_sha": sha,
            "image_digest": os.environ.get("LUNA_V3_IMAGE_DIGEST"), "base_image_digest": os.environ.get("LUNA_V3_BASE_IMAGE_DIGEST"),
            "instruction_sha256": os.environ.get("LUNA_V3_INSTRUCTION_SHA256"), "plugin_sha256": plugin["sha256"],
            "contract_sha256": os.environ.get("LUNA_V3_CONTRACT_SHA256")}})

    async def state(request: Any) -> Any:
        if adapter._check_auth(request) is not None or not _harness_trace_allowed(request):
            return web.json_response({"ok": False, "code": "harness_forbidden"}, status=403)
        body = await request.json()
        phone = _normalize_phone(body.get("thread"))
        if not _RESERVED_PHONE.fullmatch(phone):
            return web.json_response({"ok": False, "code": "clone_phone_out_of_range"}, status=400)
        # Admission owns the isolated TEST principal/database state readback.
        key = "luna-v3:" + hashlib.sha256(phone.encode()).hexdigest()[:24]
        admission = await _admit_test_session(key, phone, hashlib.sha256(b"harness-state").hexdigest())
        staff_state = admission.get("staff_state") if isinstance(admission, dict) else None
        required = ("booking_count", "hold_count", "payment_count", "external_send_count", "staff_alert_count")
        if (not isinstance(staff_state, dict) or staff_state.get("ok") is False
                or any(type(staff_state.get(field)) is not int or staff_state[field] < 0 for field in required)):
            return web.json_response({"ok": False, "code": "staff_state_readback_missing"}, status=503)
        return web.json_response({**staff_state, "ok": True, "schema": "luna-v3-test-state/v1",
            "authenticated": True, "tenant": "wolfhouse-somo", "thread": phone})

    app.router.add_post("/wolfhouse/simulate-guest-turn", route)
    app.router.add_post("/wolfhouse/luna-v3-harness/preflight", preflight)
    app.router.add_post("/wolfhouse/luna-v3-harness/state", state)
