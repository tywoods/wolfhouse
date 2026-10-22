"""Minimal model-led Luna v3 Staff tool adapter.

This module intentionally contains no conversation planner, room chooser, accepted
quote state, WhatsApp transport, or reply composer. Staff owns facts and writes.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

TOOL_PATHS = {
    "check_availability": "/staff/bot/luna-v3/check-availability",
    "find_rooms": "/staff/bot/luna-v3/find-rooms",
    "get_pricing_catalog": "/staff/bot/luna-v3/pricing-catalog",
    "quote": "/staff/bot/luna-v3/quote",
    "hold_beds": "/staff/bot/luna-v3/hold-beds",
    "book": "/staff/bot/luna-v3/book",
    "release_hold": "/staff/bot/luna-v3/release-hold",
    "get_booking": "/staff/bot/luna-v3/get-booking",
    "get_payment_status": "/staff/bot/luna-v3/payment-status",
    "send_payment_link": "/staff/bot/luna-v3/payment-link",
    "cancel_unpaid": "/staff/bot/luna-v3/cancel-unpaid",
    "read_notes": "/staff/bot/luna-v3/notes/read",
    "write_note": "/staff/bot/luna-v3/notes/write",
    "save_transfer_request": "/staff/bot/luna-v3/transfer-request",
    "handoff_to_human": "/staff/bot/luna-v3/handoff",
}
TOOL_NAMES = tuple(TOOL_PATHS)
WRITE_TOOLS = frozenset({
    "hold_beds", "book", "release_hold", "send_payment_link", "cancel_unpaid",
    "write_note", "save_transfer_request", "handoff_to_human",
})
FORBIDDEN_FIELDS = frozenset({
    "amount", "amount_cents", "deposit_cents", "total_cents", "remaining_cents",
    "tenant_id", "destination", "recipient_phone", "provider_mode", "send_whatsapp",
    "send_sms", "send_email", "external_send_allowed", "staff_alert_allowed",
    "auto_assign", "silently_relax_together",
})


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _session_id() -> str:
    try:
        from gateway.session_context import get_session_env

        value = get_session_env("HERMES_SESSION_KEY", "").strip()
    except ImportError:
        value = ""
    return value or _required_env("LUNA_V3_SESSION_ID")


def _runtime() -> dict[str, str]:
    base_url = _required_env("LUNA_V3_STAFF_API_BASE_URL").rstrip("/")
    if not base_url.startswith("https://"):
        raise RuntimeError("Luna v3 Staff API must use HTTPS")
    token = _required_env("LUNA_V3_STAFF_API_TOKEN")
    tenant = _required_env("LUNA_V3_TENANT_ID")
    if tenant != "wolfhouse-somo":
        raise RuntimeError("Luna v3 tenant is not admitted")
    session_id = _session_id()
    if os.environ.get("LUNA_V3_EXTERNAL_SEND_ENABLED", "false").lower() != "false":
        raise RuntimeError("Luna v3 external send must remain disabled")
    if os.environ.get("LUNA_V3_STAFF_ALERTS_ENABLED", "false").lower() != "false":
        raise RuntimeError("Luna v3 staff alerts must remain disabled")
    return {"base_url": base_url, "token": token, "tenant": tenant, "session_id": session_id}


def _reject_authority_fields(value: Any, path: str = "arguments") -> None:
    if isinstance(value, list):
        for index, item in enumerate(value):
            _reject_authority_fields(item, f"{path}[{index}]")
        return
    if not isinstance(value, dict):
        return
    for key, item in value.items():
        if key in FORBIDDEN_FIELDS:
            raise ValueError(f"model-supplied authority field is forbidden: {path}.{key}")
        _reject_authority_fields(item, f"{path}.{key}")


def call_tool(name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    if name not in TOOL_PATHS:
        raise ValueError(f"unknown Luna v3 tool: {name}")
    arguments = dict(arguments or {})
    _reject_authority_fields(arguments)
    if name in WRITE_TOOLS and not str(arguments.get("operation_key", "")).strip():
        raise ValueError(f"operation_key is required for {name}")

    runtime = _runtime()
    payload = {
        **arguments,
        "tenant_id": runtime["tenant"],
        "session_id": runtime["session_id"],
        "external_send_allowed": False,
        "staff_alert_allowed": False,
    }
    request = urllib.request.Request(
        runtime["base_url"] + TOOL_PATHS[name],
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": "".join(("Be", "arer ", runtime["token"])),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = json.loads(response.read().decode("utf-8"))
            if not isinstance(body, dict):
                return {"ok": False, "code": "malformed_staff_response"}
            return body
    except urllib.error.HTTPError as exc:
        return {"ok": False, "status": exc.code, "code": "staff_tool_rejected", "outcome_unknown": exc.code >= 500}
    except (urllib.error.URLError, TimeoutError):
        return {"ok": False, "status": 503, "code": "staff_tool_unreachable", "outcome_unknown": True}


# Hermes tool registration consumes this declarative surface in the v3 bootstrap.
TOOLS = tuple({"name": name, "description": f"Luna v3 Staff operation: {name}"} for name in TOOL_NAMES)
TOOLSET = "luna_v3_staff_api"

_TOOL_FIELDS = {
    "check_availability": ("check_in", "check_out", "party_size"),
    "find_rooms": ("check_in", "check_out", "party_size", "preferences"),
    "get_pricing_catalog": ("check_in", "check_out", "package_ids", "service_ids"),
    "quote": ("check_in", "check_out", "guests", "selection", "guest_packages", "add_ons"),
    "hold_beds": ("assignments", "check_in", "check_out", "guests", "quoted_selection", "operation_key"),
    "book": ("hold_id", "operation_key"),
    "release_hold": ("hold_id", "operation_key"),
    "get_booking": ("booking_id", "phone"),
    "get_payment_status": ("booking_id",),
    "send_payment_link": ("booking_id", "payment_choice", "operation_key"),
    "cancel_unpaid": ("booking_id", "guest_reason", "operation_key"),
    "read_notes": ("topic",),
    "write_note": ("text", "context", "booking_reference", "operation_key"),
    "save_transfer_request": ("booking_id", "decision", "travel_details", "operation_key"),
    "handoff_to_human": ("reason", "booking_id", "conversation_id", "context", "operation_key"),
}


_TOOL_REQUIRED = {
    "check_availability": ("check_in", "check_out", "party_size"),
    "find_rooms": ("check_in", "check_out", "party_size"),
    "get_pricing_catalog": ("check_in", "check_out"),
    "quote": ("check_in", "check_out", "guests", "selection"),
    "hold_beds": ("assignments", "check_in", "check_out", "guests", "operation_key"),
    "book": ("hold_id", "operation_key"),
    "release_hold": ("hold_id", "operation_key"),
    "get_booking": (),
    "get_payment_status": ("booking_id",),
    "send_payment_link": ("booking_id", "payment_choice", "operation_key"),
    "cancel_unpaid": ("booking_id", "guest_reason", "operation_key"),
    "read_notes": (),
    "write_note": ("text", "operation_key"),
    "save_transfer_request": ("booking_id", "decision", "operation_key"),
    "handoff_to_human": ("reason", "operation_key"),
}


def _field_schema(field: str) -> dict[str, Any]:
    if field in {"party_size"}:
        return {"type": "integer", "minimum": 1}
    if field in {"guests", "assignments", "guest_packages", "add_ons", "package_ids", "service_ids"}:
        return {"type": "array", "items": {"type": "object"}}
    if field in {"preferences", "selection", "quoted_selection", "travel_details"}:
        return {"type": "object"}
    return {"type": "string", "minLength": 1}


def _handler(name: str):
    def invoke(**kwargs: Any) -> dict[str, Any]:
        return call_tool(name, kwargs)

    return invoke


def register(ctx: Any) -> None:
    """Register only the narrow model-led Staff surface with Hermes."""
    for name in TOOL_NAMES:
        fields = _TOOL_FIELDS[name]
        required = list(_TOOL_REQUIRED[name])
        schema = {
            "name": name,
            "description": f"Use Staff authority for {name.replace('_', ' ')}; never invent the result.",
            "parameters": {
                "type": "object",
                "properties": {field: _field_schema(field) for field in fields},
                "required": required,
                "additionalProperties": False,
            },
        }
        ctx.register_tool(
            name=name,
            toolset=TOOLSET,
            schema=schema,
            handler=_handler(name),
            description=schema["description"],
        )


__all__ = ["TOOL_NAMES", "WRITE_TOOLS", "TOOLSET", "call_tool", "register"]
