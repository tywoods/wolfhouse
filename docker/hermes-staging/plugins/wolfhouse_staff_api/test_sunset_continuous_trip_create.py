"""Executable boundary proof: a continuous 8-day Sunset trip is one create request.

Run:
  python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_continuous_trip_create.py
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wolfhouse_staff_api as mod  # noqa: E402

passed = 0
failed = 0


def check(label: str, condition: bool, detail: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + label)
    else:
        failed += 1
        print("  FAIL  " + label + ((" — " + str(detail)) if detail else ""))


class CapturingBot:
    def __init__(self):
        self.calls = []

    def __call__(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        if path == "/sunset/booking-create":
            return {
                "success": True,
                "booking_id": "booking-continuous-8d",
                "booking_code": "SUN-CONT-8D",
                "idempotent": len([p for p, _ in self.calls if p == path]) > 1,
                "total_cents": 16000,
                "currency": "EUR",
                "location_id": "sunset-somo",
            }
        return {"ok": False, "reason": "unmocked"}


dates = [f"2027-08-{day:02d}" for day in range(10, 18)]
request = {
    "guest_name": "Continuous Trip Proof",
    "guest_phone": "+34000000000",
    "guest_confirmed_booking": True,
    "location_id": "sunset-somo",
    "service_dates": dates,
    "components": {
        "lesson": {"quantity": 1, "time_preference": "morning"},
        "surfboard": {"quantity": 1},
    },
    "idempotency_key": "continuous-trip-proof-8d-v1",
}

print("\ntest_sunset_continuous_trip_create\n")
fake = CapturingBot()
mod._post_bot = fake  # type: ignore[attr-defined]
first = json.loads(mod.create_sunset_booking(request))
create_calls_after_first = [(path, body) for path, body in fake.calls if path == "/sunset/booking-create"]
check("first trip create succeeds", first.get("success") is True, first)
check("one continuous trip performs exactly one create invocation", len(create_calls_after_first) == 1, fake.calls)
wire = create_calls_after_first[0][1] if create_calls_after_first else {}
check("the single create carries all eight dates", wire.get("service_dates") == dates, wire)
check(
    "the single create carries lesson and rental components together",
    set((wire.get("components") or {}).keys()) == {"lesson", "surfboard"},
    wire,
)
check("the create boundary preserves the caller idempotency key", wire.get("idempotency_key") == request["idempotency_key"], wire)

second = json.loads(mod.create_sunset_booking(request))
create_calls_total = [(path, body) for path, body in fake.calls if path == "/sunset/booking-create"]
check("unchanged retry reuses the same create-boundary key",
      len(create_calls_total) == 2
      and create_calls_total[0][1].get("idempotency_key") == create_calls_total[1][1].get("idempotency_key"),
      create_calls_total)
check("backend replay is surfaced as idempotent", second.get("idempotent") is True, second)

print(f"\nResults: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
