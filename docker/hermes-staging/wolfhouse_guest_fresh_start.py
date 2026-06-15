"""Wolfhouse guest Fresh Start — reset Hermes session memory for a WhatsApp guest."""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

FRESH_START_PATH = "/wolfhouse/guest-fresh-start"


def _auth_ok(request) -> bool:
    token = (os.getenv("LUNA_BOT_INTERNAL_TOKEN") or "").strip()
    if not token:
        return False
    hdr = request.headers.get("X-Luna-Bot-Token") or request.headers.get("Authorization") or ""
    if hdr.startswith("Bearer "):
        hdr = hdr[7:].strip()
    return hdr == token


def _digits_phone(raw: str) -> str:
    return "".join(ch for ch in str(raw or "") if ch.isdigit())


def reset_guest_session(guest_phone: str) -> Dict[str, Any]:
    """Reset the Hermes gateway session for a WhatsApp Cloud guest (same as /new)."""
    digits = _digits_phone(guest_phone)
    if not digits:
        return {"ok": False, "reason": "invalid_phone"}

    try:
        from gateway.run import _wolfhouse_gateway_runner  # noqa: WPS433
    except ImportError:
        return {"ok": False, "reason": "gateway_patch_missing"}

    runner = _wolfhouse_gateway_runner
    if runner is None:
        return {"ok": False, "reason": "gateway_not_ready"}

    from gateway.config import Platform
    from gateway.session import SessionSource

    source = SessionSource(
        platform=Platform.WHATSAPP_CLOUD,
        user_id=digits,
        chat_id=digits,
        chat_type="dm",
    )
    session_key = runner._session_key_for_source(source)  # noqa: SLF001

    runner.session_store._ensure_loaded()  # noqa: SLF001
    if session_key not in runner.session_store._entries:  # noqa: SLF001
        return {
            "ok": True,
            "reset": False,
            "session_key": session_key,
            "reason": "no_session",
        }

    old_entry = runner.session_store._entries.get(session_key)  # noqa: SLF001
    old_session_id: Optional[str] = old_entry.session_id if old_entry else None

    runner._invalidate_session_run_generation(session_key, reason="fresh_start")  # noqa: SLF001

    _cache_lock = getattr(runner, "_agent_cache_lock", None)
    if _cache_lock is not None:
        with _cache_lock:
            _cached = runner._agent_cache.get(session_key)  # noqa: SLF001
            _old_agent = (
                _cached[0]
                if isinstance(_cached, tuple)
                else _cached
                if _cached
                else None
            )
        if _old_agent is not None:
            runner._cleanup_agent_resources(_old_agent)  # noqa: SLF001

    runner._evict_cached_agent(session_key)  # noqa: SLF001

    _qe = getattr(runner, "_queued_events", None)
    if _qe is not None:
        _qe.pop(session_key, None)

    new_entry = runner.session_store.reset_session(session_key)  # noqa: SLF001
    runner._session_model_overrides.pop(session_key, None)  # noqa: SLF001
    runner._set_session_reasoning_override(session_key, None)  # noqa: SLF001
    if hasattr(runner, "_pending_model_notes"):
        runner._pending_model_notes.pop(session_key, None)  # noqa: SLF001
    runner._clear_session_boundary_security_state(session_key)  # noqa: SLF001

    return {
        "ok": True,
        "reset": True,
        "session_key": session_key,
        "old_session_id": old_session_id,
        "new_session_id": new_entry.session_id if new_entry else None,
    }


def register_fresh_start_route(app) -> None:
    """Register POST /wolfhouse/guest-fresh-start on the WhatsApp webhook aiohttp app."""

    async def _handle_guest_fresh_start(request):
        if not _auth_ok(request):
            return _json_response(401, {"ok": False, "error": "unauthorized"})
        try:
            body = await request.json()
        except Exception:
            return _json_response(400, {"ok": False, "error": "invalid_json"})
        guest_phone = body.get("guest_phone") or body.get("phone") or ""
        result = reset_guest_session(str(guest_phone))
        status = 200 if result.get("ok") else 503
        return _json_response(status, result)

    app.router.add_post(FRESH_START_PATH, _handle_guest_fresh_start)


def _json_response(status: int, payload: Dict[str, Any]):
    from aiohttp import web

    return web.Response(
        status=status,
        text=json.dumps(payload),
        content_type="application/json",
    )
