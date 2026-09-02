"""First-answer Staff lookup for sunset-luna-http inbound turns.

Uses wolfhouse_staff_api.get_sunset_lesson_availability so date+party size
follows joinable/course leftover (#844/#845), never daily-full invent.
Sol home is pinned for future agent turns; this slice does not call Sol for
the deterministic availability probe.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from wolfhouse.luna_http_contract import RESULT_SCHEMA, RUNTIME


AvailabilityFn = Callable[[dict[str, Any]], str]


def default_availability(params: dict[str, Any]) -> str:
    """Import Staff plugin lazily so unit tests can stub without Hermes install."""
    from wolfhouse_staff_api import get_sunset_lesson_availability

    return get_sunset_lesson_availability(params)


def _parse_tool_json(raw: str | dict[str, Any] | None) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def run_first_answer_lookup(
    req: dict[str, Any],
    *,
    availability: AvailabilityFn | None = None,
) -> dict[str, Any]:
    """Run the first Staff availability lookup when date (+ optional party) is present."""
    date = req.get("date")
    if not date:
        return {
            "ran": False,
            "reason": "no_date",
            "tool": None,
            "result": None,
        }
    params: dict[str, Any] = {
        "date": date,
        "location_id": req.get("location_id") or req.get("location_key"),
    }
    if req.get("quantity") is not None:
        params["quantity"] = req["quantity"]
    if req.get("slot_time"):
        params["slot_time"] = req["slot_time"]
    if req.get("course_id"):
        params["course_id"] = req["course_id"]
    fn = availability or default_availability
    raw = fn(params)
    result = _parse_tool_json(raw)
    return {
        "ran": True,
        "reason": None,
        "tool": "get_sunset_lesson_availability",
        "params": params,
        "result": result,
    }


def build_inbound_result(
    req: dict[str, Any],
    lookup: dict[str, Any],
    *,
    outbound: dict[str, Any] | None = None,
) -> dict[str, Any]:
    tool_result = lookup.get("result") if isinstance(lookup.get("result"), dict) else {}
    scope = tool_result.get("scope")
    # First-answer safety: unscoped date+qty must be course_choices / joinable,
    # never a whole-day daily invent that falsely marks the date full.
    first_answer_ok = True
    first_answer_notes: list[str] = []
    if lookup.get("ran") and req.get("quantity") is not None and not req.get("slot_time") and not req.get("course_id"):
        if scope != "course_choices":
            first_answer_ok = False
            first_answer_notes.append("expected_course_choices_scope")
        if tool_result.get("do_not_claim_date_full") is not True and tool_result.get("has_fitting_course") is True:
            first_answer_ok = False
            first_answer_notes.append("fitting_course_must_not_claim_date_full")
        if tool_result.get("has_fitting_course") is True and tool_result.get("has_seats") is False:
            first_answer_ok = False
            first_answer_notes.append("fitting_course_must_not_has_seats_false")
        if scope == "daily" or tool_result.get("daily_capacity") is not None:
            first_answer_ok = False
            first_answer_notes.append("daily_full_forbidden_on_unscoped_first_pass")
    reply_hint = None
    if isinstance(tool_result.get("guest_safe_next_action"), str):
        reply_hint = tool_result["guest_safe_next_action"]
    return {
        "schema": RESULT_SCHEMA,
        "runtime": RUNTIME,
        "request_id": req["request_id"],
        "channel": req["channel"],
        "tenant_id": req["tenant_id"],
        "location_key": req["location_key"],
        "first_answer": {
            "ok": first_answer_ok,
            "notes": first_answer_notes,
            "lookup": {
                "ran": bool(lookup.get("ran")),
                "tool": lookup.get("tool"),
                "params": lookup.get("params"),
                "scope": scope,
                "has_fitting_course": tool_result.get("has_fitting_course"),
                "do_not_claim_date_full": tool_result.get("do_not_claim_date_full"),
                "has_seats": tool_result.get("has_seats"),
                "largest_seats_remaining": tool_result.get("largest_seats_remaining"),
                "fitting_course_ids": tool_result.get("fitting_course_ids"),
                "reason": tool_result.get("reason"),
                "courses": tool_result.get("courses"),
                "course_capacity": tool_result.get("course_capacity"),
                "seats_available": tool_result.get("seats_available"),
                "daily_capacity": tool_result.get("daily_capacity"),
            },
        },
        "reply_hint": reply_hint,
        "outbound": outbound
        or {
            "mode": req.get("outbound_mode") or "none",
            "sent": False,
            "via": None,
        },
        "soul_loaded": True,
        "tools_loaded": True,
        "sol_configured": True,
    }
