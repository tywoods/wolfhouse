"""Private inbound contract for sunset-luna-http (first shared Luna HTTP slice).

Authenticated JSON only. No Meta Graph webhook shape. Staff API remains the
board for availability; this runtime never invents daily-full leftover.
"""

from __future__ import annotations

import json
from typing import Any

TENANT = "sunset"
LOCATION_KEY = "sunset-somo"
RUNTIME = "sunset-luna-http"
ROLE = "sunset-luna-http"
INBOUND_PATH = "/v1/inbound"
REQUEST_SCHEMA = "sunset.luna_http.inbound.v1"
RESULT_SCHEMA = "sunset.luna_http.result.v1"
MAX_BODY = 65536
PROVIDER = "openai-codex"
MODEL = "gpt-5.6-sol"

REQUIRED_KEYS = frozenset(
    {
        "schema",
        "tenant_id",
        "location_key",
        "request_id",
        "channel",
        "text",
    }
)
OPTIONAL_KEYS = frozenset(
    {
        "date",
        "quantity",
        "slot_time",
        "course_id",
        "location_id",
        "conversation_id",
        "thread_key",
        "language",
        "outbound_mode",
    }
)
ALLOWED_CHANNELS = frozenset({"http_probe", "whatsapp", "email", "staff_draft"})
ALLOWED_OUTBOUND = frozenset({"none", "staff_draft"})


def _clean(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def parse_inbound(raw_body: bytes) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(raw_body, (bytes, bytearray)):
        return None, "malformed"
    if len(raw_body) > MAX_BODY:
        return None, "oversized"
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, "malformed"
    if not isinstance(payload, dict):
        return None, "malformed"
    keys = set(payload.keys())
    if not REQUIRED_KEYS.issubset(keys):
        return None, "missing_keys"
    if keys - REQUIRED_KEYS - OPTIONAL_KEYS:
        return None, "extra_keys"
    if payload.get("schema") != REQUEST_SCHEMA:
        return None, "wrong_schema"
    if _clean(payload.get("tenant_id")) != TENANT:
        return None, "wrong_tenant"
    if _clean(payload.get("location_key")) != LOCATION_KEY:
        return None, "wrong_location"
    request_id = _clean(payload.get("request_id"))
    if not request_id or len(request_id) > 128:
        return None, "bad_request_id"
    channel = _clean(payload.get("channel"))
    if channel not in ALLOWED_CHANNELS:
        return None, "bad_channel"
    text = payload.get("text")
    if not isinstance(text, str) or len(text) > 8000:
        return None, "bad_text"
    outbound_mode = _clean(payload.get("outbound_mode") or "none") or "none"
    if outbound_mode not in ALLOWED_OUTBOUND:
        return None, "bad_outbound_mode"
    date = _clean(payload.get("date")) if "date" in payload else ""
    if "date" in payload and (not date or len(date) > 32):
        return None, "bad_date"
    quantity = None
    if "quantity" in payload and payload.get("quantity") is not None:
        raw_qty = payload.get("quantity")
        if isinstance(raw_qty, bool) or not isinstance(raw_qty, (int, float, str)):
            return None, "bad_quantity"
        try:
            quantity = int(raw_qty)
        except (TypeError, ValueError):
            return None, "bad_quantity"
        if quantity < 1 or quantity > 200:
            return None, "bad_quantity"
    slot_time = _clean(payload.get("slot_time")) if "slot_time" in payload else ""
    if "slot_time" in payload and slot_time and len(slot_time) > 32:
        return None, "bad_slot_time"
    course_id = _clean(payload.get("course_id")) if "course_id" in payload else ""
    location_id = _clean(payload.get("location_id") or LOCATION_KEY)
    if location_id and location_id != LOCATION_KEY:
        return None, "wrong_location"
    language = _clean(payload.get("language") or "en") or "en"
    if language not in {"en", "es", "it"}:
        return None, "bad_language"
    return {
        "schema": REQUEST_SCHEMA,
        "tenant_id": TENANT,
        "location_key": LOCATION_KEY,
        "location_id": location_id or LOCATION_KEY,
        "request_id": request_id,
        "channel": channel,
        "text": text,
        "date": date or None,
        "quantity": quantity,
        "slot_time": slot_time or None,
        "course_id": course_id or None,
        "conversation_id": _clean(payload.get("conversation_id")) or None,
        "thread_key": _clean(payload.get("thread_key")) or None,
        "language": language,
        "outbound_mode": outbound_mode,
    }, None
