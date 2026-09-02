"""Optional outbound stub for sunset-luna-http — Staff API only, never Meta Graph.

Default mode is none. When outbound_mode=staff_draft, POST the reply hint to
Staff bot guest-reply-draft (or a caller-injected helper). No WhatsApp Graph
client lives in this runtime.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable

StaffPostFn = Callable[[str, dict[str, Any]], dict[str, Any]]


def _staff_base_url() -> str:
    value = (
        os.environ.get("WOLFHOUSE_STAFF_API_BASE_URL")
        or os.environ.get("STAFF_API_BASE_URL")
        or ""
    ).strip().rstrip("/")
    if value != "https://sunset-staging.lunafrontdesk.com":
        raise RuntimeError("sunset_staff_base_url_required")
    return value


def _bot_token() -> str:
    return (os.environ.get("LUNA_BOT_INTERNAL_TOKEN") or "").strip()


def default_staff_post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    """POST /staff/bot/... — same board Hermes WhatsApp uses. No Graph API."""
    token = _bot_token()
    if not token:
        raise RuntimeError("staff_token_missing")
    url = f"{_staff_base_url()}/staff/bot{path}"
    raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=raw,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
            "accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"staff_http_{exc.code}:{detail}") from exc
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"staff_unreachable:{type(exc).__name__}") from exc
    return payload if isinstance(payload, dict) else {"raw": payload}


def maybe_outbound(
    req: dict[str, Any],
    *,
    reply_hint: str | None,
    staff_post: StaffPostFn | None = None,
) -> dict[str, Any]:
    mode = req.get("outbound_mode") or "none"
    if mode == "none":
        return {"mode": "none", "sent": False, "via": None}
    if mode != "staff_draft":
        return {"mode": mode, "sent": False, "via": None, "error": "unsupported_outbound"}
    # Draft-only board path — never Meta Graph, never n8n.
    body = {
        "client_slug": "sunset",
        "location_id": req.get("location_id") or req.get("location_key"),
        "channel": req.get("channel") or "http_probe",
        "text": req.get("text") or "",
        "suggested_reply": reply_hint or "",
        "draft_only": True,
        "preview_only": True,
        "source_runtime": "sunset-luna-http",
        "request_id": req.get("request_id"),
    }
    if req.get("conversation_id"):
        body["conversation_id"] = req["conversation_id"]
    if req.get("thread_key"):
        body["thread_key"] = req["thread_key"]
    post = staff_post or default_staff_post
    try:
        result = post("/guest-reply-draft", body)
    except Exception as exc:  # noqa: BLE001
        return {
            "mode": "staff_draft",
            "sent": False,
            "via": "staff_bot_guest_reply_draft",
            "error": str(exc)[:200],
        }
    return {
        "mode": "staff_draft",
        "sent": False,
        "via": "staff_bot_guest_reply_draft",
        "staff": {
            "success": bool(result.get("success")),
            "draft_only": True,
            "preview_only": True,
        },
    }
