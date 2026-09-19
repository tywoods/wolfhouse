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
SUNSET_SOUL = ROOT / "docker" / "hermes-sunset" / "SOUL.md"
WOLFHOUSE_SOUL = ROOT / "docker" / "hermes-staging" / "SOUL.md"
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
    if path == "/payments/payment-1/create-stripe-link":
        return {
            "success": True,
            "payment_id": "payment-1",
            "checkout_url": "https://checkout.stripe.test/cs_wh_001",
            "payment_short_url": "https://staff-staging.lunafrontdesk.com/pay/WH-001",
        }
    if path == "/booking-create-from-plan":
        return {
            "success": True,
            "write_performed": True,
            "booking_id": "booking-1",
            "booking_code": "WH-001",
            "payment_id": "payment-1",
        }
    if path == "/payments/create-balance-link":
        return {
            "success": True,
            "booking_code": "WH-001",
            "payment_short_url": "https://staff-staging.lunafrontdesk.com/pay/WH-001",
            "balance_due_cents": 5000,
        }
    if path == "/booking-guests/guest-1/create-payment-link":
        return {
            "success": True,
            "booking_guest_id": "guest-1",
            "payment_short_url": "https://staff-staging.lunafrontdesk.com/pay/WH-001-G1",
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

sunset_generic = json.loads(mod.create_payment_link({"payment_id": "payment-1"}))
check("Sunset generic payment tool never receives the Wolfhouse map",
      sunset_generic.get("guest_location_line") is None, sunset_generic)

os.environ["LUNA_CLIENT_SLUG"] = "wolfhouse-somo"
wolfhouse_map = "📍 Wolfhouse: https://maps.app.goo.gl/6KdamJ66roaMugJD8"
for label, result in (
    ("initial booking payment", json.loads(mod.create_booking_from_plan({
        "guest_name": "Map Test",
        "guest_phone": "+34600000000",
        "check_in": "2026-10-01",
        "check_out": "2026-10-08",
        "guest_count": 1,
        "selected_bed_codes": ["BED-1"],
    }))),
    ("deposit payment", json.loads(mod.create_payment_link({"payment_id": "payment-1"}))),
    ("balance payment", json.loads(mod.create_balance_payment_link({"booking_code": "WH-001"}))),
    ("per-guest payment", json.loads(mod.create_guest_payment_link({"booking_guest_id": "guest-1"}))),
):
    check(f"Wolfhouse {label} response supplies the authoritative map line",
          result.get("guest_location_line") == wolfhouse_map, result)

os.environ["LUNA_CLIENT_SLUG"] = "sunset"
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

handoff = json.loads(mod.flag_needs_human({
    "reason": "accommodation_request",
    "phone": "+34600000000",
}))
handoff_calls = [body for path, body in calls if path == "/conversation/needs-human"]
check("accommodation reason produces Needs Human", handoff.get("needs_human") is True, handoff)
check("accommodation handoff does not pause the conversation",
      handoff.get("conversation_paused") is False, handoff)
check("accommodation request uses only the Needs Human endpoint",
      len(handoff_calls) == 1 and handoff_calls[0].get("reason") == "accommodation_request", calls)

sunset_soul = SUNSET_SOUL.read_text(encoding="utf-8")
wolfhouse_soul = WOLFHOUSE_SOUL.read_text(encoding="utf-8")
check("Sunset SOUL requires payment URL followed by tool-owned pin map line",
      "guest_location_line" in sunset_soul and "immediately after the payment URL" in sunset_soul)
check("Wolfhouse SOUL requires payment URL followed by tool-owned pin map line",
      "guest_location_line" in wolfhouse_soul and "immediately after the payment URL" in wolfhouse_soul)
check("Wolfhouse map line uses a cute title before the maps URL",
      wolfhouse_map.startswith("📍 Wolfhouse:") and "maps.app.goo.gl/6KdamJ66roaMugJD8" in wolfhouse_map)
check("Wolfhouse SOUL skips girls/guys/mix when private room is chosen",
      "Private room = no composition ask" in wolfhouse_soul
      and "gender mix does not matter for a private room" in wolfhouse_soul)
check("SOUL requires a useful booking note",
      "notes" in sunset_soul and "guest's confirmed request" in sunset_soul)
check("SOUL routes accommodation to Needs Human only",
      "accommodation_request" in sunset_soul and "do not pause" in sunset_soul.lower()
      and "do not quote lodging" in sunset_soul.lower())

print(f"\n{passed} passed\n")
