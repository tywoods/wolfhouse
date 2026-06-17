"""Map Staff API bot paths and block/redirect writes during simulate turns."""

from __future__ import annotations

import copy
import json
from typing import Any, Dict, List, Tuple

_PREVIEW_PATH = "/staff/bot/booking-preview"
_ADDON_PREVIEW = "/staff/bot/addon-request-preview"

_PATH_TOOL_NAMES = {
    "availability-check": "check_availability",
    "booking-preview": "quote_booking",
    "booking-create-from-plan": "create_booking_from_plan",
    "bookings/create": "create_booking_from_plan",
    "addon-request-preview": "add_service_to_booking",
    "addon-requests/create": "add_service_to_booking",
    "payments/status": "get_payment_status",
    "create-stripe-link": "create_payment_link",
    "create-balance-link": "create_balance_payment_link",
    "guest-packages": "update_guest_packages",
    "transfers/save": "save_transfer_request",
    "surf-report": "get_surf_report",
    "bookings/by-phone": "list_my_bookings",
    "update-contact": "update_booking_contact",
    "needs-human": "flag_needs_human",
}


def tool_name_from_path(path: str) -> str:
    p = str(path or "").strip().lower().lstrip("/")
    if p.startswith("staff/bot/"):
        p = p[len("staff/bot/") :]
    for key, name in _PATH_TOOL_NAMES.items():
        if key in p:
            return name
    tail = p.split("/")[-1] if p else "unknown"
    return tail.replace("-", "_")


def summarize_tool_result(result: Any, max_len: int = 400) -> str:
    if not isinstance(result, dict):
        return str(result)[:max_len]
    bits: List[str] = []
    for key in (
        "success",
        "next_action",
        "quote_status",
        "availability_status",
        "booking_code",
        "payment_id",
        "error",
        "staff_review_needed",
        "write_performed",
        "unknown_add_on_codes",
    ):
        if key in result and result[key] not in (None, "", []):
            val = result[key]
            if isinstance(val, (dict, list)):
                val = json.dumps(val, ensure_ascii=False)[:120]
            bits.append(f"{key}={val}")
    if not bits:
        bits.append(f"keys={','.join(sorted(result.keys())[:8])}")
    return "; ".join(bits)[:max_len]


def _norm_path(path: str) -> str:
    norm = "/" + str(path or "").strip().lstrip("/")
    if not norm.startswith("/staff/bot/"):
        norm = "/staff/bot/" + norm.strip("/")
    return norm


def guard_bot_path_and_payload(path: str, payload: Dict[str, Any], *, allow_writes: bool) -> Tuple[str, Dict[str, Any], List[str]]:
    """Return (path, payload, warnings). Redirect write routes to preview when writes disabled."""
    warnings: List[str] = []
    if allow_writes:
        return path, payload, warnings

    norm = _norm_path(path)
    body = copy.deepcopy(payload or {})

    if "booking-create-from-plan" in norm or norm.endswith("/bookings/create"):
        warnings.append("redirected_create_to_booking_preview")
        body.pop("confirm", None)
        return _PREVIEW_PATH, body, warnings

    if "addon-requests/create" in norm:
        warnings.append("redirected_addon_create_to_preview")
        body.pop("confirm", None)
        return _ADDON_PREVIEW, body, warnings

    if any(
        frag in norm
        for frag in (
            "create-stripe-link",
            "create-balance-link",
            "payments/create",
        )
    ):
        warnings.append("blocked_payment_write_in_simulate")
        return norm, body, warnings

    if "transfers/save" in norm:
        body["confirm_transfer_write"] = False
        warnings.append("transfer_write_disabled")

    if any(frag in norm for frag in ("update-contact", "guest-packages")):
        warnings.append("blocked_booking_mutation_in_simulate")
        body["simulate_write_blocked"] = True

    return norm, body, warnings
