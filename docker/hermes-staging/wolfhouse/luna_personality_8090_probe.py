"""Wolfhouse-only no-send evidence for the existing per-turn personality bind.

This is an authenticated staging diagnostic at hermes-luna (:8090).  It accepts
only a closed server-owned pack ID, reads the installed SOUL, binds that pack as
a fresh WhatsApp turn, and returns a small non-content receipt.  It never calls
Staff, a model, a tool, a WhatsApp adapter, or a persistence owner.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Optional

from wolfhouse.luna_personality import (
    CLOSED_PERSONALITY_IDS,
    INJECTION_MARK,
    apply_personality_to_soul_text,
    bind_whatsapp_turn_personality,
    clear_bound_personality,
)

PROBE_PATH = "/wolfhouse/internal/luna-personality-8090-probe"
WOLFHOUSE_ROLE = "luna"
WOLFHOUSE_SLUG = "wolfhouse-somo"
INSTALLED_SOUL_PATH = Path("/etc/hermes-staging/SOUL.md")


class ProbeRefusal(RuntimeError):
    """Safe reason for a denied no-send probe request."""


def _is_wolfhouse_8090_identity() -> bool:
    return (
        (os.getenv("HERMES_ROLE") or "").strip() == WOLFHOUSE_ROLE
        and (os.getenv("LUNA_CLIENT_SLUG") or os.getenv("LUNA_BOT_CLIENT_SLUG") or "").strip()
        == WOLFHOUSE_SLUG
    )


def _require_wolfhouse_8090_identity() -> None:
    if not _is_wolfhouse_8090_identity():
        raise ProbeRefusal("wolfhouse_8090_identity_required")


def _closed_id(value: Any) -> str:
    pid = str(value or "").strip().lower()
    if pid not in CLOSED_PERSONALITY_IDS:
        raise ProbeRefusal("invalid_personality_id")
    return pid


def run_no_send_injection_probe(
    personality_id: Any,
    *,
    soul_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Exercise one isolated in-memory bind/inject cycle and return no prompt text."""
    _require_wolfhouse_8090_identity()
    pid = _closed_id(personality_id)
    path = soul_path or INSTALLED_SOUL_PATH
    try:
        soul = path.read_text(encoding="utf-8")
    except Exception as exc:
        raise ProbeRefusal("installed_soul_unavailable") from exc

    clear_bound_personality()
    try:
        bound = bind_whatsapp_turn_personality(
            SimpleNamespace(platform=SimpleNamespace(value="whatsapp_cloud")),
            fetch_setting=lambda _tenant: {"personality_id": pid},
        )
        prompt = apply_personality_to_soul_text(soul)
        observed = str(((bound.get("pack") or {}).get("id") or "")).strip().lower()
        injection_count = prompt.count(INJECTION_MARK)
        if observed != pid or injection_count != 1:
            raise ProbeRefusal("selected_pack_not_injected")
        return {
            "ok": True,
            "probe": "wolfhouse_8090_no_send_personality_injection",
            "no_send": True,
            "requested_personality_id": pid,
            "observed_personality_id": observed,
            "injection_count": injection_count,
            "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            "sends_attempted": 0,
            "tools_invoked": 0,
            "model_calls": 0,
        }
    finally:
        clear_bound_personality()


def _authorized(request: Any) -> bool:
    expected = (os.getenv("LUNA_BOT_INTERNAL_TOKEN") or "").strip()
    supplied = str(request.headers.get("X-Luna-Bot-Token") or "").strip()
    return bool(expected and supplied and hmac.compare_digest(expected, supplied))


def register_wolfhouse_8090_probe_route(app: Any) -> bool:
    """Register only on the Wolfhouse :8090 role; no route exists for Sunset."""
    if not _is_wolfhouse_8090_identity():
        return False
    if getattr(app, "_wolfhouse_8090_personality_probe_registered", False):
        return True

    async def handle(request: Any) -> Any:
        from aiohttp import web

        if not _authorized(request):
            return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)
        if not isinstance(body, dict) or set(body) != {"personality_id"}:
            return web.json_response({"ok": False, "error": "closed_input_required"}, status=400)
        try:
            return web.json_response(run_no_send_injection_probe(body["personality_id"]))
        except ProbeRefusal as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    app.router.add_post(PROBE_PATH, handle)
    setattr(app, "_wolfhouse_8090_personality_probe_registered", True)
    return True


