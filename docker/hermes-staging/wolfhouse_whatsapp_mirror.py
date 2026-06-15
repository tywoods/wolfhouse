"""Fire-and-forget mirror of Hermes WhatsApp turns into Staff Portal inbox."""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.request

_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)", re.IGNORECASE)
_NEEDS_HUMAN_RE = re.compile(
    r"(team\s+will\s+(?:need\s+to\s+)?(?:review|check|double-check)"
    r"|staff\s+will\s+(?:need\s+to\s+)?(?:review|check|double-check)"
    r"|team\s+will\s+get\s+back\s+to\s+you"
    r"|staff\s+will\s+get\s+back\s+to\s+you"
    r"|I['’]ll\s+follow\s+up\s+with\s+the\s+team)",
    re.IGNORECASE,
)
_INTERNAL_STATUS_RE = re.compile(
    r"(^|\b)(self.?improvement|skill\s+['\"]?[-\w]+\s+(?:created|saved|updated)|auxiliary\s+|compression\s+|preflight|rate\s+limited)(\b|:)",
    re.IGNORECASE,
)


def normalize_whatsapp_message_text(text: str) -> str:
    """WhatsApp does not render markdown links — convert to plain label + URL."""
    if not text:
        return text
    def _repl(match: re.Match) -> str:
        label = (match.group(1) or "").strip()
        url = (match.group(2) or "").strip()
        if not url:
            return match.group(0)
        if not label or label == url:
            return url
        return f"{label}: {url}"
    return _MD_LINK_RE.sub(_repl, str(text))


def _digits_phone(source) -> str:
    for attr in ("user_id", "chat_id"):
        raw = getattr(source, attr, None)
        if not raw:
            continue
        digits = "".join(ch for ch in str(raw) if ch.isdigit())
        if digits:
            return f"+{digits}"
    return ""


def _post_mirror(payload: dict) -> None:
    base = (os.getenv("WOLFHOUSE_STAFF_API_BASE_URL") or "https://staff-staging.lunafrontdesk.com").rstrip("/")
    token = os.getenv("LUNA_BOT_INTERNAL_TOKEN") or ""
    if not token:
        return
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/staff/bot/whatsapp-thread-mirror",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Luna-Bot-Token": token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as res:
            res.read()
    except Exception:
        pass


def mirror_whatsapp_thread(source, event, direction, text, wa_id=None, contact_name=None) -> None:
    phone = _digits_phone(source)
    msg = (text or "").strip()
    if direction == "outbound":
        msg = normalize_whatsapp_message_text(msg).strip()
        if _INTERNAL_STATUS_RE.search(msg):
            return
    if not phone or not msg:
        return
    payload = {
        "client_slug": "wolfhouse-somo",
        "guest_phone": phone,
        "direction": direction,
        "message_text": msg[:4000],
    }
    if direction == "outbound" and _NEEDS_HUMAN_RE.search(msg):
        payload["needs_human"] = True
        payload["handoff_reason"] = "luna_team_review_reply"
    if wa_id:
        payload["whatsapp_message_id"] = str(wa_id)
    if contact_name:
        payload["contact_name"] = str(contact_name)
    if direction == "outbound" and not wa_id:
        payload["idempotency_key"] = hashlib.sha256(f"{phone}:{msg}".encode("utf-8")).hexdigest()[:32]
    _post_mirror(payload)
