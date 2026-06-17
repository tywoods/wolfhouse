"""Fail-open input validation for guest-facing tool calls (step 3, input side).

Catches *unambiguous* malformed tool arguments BEFORE they hit the Staff API, so
Luna re-asks the guest cleanly instead of relaying a confusing API error. The
design is deliberately FAIL-OPEN: anything unparseable or even slightly ambiguous
returns "valid" and is passed straight through to the API (the source of truth).
We only reject inputs that cannot possibly be correct — so this can never block a
legitimate quote/availability call (which would itself cause a staff handoff).

Scope (for now): the read tools check_availability / quote_booking. Write/charge
paths (create_booking_from_plan, add_service_to_booking) are intentionally NOT
validated here — their arg semantics (e.g. add-on quantity/vocab) are owned by the
Staff API server-side fix, and guessing on a charging path is the wrong layer.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any, Dict, Optional, Tuple

_DATE_RE = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})\s*$")
_MAX_PLAUSIBLE_GUESTS = 40


def _parse_iso(value: Any) -> Optional[date]:
    """A real ISO calendar date, or None (None == 'can't tell', fail open)."""
    if not isinstance(value, str):
        return None
    m = _DATE_RE.match(value)
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def validate_stay(params: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Return a guest-safe error dict for an UNAMBIGUOUS problem, else None."""
    p = params or {}

    ci = _parse_iso(p.get("check_in"))
    co = _parse_iso(p.get("check_out"))
    if ci and co and co <= ci:
        return {
            "field": "check_out",
            "code": "checkout_not_after_checkin",
            "message": "those dates look swapped — the check-out is on or before the check-in",
        }

    gc = p.get("guest_count")
    if gc is not None and not isinstance(gc, bool):
        try:
            n = int(gc)
        except (TypeError, ValueError):
            n = None  # non-numeric -> fail open
        if n is not None:
            if n <= 0:
                return {
                    "field": "guest_count",
                    "code": "guest_count_not_positive",
                    "message": "the number of guests needs to be at least 1",
                }
            if n > _MAX_PLAUSIBLE_GUESTS:
                return {
                    "field": "guest_count",
                    "code": "guest_count_implausible",
                    "message": "that group size looks too large — let me double-check the number of guests",
                }
    return None


# Tools that carry stay dates / guest counts and are safe (read-only) to pre-validate.
_STAY_TOOLS = ("check_availability", "quote_booking")


def guard_tool_input(tool_name: str, params: Optional[Dict[str, Any]]) -> Tuple[bool, Optional[Dict[str, Any]]]:
    """(ok, error_dict). ok=False only on an unambiguous, guest-fixable problem."""
    if tool_name in _STAY_TOOLS:
        err = validate_stay(params)
        if err:
            return False, err
    return True, None
