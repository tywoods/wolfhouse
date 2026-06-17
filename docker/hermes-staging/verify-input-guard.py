#!/usr/bin/env python3
"""Unit test for the staff-api input-guard (step 3, input side).

No container / no network:  cd docker/hermes-staging && python3 verify-input-guard.py
Invalid-input cases short-circuit before _post_bot, so the wired plugin tools are
testable offline. Exit 0 = all pass, 1 = any failure.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "plugins"))
sys.path.insert(0, os.path.join(HERE, "plugins", "wolfhouse_staff_api"))

import input_guard as ig  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(f"  {'✓' if cond else '✗'} {name}{('  — ' + detail) if (detail and not cond) else ''}")
    if not cond:
        FAILS.append(name)


# --- pure validators ----------------------------------------------------------
print("validate_stay (must REJECT only unambiguous errors):")
check("checkout before checkin -> reject",
      (ig.validate_stay({"check_in": "2026-08-18", "check_out": "2026-08-15"}) or {}).get("code") == "checkout_not_after_checkin")
check("checkout == checkin -> reject",
      ig.validate_stay({"check_in": "2026-08-15", "check_out": "2026-08-15"}) is not None)
check("guest_count 0 -> reject", (ig.validate_stay({"guest_count": 0}) or {}).get("code") == "guest_count_not_positive")
check("guest_count -3 -> reject", ig.validate_stay({"guest_count": -3}) is not None)
check("guest_count 999 -> reject (implausible)", (ig.validate_stay({"guest_count": 999}) or {}).get("code") == "guest_count_implausible")

print("validate_stay (must FAIL OPEN — pass ambiguous/valid through):")
check("valid future stay -> ok", ig.validate_stay({"check_in": "2026-08-15", "check_out": "2026-08-22", "guest_count": 4}) is None)
check("missing dates -> ok (fail open)", ig.validate_stay({"guest_count": 2}) is None)
check("unparseable date -> ok (fail open)", ig.validate_stay({"check_in": "next friday", "check_out": "the 20th"}) is None)
check("non-numeric guest_count -> ok (fail open)", ig.validate_stay({"guest_count": "a few"}) is None)
check("guest_count as string '4' -> ok", ig.validate_stay({"guest_count": "4"}) is None)
check("empty params -> ok", ig.validate_stay({}) is None)
check("None params -> ok", ig.validate_stay(None) is None)
# bool must not be treated as an int count (True==1 would silently pass; False==0 must not crash)
check("guest_count False -> ok (not treated as 0)", ig.validate_stay({"guest_count": False}) is None)

print("guard_tool_input dispatch:")
ok, err = ig.guard_tool_input("check_availability", {"check_in": "2026-08-18", "check_out": "2026-08-15"})
check("check_availability swapped dates -> not ok", (ok is False) and err is not None)
check("write tool not validated here", ig.guard_tool_input("add_service_to_booking", {"guest_count": 0}) == (True, None))
check("unknown tool -> ok", ig.guard_tool_input("get_surf_report", {"guest_count": 0}) == (True, None))

# --- wired plugin behavior (offline: invalid input never reaches the network) --
print("wired plugin short-circuit (no network):")
import wolfhouse_staff_api as api  # noqa: E402


def _payload(res):
    # tools return a JSON string (_json_result == json.dumps); parse it back
    if isinstance(res, str):
        return json.loads(res)
    return res


r = _payload(api.check_availability({"check_in": "2026-08-18", "check_out": "2026-08-15", "guest_count": 4}))
check("check_availability rejects swapped dates", r.get("input_error") == "checkout_not_after_checkin")
check("rejection is NOT a staff handoff", r.get("staff_review_needed") is False and r.get("success") is False)
check("rejection carries a guest-safe message", bool(r.get("guest_safe_next_action")))

r2 = _payload(api.quote_booking({"guest_count": 0}))
check("quote_booking rejects guest_count 0", r2.get("input_error") == "guest_count_not_positive")

print()
if FAILS:
    print(f"✗ input-guard: {len(FAILS)} FAILED: {FAILS}")
    sys.exit(1)
print("✓ input-guard: all checks passed")
sys.exit(0)
