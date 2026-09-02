"""Sunset guest shadow intelligence, with Staff facts frozen before voice composition.

This module has no send or booking-write capability. It creates one intended reply
for Postgres outbox review after a deterministic planner and read-only Staff lookup.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, cast

from wolfhouse.email_draft_contract import AttemptResult
from wolfhouse.email_draft_invoke import default_invoke

StaffLookup = Callable[[str, dict[str, Any]], dict[str, Any]]
Invoke = Callable[[str, str], AttemptResult | str]

_SYSTEM = """You are Luna Front Desk for Sunset Somo staging shadow evaluation.
Write exactly one guest-facing WhatsApp reply as strict JSON: {"reply":"..."}.
Return exactly one string from POLICY.allowed_replies, without changing or adding
any words. The deterministic policy owns every factual claim; do not add prices,
availability, inclusions, locations, booking references, links, or actions."""


def plan_read_only(req: dict[str, Any]) -> dict[str, Any]:
    """Deterministic first-turn planner; only read-only capability names exist."""
    text = str(req.get("text") or "").lower()
    gear = any(word in text for word in ("gear", "equipment", "board", "wetsuit", "material", "equipo"))
    intent = "catalog" if gear and not req.get("slot_time") else "availability"
    if intent == "availability" and not req.get("date"):
        return {"intent": "clarify_date", "staff_capability": None}
    return {"intent": intent, "staff_capability": intent}


def default_staff_lookup(intent: str, params: dict[str, Any]) -> dict[str, Any]:
    """Invoke only read-only Staff plugin capabilities; no booking tools."""
    from plugins import wolfhouse_staff_api as staff
    fn = staff.get_sunset_lesson_catalog if intent == "catalog" else staff.get_sunset_lesson_availability
    raw = fn(params)
    payload = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(payload, dict):
        raise ValueError("staff_result_malformed")
    if intent == "catalog" and "scope" not in payload:
        payload = {**payload, "scope": "catalog"}
    return payload


def _freeze(intent: str, staff: dict[str, Any]) -> dict[str, Any]:
    """Validate Staff's intent-specific contract, then reduce it to immutable claim facts."""
    signals = [staff[key] for key in ("success", "ok") if key in staff]
    if not signals or any(value is not True for value in signals):
        return {"verified": False, "reason": "staff_success_contract_invalid"}

    if intent == "catalog":
        if staff.get("scope") != "catalog":
            return {"verified": False, "reason": "catalog_contract_invalid"}
        raw_offerings = staff.get("offerings")
        if not isinstance(raw_offerings, list):
            return {"verified": False, "reason": "catalog_contract_invalid"}
        offerings: list[dict[str, Any]] = []
        included: list[str] = []
        for item in raw_offerings:
            if not isinstance(item, dict) or _safe_label(item.get("label")) is None:
                return {"verified": False, "reason": "catalog_contract_invalid"}
            raw_labels = item.get("free_included_equipment_labels")
            if not isinstance(raw_labels, list) or any(_safe_label(x) is None for x in raw_labels):
                return {"verified": False, "reason": "catalog_contract_invalid"}
            labels = list(raw_labels) if item.get("may_claim_free_equipment") is True else []
            included.extend(x for x in labels if x not in included)
            offerings.append({"label": item["label"], "included_gear": labels})
        return {"verified": True, "scope": "catalog", "offerings": offerings}

    scope = staff.get("scope")
    if scope == "course_choices":
        courses = staff.get("courses")
        if (staff.get("has_fitting_course") is not True
                or staff.get("do_not_claim_date_full") is not True
                or not isinstance(courses, list) or not courses):
            return {"verified": False, "reason": "course_choices_contract_invalid"}
        frozen_courses: list[dict[str, Any]] = []
        for course in courses:
            if not isinstance(course, dict):
                return {"verified": False, "reason": "course_choices_contract_invalid"}
            course_id, course_label = course.get("course_id"), course.get("label")
            if (type(course.get("seats_remaining")) is not int
                    or (course_id is not None and (isinstance(course_id, bool) or not isinstance(course_id, (str, int))))
                    or (course_label is not None and _safe_label(course_label) is None)):
                return {"verified": False, "reason": "course_choices_contract_invalid"}
            schedules = course.get("schedules")
            if (course["seats_remaining"] < 0 or not isinstance(schedules, list) or not schedules
                    or any(not isinstance(s, dict) or _safe_slot(s.get("start_time")) is None for s in schedules)):
                return {"verified": False, "reason": "course_choices_contract_invalid"}
            frozen_courses.append({"seats_remaining": course["seats_remaining"],
                                   "schedules": [{"start_time": s["start_time"]} for s in schedules]})
        return {"verified": True, "scope": scope,
                "has_fitting_course": True, "do_not_claim_date_full": True, "courses": frozen_courses}

    if scope == "course_slot":
        remaining, booked, capacity = (staff.get("seats_available"), staff.get("seats_booked"),
                                       staff.get("course_capacity"))
        has_seats, reason = staff.get("has_seats"), staff.get("reason")
        if (type(remaining) is not int or type(booked) is not int or type(capacity) is not int
                or not 0 <= booked <= capacity or remaining != capacity - booked
                or _safe_slot(staff.get("slot_time")) is None
                or type(has_seats) is not bool
                or (has_seats and reason is not None)
                or (not has_seats and not isinstance(reason, str))):
            return {"verified": False, "reason": "course_slot_contract_invalid"}
        return {"verified": True, "scope": scope,
                "slot_time": staff["slot_time"],
                "course_capacity": capacity, "seats_booked": booked, "open_spots": remaining,
                "has_seats": has_seats}

    return {"verified": False, "reason": "staff_scope_invalid"}


