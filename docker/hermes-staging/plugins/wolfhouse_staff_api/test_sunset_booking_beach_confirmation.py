"""Regression: Sunset lesson booking tool preserves authoritative beach confirmation."""
import importlib.util
import json
import os
from pathlib import Path

os.environ.setdefault("LUNA_CLIENT_SLUG", "sunset")

MODULE_PATH = Path(__file__).with_name("__init__.py")
spec = importlib.util.spec_from_file_location("wolfhouse_staff_api_booking_beach", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(mod)

calls = []

def fake_post(path, body):
    calls.append((path, body))
    return {
        "success": True,
        "booking_id": "00000000-0000-0000-0000-000000000001",
        "booking_code": "SUNSET-TEST-001",
        "total_cents": 4500,
        "currency": "EUR",
        "location_id": "sunset-somo",
        "beach": {"beach_key": "somo", "display_name": "Somo"},
        "guest_confirmation_text": "Your lesson is booked at Somo.",
    }

mod._post_bot = fake_post
result = json.loads(mod.create_sunset_booking({
    "guest_confirmed_booking": True,
    "guest_name": "Beach Test",
    "components": {"lesson": {"quantity": 1}},
    "service_dates": ["2026-09-21"],
    "beach_key": "somo",
    "location_id": "sunset-somo",
}))

assert calls and calls[0][0] == "/sunset/booking-create", result
assert calls[0][1]["beach_key"] == "somo"
assert result["beach"] == {"beach_key": "somo", "display_name": "Somo"}
assert result["guest_confirmation_text"] == "Your lesson is booked at Somo."
print("PASS create_sunset_booking carries beach identity and guest confirmation")
