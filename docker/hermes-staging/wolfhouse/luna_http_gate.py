"""Single Staff API automation gate for the Sunset Luna HTTP runtime."""
from __future__ import annotations

from typing import Any, Callable

from wolfhouse.luna_http_outbound import default_staff_post


def normalize_gate_snapshot(payload: dict[str, Any] | None) -> dict[str, Any]:
    """Normalize one authoritative gate response; Needs Human is advisory on Sunset."""
    data = payload if isinstance(payload, dict) else {}
    lookup_error = bool(data.get("lookup_error") or data.get("success") is False)
    mode = str(data.get("whatsapp_channel_mode") or "").strip().lower() or None
    agent_paused = bool(
        lookup_error
        or data.get("bot_paused") is True
        or data.get("can_continue_guest_automation") is False
        or mode == "off"
    )
    authoritative_block = bool(
        agent_paused
        or data.get("live_send_blocked") is True
        or mode == "draft"
    )
    return {
        "source": str(data.get("source") or ("lookup_error" if lookup_error else "unknown")),
        "lookup_error": lookup_error,
        "bot_paused": agent_paused,
        "global_paused": bool(data.get("global_paused")),
        "conversation_paused": bool(data.get("conversation_paused")),
        "needs_human": bool(data.get("needs_human")),
        "whatsapp_channel_mode": mode,
        "live_send_blocked": authoritative_block,
        "stage_outbound_as_draft": bool(data.get("stage_outbound_as_draft")),
    }


def lookup_gate(req: dict[str, Any], *, staff_post: Callable | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "client_slug": "sunset",
        "source": "sunset_luna_http",
    }
    if req.get("conversation_id"):
        body["conversation_id"] = req["conversation_id"]
    if req.get("thread_key"):
        body["thread_key"] = req["thread_key"]
    post = staff_post or default_staff_post
    try:
        return normalize_gate_snapshot(post("/check-guest-automation-gate", body))
    except Exception as exc:  # fail closed for Pause / Luna Off / Auto authority
        return normalize_gate_snapshot({
            "success": False,
            "lookup_error": True,
            "source": f"staff_gate_{type(exc).__name__}",
        })
