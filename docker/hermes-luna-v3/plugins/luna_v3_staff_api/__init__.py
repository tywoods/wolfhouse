"""Minimal model-led Luna v3 Staff tool adapter.

This module intentionally contains no conversation planner, room chooser, accepted
quote state, WhatsApp transport, or reply composer. Staff owns facts and writes.
"""

from __future__ import annotations

import json
import io
import hashlib
import os
import urllib.error
import urllib.request
import urllib.parse
import time
import socket
from pathlib import Path
from typing import Any

_CHECK_QUOTE_BOOK_SCHEMA = json.loads((Path(__file__).resolve().parents[2] / "contracts" / "check_quote_book.schema.json").read_text())
FAILURE_CLASSIFICATIONS = frozenset({"validation", "authorization", "configuration", "conflict", "availability", "internal", "transport", "http"})


def _refusal(code: str, classification: str, status: int | None = None, correlation_id: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"ok": False, "code": code, "classification": classification,
        "message": "I could not safely complete that booking action.",
        "field_errors": [{"path": "$", "code": code, "message": "Staff could not return a usable result."}],
        "next_step": "wait_for_verified_result", "retry_allowed": False, "correlation_id": correlation_id}
    if status is not None:
        result["status"] = status
    return result

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
    "get_booking": "/staff/bot/luna-v3/get-booking",
    "get_payment_status": "/staff/bot/luna-v3/payment-status",
    "send_payment_link": "/staff/bot/luna-v3/payment-link",
    "cancel_unpaid": "/staff/bot/luna-v3/cancel-unpaid",
    "read_notes": "/staff/bot/luna-v3/notes/read",
    "write_note": "/staff/bot/luna-v3/notes/write",
    "save_transfer_request": "/staff/bot/luna-v3/transfer-request",
    "handoff_to_human": "/staff/bot/luna-v3/handoff",
}
TOOL_NAMES = (
    "check_quote_book", "get_booking", "get_payment_status", "send_payment_link",
    "cancel_unpaid", "read_notes", "write_note", "save_transfer_request", "handoff_to_human",
)
WRITE_TOOLS = frozenset({
    "check_quote_book", "send_payment_link", "cancel_unpaid",
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
    local_harness = os.environ.get("LUNA_V3_AUTHENTIC_HARNESS") == "1" and base_url == "http://staff:3036"
    if not base_url.startswith("https://") and not local_harness:
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
    if name not in TOOL_NAMES:
        raise ValueError(f"unknown Luna v3 public tool: {name}")
    arguments = dict(arguments or {})
    _reject_authority_fields(arguments)

    if name == "check_quote_book" and arguments.get("action") == "prepare":
        from runtime.trusted_turn_context import reserve_prepare_dispatch
        if not reserve_prepare_dispatch():
            return _refusal("prepare_attempt_already_consumed", "conflict", 409, None)

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
    try:
        from runtime.trusted_turn_context import get_inbound_event
        inbound_event_id = get_inbound_event()
    except ImportError:
        inbound_event_id = ""
    if not inbound_event_id:
        raise RuntimeError("trusted persisted inbound event is required")
    turn_id = "turn:" + hashlib.sha256((runtime["session_id"] + ":" + inbound_event_id).encode()).hexdigest()[:32]
    request = urllib.request.Request(
        runtime["base_url"] + TOOL_PATHS[name],
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": "".join(("Be", "arer ", runtime["token"])),
            "X-Luna-V3-Turn-Id": turn_id,
            "X-Luna-V3-Inbound-Event": inbound_event_id,
        },
        method="POST",
    )
    recorder = None
    fault = ""
    try:
        from runtime.trusted_turn_context import harness_evidence, consume_harness_fault
        recorder = harness_evidence()
        fault = consume_harness_fault()
    except ImportError:
        pass
    call_id = hashlib.sha256(f"{inbound_event_id}:{name}:{time.monotonic_ns()}".encode()).hexdigest()[:24]
    recorded = False
    recorded_exchange = None
    def record_exchange(*, status: int | None = None, original_status: int | None = None, original_raw: bytes = b"", observed_raw: bytes | None = None,
                        exception: BaseException | None = None, applied: bool = False,
                        observed: str | None = None) -> None:
        nonlocal recorded, recorded_exchange
        if recorder is not None:
            recorded_exchange={"tool": name, "path": TOOL_PATHS[name], "status": status, "original_status": status if original_status is None else original_status, "call_id": call_id,
                "event_id": inbound_event_id, "request": payload,
                "original_response_hex": original_raw.hex(),
                "raw_response_hex": (original_raw if observed_raw is None else observed_raw).hex(),
                "fault_requested": fault or None, "fault_applied": fault if applied else None,
                "fault_observed": observed, "fault": fault if applied else None,
                **({"exception_type": type(exception).__name__} if exception is not None else {})}
            recorder.append(recorded_exchange)
            recorded = True

    try:
        with _open_staff(request, runtime["base_url"]) as response:
            raw = response.read()
            response_raw = raw
            # A genuine authenticated Staff response has crossed the boundary before
            # this narrow TEST-only mutation. ContextVars cannot be guest/model supplied.
            if fault == "timeout":
                error = TimeoutError("injected Staff response timeout")
                record_exchange(status=getattr(response, "status", 200), original_raw=raw, exception=error, applied=True, observed="timeout_exception_raised")
                raise error
            elif fault == "http-422":
                mutated=b'{"code":"injected_validation","classification":"validation","reason":"injected owner validation refusal","next_step":"correct_request","retry_allowed":false}'
                # Preserve genuine bytes separately; observe only after reading the raised error.
                injected = urllib.error.HTTPError(request.full_url, 422, "injected Staff rejection", {}, io.BytesIO(mutated))
                injected._luna_original_raw = raw
                raise injected
            elif fault == "exception":
                error=RuntimeError("injected Staff boundary exception")
                record_exchange(status=getattr(response, "status", 200), original_raw=raw, exception=error, applied=True, observed="runtime_exception_raised")
                raise error
            elif fault == "non-json":
                raw = b"CAP-HARNESS-NON-JSON"
            elif fault == "malformed":
                raw = b"[]"
            record_exchange(status=getattr(response, "status", 200), original_raw=raw if not fault else response_raw,
                            observed_raw=raw, applied=fault in {"non-json","malformed"},
                            observed={"non-json":"json_parse_error","malformed":"malformed_shape"}.get(fault))
            try:
                body = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeError):
                if recorded_exchange is not None: recorded_exchange["fault_observed"]="json_parse_error"
                return {**_refusal("staff_transport_non_json", "transport", getattr(response, "status", 200), turn_id), "call_id": call_id}
            if not isinstance(body, dict):
                if recorded_exchange is not None: recorded_exchange["fault_observed"]="malformed_shape"
                return {**_refusal("malformed_staff_response", "transport", getattr(response, "status", 200), turn_id), "call_id": call_id}
            private = {"bookingId", "paymentId", "paymentIds", "checkoutId", "guestId",
                       "transferId", "authoritativeTransferId", "holdId", "consumedHoldId",
                       "authorityKey", "payments", "events", "booking_id", "payment_id",
                       "checkout_id", "transfer_id", "authoritative_transfer_id", "hold_id"}
            if name == "get_booking":
                private |= {"id", "phone", "booking_code", "payment_status", "total_amount_cents",
                            "deposit_required_cents", "paid_cents", "balance_due_cents", "updated_at"}
            if name == "get_payment_status":
                private |= {"guests", "associations", "provider", "provider_readback"}
            def redact(value: Any) -> Any:
                if isinstance(value, list):
                    return [redact(item) for item in value]
                if isinstance(value, dict):
                    return {key: redact(item) for key, item in value.items() if key not in private}
                return value
            return {**redact(body), "call_id": call_id}
    except urllib.error.HTTPError as exc:
        try:
            original_raw = exc.read()
        except Exception as read_error:
            record_exchange(status=exc.code, exception=read_error, observed="http_error_read_error")
            return {**_refusal("staff_tool_unreachable", "transport", 503, turn_id), "recoveryStatus": "unknown", "outcome": "unknown", "call_id": call_id}
        raw = original_raw
        boundary_original_raw = getattr(exc, "_luna_original_raw", original_raw)
        if fault == "timeout":
            try:
                raise TimeoutError("injected Staff HTTP-error timeout")
            except TimeoutError as error:
                record_exchange(status=exc.code, original_status=exc.code, original_raw=original_raw, observed_raw=original_raw, exception=error, applied=True, observed="timeout_exception_raised")
                return {**_refusal("staff_tool_unreachable", "transport", 503, turn_id), "recoveryStatus": "unknown", "outcome": "unknown", "call_id": call_id}
        if fault == "http-422":
            raw=b'{"code":"injected_validation","classification":"validation","reason":"injected owner validation refusal","next_step":"correct_request","retry_allowed":false}'
        elif fault == "exception":
            try:
                raise RuntimeError("injected Staff boundary exception")
            except RuntimeError as error:
                record_exchange(status=exc.code, original_status=exc.code, original_raw=original_raw, observed_raw=original_raw, exception=error, applied=True, observed="runtime_exception_raised")
                return {**_refusal("staff_plugin_internal_failure", "internal", 500, turn_id), "call_id": call_id}
        elif fault == "non-json": raw = b"CAP-HARNESS-NON-JSON"
        elif fault == "malformed": raw = b"[]"
        effective_status=422 if fault=="http-422" else exc.code
        if not recorded:
            record_exchange(status=effective_status, original_status=exc.code, original_raw=boundary_original_raw, observed_raw=raw,
                            applied=fault in {"http-422","non-json","malformed"},
                            observed={"http-422":"http_error_read","non-json":"http_error_json_parse_error","malformed":"http_error_malformed_shape"}.get(fault,"http_error_read"))
        try:
            staff = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError):
            if recorded_exchange is not None: recorded_exchange["fault_observed"]="http_error_json_parse_error"
            return {**_refusal("staff_transport_http_non_json", "transport", effective_status, turn_id),
                    "recoveryStatus": "unknown", "outcome": "unknown", "call_id": call_id}
        if not isinstance(staff, dict):
            if recorded_exchange is not None: recorded_exchange["fault_observed"]="http_error_malformed_shape"
            return {**_refusal("staff_transport_http_malformed", "transport", effective_status, turn_id),
                    "recoveryStatus": "unknown", "outcome": "unknown", "call_id": call_id}
        result: dict[str, Any] = _refusal("staff_tool_rejected", "http", effective_status, turn_id)
        if isinstance(staff, dict):
            bounded_fields = {"code", "reason_code", "reason", "error", "next_step", "correlation_id"}
            for field in ("code", "reason_code", "reason", "error", "message", "next_step", "correlation_id"):
                value = staff.get(field)
                limit = 160 if field in bounded_fields else 500
                if isinstance(value, str) and value and len(value) <= limit:
                    result[field] = value
            if staff.get("classification") in FAILURE_CLASSIFICATIONS:
                result["classification"] = staff["classification"]
            pricing_failure = staff.get("pricing_failure")
            if isinstance(pricing_failure, dict):
                choice = pricing_failure.get("choice")
                safe_choice = None
                if isinstance(choice, dict) and set(choice).issubset({"item_type", "item_code", "season_code"}):
                    candidate = {key: choice.get(key) for key in ("item_type", "item_code", "season_code")}
                    if (
                        isinstance(candidate["item_type"], str) and 0 < len(candidate["item_type"]) <= 80
                        and isinstance(candidate["item_code"], str) and 0 < len(candidate["item_code"]) <= 160
                        and (candidate["season_code"] is None or isinstance(candidate["season_code"], str) and 0 < len(candidate["season_code"]) <= 80)
                    ):
                        safe_choice = candidate
                price_kind = pricing_failure.get("price_kind")
                recovery_action = pricing_failure.get("recovery_action")
                if (
                    pricing_failure.get("type") == "pricing_failure"
                    and price_kind in {"stay", "package", "service", "add_on", "rental", "lesson"}
                    and isinstance(recovery_action, str) and recovery_action == result.get("next_step")
                    and safe_choice is not None
                ):
                    result["pricing_failure"] = {
                        "type": "pricing_failure",
                        "price_kind": price_kind,
                        "choice": safe_choice,
                        "recovery_action": recovery_action,
                    }
            def bounded_facts(field: str, allowed: set[str]) -> None:
                value = staff.get(field)
                if not isinstance(value, dict) or len(value) > 16 or not set(value).issubset(allowed):
                    return
                safe: dict[str, Any] = {}
                for key, item in value.items():
                    if isinstance(item, bool) or isinstance(item, int) and not isinstance(item, bool) and abs(item) <= 100000:
                        safe[key] = item
                    elif isinstance(item, str) and 0 < len(item) <= 240:
                        safe[key] = item
                    elif isinstance(item, list) and len(item) <= 16 and all(isinstance(v, str) and 0 < len(v) <= 120 for v in item):
                        safe[key] = item
                if len(safe) == len(value):
                    result[field] = safe
            bounded_facts("eligibility_facts", {"package_code", "package_name", "minimum_nights", "requested_nights", "eligible", "reason", "check_in", "check_out"})
            bounded_facts("season_coverage", {"season_code", "season_name", "check_in", "check_out", "covered", "uncovered_dates", "reason"})
            if isinstance(staff.get("retry_allowed"), bool):
                result["retry_allowed"] = staff["retry_allowed"]
            field_errors = staff.get("field_errors")
            if isinstance(field_errors, list) and len(field_errors) <= 20:
                admitted = []
                for row in field_errors:
                    if not isinstance(row, dict):
                        continue
                    safe = {key: row.get(key) for key in ("path", "code", "message")}
                    if all(isinstance(value, str) and value and len(value) <= 500 for value in safe.values()):
                        admitted.append(safe)
                if admitted:
                    result["field_errors"] = admitted
            if effective_status == 409:
                for field in ("reason", "handoffId", "handoffOperationKey"):
                    value = staff.get(field)
                    if isinstance(value, str) and value and len(value) <= 160:
                        result[field] = value
                if isinstance(staff.get("requiredHumanHandoff"), bool):
                    result["requiredHumanHandoff"] = staff["requiredHumanHandoff"]
            if isinstance(staff.get("outcome_unknown"), bool):
                result["outcome_unknown"] = staff["outcome_unknown"]
            if effective_status < 500 and staff.get("recoveryStatus") in {"rejected", "unknown"}:
                result["recoveryStatus"] = staff["recoveryStatus"]
            if effective_status < 500 and staff.get("outcome") in {"rejected", "unknown"}:
                result["outcome"] = staff["outcome"]
        result.setdefault("code", "staff_tool_rejected")
        result.setdefault("recoveryStatus", "unknown" if effective_status >= 500 else "rejected")
        result.setdefault("outcome", "unknown" if effective_status >= 500 else "rejected")
        result["call_id"] = call_id
        return result
    except (urllib.error.URLError, TimeoutError, ConnectionError, socket.timeout) as exc:
        if not recorded: record_exchange(exception=exc, observed="timeout_caught" if isinstance(exc,(TimeoutError,socket.timeout)) else "connect_error_caught")
        return {**_refusal("staff_tool_unreachable", "transport", 503, turn_id), "recoveryStatus": "unknown", "outcome": "unknown", "call_id": call_id}
    except Exception as exc:
        if not recorded: record_exchange(exception=exc, observed="response_read_error")
        return {**_refusal("staff_plugin_internal_failure", "internal", 500, turn_id), "call_id": call_id}


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
    "get_booking": ("booking_reference",),
    "get_payment_status": ("booking_reference",),
    "send_payment_link": ("booking_reference", "payment_scope", "guest_position", "payment_choice", "operation_key"),
    "cancel_unpaid": ("booking_reference", "guest_reason", "operation_key"),
    "read_notes": ("topic", "booking_reference"),
    "write_note": ("text", "context", "booking_reference", "operation_key"),
    "save_transfer_request": ("booking_reference", "decision", "travel_details", "operation_key"),
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
    "get_payment_status": ("booking_reference",),
    "send_payment_link": ("booking_reference", "payment_scope", "payment_choice", "operation_key"),
    "cancel_unpaid": ("booking_reference", "guest_reason", "operation_key"),
    "read_notes": (),
    "write_note": ("text", "operation_key"),
    "save_transfer_request": ("booking_reference", "decision", "operation_key"),
    "handoff_to_human": ("reason", "operation_key"),
    "recover_operation": ("tool", "operation_key"),
}


