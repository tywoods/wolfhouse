"""Sunset list_sunset_bookings — Staff API truth, tenant isolation, no send.

Pure: _post_bot is monkeypatched. No network, no WhatsApp.

    python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_booking_truth.py
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("LUNA_CLIENT_SLUG", "sunset")
import wolfhouse_staff_api as mod  # noqa: E402

PASSED = 0
FAILED = 0


def check(name, cond, detail=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print("  PASS  " + name)
    else:
        FAILED += 1
        print("  FAIL  " + name + ((" - " + str(detail)) if detail else ""))


class FakeBot:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        for key, resp in self.responses.items():
            if key in path:
                return dict(resp)
        return {"success": False, "error": "unexpected_path"}


print("\n== list_sunset_bookings ==")

fake = FakeBot({
    "/sunset/bookings-by-phone": {
        "success": True,
        "count": 2,
        "bookings": [
            {"booking_code": "SUNSET-KYLE", "guest_name": "Kyle", "status": "confirmed", "payment_status": "unpaid"},
            {"booking_code": "SUNSET-GEORGE", "guest_name": "George", "status": "confirmed", "payment_status": "unpaid"},
        ],
        "no_whatsapp": True,
    },
})
mod._post_bot = fake  # type: ignore[attr-defined]
out = json.loads(mod.list_sunset_bookings({"phone": "+5491122676249"}))
check("L1 success + two Hernan bookings", out.get("success") is True and out.get("count") == 2)
check("L2 names Kyle and George", {b.get("guest_name") for b in (out.get("bookings") or [])} == {"Kyle", "George"})
check("L3 posts sunset/bookings-by-phone not wolfhouse by-phone",
      any("/sunset/bookings-by-phone" in c[0] for c in fake.calls)
      and not any("/bookings/by-phone" == c[0] or c[0].endswith("/bookings/by-phone") for c in fake.calls))
check("L4 never escalates on a successful list", out.get("do_not_escalate") is True)
check("L5 no WhatsApp send flag", out.get("no_whatsapp") is True)

_prev_session = getattr(mod, "_session_guest_phone", None)
mod._session_guest_phone = lambda: ""  # type: ignore[attr-defined]
missing = json.loads(mod.list_sunset_bookings({}))
check("L6 missing phone fails closed", missing.get("success") is False and missing.get("error") == "phone_required", missing)
mod._session_guest_phone = _prev_session  # type: ignore[attr-defined]

fake_fail = FakeBot({"/sunset/bookings-by-phone": {"success": False, "error": "booking lookup failed"}})
mod._post_bot = fake_fail  # type: ignore[attr-defined]
fail_out = json.loads(mod.list_sunset_bookings({"phone": "+5491122676249"}))
check("L7 Staff API failure is not success", fail_out.get("success") is False)
check("L8 unclear list returns no invented rows", fail_out.get("bookings") == [])

names = {t[0] for t in mod._sunset_tools()}
check("L9 list_sunset_bookings is a sunset read tool", "list_sunset_bookings" in names)
check("L10 wolfhouse list_my_bookings is not a sunset read tool", "list_my_bookings" not in names)

print(f"\nResults: {PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
