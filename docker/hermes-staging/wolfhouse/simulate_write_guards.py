"""Map Staff API bot paths and block/redirect writes during simulate turns."""

from __future__ import annotations

import copy
import json
import os
import re
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

_PREVIEW_PATH = "/staff/bot/booking-preview"
_ADDON_PREVIEW = "/staff/bot/addon-request-preview"
WOLFHOUSE_STAGING_BOOKING_CAPABILITY = "wolfhouse_staging_booking_test_link"
_APPROVED_WOLFHOUSE_STAGING_STAFF_ORIGIN = "https://staff-staging.lunafrontdesk.com"
_APPROVED_WOLFHOUSE_STAGING_PAY_ORIGIN = "https://staff-staging.lunafrontdesk.com"
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.I,
)
_WOLFHOUSE_READ_FRAGMENTS = (
    "availability-check",
    "booking-preview",
    "surf-report",
    "/catalog",
    "bookings/by-phone",
    "payments/status",
    "booking-guests/payment-status",
)

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
    "sunset/booking-create": "create_sunset_booking",
    "sunset/payment-link": "create_sunset_payment_link",
    "sunset/lesson-quote": "get_sunset_group_lesson_quote",
    "sunset/lesson-availability": "get_sunset_lesson_availability",
    "sunset/rental-price": "get_sunset_rental_price",
    "sunset/full-day-addon": "get_sunset_full_day_equipment_addon",
    "sunset/private-lesson": "get_sunset_private_lesson",
    "sunset/bookings-by-phone": "list_sunset_bookings",
}


def is_simulate_write_blocked(warnings: List[str]) -> bool:
    return any(str(w or "").startswith("blocked") for w in (warnings or []))