def _parse_reply(attempt: AttemptResult | str) -> tuple[str | None, dict[str, Any]]:
    content = attempt.content if isinstance(attempt, AttemptResult) else attempt
    provenance = ({"provider": attempt.provider, "model": attempt.model, "source": attempt.source}
                  if isinstance(attempt, AttemptResult) else {})
    try:
        data = json.loads(content)
    except (TypeError, json.JSONDecodeError):
        return None, provenance
    reply = data.get("reply") if isinstance(data, dict) else None
    return (reply if isinstance(reply, str) and reply else None), provenance


def _all_numbers(value: Any) -> set[int]:
    found: set[int] = set()
    if isinstance(value, bool) or value is None:
        return found
    if isinstance(value, int):
        return {value}
    if isinstance(value, str):
        return {int(x) for x in re.findall(r"(?<![\d-])\d+(?!\d)", value)}
    if isinstance(value, dict):
        for child in value.values(): found.update(_all_numbers(child))
    elif isinstance(value, list):
        for child in value: found.update(_all_numbers(child))
    return found


def _safe_label(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 80 or re.search(r"https?://|[\r\n?]", value, re.I):
        return None
    return value


def _safe_slot(value: Any) -> str | None:
    if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        return None
    return value


def policy_decision(req: dict[str, Any], frozen: dict[str, Any]) -> dict[str, Any]:
    """Authorize only complete typed facts and construct the exact safe claim surface."""
    if frozen.get("verified") is not True:
        return {"authorized": False, "reason": "staff_facts_unverified", "allowed_replies": []}
    lang = "es" if str(req.get("language") or "").lower().startswith("es") else "en"
    scope, replies = frozen.get("scope"), []
    if scope == "clarification":
        replies = ["¿Para qué fecha te gustaría comprobarlo?" if lang == "es" else
                   "What date would you like me to check?"]
    elif scope == "course_slot":
        spots, slot, qty = frozen.get("open_spots"), _safe_slot(frozen.get("slot_time")), req.get("quantity")
        booked, capacity = frozen.get("seats_booked"), frozen.get("course_capacity")
        valid_math = (type(spots) is int and type(booked) is int and type(capacity) is int
                      and 0 <= booked <= capacity and spots == capacity - booked)
        if (valid_math and isinstance(slot, str) and slot and type(qty) is int
                and 1 <= qty <= 99 and frozen.get("has_seats") is True
                and cast(int, spots) >= cast(int, qty)):
            replies = ([f"Quedan {spots} plazas en la clase de las {slot}. ¿Quieres {qty} plazas?"] if lang == "es" else
                       [f"There are {spots} open spots in the {slot} class. Would you like {qty} places?"])
    elif scope == "course_choices" and frozen.get("do_not_claim_date_full") is True:
        qty = req.get("quantity")
        if type(qty) is not int or not 1 <= qty <= 99:
            return {"authorized": False, "reason": "invalid_requested_quantity", "allowed_replies": []}
        for course in frozen.get("courses") or []:
            schedules = course.get("schedules") or [] if isinstance(course, dict) else []
            remaining = course.get("seats_remaining") if isinstance(course, dict) else None
            slot = _safe_slot(schedules[0].get("start_time")) if schedules and isinstance(schedules[0], dict) else None
            if type(remaining) is int and remaining >= qty and isinstance(slot, str) and slot:
                replies = ([f"La clase de las {slot} tiene {remaining} plazas libres. ¿Te viene bien a las {slot}?"] if lang == "es" else
                           [f"The {slot} class has {remaining} open spots. Does {slot} work for you?"])
                break
    elif scope == "catalog":
        offerings = frozen.get("offerings") or []
        selected = next((item for item in offerings
                         if isinstance(item, dict) and item.get("included_gear")), None)
        gear = selected["included_gear"] if selected and isinstance(selected.get("included_gear"), list) else []
        label = _safe_label(selected.get("label")) if selected else None
        safe_gear = [safe for safe in (_safe_label(x) for x in gear) if safe is not None]
        if safe_gear and len(safe_gear) == len(gear) and label:
            gear_text = " + ".join(safe_gear)
            replies = ([f"{gear_text} están incluidos con {label}. ¿Qué día te viene bien?"] if lang == "es" else
                       [f"{gear_text} are included with the {label}. Which day suits you?"])
    return {"authorized": bool(replies), "reason": None if replies else "insufficient_typed_facts",
            "allowed_replies": replies}


def grade_first_reply(req: dict[str, Any], frozen: dict[str, Any], reply: str | None,
                      policy: dict[str, Any] | None = None) -> dict[str, Any]:
    policy = policy or policy_decision(req, frozen)
    if not policy.get("authorized"):
        return {"ok": False, "notes": [str(policy.get("reason") or "policy_denied")]}
    if not reply:
        return {"ok": False, "notes": ["missing_reply"]}
    notes: list[str] = []
    if _all_numbers(reply) - _all_numbers(policy.get("allowed_replies") or []):
        notes.append("unfrozen_number")
    if reply not in policy.get("allowed_replies", []):
        notes.append("unsupported_claim_surface")
    if reply.count("?") > 1:
        notes.append("multiple_questions")
    return {"ok": not notes, "notes": notes}


def run_shadow_turn(req: dict[str, Any], *, staff_lookup: StaffLookup = default_staff_lookup,
                    invoke: Invoke = default_invoke) -> dict[str, Any]:
    plan = plan_read_only(req)
    if plan["staff_capability"] is None:
        frozen = {"verified": True, "scope": "clarification", "missing": "date"}
    else:
        params = {k: req.get(k) for k in ("date", "quantity", "slot_time", "course_id", "location_id") if req.get(k) is not None}
        staff = staff_lookup(plan["staff_capability"], params)
        frozen = _freeze(plan["staff_capability"], staff)
    policy = policy_decision(req, frozen)
    if not policy["authorized"]:
        grade = {"ok": False, "notes": [policy["reason"]]}
        return {"planner": plan, "policy": policy, "frozen_facts": frozen, "intended_reply": None,
                "first_answer": grade, "provenance": {}, "send_enabled": False}
    user = "BEGIN UNTRUSTED_GUEST\n" + json.dumps({"text": req.get("text"), "language": req.get("language")}) \
        + "\nEND UNTRUSTED_GUEST\nBEGIN FROZEN_FACTS\n" + json.dumps(frozen, separators=(",", ":")) \
        + "\nEND FROZEN_FACTS\nBEGIN POLICY\n" + json.dumps(policy, separators=(",", ":")) + "\nEND POLICY"
    reply, provenance = _parse_reply(invoke(_SYSTEM, user))
    grade = grade_first_reply(req, frozen, reply, policy)
    return {"planner": plan, "policy": policy, "frozen_facts": frozen,
            "intended_reply": reply if grade["ok"] else None,
            "first_answer": grade, "provenance": provenance, "send_enabled": False}
