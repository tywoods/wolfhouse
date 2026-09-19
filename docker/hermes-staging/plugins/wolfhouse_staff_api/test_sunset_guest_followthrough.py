"""Regression: Sunset Luna payment maps, booking notes, and accommodation handoff.

Run:
  python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_guest_followthrough.py
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

os.environ.setdefault("LUNA_CLIENT_SLUG", "sunset")
os.environ.setdefault("HERMES_SESSION_ID", "whatsapp:+34600000000")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
SOUL = ROOT / "docker" / "hermes-sunset" / "SOUL.md"
MODULE_PATH = HERE / "__init__.py"
spec = importlib.util.spec_from_file_location("wolfhouse_staff_api_sunset_followthrough", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(mod)

passed = 0


def check(label: str, condition: bool, detail: object = None) -> None:
    global passed
    if not condition:
        raise AssertionError(f"FAIL {label}: {detail!r}")
    passed += 1
    print(f"PASS {label}")


calls = []


def fake_post(path, body):
    calls.append((path, dict(body)))
    if path == "/sunset/payment-link":
        return {
            "success": True,
            "booking_id": "00000000-0000-4000-8000-000000000001",
            "booking_code": "SUNSET-FOLLOW-001",
            "payment_short_url": "https://sunset-staging.lunafrontdesk.com/pay/SUNSET-FOLLOW-001",
            "location_id": body.get("location_id"),
            "amount_due_cents": 4500,
            "currency": "EUR",
        }
    if path == "/sunset/booking-create":
        return {
            "success": True,
            "booking_id": "00000000-0000-4000-8000-000000000001",
            "booking_code": "SUNSET-FOLLOW-001",
            "total_cents": 4500,
            "currency": "EUR",
            "location_id": body.get("location_id"),
        }
    if path == "/conversation/needs-human":
        return {
            "success": True,
            "needs_human": True,
            "conversation_id": "00000000-0000-4000-8000-000000000002",
            "conversation_paused": False,
            "handoff_reason": body.get("reason"),
        }
    raise AssertionError(f"unexpected path {path}")


mod._post_bot = fake_post

somo = json.loads(mod.create_sunset_payment_link({
    "booking_code": "SUNSET-FOLLOW-001",
    "location_id": "sunset-somo",
}))
check("Somo payment response supplies a pin-prefixed authoritative map line",
      somo.get("guest_location_line") == "📍 https://www.google.com/maps/search/?api=1&query=Sunset+Surf+School+Somo", somo)

sardi = json.loads(mod.create_sunset_payment_link({
    "booking_code": "SUNSET-FOLLOW-001",
    "location_id": "sunset-sardinero",
}))
check("El Sardi payment response supplies its own pin-prefixed map line",
      sardi.get("guest_location_line") == "📍 https://www.google.com/maps/search/?api=1&query=Sunset+Surf+School+El+Sardinero", sardi)
check("unknown location fails closed without a map URL",
      json.loads(mod.create_sunset_payment_link({
          "booking_code": "SUNSET-FOLLOW-001", "location_id": "unknown",
      })).get("guest_location_line") is None)

note = "Guest wants a group lesson and full-day softboard; English conversation."
created = json.loads(mod.create_sunset_booking({
    "guest_confirmed_booking": True,
    "guest_name": "Notes Test",
    "location_id": "sunset-somo",
    "service_dates": ["2026-10-01"],
    "components": {"lesson": {"quantity": 1}},
    "notes": note,
}))
booking_calls = [body for path, body in calls if path == "/sunset/booking-create"]
check("create succeeds", created.get("success") is True, created)
check("Luna booking note crosses the real create boundary unchanged",
      len(booking_calls) == 1 and booking_calls[0].get("notes") == note, booking_calls)

handoff = json.loads(mod.flag_needs_human({"reason": "accommodation_request"}))
handoff_calls = [body for path, body in calls if path == "/conversation/needs-human"]
check("accommodation reason produces Needs Human", handoff.get("needs_human") is True, handoff)
check("accommodation handoff does not pause the conversation",
      handoff.get("conversation_paused") is False, handoff)
check("accommodation request uses only the Needs Human endpoint",
      len(handoff_calls) == 1 and handoff_calls[0].get("reason") == "accommodation_request", calls)

soul = SOUL.read_text(encoding="utf-8")
check("SOUL requires payment URL followed by tool-owned pin map line",
      "guest_location_line" in soul and "immediately after the payment URL" in soul)
check("SOUL requires a useful booking note",
      "notes" in soul and "guest's confirmed request" in soul)
check("SOUL routes accommodation to Needs Human only",
      "accommodation_request" in soul and "do not pause" in soul.lower()
      and "do not quote lodging" in soul.lower())

print(f"\n{passed} passed\n")