def synthetic_blocked_result(path: str, guard_warnings: List[str], *, allow_writes: bool) -> Dict[str, Any]:
    """Deterministic tool failure when simulate mode blocks a write route."""
    tool = tool_name_from_path(path)
    if any("blocked_sunset_booking" in w for w in guard_warnings):
        error = "Sunset booking writes are disabled in simulate mode"
    elif any("blocked_sunset_payment" in w or "blocked_payment" in w for w in guard_warnings):
        error = "Sunset payment writes are disabled in simulate mode (use --allow-writes)"
    elif any("blocked_booking_mutation" in w for w in guard_warnings):
        error = "Booking mutation writes are disabled in simulate mode"
    else:
        error = "Write disabled in simulate mode (use --allow-writes)"
    return {
        "success": False,
        "simulate_write_blocked": True,
        "allow_writes": allow_writes,
        "tool": tool,
        "error": error,
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
        "simulate_write_blocked",
        "intentional_capability_block",
        "outcome",
        "capability_admitted",
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


def _origin(value: Any) -> str:
    return str(value or "").strip().rstrip("/").lower()


def _uuid_after(norm: str, marker: str) -> str:
    low = norm.lower()
    idx = low.find(marker)
    if idx < 0:
        return ""
    token = norm[idx + len(marker):].split("/", 1)[0].strip()
    return token.lower() if _UUID_RE.fullmatch(token) else ""


def _owned(ids: Optional[Iterable[str]]) -> set[str]:
    return {str(item or "").strip().lower() for item in (ids or []) if str(item or "").strip()}


def evaluate_wolfhouse_staging_booking_capability(
    *,
    scope_active: bool,
    scope_revoked: bool = False,
    env: Optional[Mapping[str, str]] = None,
) -> Dict[str, Any]:
    """Server-owned Wolfhouse Live Sim booking admission. Ignores request JSON.

    Missing or conflicting evidence stays denied. This function never rewrites
    process environment, and port / NODE_ENV alone are not staging proof.
    The receipt names mode and origins only — never a Stripe secret.
    """
    source = env if env is not None else os.environ
    reasons: List[str] = []
    if not scope_active:
        reasons.append("simulator_provenance_missing")
    if scope_revoked:
        reasons.append("request_scope_revoked")
    if str(source.get("HERMES_ROLE") or "").strip() != "luna":
        reasons.append("wolfhouse_runner_role_missing")
    if str(source.get("LUNA_TENANT_ID") or "").strip() != "wolfhouse-somo":
        reasons.append("wolfhouse_tenant_mismatch")
    if str(source.get("LUNA_CLIENT_SLUG") or "").strip() != "wolfhouse-somo":
        reasons.append("wolfhouse_client_mismatch")

    staff = _origin(source.get("WOLFHOUSE_STAFF_API_BASE_URL"))
    if not staff:
        reasons.append("staff_destination_missing")
    elif staff != _APPROVED_WOLFHOUSE_STAGING_STAFF_ORIGIN:
        reasons.append("staff_destination_not_approved_staging")

    pay = _origin(source.get("PUBLIC_PAYMENT_BASE_URL"))
    if not pay:
        reasons.append("public_pay_origin_missing")
    elif pay != _APPROVED_WOLFHOUSE_STAGING_PAY_ORIGIN:
        reasons.append("public_pay_origin_not_approved_staging")

    if str(source.get("BOT_BOOKING_ENABLED") or "").strip() != "true":
        reasons.append("bot_booking_disabled")

    stripe_key = str(source.get("STRIPE_SECRET_KEY") or "")
    stripe_mode = str(source.get("WOLFHOUSE_STRIPE_MODE") or source.get("STRIPE_MODE") or "").strip().lower()
    if stripe_key.startswith("sk_live_") or stripe_mode == "live":
        reasons.append("live_stripe_key_blocked")
    elif not stripe_key.startswith("sk_test_") and stripe_mode != "test":
        reasons.append("test_payment_config_missing")

    admitted = not reasons
    if stripe_key.startswith("sk_live_") or stripe_mode == "live":
        mode = "live"
    elif stripe_key.startswith("sk_test_") or stripe_mode == "test":
        mode = "test"
    else:
        mode = "unknown"
    return {
        "capability": WOLFHOUSE_STAGING_BOOKING_CAPABILITY,
        "admitted": admitted,
        "reasons": reasons,
        "staff_origin": staff or None,
        "pay_origin": pay or None,
        "stripe_mode": mode,
        "outcome": "ADMITTED" if admitted else "INTENTIONALLY_BLOCKED",
    }


def _capability_admitted(capability: Optional[Dict[str, Any]]) -> bool:
    return bool(
        isinstance(capability, dict)
        and capability.get("admitted") is True
        and capability.get("capability") == WOLFHOUSE_STAGING_BOOKING_CAPABILITY
    )


def _deny(norm: str, body: Dict[str, Any], warning: str) -> Tuple[str, Dict[str, Any], List[str]]:
    return norm, body, [warning]


def _route_admitted_wolfhouse_staging(
    norm: str,
    body: Dict[str, Any],
    *,
    owned_payment_ids: Optional[Iterable[str]] = None,
    owned_guest_ids: Optional[Iterable[str]] = None,
) -> Tuple[str, Dict[str, Any], List[str]]:
    """Closed route set. Never a blanket allow_writes bypass."""
    routed = copy.deepcopy(body)
    routed.pop("allow_writes", None)
    routed.pop("wolfhouse_staging_capability", None)
    payments = _owned(owned_payment_ids)
    guests = _owned(owned_guest_ids)

    if "create-balance-link" in norm:
        return _deny(norm, routed, "blocked_balance_link_not_admitted")
    if "create-stripe-link" in norm:
        payment_id = _uuid_after(norm, "/payments/")
        if payment_id and payment_id in payments:
            return norm, routed, ["allowed_wolfhouse_staging_test_link"]
        return _deny(norm, routed, "blocked_foreign_payment_uuid")
    if "booking-guests/" in norm and "create-payment-link" in norm:
        guest_id = _uuid_after(norm, "/booking-guests/")
        if guest_id and guest_id in guests:
            return norm, routed, ["allowed_wolfhouse_staging_guest_test_link"]
        return _deny(norm, routed, "blocked_foreign_guest_uuid")
    if "booking-create-from-plan" in norm or norm.endswith("/bookings/create"):
        return norm, routed, ["allowed_wolfhouse_staging_booking_create"]
    if "transfers/save" in norm:
        return _deny(norm, routed, "blocked_transfer_not_admitted")
    if any(frag in norm for frag in ("update-contact", "guest-packages")):
        return _deny(norm, routed, "blocked_booking_mutation_in_simulate")
    if "addon-requests/create" in norm:
        return _deny(norm, routed, "blocked_addon_not_admitted")
    if "sunset/booking-create" in norm:
        return _deny(norm, routed, "blocked_sunset_booking_write_in_simulate")
    if "sunset/payment-link" in norm:
        return _deny(norm, routed, "blocked_sunset_payment_write_in_simulate")
    if "waiver-link" in norm:
        return _deny(norm, routed, "blocked_sunset_waiver_write_in_simulate")
    if any(frag in norm for frag in _WOLFHOUSE_READ_FRAGMENTS) and "create" not in norm:
        return norm, routed, []
    return _deny(norm, routed, "blocked_unlisted_wolfhouse_sim_write")


def collect_owned_simulator_ids(result: Any) -> Tuple[set[str], set[str]]:
    """Payment and guest UUIDs created by this synthetic session, not caller-supplied phones."""
    payments: set[str] = set()
    guests: set[str] = set()
    if not isinstance(result, dict):
        return payments, guests
    payment_id = str(result.get("payment_id") or "").strip().lower()
    if _UUID_RE.fullmatch(payment_id):
        payments.add(payment_id)
    rows = result.get("booking_guests") or []
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            guest_id = str(row.get("booking_guest_id") or row.get("id") or "").strip().lower()
            if _UUID_RE.fullmatch(guest_id):
                guests.add(guest_id)
            nested_payment = str(row.get("payment_id") or "").strip().lower()
            if _UUID_RE.fullmatch(nested_payment):
                payments.add(nested_payment)
    return payments, guests


def guard_bot_path_and_payload(
    path: str,
    payload: Dict[str, Any],
    *,
    allow_writes: bool,
    booking_only_mode: str = "",
    synthetic_identity: str = "",
    wolfhouse_capability: Optional[Dict[str, Any]] = None,
    owned_payment_ids: Optional[Iterable[str]] = None,
    owned_guest_ids: Optional[Iterable[str]] = None,
) -> Tuple[str, Dict[str, Any], List[str]]:
    """Return (path, payload, warnings). Redirect write routes to preview when writes disabled.

    ``booking_only_mode='sunset_booking_only'`` is narrower than allow_writes:
    it permits only Sunset's existing booking-create bot path. Production still
    needs the existing BOT_BOOKING_ENABLED gate; isolated simulator runtimes may
    opt in with SUNSET_SIMULATOR_BOOKING_ENABLED=true. Payments, waivers, sends,
    and unrelated mutations remain blocked.
    """
    warnings: List[str] = []
    if allow_writes:
        return path, payload, warnings

    norm = _norm_path(path)
    body = copy.deepcopy(payload or {})
    simulator_booking_flag = os.getenv("BOT_BOOKING_ENABLED") == "true" or os.getenv("SUNSET_SIMULATOR_BOOKING_ENABLED") == "true"
    sunset_booking_only = (
        booking_only_mode == "sunset_booking_only"
        and simulator_booking_flag
    )
    sunset_isolated = (
        booking_only_mode == "sunset_isolated"
        and os.getenv("BOT_BOOKING_ENABLED") == "true"
        and bool(str(synthetic_identity or "").strip())
    )
    if booking_only_mode == "sunset_isolated":
        supplied_identity = str(body.get("guest_phone") or synthetic_identity or "").strip()
        if not sunset_isolated or supplied_identity != str(synthetic_identity).strip():
            warnings.append("blocked_sunset_isolated_identity_mismatch")
            return norm, body, warnings
        body["guest_phone"] = str(synthetic_identity).strip()
        body["simulator_isolated_mode"] = True

    if _capability_admitted(wolfhouse_capability) and not str(booking_only_mode or "").strip():
        return _route_admitted_wolfhouse_staging(
            norm,
            body,
            owned_payment_ids=owned_payment_ids,
            owned_guest_ids=owned_guest_ids,
        )

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

    if "sunset/booking-create" in norm:
        if sunset_isolated:
            warnings.append("allowed_sunset_isolated_booking")
            body["simulator_booking_only_mode"] = True
            return norm, body, warnings
        if sunset_booking_only:
            warnings.append("allowed_sunset_booking_only_write_in_simulate")
            body["simulator_booking_only_mode"] = True
            return norm, body, warnings
        if booking_only_mode == "sunset_booking_only":
            warnings.append("blocked_sunset_booking_write_bot_booking_disabled")
        else:
            warnings.append("blocked_sunset_booking_write_in_simulate")
        return norm, body, warnings

    if any(frag in norm for frag in ("sunset/payment-link", "sunset/payment-link/")):
        if sunset_isolated:
            warnings.append("allowed_sunset_isolated_test_payment")
            return norm, body, warnings
        warnings.append("blocked_sunset_payment_write_in_simulate")
        return norm, body, warnings

    # Waiver link generation mutates/registration state — fail closed without writes.
    if "sunset/waiver-link" in norm or "waiver-link" in norm:
        if sunset_isolated:
            warnings.append("allowed_sunset_isolated_waiver")
            return norm, body, warnings
        warnings.append("blocked_sunset_waiver_write_in_simulate")
        return norm, body, warnings

    if "sunset/payment-status" in norm and sunset_isolated:
        warnings.append("allowed_sunset_isolated_payment_status")
        return norm, body, warnings

    return norm, body, warnings
