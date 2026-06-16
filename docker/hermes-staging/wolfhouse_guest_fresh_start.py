"""Wolfhouse guest Fresh Start — delete or rotate Hermes gateway sessions for a WhatsApp guest."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

FRESH_START_PATH = "/wolfhouse/guest-fresh-start"

_WHATSAPP_SOURCES = ("whatsapp_cloud", "whatsapp")
_MEMORY_FILES = ("USER.md", "USER.md.lock", "MEMORY.md", "MEMORY.md.lock")


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


def _runner():
    try:
        from gateway.run import _wolfhouse_gateway_runner  # noqa: WPS433
    except ImportError:
        return None
    return _wolfhouse_gateway_runner


def _session_source(digits: str):
    from gateway.config import Platform
    from gateway.session import SessionSource

    return SessionSource(
        platform=Platform.WHATSAPP_CLOUD,
        user_id=digits,
        chat_id=digits,
        chat_type="dm",
    )


def _list_whatsapp_session_ids(db, digits: str) -> List[str]:
    """Return all state.db session ids for this WhatsApp user."""
    ids: List[str] = []
    if db is None:
        return ids
    conn = getattr(db, "_conn", None)
    lock = getattr(db, "_lock", None)
    if conn is None:
        return ids

    def _query() -> None:
        for src in _WHATSAPP_SOURCES:
            try:
                rows = conn.execute(
                    "SELECT id FROM sessions WHERE user_id = ? AND source = ?",
                    (digits, src),
                ).fetchall()
            except Exception:
                continue
            for row in rows:
                sid = row[0] if not hasattr(row, "keys") else row["id"]
                if sid and sid not in ids:
                    ids.append(str(sid))

    if lock is not None:
        with lock:
            _query()
    else:
        _query()
    return ids


def _memories_dir() -> Path:
    home = Path(os.getenv("HERMES_HOME", "/opt/data"))
    return home / "memories"


def clear_luna_agent_memories() -> Dict[str, Any]:
    """Remove shared agent memory files so guest-specific facts do not persist."""
    memories_dir = _memories_dir()
    cleared: List[str] = []
    if not memories_dir.is_dir():
        return {"cleared": cleared, "memories_dir": str(memories_dir)}
    for name in _MEMORY_FILES:
        path = memories_dir / name
        if not path.exists():
            continue
        try:
            path.unlink()
            cleared.append(name)
        except Exception:
            continue
    return {"cleared": cleared, "memories_dir": str(memories_dir)}


def _purge_runner_state(runner, session_key: str) -> None:
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

    runner._session_model_overrides.pop(session_key, None)  # noqa: SLF001
    runner._set_session_reasoning_override(session_key, None)  # noqa: SLF001
    if hasattr(runner, "_pending_model_notes"):
        runner._pending_model_notes.pop(session_key, None)  # noqa: SLF001
    runner._clear_session_boundary_security_state(session_key)  # noqa: SLF001


def delete_guest_agent_sessions(guest_phone: str) -> Dict[str, Any]:
    """Hard-delete all WhatsApp sessions + messages for this guest in state.db."""
    digits = _digits_phone(guest_phone)
    if not digits:
        return {"ok": False, "reason": "invalid_phone"}

    runner = _runner()
    if runner is None:
        return {"ok": False, "reason": "gateway_not_ready"}

    source = _session_source(digits)
    session_key = runner._session_key_for_source(source)  # noqa: SLF001
    store = runner.session_store
    db = getattr(store, "_db", None)
    sessions_dir = getattr(store, "sessions_dir", None)

    deleted_ids: List[str] = []
    if db is not None:
        for sid in _list_whatsapp_session_ids(db, digits):
            try:
                if db.delete_session(sid, sessions_dir):
                    deleted_ids.append(sid)
            except Exception:
                continue

    old_session_id: Optional[str] = None
    store._ensure_loaded()  # noqa: SLF001
    if session_key in store._entries:  # noqa: SLF001
        old_entry = store._entries.get(session_key)  # noqa: SLF001
        old_session_id = old_entry.session_id if old_entry else None
        with store._lock:  # noqa: SLF001
            store._entries.pop(session_key, None)  # noqa: SLF001
            store._save()  # noqa: SLF001

    _purge_runner_state(runner, session_key)

    memories_cleared = clear_luna_agent_memories()

    return {
        "ok": True,
        "reset": True,
        "hard_delete": True,
        "session_key": session_key,
        "old_session_id": old_session_id,
        "deleted_session_ids": deleted_ids,
        "deleted_count": len(deleted_ids),
        "memories_cleared": memories_cleared,
    }


def rotate_guest_session(guest_phone: str) -> Dict[str, Any]:
    """Legacy rotate: new session id but old SQLite rows may remain."""
    digits = _digits_phone(guest_phone)
    if not digits:
        return {"ok": False, "reason": "invalid_phone"}

    runner = _runner()
    if runner is None:
        return {"ok": False, "reason": "gateway_not_ready"}

    source = _session_source(digits)
    session_key = runner._session_key_for_source(source)  # noqa: SLF001

    store = runner.session_store
    store._ensure_loaded()  # noqa: SLF001
    if session_key not in store._entries:  # noqa: SLF001
        return {
            "ok": True,
            "reset": False,
            "session_key": session_key,
            "reason": "no_session",
        }

    old_entry = store._entries.get(session_key)  # noqa: SLF001
    old_session_id: Optional[str] = old_entry.session_id if old_entry else None

    _purge_runner_state(runner, session_key)

    new_entry = store.reset_session(session_key)  # noqa: SLF001

    memories_cleared = clear_luna_agent_memories()

    return {
        "ok": True,
        "reset": True,
        "hard_delete": False,
        "session_key": session_key,
        "old_session_id": old_session_id,
        "new_session_id": new_entry.session_id if new_entry else None,
        "memories_cleared": memories_cleared,
    }


def reset_guest_session(guest_phone: str, *, hard_delete: bool = True) -> Dict[str, Any]:
    if hard_delete:
        return delete_guest_agent_sessions(guest_phone)
    return rotate_guest_session(guest_phone)


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
        hard_delete = body.get("hard_delete")
        if hard_delete is None:
            hard_delete = body.get("mode", "delete") != "rotate"
        result = reset_guest_session(str(guest_phone), hard_delete=bool(hard_delete))
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
