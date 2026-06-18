"""Wolfhouse Staff API tools for guest-facing Agent Luna.

These tools are intentionally thin wrappers around Staff API /staff/bot/*
routes. They do not calculate availability, prices, payment truth, or booking
state locally — Staff API remains the source of truth.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import hashlib

# Fail-open input validation (step 3). Defensive import so a missing/broken module
# can never disable the tools — it just disables pre-validation.
try:
    from .input_guard import guard_tool_input  # type: ignore
except Exception:  # pragma: no cover
    try:
        from wolfhouse_staff_api.input_guard import guard_tool_input  # type: ignore
    except Exception:
        def guard_tool_input(_tool_name, _params):
            return True, None

DEFAULT_BASE_URL = "https://staff-staging.lunafrontdesk.com"
TOOLSET = "wolfhouse_staff_api"

GUEST_UNSAFE_TERMS = {
    "stripe": "payment provider",
    "api": "system",
    "webhook": "payment update",
    "database": "system",
    "postgres": "system",
}


def _clean(value):
    if value is None:
        return ""
    return str(value).strip()


def _normalize_phone(value):
    raw = _clean(value)
    if not raw:
        return ""
    digits = "".join(ch for ch in raw if ch.isdigit())
    return f"+{digits}" if digits else ""


def _normalize_payment_choice(value):
    raw = _clean(value).lower()
    if not raw:
        return "deposit"
    compact = re.sub(r"[^a-z0-9]+", " ", raw).strip()
    if compact in {"full", "full amount", "pay full", "pay full amount", "all", "all now", "pay all", "everything", "whole amount"}:
        return "full"
    if compact in {"deposit", "pay deposit", "the deposit", "deposit only"}:
        return "deposit"
    if compact in {"arrival", "on arrival", "pay on arrival", "later"}:
        return "pay_on_arrival"
    return raw


def _session_guest_phone():
    """Best-effort WhatsApp sender phone from Hermes gateway context.

    Luna should not have to invent/pass the WhatsApp sender number. The
    gateway binds per-turn source identifiers in contextvars; for WhatsApp
    these are the guest's phone-like user/chat ids. Some tool execution paths
    can lose contextvars, so Wolfhouse gateway patches also export a per-turn
    process-env fallback.
    """
    for key in (
        "WOLFHOUSE_WHATSAPP_GUEST_PHONE",
        "WHATSAPP_GUEST_PHONE",
        "HERMES_SESSION_USER_ID",
        "HERMES_SESSION_CHAT_ID",
    ):
        phone = _normalize_phone(os.getenv(key, ""))
        if phone:
            return phone
    try:
        from gateway.session_context import get_session_env
    except Exception:
        return ""
    platform = _clean(get_session_env("HERMES_SESSION_PLATFORM", "")).lower()
    if platform not in {"whatsapp", "whatsapp_cloud"}:
        return ""
    for key in ("HERMES_SESSION_USER_ID", "HERMES_SESSION_CHAT_ID"):
        phone = _normalize_phone(get_session_env(key, ""))
        if phone:
            return phone
    return ""


def _base_url():
    return (os.getenv("WOLFHOUSE_STAFF_API_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def _bot_token():
    return _clean(os.getenv("LUNA_BOT_INTERNAL_TOKEN"))


def _safe_text(text):
    out = _clean(text)
    for term, replacement in GUEST_UNSAFE_TERMS.items():
        out = re.sub(rf"\b{re.escape(term)}\b", replacement, out, flags=re.I)
    return out[:500]


def _normalize_bot_path(path):
    p = _clean(path)
    if not p:
        raise ValueError("bot_path_required")
    if p.startswith("http://") or p.startswith("https://"):
        return p
    p = p.lstrip("/")
    if p.startswith("staff/bot/"):
        return "/" + p
    if p.startswith("bot/"):
        return "/staff/" + p
    return "/staff/bot/" + p


def _post_bot(path, payload):
    token = _bot_token()
    if not token:
        return {
            "success": False,
            "staff_api_status": "not_configured",
            "staff_review_needed": True,
            "guest_safe_next_action": "Thanks — I’m going to have the team double-check this and get back to you shortly 😊",
            "error": "LUNA_BOT_INTERNAL_TOKEN is not configured for Agent Luna.",
        }

    url_path = _normalize_bot_path(path)
    url = url_path if url_path.startswith(("http://", "https://")) else _base_url() + url_path
    body = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Luna-Bot-Token": token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as res:
            text = res.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(text or "{}")
            except json.JSONDecodeError:
                data = {"raw": text}
            if isinstance(data, dict):
                data.setdefault("success", True)
                data.setdefault("staff_api_status", "ok")
                return data
            return {"success": True, "staff_api_status": "ok", "data": data}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(text or "{}")
        except json.JSONDecodeError:
            data = {"error": text}
        return {
            "success": False,
            "staff_api_status": "http_error",
            "status": exc.code,
            "staff_review_needed": True,
            "guest_safe_next_action": "Thanks — I’m going to have the team double-check this and get back to you shortly 😊",
            "error": _safe_text(data.get("error") or data.get("message") or str(exc)),
        }
    except Exception as exc:  # network/config safety; never crash the guest agent
        return {
            "success": False,
            "staff_api_status": "unavailable",
            "staff_review_needed": True,
            "guest_safe_next_action": "Thanks — I’m going to have the team double-check this and get back to you shortly 😊",
            "error": _safe_text(str(exc)),
        }


def _json_result(payload):
    return json.dumps(payload, ensure_ascii=False)


def _availability_status(data):
    if not data.get("success"):
        return "unclear"
    if data.get("has_enough_beds") is True:
        return "available"
    if data.get("has_enough_beds") is False:
        return "unavailable"
    return data.get("availability_status") or "unclear"


def check_availability(params, **kwargs):
    del kwargs
    _ok, _err = guard_tool_input("check_availability", params)
    if not _ok:
        return _json_result({
            "success": False,
            "tool": "check_availability",
            "input_error": _err.get("code"),
            "staff_review_needed": False,
            "guest_safe_next_action": _err.get("message"),
        })
    payload = {
        "client_slug": params.get("client_slug") or "wolfhouse-somo",
        "check_in": params.get("check_in"),
        "check_out": params.get("check_out"),
        "guest_count": params.get("guest_count"),
        "room_type": params.get("room_type") or params.get("stay_preference") or "shared",
    }
    data = _post_bot("/availability-check", payload)
    status = _availability_status(data)
    return _json_result({
        "success": bool(data.get("success")),
        "tool": "check_availability",
        "availability_status": status,
        "available": status == "available",
        "unavailable": status == "unavailable",
        "unclear": status == "unclear",
        "staff_review_needed": status == "unclear" or bool(data.get("staff_review_needed")),
        "selected_bed_codes": data.get("selected_bed_codes") or [],
        "available_count": data.get("available_count"),
        "girls_room_available": data.get("girls_room_available"),
        "private_room_available": data.get("private_room_available"),
        "room_options": data.get("room_options") or {},
        "warnings": data.get("warnings") or [],
        "blockers": data.get("blockers") or [],
        "next_action": data.get("next_action"),
        "guest_safe_next_action": data.get("guest_safe_next_action"),
    })


def quote_booking(params, **kwargs):
    del kwargs
    _ok, _err = guard_tool_input("quote_booking", params)
    if not _ok:
        return _json_result({
            "success": False,
            "tool": "quote_booking",
            "input_error": _err.get("code"),
            "quote_status": "needs_guest_clarification",
            "staff_review_needed": False,
            "guest_safe_next_action": _err.get("message"),
        })
    payload = dict(params or {})
    payload.setdefault("client_slug", "wolfhouse-somo")
    payload.setdefault("source", "agent_luna_whatsapp")
    data = _post_bot("/booking-preview", payload)
    quote = data.get("quote") if isinstance(data.get("quote"), dict) else {}
    total = data.get("quote_total_cents") or quote.get("total_cents") or data.get("total_cents")
    deposit = data.get("deposit_required_cents") or quote.get("deposit_required_cents")
    balance = data.get("balance_due_cents") or quote.get("balance_due_cents")
    remaining_after_deposit = None
    if total is not None and deposit is not None:
        try:
            remaining_after_deposit = max(0, int(total) - int(deposit))
        except Exception:
            remaining_after_deposit = None
    payment_choice_needed = (
        remaining_after_deposit is not None and remaining_after_deposit > 0
    )
    unknown_codes = data.get("unknown_add_on_codes") or []
    if not isinstance(unknown_codes, list):
        unknown_codes = []
    next_action = data.get("next_action")
    closed_season = next_action == "closed_season"
    return _json_result({
        "success": bool(data.get("success")) and not unknown_codes and not closed_season,
        "tool": "quote_booking",
        "quote_status": data.get("quote_status") or next_action or ("ready" if total else "unclear"),
        "total_cents": total,
        "deposit_required_cents": deposit,
        "balance_due_cents": balance,
        "remaining_after_deposit_cents": remaining_after_deposit,
        "payment_choice_needed": payment_choice_needed,
        "full_payment_only": not payment_choice_needed and total is not None and deposit is not None,
        "guest_safe_balance_label": "remaining after deposit",
        "currency": data.get("currency") or quote.get("currency") or "EUR",
        "included_items": data.get("included_items") or quote.get("included_items") or [],
        "missing_fields": data.get("missing_fields") or [],
        "unknown_add_on_codes": unknown_codes,
        "add_on_errors": data.get("add_on_errors") or [],
        "reply_draft": data.get("reply_draft"),
        "staff_review_needed": (
            (bool(data.get("staff_review_needed")) or next_action in ("staff_review_required", "invalid_add_ons") or bool(unknown_codes))
            and not closed_season
        ),
        "guest_safe_next_action": data.get("guest_safe_next_action") or (data.get("reply_draft") if closed_season else None),
    })


def _extract_booking_write_fields(data):
    """Flatten booking-create-from-plan bridge payload for tool callers."""
    if not isinstance(data, dict):
        return {}
    cr = data.get("create_outcome")
    create_response = cr.get("create_response") if isinstance(cr, dict) else {}
    if not isinstance(create_response, dict):
        create_response = {}
    return {
        "booking_id": data.get("booking_id") or create_response.get("booking_id"),
        "booking_code": data.get("booking_code") or create_response.get("booking_code"),
        "payment_id": data.get("payment_id") or create_response.get("payment_id"),
        "payment_status": data.get("payment_status") or create_response.get("payment_status"),
    }


def _guest_payment_url(data):
    if not isinstance(data, dict):
        return None
    for key in ("guest_payment_url", "payment_short_url", "checkout_url"):
        val = _clean(data.get(key))
        if val:
            return val
    return None


def _auto_save_pending_transfers(payload, booking_id, booking_code):
    """Persist transfer details collected earlier in the booking flow.

    Transfers are usually collected (Step 4) BEFORE the booking exists, so the
    first save_transfer_request returns transfer_collected_for_later with no
    write. Relying on the model to re-call save_transfer_request after the
    booking is created is unreliable across turns (the #1 cause of "shuttle
    noted but never saved to the portal"). So create_booking_from_plan accepts
    the collected transfer(s) and saves them here deterministically with
    confirm_transfer_write forced true.

    Accepts either payload['pending_transfers'] (list) or a single
    payload['pending_transfer'] (dict). Each entry needs at least a direction;
    airport/scheduled_at/flight_number/notes are optional. Returns a list of
    per-direction result dicts (best-effort; never raises).
    """
    raw = payload.get("pending_transfers")
    if not raw and payload.get("pending_transfer"):
        raw = [payload.get("pending_transfer")]
    if not isinstance(raw, list) or not raw:
        return []
    client_slug = payload.get("client_slug") or "wolfhouse-somo"
    results = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        direction = _clean(entry.get("direction")) or "arrival"
        tpayload = {
            "client_slug": client_slug,
            "source": "agent_luna_whatsapp",
            "confirm_transfer_write": True,
            "direction": direction,
        }
        if booking_id:
            tpayload["booking_id"] = booking_id
        if booking_code:
            tpayload["booking_code"] = booking_code
        airport = _clean(entry.get("airport") or entry.get("arrival_airport_or_city") or entry.get("airport_or_city"))
        if airport:
            tpayload["airport"] = airport
        scheduled = _clean(
            entry.get("scheduled_at")
            or entry.get("transfer_datetime")
            or entry.get("arrival_datetime")
            or entry.get("departure_datetime")
        )
        if scheduled:
            tpayload["scheduled_at"] = scheduled
        for opt in ("flight_number", "notes", "guest_count", "luggage_or_surfboards"):
            if entry.get(opt) not in (None, ""):
                tpayload[opt] = entry.get(opt)
        try:
            tdata = _post_bot("/transfers/save", tpayload)
            transfer = tdata.get("transfer") if isinstance(tdata.get("transfer"), dict) else {}
            results.append({
                "direction": direction,
                "write_performed": bool(tdata.get("write_performed")) or (bool(tdata.get("success")) and bool(transfer.get("id"))),
                "success": bool(tdata.get("success")),
            })
        except Exception as exc:  # never block the booking/payment flow on a transfer save
            results.append({"direction": direction, "write_performed": False, "success": False, "error": _safe_text(str(exc))})
    return results


def create_booking_from_plan(params, **kwargs):
    del kwargs
    payload = dict(params or {})
    payload.setdefault("client_slug", "wolfhouse-somo")
    payload.setdefault("source", "agent_luna_whatsapp")

    # Auto-inject required write fields the model shouldn't need to know about.
    # confirm: true is the deliberate "guest accepted" signal the bridge requires.
    payload.setdefault("confirm", True)
    # Default/normalize payment_choice — guests say "full amount", Staff API expects "full".
    payload["payment_choice"] = _normalize_payment_choice(payload.get("payment_choice"))

    phone = _normalize_phone(payload.get("guest_phone") or payload.get("phone") or _session_guest_phone())
    if phone:
        payload["phone"] = phone
        payload["guest_phone"] = phone

    guest_name = _clean(
        payload.get("guest_name")
        or payload.get("name")
        or payload.get("booking_name")
        or payload.get("channel_guest_name")
        or payload.get("whatsapp_guest_name")
    )
    if not guest_name:
        return _json_result({
            "success": True,
            "tool": "create_booking_from_plan",
            "write_performed": False,
            "booking_not_created_yet": True,
            "next_action": "ask_guest_name",
            "guest_safe_next_action": "ask_guest_name",
            "missing_fields": ["guest_name"],
            "reply_draft": "Perfect — what name should I put the booking under?",
            "staff_review_needed": False,
            "do_not_escalate": True,
        })
    payload["guest_name"] = guest_name

    # Persist the guest's language on the booking so the post-payment confirmation
    # (built server-side from templates) goes out in the same language the booking
    # was made in, not a hardcoded English default. Stored as a short code (e.g. de).
    language = _clean(payload.get("language") or payload.get("guest_language"))
    if language:
        payload["language"] = language.lower()[:10]

    # Auto-fetch selected_bed_codes if Luna didn't pass them — required by Staff API
    if not payload.get("selected_bed_codes"):
        try:
            avail_data = _post_bot("/availability-check", {
                "client_slug": payload.get("client_slug", "wolfhouse-somo"),
                "check_in": payload.get("check_in"),
                "check_out": payload.get("check_out"),
                "guest_count": payload.get("guest_count", 1),
                "room_type": payload.get("room_type") or payload.get("room_preference") or "shared",
                **({"room_preference": payload.get("room_preference")} if payload.get("room_preference") else {}),
                **({"gender_preference": payload.get("gender_preference")} if payload.get("gender_preference") else {}),
                **({"group_gender": payload.get("group_gender")} if payload.get("group_gender") else {}),
            })
            bed_codes = avail_data.get("selected_bed_codes") or []
            if bed_codes:
                payload["selected_bed_codes"] = bed_codes
        except Exception:
            pass

    # Idempotency key: stable per (phone, check_in, check_out, package).
    # Prevents duplicate bookings if the model calls this twice.
    if not payload.get("idempotency_key"):
        key_parts = "|".join([
            str(payload.get("guest_phone") or payload.get("phone") or ""),
            str(payload.get("check_in") or ""),
            str(payload.get("check_out") or ""),
            str(payload.get("package_code") or ""),
            json.dumps(payload.get("guest_packages") or [], sort_keys=True),
            json.dumps(payload.get("add_ons") or [], sort_keys=True),
        ])
        payload["idempotency_key"] = "luna-" + hashlib.sha256(key_parts.encode()).hexdigest()[:16]

    # Short stays (<7 nights): accommodation-only — no weekly package, no shuttle.
    check_in = _clean(payload.get("check_in"))
    check_out = _clean(payload.get("check_out"))
    pkg = _clean(payload.get("package_code")).lower()
    if check_in and check_out:
        try:
            from datetime import date
            ci = date.fromisoformat(check_in[:10])
            co = date.fromisoformat(check_out[:10])
            nights = (co - ci).days
            if nights > 0 and nights < 7:
                payload["package_code"] = "package_none"
                if not payload.get("add_ons"):
                    payload.setdefault("add_ons", [])
                payload.pop("pending_transfers", None)
        except Exception:
            pass
    elif pkg in ("", "accommodation_only", "no_package"):
        payload["package_code"] = "package_none"

    data = _post_bot("/booking-create-from-plan", payload)
    fields = _extract_booking_write_fields(data)
    payment_id = _clean(fields.get("payment_id"))
    secure_url = None
    link_data = {}
    payment_link_error = None

    if bool(data.get("success")) and bool(data.get("write_performed")) and payment_id:
        link_payload = {"client_slug": payload.get("client_slug") or "wolfhouse-somo"}
        link_data = _post_bot(
            f"/payments/{urllib.parse.quote(payment_id)}/create-stripe-link",
            link_payload,
        )
        if link_data.get("success") and link_data.get("checkout_url"):
            secure_url = _guest_payment_url(link_data)
        else:
            payment_link_error = _safe_text(
                link_data.get("error") or link_data.get("message") or "payment_link_create_failed",
            )

    blocked_reasons = data.get("blocked_reasons") or []
    expected_missing = any(
        reason in {"guest_name_missing", "payment_choice_missing", "guest_phone_missing"}
        for reason in blocked_reasons
    ) or data.get("safe_next_step") in {"ask_missing_details", "ask_deposit_or_full_payment"}

    # Deterministically attach any transfer details the guest gave earlier in the
    # flow (collected before the booking existed). This removes the unreliable
    # "model remembers to re-call save_transfer_request after create" step.
    transfer_results = []
    if bool(data.get("success")) and bool(data.get("write_performed")):
        transfer_results = _auto_save_pending_transfers(
            payload,
            fields.get("booking_id"),
            fields.get("booking_code"),
        )

    return _json_result({
        "success": bool(data.get("success")),
        "tool": "create_booking_from_plan",
        "write_performed": bool(data.get("write_performed")),
        "booking_id": fields.get("booking_id"),
        "booking_code": fields.get("booking_code"),
        "payment_id": payment_id or None,
        "payment_status": fields.get("payment_status") or link_data.get("payment_status"),
        "secure_payment_url": secure_url,
        "payment_link_created": bool(secure_url),
        "payment_link_error": payment_link_error,
        "transfers_saved": [r for r in transfer_results if r.get("write_performed")],
        "transfer_save_results": transfer_results,
        "next_action": "send_secure_payment_link" if secure_url else data.get("next_action"),
        "staff_review_needed": (bool(data.get("staff_review_needed")) or not bool(data.get("success")) or (bool(data.get("write_performed")) and not secure_url)) and not expected_missing,
        "blocked_reasons": blocked_reasons,
        "safe_next_step": data.get("safe_next_step"),
        "reply_draft": data.get("reply_draft"),
        "do_not_escalate": expected_missing,
        "guest_safe_next_action": data.get("guest_safe_next_action"),
    })


def create_payment_link(params, **kwargs):
    del kwargs
    payload = dict(params or {})
    payment_id = _clean(params.get("payment_id") or params.get("paymentId") or params.get("id"))
    if not payment_id:
        lookup_payload = {
            "client_slug": payload.get("client_slug") or "wolfhouse-somo",
        }
        if payload.get("booking_id") or payload.get("bookingId"):
            lookup_payload["booking_id"] = payload.get("booking_id") or payload.get("bookingId")
        elif payload.get("booking_code"):
            lookup_payload["booking_code"] = payload.get("booking_code")
        if lookup_payload.get("booking_id") or lookup_payload.get("booking_code"):
            status_data = _post_bot("/payments/status", lookup_payload)
            latest = status_data.get("latest_payment") if isinstance(status_data.get("latest_payment"), dict) else {}
            payment_id = _clean(latest.get("payment_id") or status_data.get("payment_id"))
    if not payment_id:
        return _json_result({"success": False, "tool": "create_payment_link", "error": "payment_id_required", "staff_review_needed": True})
    data = _post_bot(f"/payments/{urllib.parse.quote(payment_id)}/create-stripe-link", dict(params or {}))
    guest_url = _guest_payment_url(data)

    # Graceful guard for a wrong id type. create_payment_link is ONLY for a
    # deposit/balance payment_id from create_booking_from_plan. If it is handed a
    # service_record_id (an add-on's id) or any non-payment id, the Staff API has
    # no draft payment for it and returns a bare 404 → staff_review_needed, which
    # made Luna tell the guest "small issue generating the link" even though the
    # add-on's link already existed in add_service_to_booking's result. Detect the
    # not-found and return a clear, non-escalating wrong_id_type guidance so a
    # future misfire self-corrects instead of dead-ending on the guest.
    err_text = str(data.get("error") or data.get("message") or "").lower()
    not_found = (
        not bool(data.get("success"))
        and not guest_url
        and (
            data.get("status") in (404, "404")
            or "not found" in err_text
            or "no payment" in err_text
            or "no draft" in err_text
        )
    )
    if not_found:
        return _json_result({
            "success": False,
            "tool": "create_payment_link",
            "error": "wrong_id_type",
            "wrong_id_type": True,
            "payment_id": payment_id,
            "guidance": (
                "No draft payment matches this id. Do NOT call create_payment_link for an "
                "add-on/service — after add_service_to_booking call create_balance_payment_link "
                "with the booking_code and send that balance link (covers all unpaid add-ons). "
                "create_payment_link only accepts a deposit/balance payment_id from create_booking_from_plan."
            ),
            "next_action": "create_balance_payment_link",
            "staff_review_needed": False,
            "do_not_escalate": True,
            "guest_safe_next_action": data.get("guest_safe_next_action"),
        })

    return _json_result({
        "success": bool(data.get("success")),
        "tool": "create_payment_link",
        "payment_id": data.get("payment_id") or payment_id,
        "booking_id": data.get("booking_id"),
        "booking_code": data.get("booking_code"),
        "amount_due_cents": data.get("amount_due_cents"),
        "currency": data.get("currency") or "EUR",
        "secure_payment_url": guest_url,
        "payment_short_url": data.get("payment_short_url"),
        "uses_short_payment_link": bool(data.get("uses_short_payment_link")),
        "payment_status": data.get("payment_status") or data.get("status"),
        "no_payment_truth_recorded": data.get("no_payment_truth_recorded", True),
        "next_action": data.get("next_action") or "send_secure_payment_link",
        "staff_review_needed": bool(data.get("staff_review_needed")) or not bool(data.get("success")),
        "guest_safe_next_action": data.get("guest_safe_next_action"),
    })


def create_balance_payment_link(params, **kwargs):
    del kwargs
    payload = dict(params or {})
    payload.setdefault("client_slug", "wolfhouse-somo")
    booking_id = _clean(payload.get("booking_id") or payload.get("bookingId"))
    booking_code = _clean(payload.get("booking_code") or payload.get("bookingCode"))
    if not booking_id and not booking_code:
        return _json_result({
            "success": False,
            "tool": "create_balance_payment_link",
            "error": "booking_id_or_code_required",
            "staff_review_needed": True,
        })
    if booking_id:
        payload["booking_id"] = booking_id
    if booking_code:
        payload["booking_code"] = booking_code
    data = _post_bot("/payments/create-balance-link", payload)
    guest_url = _guest_payment_url(data)
    err = _clean(data.get("error")).lower()
    reason = _clean(data.get("reason")).lower()
    no_balance = err in {"no_balance_due", "no_payment_due"} or reason == "no_balance_due"
    if no_balance:
        return _json_result({
            "success": False,
            "tool": "create_balance_payment_link",
            "error": "no_balance_due",
            "reason": "no_balance_due",
            "booking_id": data.get("booking_id"),
            "booking_code": data.get("booking_code"),
            "amount_cents": 0,
            "balance_due_cents": 0,
            "staff_review_needed": False,
            "do_not_escalate": True,
            "guest_safe_next_action": "Tell the guest their booking is already fully paid — nothing left to pay online.",
        })
    ok = bool(data.get("success")) and bool(guest_url)
    return _json_result({
        "success": ok,
        "tool": "create_balance_payment_link",
        "booking_id": data.get("booking_id"),
        "booking_code": data.get("booking_code"),
        "payment_id": data.get("payment_id"),
        "amount_cents": data.get("amount_due_cents") or data.get("balance_due_cents"),
        "amount_due_cents": data.get("amount_due_cents") or data.get("balance_due_cents"),
        "balance_due_cents": data.get("balance_due_cents") or data.get("amount_due_cents"),
        "currency": data.get("currency") or "EUR",
        "secure_payment_url": guest_url,
        "payment_short_url": data.get("payment_short_url"),
        "idempotent": data.get("idempotent"),
        "next_action": "send_secure_payment_link" if guest_url else data.get("next_action"),
        "staff_review_needed": bool(data.get("staff_review_needed")) or not ok,
        "guest_safe_next_action": data.get("guest_safe_next_action"),
    })


def get_payment_status(params, **kwargs):
    del kwargs
    payload = dict(params or {})
    payload.setdefault("client_slug", "wolfhouse-somo")
    data = _post_bot("/payments/status", payload)
    latest = data.get("latest_payment") if isinstance(data.get("latest_payment"), dict) else {}
    status = data.get("payment_status") or latest.get("payment_status") or latest.get("status")
    paid_confirmed = str(status or "").lower() in {"paid", "deposit_paid", "fully_paid"}
    return _json_result({
        "success": bool(data.get("success")),
        "tool": "get_payment_status",
        "payment_truth_known": bool(data.get("payment_truth_known")) or paid_confirmed,
        "payment_confirmed": paid_confirmed,
        "payment_status": status,
        "payment_id": data.get("payment_id") or latest.get("payment_id"),
        "booking_id": data.get("booking_id"),
        "booking_code": data.get("booking_code"),
        "amount_paid_cents": data.get("amount_paid_cents") or latest.get("amount_paid_cents"),
        "balance_due_cents": data.get("balance_due_cents"),
        "staff_review_needed": bool(data.get("staff_review_needed")) or not bool(data.get("success")),
        "guest_safe_next_action": data.get("guest_safe_next_action"),
    })


def get_surf_report(params, **kwargs):
    del kwargs
    payload = dict(params or {})
    payload.setdefault("client_slug", "wolfhouse-somo")
    day = str(payload.get("day") or "today").strip().lower()
    payload["day"] = "tomorrow" if day == "tomorrow" else "today"
    data = _post_bot("/surf-report", payload)
    reply = _clean(data.get("reply"))
    return _json_result({
        "success": bool(data.get("success")),
        "tool": "get_surf_report",
        # reply is guest-safe, on-tone copy — send it (or paraphrase lightly in your own voice).
        "reply": reply or None,
        "day": data.get("day") or payload["day"],
        "unavailable": bool(data.get("unavailable")),
        "next_action": "send_surf_report_reply",
        "guest_safe_next_action": reply or None,
        # Never escalate on a surf question — the reply already degrades gracefully.
        "staff_review_needed": False,
        "do_not_escalate": True,
    })


def list_my_bookings(params, **kwargs):
    del kwargs
    payload = dict(params or {})
    payload.setdefault("client_slug", "wolfhouse-somo")
    phone = _normalize_phone(payload.get("phone") or payload.get("guest_phone") or _session_guest_phone())
    if phone:
        payload["phone"] = phone
    data = _post_bot("/bookings/by-phone", payload)
    bookings = data.get("bookings") if isinstance(data.get("bookings"), list) else []
    return _json_result({
        "success": bool(data.get("success")),
        "tool": "list_my_bookings",
        "count": data.get("count") if data.get("count") is not None else len(bookings),
        # Each booking: {booking_code, check_in, check_out, guest_count, guest_name, status, payment_status}.
        # If more than one, list them (code + dates) and ask which before changing anything.
        "bookings": bookings,
        "staff_review_needed": False,
        "do_not_escalate": True,
    })


def update_booking_contact(params, **kwargs):
    del kwargs
    payload = dict(params or {})
    payload.setdefault("client_slug", "wolfhouse-somo")
    data = _post_bot("/bookings/update-contact", payload)
    return _json_result({
        "success": bool(data.get("success")),
        "tool": "update_booking_contact",
        "updated_fields": data.get("updated_fields") or [],
        "booking": data.get("booking"),
        "write_performed": bool(data.get("write_performed")),
        "staff_review_needed": bool(data.get("staff_review_needed")) or not bool(data.get("success")),
        "guest_safe_next_action": data.get("guest_safe_next_action"),
    })


def flag_needs_human(params, **kwargs):
    del kwargs
    payload = dict(params or {})
    payload.setdefault("client_slug", "wolfhouse-somo")
    phone = _normalize_phone(payload.get("phone") or payload.get("guest_phone") or _session_guest_phone())
    if phone:
        payload["phone"] = phone
    data = _post_bot("/conversation/needs-human", payload)
    return _json_result({
        "success": bool(data.get("success")),
        "tool": "flag_needs_human",
        "needs_human": bool(data.get("needs_human")),
        "conversation_id": data.get("conversation_id"),
        # This is a notify-staff flag, never a guest-facing error.
        "staff_review_needed": False,
        "do_not_escalate": True,
    })


def add_service_to_booking(params, **kwargs):
    del kwargs
    payload = dict(params or {})
    payload.setdefault("client_slug", "wolfhouse-somo")
    payload.setdefault("source", "agent_luna_whatsapp")
    # Call create route — this writes the service record to the DB.
    # Staff API handles pricing/payment eligibility internally.
    payload.setdefault("confirm", True)
    data = _post_bot("/addon-requests/create", payload)

    # The Staff API addon-create route generates the Stripe link inline and
    # returns it as checkout_url (and bakes it into reply_draft). Surface it as
    # secure_payment_url so Luna can send the link immediately — otherwise the
    # link is silently discarded and the guest is told there was "a small issue
    # generating the payment link" even though the record + link were created.
    secure_url = _guest_payment_url(data)
    payment_id = _clean(data.get("payment_id"))
    payment_required = data.get("payment_required")
    if payment_required is None:
        payment_required = (data.get("payment_preview") or {}).get("payment_required")
    write_ok = bool(data.get("write_performed")) or bool(data.get("idempotent"))
    needs_link = bool(payment_required)
    payment_link_error = None
    if needs_link and write_ok and not secure_url:
        payment_link_error = _safe_text(
            data.get("error") or data.get("message") or "payment_link_create_failed"
        )

    balance_link_next = bool(data.get("success")) and write_ok and needs_link
    addon_guidance = (
        "Post-booking add-on recorded. Call create_balance_payment_link with this booking_code, "
        "then send that secure_payment_url to the guest. One balance link covers all unpaid "
        "add-ons plus any remaining accommodation balance — do NOT send the per-service checkout URL."
    ) if balance_link_next else None

    return _json_result({
        "success": bool(data.get("success")),
        "tool": "add_service_to_booking",
        "service_status": data.get("service_status") or data.get("next_action"),
        "booking_id": data.get("booking_id"),
        "booking_code": data.get("booking_code"),
        "service_type": data.get("service_type"),
        "service_date": data.get("service_date"),
        "quantity": data.get("quantity"),
        "amount_due_cents": data.get("amount_due_cents"),
        "payment_required": payment_required,
        "write_performed": write_ok,
        "service_record_id": data.get("service_record_id"),
        "payment_id": payment_id or None,
        "secure_payment_url": secure_url,
        "per_service_checkout_url": secure_url,
        "use_balance_payment_link": balance_link_next,
        "payment_link_created": bool(secure_url),
        "payment_link_error": payment_link_error,
        "guidance": addon_guidance,
        "next_action": (
            "create_balance_payment_link"
            if balance_link_next
            else (data.get("service_status") or data.get("next_action"))
        ),
        "reply_draft": data.get("reply_draft"),
        "staff_review_needed": (
            bool(data.get("staff_review_needed"))
            or data.get("next_action") == "handoff_to_staff"
            or (needs_link and write_ok and not secure_url)
        ),
        "guest_safe_next_action": data.get("guest_safe_next_action"),
    })



def update_guest_packages(params, **kwargs):
    del kwargs
    payload = dict(params or {})
    payload.setdefault("client_slug", "wolfhouse-somo")
    payload.setdefault("source", "agent_luna_whatsapp")
    booking_code = _clean(payload.get("booking_code"))
    guest_packages = payload.get("guest_packages") if isinstance(payload.get("guest_packages"), list) else []
    if not booking_code:
        return _json_result({
            "success": False,
            "tool": "update_guest_packages",
            "staff_review_needed": True,
            "guest_safe_next_action": "I can update that — can you send me the booking code first?",
        })
    if not guest_packages:
        return _json_result({
            "success": False,
            "tool": "update_guest_packages",
            "staff_review_needed": True,
            "guest_safe_next_action": "I can update that — which package should each guest have?",
        })
    key_parts = "|".join([
        booking_code,
        json.dumps(guest_packages, sort_keys=True),
    ])
    payload.setdefault("idempotency_key", "luna-gp-" + hashlib.sha256(key_parts.encode()).hexdigest()[:16])
    data = _post_bot(f"/bookings/{urllib.parse.quote(booking_code)}/guest-packages", payload)
    return _json_result({
        "success": bool(data.get("success")),
        "tool": "update_guest_packages",
        "updated": bool(data.get("updated")),
        "booking_code": booking_code,
        "guest_packages": data.get("guest_packages") or data.get("after_guest_packages") or guest_packages,
        "package_code": data.get("package_code"),
        "staff_review_needed": bool(data.get("staff_review_needed")) or not bool(data.get("success")),
        "guest_safe_next_action": data.get("guest_safe_next_action"),
    })

def save_transfer_request(params, **kwargs):
    del kwargs
    payload = dict(params or {})
    payload.setdefault("client_slug", "wolfhouse-somo")
    payload.setdefault("source", "agent_luna_whatsapp")

    # Transfers are collected during the booking flow before a booking exists.
    # Staff API can only persist transfer rows once it has booking_id/booking_code,
    # so pre-booking transfer details must not become a guest-facing handoff/blocker.
    if not _clean(payload.get("booking_id")) and not _clean(payload.get("booking_code")):
        return _json_result({
            "success": True,
            "tool": "save_transfer_request",
            "write_performed": False,
            "transfer_collected_for_later": True,
            "booking_not_created_yet": True,
            "next_action": "continue_booking_flow",
            "safe_next_step": "Ask for the remaining booking detail, create the booking after guest acceptance, then attach the transfer request once booking_id or booking_code is available.",
            "direction": payload.get("direction"),
            "airport_or_city": payload.get("airport") or payload.get("arrival_airport_or_city"),
            "flight_number": payload.get("flight_number"),
            "arrival_datetime": payload.get("arrival_datetime") or payload.get("transfer_datetime") or payload.get("scheduled_at"),
            "staff_review_needed": False,
            "do_not_escalate": True,
            "guest_safe_next_action": "Great, I’ll note the shuttle details and keep going with the booking 😊",
        })

    data = _post_bot("/transfers/save", payload)
    # Auto-confirm: if booking_id/booking_code is present, the model has already decided
    # to save the transfer. Force confirm_transfer_write=true so the write always happens.
    # This removes a silent failure mode where the model forgets the flag and gets
    # write_performed=false with success=true (preview-only response).
    if not payload.get("confirm_transfer_write"):
        payload["confirm_transfer_write"] = True
        data = _post_bot("/transfers/save", payload)
    transfer = data.get("transfer") if isinstance(data.get("transfer"), dict) else {}
    write_ok = bool(data.get("write_performed")) or (bool(data.get("success")) and bool(transfer.get("id")))
    return _json_result({
        "success": bool(data.get("success")),
        "tool": "save_transfer_request",
        "write_performed": write_ok,
        "booking_id": data.get("booking_id") or transfer.get("booking_id"),
        "booking_code": data.get("booking_code") or transfer.get("booking_code"),
        "direction": data.get("direction") or transfer.get("direction") or payload.get("direction"),
        "airport_or_city": data.get("airport_or_city") or transfer.get("airport") or payload.get("airport") or payload.get("arrival_airport_or_city"),
        "flight_number": data.get("flight_number") or transfer.get("flight_number") or payload.get("flight_number"),
        "arrival_datetime": data.get("arrival_datetime") or transfer.get("arrival_datetime") or payload.get("arrival_datetime"),
        "staff_review_needed": bool(data.get("staff_review_needed")) or not bool(data.get("success")),
        "guest_safe_next_action": data.get("guest_safe_next_action"),
    })


def _schema(name, description, properties, required=None):
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required or [],
        },
    }


def register(ctx):
    common_availability = {
        "client_slug": {"type": "string", "description": "Client slug, normally wolfhouse-somo."},
        "check_in": {"type": "string", "description": "Check-in date in YYYY-MM-DD."},
        "check_out": {"type": "string", "description": "Check-out date in YYYY-MM-DD."},
        "guest_count": {"type": "integer", "description": "Number of guests."},
        "room_type": {"type": "string", "description": "shared, private, double, or any."},
    }
    common_booking = {
        "client_slug": {"type": "string", "description": "Client slug, normally wolfhouse-somo."},
        "check_in": {"type": "string", "description": "Check-in date in YYYY-MM-DD."},
        "check_out": {"type": "string", "description": "Check-out date in YYYY-MM-DD."},
        "guest_count": {"type": "integer", "description": "Number of guests."},
        "room_type": {"type": "string", "description": "shared, private, double, or any."},
        "room_preference": {"type": "string", "description": "Guest room choice: shared, mixed, female_only, private, couple_private, etc. Pass through from the guest's answer."},
        "group_gender": {"type": "string", "description": "Authoritative group composition for 2+ guests: female (all girls), male (all guys), or mixed. Ask at the room-preference step before create — never on availability."},
        "gender_preference": {"type": "string", "description": "Same as group_gender for groups; for solo bookings only, infer silently from name (female/male/mixed). Never ask a solo guest 'are you a girl'."},
        "package_code": {"type": "string", "description": "malibu, uluwatu, waimea for 7+ nights; package_none for short stays / accommodation-only."},
        "guest_packages": {"type": "array", "description": "Optional per-guest packages, e.g. [{guest_number:1, package_code:'malibu'}]. If one package applies to all guests, include one entry per guest with the same package.", "items": {"type": "object"}},
        "add_ons": {
            "type": "array",
            "description": "Short-stay bundled add-ons. Exact codes only: wetsuit_rental; soft_top_rental (soft board — NOT soft_board_rental); hard_board_rental (hard board — NOT hard_top_rental). Example hard+wetsuit promo: [{code:hard_board_rental,days:3},{code:wetsuit_rental,days:3}]. Also surf_lesson_single, yoga_class, meals.",
            "items": {"type": "object"},
        },
    }
    tools = [
        ("check_availability", "Check real Wolfhouse bed availability (gender-neutral capacity only). Use before any availability claim. Do NOT pass group_gender — ask composition later at the room-preference step before create.", check_availability, common_availability, ["check_in", "check_out", "guest_count"]),
        ("quote_booking", "Get a Staff API-backed booking quote. Use before saying totals, deposit, balance, or included items. Show the guest ONLY lines from included_items — never invent add-on lines. When the guest chooses a private couples room and private_room_available was true, re-call with room_preference couple_private before create and show the room_supplement line (+€10/night flat room charge).", quote_booking, {**common_booking, "payment_choice": {"type": "string"}, "guest_name": {"type": "string"}, "phone": {"type": "string"}}, ["check_in", "check_out", "guest_count"]),
        ("create_booking_from_plan", "Create a pending booking/hold from an accepted Staff API plan. Do not use until the guest accepts the quote. For short stays (<7 nights) pass package_code package_none and add_ons bundled in the quote. If the guest gave shuttle/transfer details earlier on a PACKAGE booking, pass them as pending_transfers.", create_booking_from_plan, {"plan_id": {"type": "string"}, "confirm": {"type": "boolean"}, **common_booking, "guest_name": {"type": "string"}, "guest_phone": {"type": "string"}, "language": {"type": "string", "description": "The guest's language as a short code (e.g. 'de', 'es', 'it', 'en') — the language THIS conversation is happening in. Saved on the booking so the payment confirmation goes out in the same language."}, "payment_choice": {"type": "string"}, "selected_bed_codes": {"type": "array", "items": {"type": "string"}}, "pending_transfers": {"type": "array", "description": "Package bookings only — transfer details for the free Santander shuttle.", "items": {"type": "object"}}, "idempotency_key": {"type": "string"}}, []),
        ("create_payment_link", "Create a secure payment link through Staff API for an existing draft payment. Never call this Stripe to guests.", create_payment_link, {"payment_id": {"type": "string"}, "payment_choice": {"type": "string"}}, ["payment_id"]),
        ("create_balance_payment_link", "Create a secure payment link for ALL outstanding balance on an existing booking — remaining accommodation after deposit plus every unpaid post-booking add-on (ledger total). Use when the guest asks for balance/remaining link OR immediately after each successful add_service_to_booking. Never say Stripe to guests.", create_balance_payment_link, {"client_slug": {"type": "string"}, "booking_id": {"type": "string"}, "booking_code": {"type": "string"}}, []),
        ("get_payment_status", "Check webhook-confirmed payment truth through Staff API. Use when a guest says they paid; never mark paid from guest text alone.", get_payment_status, {"client_slug": {"type": "string"}, "payment_id": {"type": "string"}, "booking_id": {"type": "string"}, "booking_code": {"type": "string"}}, []),
        ("update_guest_packages", "Update package choices per guest on an existing booking through Staff API. Use when a guest changes package choices after booking, or says e.g. 2 Malibu + 1 Waimea.", update_guest_packages, {"client_slug": {"type": "string"}, "booking_code": {"type": "string"}, "guest_packages": {"type": "array", "items": {"type": "object"}}, "reason": {"type": "string"}}, ["booking_code", "guest_packages"]),
        ("add_service_to_booking", "Record a post-booking service/add-on (lessons, gear, yoga, meals). service_type must be yoga, meal, surf_lesson, wetsuit, or surfboard (server accepts quote-code aliases). After success when payment is required, call create_balance_payment_link and send that one balance link — not the per-service checkout URL.", add_service_to_booking, {"client_slug": {"type": "string"}, "booking_id": {"type": "string"}, "booking_code": {"type": "string"}, "service_type": {"type": "string", "enum": ["yoga", "meal", "surf_lesson", "wetsuit", "surfboard"], "description": "Canonical post-booking code. For surfboard, also pass board_type soft or hard."}, "service_date": {"type": "string"}, "quantity": {"type": "integer"}, "board_type": {"type": "string", "description": "For surfboard rentals: soft or hard"}, "payment_choice": {"type": "string"}, "notes": {"type": "string"}}, ["service_type"]),
        ("save_transfer_request", "Save guest transfer details through Staff API for Staff Portal visibility. Collect airport/city, date/time, flight, guests, luggage/surfboards, notes.", save_transfer_request, {"client_slug": {"type": "string"}, "booking_id": {"type": "string"}, "booking_code": {"type": "string"}, "direction": {"type": "string"}, "airport": {"type": "string"}, "arrival_airport_or_city": {"type": "string"}, "flight_number": {"type": "string"}, "arrival_datetime": {"type": "string"}, "guest_count": {"type": "integer"}, "luggage_or_surfboards": {"type": "string"}, "notes": {"type": "string"}, "confirm_transfer_write": {"type": "boolean"}}, []),
        ("get_surf_report", "Get a guest-friendly Somo surf/wave report through Staff API when a guest asks about the waves, surf, or conditions. Returns an on-tone 'reply' to send. day is 'today' or 'tomorrow'. Degrades gracefully if live data isn't available.", get_surf_report, {"client_slug": {"type": "string"}, "day": {"type": "string"}, "message_text": {"type": "string"}, "lang": {"type": "string"}}, []),
        ("list_my_bookings", "List the guest's active/upcoming bookings for their WhatsApp number through Staff API. Use before changing or adding to an existing booking when you are not sure which one they mean — if more than one comes back, list them (booking_code + check-in/check-out dates) and ask which one. Uses the WhatsApp sender number automatically.", list_my_bookings, {"client_slug": {"type": "string"}, "phone": {"type": "string"}}, []),
        ("update_booking_contact", "Update the guest_name and/or email on an existing booking through Staff API. Only use after the guest confirms the new value. Never changes dates, package, or payment.", update_booking_contact, {"client_slug": {"type": "string"}, "booking_code": {"type": "string"}, "guest_name": {"type": "string"}, "email": {"type": "string"}}, ["booking_code"]),
        ("flag_needs_human", "Flag this conversation for a human teammate (sets Needs Human in the Staff Portal). Call when you hand off for date changes, refunds, complaints, or tool errors. Do NOT use for private/couple room requests when private_room_available was true — re-quote with couple_private instead.", flag_needs_human, {"client_slug": {"type": "string"}, "phone": {"type": "string"}, "reason": {"type": "string"}}, []),
    ]
    for name, description, handler, properties, required in tools:
        ctx.register_tool(
            name=name,
            toolset=TOOLSET,
            schema=_schema(name, description, properties, required),
            handler=handler,
            description=description,
        )
