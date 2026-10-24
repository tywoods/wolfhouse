"""Minimal model-led Luna v3 Staff tool adapter.

This module intentionally contains no conversation planner, room chooser, accepted
quote state, WhatsApp transport, or reply composer. Staff owns facts and writes.
"""

from __future__ import annotations

import json
import hashlib
import os
import urllib.error
import urllib.request
import urllib.parse
from typing import Any

class _SameHostRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, admitted_url: str):
        parsed = urllib.parse.urlsplit(admitted_url)
        self.admitted_origin = (parsed.scheme.lower(), (parsed.hostname or "").lower(), parsed.port or (443 if parsed.scheme.lower() == "https" else None))
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        target = urllib.parse.urlsplit(newurl)
        target_origin = (target.scheme.lower(), (target.hostname or "").lower(), target.port or (443 if target.scheme.lower() == "https" else None))
        if target.username or target.password or target_origin != self.admitted_origin or target.scheme.lower() != "https":
            raise urllib.error.HTTPError(newurl, code, "cross-origin redirect denied", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def _open_staff(request: Any, base_url: str) -> Any:
    return urllib.request.build_opener(_SameHostRedirectHandler(base_url)).open(request, timeout=20)

TOOL_PATHS = {
    "check_quote_book": "/staff/bot/luna-v3/check-quote-book",
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
    "recover_operation": "/staff/bot/luna-v3/recover-operation",
}
TOOL_NAMES = tuple(TOOL_PATHS)
WRITE_TOOLS = frozenset({
    "check_quote_book", "quote", "hold_beds", "book", "release_hold", "send_payment_link", "cancel_unpaid",
    "write_note", "save_transfer_request", "handoff_to_human",
})
FORBIDDEN_FIELDS = frozenset({
    "amount", "amount_cents", "deposit_cents", "total_cents", "remaining_cents",
    "tenant_id", "destination", "recipient_phone", "provider_mode", "send_whatsapp",
    "send_sms", "send_email", "external_send_allowed", "staff_alert_allowed",
    "auto_assign", "silently_relax_together",
    "totalCents", "depositCents", "remainingCents", "balanceDueCents",
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
    if name == "recover_operation" and (not str(arguments.get("tool", "")).strip() or not str(arguments.get("operation_key", "")).strip()):
        raise ValueError("tool and operation_key are required for recover_operation")
    if name in WRITE_TOOLS and name != "check_quote_book" and not str(arguments.get("operation_key", "")).strip():
        raise ValueError(f"operation_key is required for {name}")

    runtime = _runtime()
    payload = {
        **arguments,
        "tenant_id": runtime["tenant"],
        "session_id": runtime["session_id"],
        "external_send_allowed": False,
        "staff_alert_allowed": False,
    }
    turn_id = "turn:" + hashlib.sha256((runtime["session_id"] + ":" + json.dumps(arguments, sort_keys=True, separators=(",", ":"))).encode()).hexdigest()[:32]
    request = urllib.request.Request(
        runtime["base_url"] + TOOL_PATHS[name],
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": "".join(("Be", "arer ", runtime["token"])),
            "X-Luna-V3-Turn-Id": turn_id,
        },
        method="POST",
    )
    try:
        with _open_staff(request, runtime["base_url"]) as response:
            body = json.loads(response.read().decode("utf-8"))
            if not isinstance(body, dict):
                return {"ok": False, "code": "malformed_staff_response"}
            return body
    except urllib.error.HTTPError as exc:
        result: dict[str, Any] = {"ok": False, "status": exc.code}
        try: staff = json.loads(exc.read().decode("utf-8"))
        except (ValueError, UnicodeError): staff = {}
        if isinstance(staff, dict):
            for field in ("code", "reason_code", "error"):
                value = staff.get(field)
                if isinstance(value, str) and value and len(value) <= 160:
                    result[field] = value
            if exc.code == 409:
                for field in ("reason", "handoffId", "handoffOperationKey"):
                    value = staff.get(field)
                    if isinstance(value, str) and value and len(value) <= 160:
                        result[field] = value
                if isinstance(staff.get("requiredHumanHandoff"), bool):
                    result["requiredHumanHandoff"] = staff["requiredHumanHandoff"]
            if isinstance(staff.get("outcome_unknown"), bool):
                result["outcome_unknown"] = staff["outcome_unknown"]
            if exc.code < 500 and staff.get("recoveryStatus") in {"rejected", "unknown"}:
                result["recoveryStatus"] = staff["recoveryStatus"]
            if exc.code < 500 and staff.get("outcome") in {"rejected", "unknown"}:
                result["outcome"] = staff["outcome"]
        result.setdefault("code", "staff_tool_rejected")
        result.setdefault("recoveryStatus", "unknown" if exc.code >= 500 else "rejected")
        result.setdefault("outcome", "unknown" if exc.code >= 500 else "rejected")
        return result
    except (urllib.error.URLError, TimeoutError):
        return {"ok": False, "status": 503, "recoveryStatus": "unknown", "outcome": "unknown", "code": "staff_tool_unreachable"}


# Hermes tool registration consumes this declarative surface in the v3 bootstrap.
TOOLS = tuple({"name": name, "description": f"Luna v3 Staff operation: {name}"} for name in TOOL_NAMES)
TOOLSET = "luna_v3_staff_api"

_TOOL_FIELDS = {
    "check_quote_book": ("action", "purpose", "check_in", "check_out", "guests", "room", "package", "add_ons", "payment", "offer_reference"),
    "check_availability": ("check_in", "check_out", "party_size"),
    "find_rooms": ("check_in", "check_out", "party_size", "preferences"),
    "get_pricing_catalog": ("check_in", "check_out", "package_ids", "service_ids"),
    "quote": ("operation_key", "check_in", "check_out", "guests", "selection", "package_id", "guest_packages", "add_ons"),
    "hold_beds": ("assignments", "check_in", "check_out", "guests", "quoted_selection", "operation_key"),
    "book": ("hold_id", "operation_key"),
    "release_hold": ("hold_id", "operation_key"),
    "get_booking": ("booking_id",),
    "get_payment_status": ("booking_id",),
    "send_payment_link": ("booking_id", "guest_id", "payment_choice", "operation_key"),
    "cancel_unpaid": ("booking_id", "guest_reason", "operation_key"),
    "read_notes": ("topic",),
    "write_note": ("text", "context", "booking_reference", "operation_key"),
    "save_transfer_request": ("booking_id", "decision", "travel_details", "operation_key"),
    "handoff_to_human": ("reason", "booking_id", "conversation_id", "context", "operation_key"),
    "recover_operation": ("tool", "operation_key"),
}


_TOOL_REQUIRED = {
    "check_quote_book": ("action",),
    "check_availability": ("check_in", "check_out", "party_size"),
    "find_rooms": ("check_in", "check_out", "party_size"),
    "get_pricing_catalog": ("check_in", "check_out"),
    "quote": ("operation_key", "check_in", "check_out", "guests", "selection"),
    "hold_beds": ("assignments", "check_in", "check_out", "guests", "quoted_selection", "operation_key"),
    "book": ("hold_id", "operation_key"),
    "release_hold": ("hold_id", "operation_key"),
    "get_booking": (),
    "get_payment_status": ("booking_id",),
    "send_payment_link": ("booking_id", "guest_id", "payment_choice", "operation_key"),
    "cancel_unpaid": ("booking_id", "guest_reason", "operation_key"),
    "read_notes": (),
    "write_note": ("text", "operation_key"),
    "save_transfer_request": ("booking_id", "decision", "operation_key"),
    "handoff_to_human": ("reason", "operation_key"),
    "recover_operation": ("tool", "operation_key"),
}


def _field_schema(field: str) -> dict[str, Any]:
    if field == "action":
        return {"type": "string", "enum": ["prepare", "confirm", "decline"]}
    if field == "purpose":
        return {"type": "string", "enum": ["offer"]}
    if field == "offer_reference":
        return {"type": "string", "pattern": "^offer_[A-Za-z0-9_-]{24,80}$"}
    if field == "room":
        return {"type": "object", "additionalProperties": False, "required": ["kind"], "properties": {
            "kind": {"type": "string", "enum": ["exact", "private", "shared", "auto"]},
            "name": {"type": "string", "minLength": 1}, "beds": {"type": "array", "items": {"type": "string", "minLength": 1}, "uniqueItems": True},
            "together": {"type": "string", "enum": ["required", "preferred", "not_required"]}}}
    if field == "package":
        return {"type": "object", "additionalProperties": False, "properties": {
            "name": {"type": "string", "minLength": 1},
            "per_guest": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                "required": ["guest", "name"], "properties": {"guest": {"type": "string", "minLength": 1}, "name": {"type": "string", "minLength": 1}}}}},
            "anyOf": [{"required": ["name"]}, {"required": ["per_guest"]}]}
    if field == "payment":
        return {"type": "object", "additionalProperties": False, "required": ["arrangement"], "properties": {
            "arrangement": {"type": "string", "enum": ["together", "separately"]}, "choice": {"type": "string", "enum": ["deposit", "balance"]}}}
    if field in {"party_size"}:
        return {"type": "integer", "minimum": 1}
    if field in {"package_ids", "service_ids"}:
        return {"type": "array", "items": {"type": "string", "minLength": 1}}
    if field == "guests":
        return {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1},
                    "explicit_gender": {"type": "string", "minLength": 1},
                    "gender": {"type": "string", "minLength": 1},
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        }
    if field == "assignments":
        return {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "bed_code": {"type": "string", "minLength": 1},
                    "guest_name": {"type": "string", "minLength": 1},
                    "package_code": {"type": "string", "minLength": 1, "description": "Exact accepted package code; accommodation-only is explicit package_none."},
                },
                "required": ["bed_code", "guest_name", "package_code"],
                "additionalProperties": False,
            },
        }
    if field == "guest_packages":
        return {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "guest_number": {"type": "integer", "minimum": 1},
                    "package_code": {"type": "string", "minLength": 1},
                },
                "required": ["guest_number", "package_code"],
                "additionalProperties": False,
            },
        }
    if field == "add_ons":
        return {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "minLength": 1},
                    "name": {"type": "string", "minLength": 1},
                    "days": {"type": "integer", "minimum": 1, "description": "For a dated rental, the number of distinct requested service dates."},
                    "quantity": {"type": "integer", "minimum": 1, "description": "For rentals, quantity counts people or equipment units, never participant-days."},
                    "dates": {
                        "type": "array",
                        "items": {"type": "string", "format": "date"},
                        "minItems": 1,
                        "uniqueItems": True,
                        "description": "The exact service dates for a dated rental; these are retained unchanged.",
                    },
                    "requested_dates": {"type": "array", "items": {"type": "string", "format": "date"}, "uniqueItems": True},
                    "people": {"type": "array", "items": {"type": "string", "minLength": 1}, "uniqueItems": True},
                },
                "anyOf": [{"required": ["code"]}, {"required": ["name"]}],
                "additionalProperties": False,
            },
        }
    if field == "context":
        return {
            "type": "object",
            "properties": {
                key: {"type": "string", "minLength": 1, "maxLength": 500}
                for key in ("topic", "kind", "detail")
            },
            "additionalProperties": False,
        }
    if field == "selection":
        return {
            "type": "object",
            "properties": {
                "room_id": {"type": "string", "minLength": 1},
                "bed_ids": {"type": "array", "items": {"type": "string", "minLength": 1}, "minItems": 1, "uniqueItems": True},
                "selected_bed_codes": {"type": "array", "items": {"type": "string", "minLength": 1}, "minItems": 1, "uniqueItems": True},
                "room_type": {"type": "string", "minLength": 1},
                "room_preference": {"type": "string", "minLength": 1},
                "keep_together": {"type": "boolean"},
            },
            "additionalProperties": False,
            "anyOf": [{"required": ["selected_bed_codes"]}, {"required": ["bed_ids"]}],
        }
    if field == "preferences":
        return {
            "type": "object",
            "properties": {
                "room_type": {"type": "string", "minLength": 1},
                "room_preference": {"type": "string", "minLength": 1},
                "keep_together": {"type": "boolean"},
                "group_gender": {"type": "string", "minLength": 1},
                "guests": _field_schema("guests"),
            },
            "additionalProperties": False,
        }
    if field == "travel_details":
        return {"type": "object"}
    return {"type": "string", "minLength": 1}


def _handler(name: str):
    def invoke(arguments: dict[str, Any], **_runtime_kwargs: Any) -> str:
        if not isinstance(arguments, dict):
            raise TypeError("Hermes tool arguments must be an object")
        return json.dumps(call_tool(name, arguments), separators=(",", ":"))

    return invoke


def register(ctx: Any) -> None:
    """Register only the narrow model-led Staff surface with Hermes."""
    for name in TOOL_NAMES:
        fields = _TOOL_FIELDS[name]
        required = list(_TOOL_REQUIRED[name])
        descriptions = {
            "find_rooms": "Discover Staff candidates matching ordered guests and explicit constraints. Results are candidates, not holds; never infer gender.",
            "get_pricing_catalog": "Load authoritative stay/package eligibility and transfer facts. Proration does not override package minimums; transfer facts are not confirmation.",
            "quote": "Price one specified Staff candidate using nonempty exact beds in guest order. A quote is provisional and not a hold or booking.",
            "hold_beds": "Copy the canonical hold input returned by the accepted quote, add one stable operation key, and hold exactly those dates, ordered guests, beds, and package codes.",
        }
        schema = {
            "name": name,
            "description": descriptions.get(name, f"Use Staff authority for {name.replace('_', ' ')}; never invent the result."),
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
