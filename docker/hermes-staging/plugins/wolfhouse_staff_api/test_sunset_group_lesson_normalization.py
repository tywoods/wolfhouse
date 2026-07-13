"""Functional regression tests for create_sunset_booking lesson vs course shapes.

Incident (guest ending 6249): the model guessed components.group_lesson and then
components.course without a course_id. The Staff API rejects group_lesson and
requires course.course_id for configured course products.

Executable regression coverage lives here. The Spanish incident fixture in
fixtures/sunset-golden/ is draft-only (runner not_wired) until a Sunset golden
runner exists.

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

MORNING_NOTE = "Luna: Guest requested morning sessions; exact time to be confirmed by staff."
AFTERNOON_NOTE = "Luna: Guest requested afternoon sessions; exact time to be confirmed by staff."
ANY_NOTE = "Luna: Guest has no morning/afternoon preference; exact time to be confirmed by staff."


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
        "guest_name": "Mateo Test",
        "guest_confirmed_booking": True,
        "location_id": "sunset-somo",
        "service_dates": ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"],
    }
    p.update(over)
    return p


BOOKING_OK = {
    "success": True,
    "booking_id": "bk-1",
    "booking_code": "SUNSET-1",
    "total_cents": 4 * 3000,
    "currency": "EUR",
    "location_id": "sunset-somo",
}


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

# [1] Alias group_lesson → lesson; canonical POST strips time_preference from component.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
out = json.loads(mod.create_sunset_booking(base_payload(components={
    "group_lesson": {"quantity": 1, "days": 4, "time_preference": "morning"},
})))
body = fake.body_for("/sunset/booking-create")
check("[1] booking POST made", fake.called("/sunset/booking-create"))
check("[1] group_lesson not sent", bool(body) and "group_lesson" not in body.get("components", {}), body and body.get("components"))
check("[1] lesson component is exactly {quantity:1}", bool(body) and body.get("components", {}).get("lesson") == {"quantity": 1}, body and body.get("components"))
check("[1] time_preference not in component", bool(body) and "time_preference" not in body["components"]["lesson"], body and body.get("components"))
check("[1] morning preference in notes", bool(body) and MORNING_NOTE in (body.get("notes") or ""), body and body.get("notes"))
check("[1] tool result success", out.get("success") is True, out)

# [2] Canonical lesson shape: strip time_preference, keep note.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
mod.create_sunset_booking(base_payload(components={"lesson": {"quantity": 1, "time_preference": "morning"}}))
body = fake.body_for("/sunset/booking-create")
check("[2] canonical lesson POSTs", fake.called("/sunset/booking-create"))
check("[2] lesson component exactly {quantity:1}", bool(body) and body.get("components", {}).get("lesson") == {"quantity": 1}, body and body.get("components"))
check("[2] morning note present", bool(body) and MORNING_NOTE in (body.get("notes") or ""), body and body.get("notes"))

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

# [6] Incident-shaped canonical payload forwarded correctly.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
mod.create_sunset_booking(base_payload(components={"lesson": {"quantity": 1, "time_preference": "morning"}}))
body = fake.body_for("/sunset/booking-create")
check("[6] POST includes 4 service_dates", bool(body) and body.get("service_dates") == ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"], body and body.get("service_dates"))
check("[6] quantity is surfers not days", bool(body) and body["components"]["lesson"]["quantity"] == 1, body and body.get("components"))

# [7] Date validation — fail closed before POST.
for label, extra in [
    ("empty service_dates", {"service_dates": []}),
    ("malformed date", {"service_dates": ["not-a-date"]}),
    ("impossible date", {"service_dates": ["2026-02-30"]}),
    ("incomplete range", {"service_dates": None, "date_from": "2026-07-20", "date_to": None}),
    ("reversed range", {"service_dates": None, "date_from": "2026-07-23", "date_to": "2026-07-20"}),
]:
    fake = with_fake({"/sunset/booking-create": BOOKING_OK})
    payload = base_payload(components={"group_lesson": {"quantity": 1}})
    payload.update(extra)
    out = json.loads(mod.create_sunset_booking(payload))
    check(f"[7] {label} → no POST", not fake.called("/sunset/booking-create"))
    check(f"[7] {label} → valid-dates error", out.get("error") == "group_lesson_requires_valid_service_dates", out)

# [7b] Date validation — accepted forms POST.
for label, extra in [
    ("valid date list", {"service_dates": ["2026-07-20", "2026-07-21"]}),
    ("valid single date", {"service_dates": None, "service_date": "2026-07-20"}),
    ("valid range", {"service_dates": None, "date_from": "2026-07-20", "date_to": "2026-07-21"}),
]:
    fake = with_fake({"/sunset/booking-create": BOOKING_OK})
    payload = base_payload(components={"group_lesson": {"quantity": 1}})
    if extra.get("service_dates") is None:
        payload.pop("service_dates", None)
    payload.update(extra)
    out = json.loads(mod.create_sunset_booking(payload))
    check(f"[7b] {label} → POST", fake.called("/sunset/booking-create"))
    check(f"[7b] {label} → success", out.get("success") is True, out)

# [8] Quantity validation — fail closed, no defaulting.
for label, qty in [
    ("zero", 0),
    ("negative", -1),
    ("fractional", 1.5),
    ("string garbage", "two"),
    ("above backend limit", 100),
]:
    fake = with_fake({"/sunset/booking-create": BOOKING_OK})
    out = json.loads(mod.create_sunset_booking(base_payload(components={"group_lesson": {"quantity": qty}})))
    check(f"[8] {label} → no POST", not fake.called("/sunset/booking-create"))
    check(f"[8] {label} → invalid error", out.get("error") == "group_lesson_invalid", out)

# [9] Time preference notes — morning, afternoon, any.
for tp, expected in [("morning", MORNING_NOTE), ("afternoon", AFTERNOON_NOTE), ("any", ANY_NOTE)]:
    fake = with_fake({"/sunset/booking-create": BOOKING_OK})
    mod.create_sunset_booking(base_payload(components={"lesson": {"quantity": 1, "time_preference": tp}}))
    body = fake.body_for("/sunset/booking-create")
    check(f"[9] {tp} note", bool(body) and expected in (body.get("notes") or ""), body and body.get("notes"))
    check(f"[9] {tp} stripped from component", bool(body) and body["components"]["lesson"] == {"quantity": 1})

# [10] Preserve existing notes + dedupe on retry.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
mod.create_sunset_booking(base_payload(
    notes="Existing staff note.",
    components={"lesson": {"quantity": 1, "time_preference": "morning"}},
))
body = fake.body_for("/sunset/booking-create")
check("[10] existing note preserved", bool(body) and "Existing staff note." in (body.get("notes") or ""), body and body.get("notes"))
check("[10] morning note appended", bool(body) and MORNING_NOTE in (body.get("notes") or ""), body and body.get("notes"))

fake2 = with_fake({"/sunset/booking-create": BOOKING_OK})
mod.create_sunset_booking(base_payload(
    notes=f"Existing staff note.\n{MORNING_NOTE}",
    components={"lesson": {"quantity": 1, "time_preference": "morning"}},
))
body2 = fake2.body_for("/sunset/booking-create")
morning_count = (body2.get("notes") or "").count(MORNING_NOTE)
check("[10] dedupe on retry", morning_count == 1, body2 and body2.get("notes"))

# [11] Unsupported time preference rejected before POST.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
out = json.loads(mod.create_sunset_booking(base_payload(components={"lesson": {"quantity": 1, "time_preference": "evening"}})))
check("[11] unsupported tp → no POST", not fake.called("/sunset/booking-create"))
check("[11] unsupported tp → typed error", out.get("error") == "lesson_time_preference_invalid", out)


# [12] Unsupported lookalikes must fail closed before POST (no fuzzy remap).
for bad in ("group_class", "group_class_lesson", "class"):
    fake = with_fake({"/sunset/booking-create": BOOKING_OK})
    out = json.loads(mod.create_sunset_booking(base_payload(components={bad: {"quantity": 1}})))
    check(f"[12] {bad} does not POST", not fake.called("/sunset/booking-create"))
    check(f"[12] {bad} typed unknown error", str(out.get("error") or "").startswith("unknown_component_keys:"), out)

# [13] Model money fields never reach _post_bot.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
out = json.loads(mod.create_sunset_booking(base_payload(components={
    "lesson": {
        "quantity": 1,
        "time_preference": "morning",
        "unit_price": 999,
        "total_cents": 99900,
        "amount_cents": 99900,
        "price": 99,
        "offering_key": "invented",
        "item_code": "FAKE",
        "type": "group",
    },
})))
check("[13] money-scrubbed create POSTs", fake.called("/sunset/booking-create"), out)
body = fake.body_for("/sunset/booking-create") or {}
lesson = (body.get("components") or {}).get("lesson") or {}
for mk in ("unit_price", "total_cents", "amount_cents", "price", "offering_key", "item_code", "type"):
    check(f"[13] {mk} stripped from POST", mk not in lesson, lesson)
check("[13] lesson remains {quantity:1}", lesson == {"quantity": 1}, lesson)

# [14] Arbitrary unknown component key fails closed.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
out = json.loads(mod.create_sunset_booking(base_payload(components={"surf_camp_special": {"quantity": 1}})))
check("[14] unknown key no POST", not fake.called("/sunset/booking-create"))
check("[14] typed error", str(out.get("error") or "").startswith("unknown_component_keys:"), out)

print("\n── test_sunset_group_lesson_normalization %s (%d/%d) ──\n" % (
    "FAILED" if FAILED else "PASSED", PASSED, PASSED + FAILED))
sys.exit(1 if FAILED else 0)
