"""Functional regression tests for create_sunset_booking lesson vs course shapes.

Incident (guest ending 6249): the model guessed components.group_lesson and then
components.course without a course_id. The Staff API rejects group_lesson and
requires course.course_id for configured course products.

These tests:
- lock the create_sunset_booking tool contract to explicitly enumerate canonical keys
- provide a narrow compatibility alias group_lesson → lesson only when unambiguous
- fail closed (no booking POST) on ambiguous or missing course_id
- ensure lesson time_preference is not lost (persisted into notes today)

Run:
  python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_group_lesson_normalization.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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
        return {"success": True}

    def called(self, fragment):
        return any(fragment in c[0] for c in self.calls)

    def body_for(self, fragment):
        for path, body in self.calls:
            if fragment in path:
                return body
        return None


def with_fake(responses):
    fake = FakeBot(responses)
    mod._post_bot = fake  # type: ignore[attr-defined]
    return fake


def base_payload(**over):
    p = {
        "guest_name": "Francisco",
        "guest_confirmed_booking": True,
        "location_id": "sunset-somo",
        "service_dates": ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"],
    }
    p.update(over)
    return p


BOOKING_OK = {"success": True, "booking_id": "bk-1", "booking_code": "SUNSET-1", "total_cents": 4 * 3000, "currency": "EUR", "location_id": "sunset-somo"}

print("\ntest_sunset_group_lesson_normalization — group lessons vs courses\n")

# [0] Tool contract must explicitly forbid group_lesson and list canonical keys.
tool_desc = None
tool_components_desc = None
for name, desc, _handler, props, _req in mod._sunset_write_tools():
    if name == "create_sunset_booking":
        tool_desc = desc
        tool_components_desc = (props.get("components") or {}).get("description")
check("[0] create_sunset_booking tool exists", bool(tool_desc))
check("[0] tool description forbids group_lesson", bool(tool_desc) and "group_lesson" in tool_desc and "never" in tool_desc.lower(), tool_desc)
check("[0] components description lists canonical keys",
      bool(tool_components_desc)
      and all(k in tool_components_desc for k in ("lesson", "course", "private_lesson", "surfboard", "wetsuit", "full_day_equipment_addon"))
      and "group_lesson" in tool_components_desc,
      tool_components_desc)

# [1] Alias group_lesson → lesson normalizes and POSTs, never sending group_lesson.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
out = json.loads(mod.create_sunset_booking(base_payload(components={
    "group_lesson": {"quantity": 1, "days": 4, "time_preference": "morning"},
})))
body = fake.body_for("/sunset/booking-create")
check("[1] booking POST made", fake.called("/sunset/booking-create"))
check("[1] group_lesson not sent", bool(body) and "group_lesson" not in body.get("components", {}), body and body.get("components"))
check("[1] lesson sent", bool(body) and body.get("components", {}).get("lesson", {}).get("quantity") == 1, body and body.get("components"))
check("[1] preserves time_preference field", bool(body) and body["components"]["lesson"].get("time_preference") == "morning", body and body.get("components"))
check("[1] time_preference persisted into notes", bool(body) and "time_preference: morning" in (body.get("notes") or "").lower(), body and body.get("notes"))
check("[1] tool result success", out.get("success") is True, out)

# [2] Canonical lesson shape passes through and keeps time preference in notes.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
mod.create_sunset_booking(base_payload(components={"lesson": {"quantity": 1, "time_preference": "morning"}}))
body = fake.body_for("/sunset/booking-create")
check("[2] canonical lesson POSTs", fake.called("/sunset/booking-create"))
check("[2] canonical lesson stays lesson", bool(body) and set(body.get("components", {})) == {"lesson"}, body and body.get("components"))
check("[2] time_preference kept in notes", bool(body) and "time_preference: morning" in (body.get("notes") or "").lower(), body and body.get("notes"))

# [3] Ambiguous: group_lesson + lesson → fail closed, no booking POST.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
out = json.loads(mod.create_sunset_booking(base_payload(components={
    "group_lesson": {"quantity": 1},
    "lesson": {"quantity": 1},
})))
check("[3] ambiguous does not POST", not fake.called("/sunset/booking-create"))
check("[3] typed error", out.get("success") is False and out.get("error") == "group_lesson_ambiguous_with_lesson", out)

# [4] Ambiguous: group_lesson + course → fail closed, no booking POST.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
out = json.loads(mod.create_sunset_booking(base_payload(components={
    "group_lesson": {"quantity": 1},
    "course": {"quantity": 1, "course_id": "course-123"},
})))
check("[4] ambiguous does not POST", not fake.called("/sunset/booking-create"))
check("[4] typed error", out.get("success") is False and out.get("error") == "group_lesson_ambiguous_with_course", out)

# [5] Course without course_id must fail closed before booking POST.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
out = json.loads(mod.create_sunset_booking(base_payload(components={
    "course": {"quantity": 1, "days": 4, "time_preference": "morning"},
})))
check("[5] missing course_id does not POST", not fake.called("/sunset/booking-create"))
check("[5] typed error", out.get("success") is False and out.get("error") == "course_id_required", out)

# [6] Incident-shaped canonical payload is accepted and forwarded correctly.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
mod.create_sunset_booking(base_payload(components={"lesson": {"quantity": 1, "time_preference": "morning"}}))
body = fake.body_for("/sunset/booking-create")
check("[6] POST includes 4 service_dates", bool(body) and body.get("service_dates") == ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"], body and body.get("service_dates"))
check("[6] quantity is surfers not days", bool(body) and body["components"]["lesson"]["quantity"] == 1, body and body.get("components"))

print("\n── test_sunset_group_lesson_normalization %s (%d/%d) ──\n" % (
    "FAILED" if FAILED else "PASSED", PASSED, PASSED + FAILED))
sys.exit(1 if FAILED else 0)

