"""Regression: create_sunset_booking equipment must be structured, not notes-only.

Catalog-defined gear (including newly added non-alias items such as foil_board_rental)
must never reach /sunset/booking-create as free-text notes alone.

Run:
  python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_equipment_structured_guard.py
"""

from __future__ import annotations

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
    def __init__(self):
        self.calls = []

    def __call__(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        if "rental-price" in path:
            return {
                "ok": True,
                "success": True,
                "result": {
                    "amount_cents": 4000,
                    "amount_eur": 40,
                    "unit_amount_cents": 4000,
                    "currency": "EUR",
                    "item": (payload or {}).get("item"),
                    "duration": (payload or {}).get("duration"),
                },
                "amount_cents": 4000,
                "amount_eur": 40,
                "currency": "EUR",
            }
        return {
            "success": True,
            "booking_id": "bk-eq-1",
            "booking_code": "SUNSET-EQ-1",
            "total_cents": 4000,
            "currency": "EUR",
            "location_id": "sunset-somo",
        }


def base(**over):
    p = {
        "guest_name": "Foil Tester",
        "guest_confirmed_booking": True,
        "location_id": "sunset-somo",
        "service_dates": ["2026-08-12"],
    }
    p.update(over)
    return p


print("\ntest_sunset_equipment_structured_guard\n")

fake = FakeBot()
mod._post_bot = fake  # type: ignore[attr-defined]

# [1] Newly catalogued non-alias item in notes only → reject (Sea Dog blocker).
out = json.loads(mod.create_sunset_booking(base(notes="Confirmed: foil board rental 1 day x1")))
check(
    "[1] foil_board notes-only rejected",
    out.get("success") is False and out.get("error") == "equipment_must_use_structured_fields",
    out,
)
check("[1] no booking-create call", not any("booking-create" in p for p, _ in fake.calls), fake.calls)

# [2] Catalog offering_key shape in notes only → reject.
fake.calls.clear()
out = json.loads(mod.create_sunset_booking(base(notes="item foil_board_rental duration 1_day")))
check(
    "[2] offering_key-shaped notes rejected",
    out.get("success") is False and out.get("error") == "equipment_must_use_structured_fields",
    out,
)

# [3] Quote provenance rental line without structured fields → reject.
fake.calls.clear()
out = json.loads(
    mod.create_sunset_booking(
        base(
            notes="ok",
            quote_provenance={
                "quote_fingerprint": "fp-foil",
                "line_items": [
                    {
                        "category": "rental",
                        "offering_key": "foil_board_rental",
                        "quantity": 1,
                        "total_cents": 4000,
                    }
                ],
                "total_cents": 4000,
            },
        )
    )
)
check(
    "[3] provenance rental line without components rejected",
    out.get("success") is False and out.get("error") == "equipment_must_use_structured_fields",
    out,
)

# [4] Structured catalog offering via rental_pricing is accepted (not notes-only).
fake.calls.clear()
out = json.loads(
    mod.create_sunset_booking(
        base(
            rental_pricing={
                "offering_key": "foil_board_rental",
                "duration": "1_day",
                "quantity": 1,
                "quoted_total_cents": 4000,
            },
            notes="foil board rental confirmed",
        )
    )
)
check("[4] structured foil rental_pricing accepted by equipment guard", out.get("success") is True, out)
check(
    "[4] booking-create reached (not blocked as notes-only)",
    any("booking-create" in p for p, _ in fake.calls),
    fake.calls,
)
create_bodies = [body for p, body in fake.calls if "booking-create" in p]
if create_bodies:
    body = create_bodies[0]
    check(
        "[4] rental_pricing offering_key preserved",
        isinstance(body.get("rental_pricing"), dict)
        and body["rental_pricing"].get("offering_key") == "foil_board_rental",
        body,
    )
else:
    check("[4] rental_pricing offering_key preserved", False, fake.calls)

# [5] Ordinary lesson + morning preference notes still allowed (no equipment intent).
fake.calls.clear()
out = json.loads(
    mod.create_sunset_booking(
        base(components={"lesson": {"quantity": 1, "time_preference": "morning"}})
    )
)
check("[5] lesson-only still succeeds", out.get("success") is True, out)
check("[5] booking-create called", any("booking-create" in p for p, _ in fake.calls), fake.calls)

# [6] Legacy wetsuit notes-only still rejected.
fake.calls.clear()
out = json.loads(mod.create_sunset_booking(base(notes="wetsuit half day please")))
check(
    "[6] wetsuit notes-only rejected",
    out.get("success") is False and out.get("error") == "equipment_must_use_structured_fields",
    out,
)

# [7] Alias full_day_equipment_addon + course_equipment all_day → overlap reject.
fake.calls.clear()
out = json.loads(
    mod.create_sunset_booking(
        base(
            components={
                "course": {"course_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "tier_key": "1_day", "quantity": 1},
                "full_day_equipment_addon": {"quantity": 1},
            },
            course_equipment={"mode": "all_day", "quantity": 1},
            quote_provenance={
                "quote_fingerprint": "fp-allday",
                "total_cents": 5000,
                "course_equipment": [{"offering_key": "board_rental", "mode": "all_day", "quantity": 1}],
                "line_items": [
                    {"total_cents": 4000},
                    {"course_equipment": True, "course_equipment_mode": "all_day", "quantity": 1, "total_cents": 1000},
                ],
            },
            service_dates=["2026-08-12"],
        )
    )
)
check(
    "[7] alias full_day + course all_day rejected",
    out.get("success") is False
    and out.get("error") in (
        "course_equipment_full_day_overlap",
        "full_day_equipment_extension_not_with_course",
    ),
    out,
)
check("[7] no booking-create", not any("booking-create" in p for p, _ in fake.calls), fake.calls)

# [8] Canonical full_day_equipment_extension + course component rejected (server owners).
fake.calls.clear()
out = json.loads(
    mod.create_sunset_booking(
        base(
            components={
                "course": {"course_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "tier_key": "1_day", "quantity": 1},
                "full_day_equipment_extension": {"enabled": True, "dates": {"2026-08-12": 1}},
            },
            service_dates=["2026-08-12"],
        )
    )
)
check(
    "[8] canonical full_day + course rejected",
    out.get("success") is False
    and out.get("error") == "full_day_equipment_extension_not_with_course",
    out,
)
check("[8] no booking-create", not any("booking-create" in p for p, _ in fake.calls), fake.calls)

# [9] Alias full_day alone (no course) still maps and reaches booking-create.
fake.calls.clear()
out = json.loads(
    mod.create_sunset_booking(
        base(
            components={
                "lesson": {"quantity": 1, "time_preference": "morning"},
                "full_day_equipment_addon": {"quantity": 1},
            },
            service_dates=["2026-08-12"],
        )
    )
)
check("[9] alias full_day without course accepted by plugin guard", out.get("success") is True, out)
if fake.calls:
    body = fake.calls[0][1]
    comps = body.get("components") or {}
    check(
        "[9] alias mapped to canonical extension",
        "full_day_equipment_extension" in comps and "full_day_equipment_addon" not in comps,
        comps,
    )

print(f"\nResults: {PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