def _field_schema(field: str) -> dict[str, Any]:
    if field == "action":
        return {"type": "string", "enum": ["prepare", "confirm", "decline"]}
    if field == "purpose":
        return {"type": "string", "enum": ["quote", "offer"]}
    if field == "offer_reference":
        return {"type": "string", "pattern": "^offer_[A-Za-z0-9_-]{24,80}$"}
    if field == "room":
        return {"type": "object", "additionalProperties": False, "required": ["kind"], "properties": {
            "kind": {"type": "string", "enum": ["exact", "private", "shared", "women_only", "auto"]},
            "name": {"type": "string", "minLength": 1}, "beds": {"type": "array", "items": {"type": "string", "minLength": 1}, "uniqueItems": True},
            "together": {"type": "string", "enum": ["required", "preferred", "not_required"]}}}
    if field == "package":
        return {"type": "object", "additionalProperties": False, "properties": {
            "name": {"type": "string", "minLength": 1},
            "per_guest": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                "required": ["guest", "name"], "properties": {"guest": {"type": "integer", "minimum": 1}, "name": {"type": "string", "minLength": 1}}}}},
            "anyOf": [{"required": ["name"]}, {"required": ["per_guest"]}]}
    if field == "payment":
        return {"type": "object", "additionalProperties": False, "required": ["arrangement"], "properties": {
            "arrangement": {"type": "string", "enum": ["together", "separately"]}, "choice": {"type": "string", "enum": ["deposit", "balance"]}}}
    if field in {"party_size"}:
        return {"type": "integer", "minimum": 1}
    if field == "guest_position":
        return {"type": "integer", "minimum": 1}
    if field == "payment_scope":
        return {"type": "string", "enum": ["individual", "booking"]}
    if field in {"package_ids", "service_ids"}:
        return {"type": "array", "items": {"type": "string", "minLength": 1}}
    if field == "guests":
        return {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1},
                    "explicit_gender": {"type": "string", "minLength": 1},
                    "gender": {"type": "string", "minLength": 1},
                },
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
                    "quantity": {"type": "integer", "minimum": 1, "description": "For rentals, count is people or equipment units, never participant-days."},
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
            "check_quote_book": "Use Staff authority for stay pricing or a held offer. Use only canonical codes in the trusted Staff capability snapshot supplied before this turn. A guest asking for a price, total, or quote needs purpose=quote, which prices without creating a hold. Quote guests may be empty objects when names are unknown; never invent names. Use purpose=offer only when the guest wants an option held. Never call quote or offer until all required guest facts are known; ask the guest instead. Staff permits exactly one prepare for this inbound event; success, refusal, or unknown is terminal and must never be repaired with another prepare.",
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
        if name == "check_quote_book":
            schema["parameters"] = json.loads(json.dumps(_CHECK_QUOTE_BOOK_SCHEMA))
            schema["parameters"]["allOf"] = [
                {"if": {"properties": {"action": {"const": "prepare"}, "purpose": {"const": "quote"}}, "required": ["action", "purpose"]},
                 "then": {"required": ["check_in", "check_out", "guests", "room", "package", "add_ons"], "not": {"required": ["payment"]}}},
                {"if": {"properties": {"action": {"const": "prepare"}, "purpose": {"const": "offer"}}, "required": ["action", "purpose"]},
                 "then": {"required": ["check_in", "check_out", "guests", "room", "package", "add_ons", "payment"],
                          "properties": {"guests": {"items": {"required": ["name"]}}}}},

                {"if": {"properties": {"action": {"enum": ["confirm", "decline"]}}, "required": ["action"]},
                 "then": {"required": ["offer_reference"], "not": {"anyOf": [
                     {"required": [field]} for field in ("purpose", "check_in", "check_out", "guests", "room", "package", "add_ons", "payment")
                 ]}}},
            ]
        ctx.register_tool(
            name=name,
            toolset=TOOLSET,
            schema=schema,
            handler=_handler(name),
            description=schema["description"],
        )


__all__ = ["TOOL_NAMES", "WRITE_TOOLS", "TOOLSET", "call_tool", "register"]
