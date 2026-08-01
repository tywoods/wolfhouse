"""Functional tests for create_sunset_booking board+wetsuit exact-offering path.

P1c: Luna sends board+wetsuit in several shapes; the plugin must re-quote via
/sunset/rental-price (same as get_sunset_rental_price), then POST an exact
offering write (rentals[] + rental_pricing) — never historical surfboard+wetsuit
component halves. Fail closed with NO booking write when price/shape is invalid.

Pure logic: _post_bot is monkeypatched. Run:

    python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_bundle_normalization.py
"""

import inspect
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
    """Records every _post_bot(path, body) call; returns canned responses by path."""

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


# Mocked portal quote: unit 2000 cents (€20) for the board+wetsuit half-day bundle.
QUOTE_OK = {
    "ok": True,
    "result": {
        "item": "board_and_suit_rental",
        "duration": "half_day",
        "amount_cents": 2000,
    },
}
QUOTE_SW = {
    "ok": True,
    "result": {
        "item": "surfboard_wetsuit_rental",
        "duration": "1_day",
        "amount_cents": 2500,
    },
}
QUOTE_FAIL = {"ok": False, "result": {}}
BOOKING_OK = {
    "success": True,
    "booking_id": "bk-1",
    "booking_code": "SUNSET-1",
    "total_cents": 4000,
    "currency": "EUR",
    "location_id": "sunset-somo",
}


def base_payload(**over):
    p = {
        "guest_name": "Robin",
        "service_date": "2026-07-21",
        "location_id": "sunset-somo",
        "guest_confirmed_booking": True,
    }
    p.update(over)
    return p


def assert_exact_rental(body, offering_key, duration, qty, total_cents):
    if not body:
        return False, "no body"
    rentals = body.get("rentals") or []
    if not (isinstance(rentals, list) and len(rentals) == 1):
        return False, rentals
    row = rentals[0]
    rp = body.get("rental_pricing") or {}
    comps = body.get("components") or {}
    ok = (
        row.get("offering_key") == offering_key
        and row.get("duration_key") == duration
        and row.get("quantity") == qty
        and rp.get("offering_key") == offering_key
        and rp.get("duration") == duration
        and rp.get("quantity") == qty
        and rp.get("quoted_total_cents") == total_cents
        and "surfboard" not in comps
        and "wetsuit" not in comps
        and "board_and_suit_rental" not in comps
    )
    return ok, {"rentals": rentals, "rental_pricing": rp, "components": comps}


print("\ntest_sunset_bundle_normalization — exact offering board+wetsuit path\n")

# [1] Valid rental_pricing, NO components → exact rentals[] write.
fake = with_fake({"/sunset/rental-price": QUOTE_OK, "/sunset/booking-create": BOOKING_OK})
r = json.loads(mod.create_sunset_booking(base_payload(rental_pricing={
    "offering_key": "board_and_suit_rental", "duration": "half day", "quantity": 2, "quoted_total_cents": 3000,
})))
body = fake.body_for("/sunset/booking-create")
check("[1] rental_pricing-only → booking POST made", fake.called("/sunset/booking-create"))
ok, detail = assert_exact_rental(body, "board_and_suit_rental", "half_day", 2, 4000)
check("[1] exact rentals[] (no surfboard/wetsuit halves)", ok, detail)
check("[1] quoted_total_cents = unit 2000 × 2 = 4000 (stale 3000 overridden)", ok, detail)
check("[1] portal re-quote called", fake.called("/sunset/rental-price"))
check("[1] result success", r.get("success") is True)

# [2] Unsupported combined component key → exact rentals[].
fake = with_fake({"/sunset/rental-price": QUOTE_OK, "/sunset/booking-create": BOOKING_OK})
mod.create_sunset_booking(base_payload(components={"board_and_suit_rental": {"quantity": 2, "duration": "half_day"}}))
body = fake.body_for("/sunset/booking-create")
check("[2] combined component → booking POST made", fake.called("/sunset/booking-create"))
ok, detail = assert_exact_rental(body, "board_and_suit_rental", "half_day", 2, 4000)
check("[2] combined → exact rentals[]", ok, detail)
check("[2] combined key not a schedule component", bool(body) and "board_and_suit_rental" not in (body.get("components") or {}))
check("[2] quoted_total_cents 4000", ok, detail)

# [3] Legacy matching surfboard+wetsuit, NO rental_pricing → quote + exact descriptor.
fake = with_fake({"/sunset/rental-price": QUOTE_OK, "/sunset/booking-create": BOOKING_OK})
mod.create_sunset_booking(base_payload(components={
    "surfboard": {"quantity": 2, "duration": "half_day"},
    "wetsuit": {"quantity": 2, "duration": "half_day"},
}))
body = fake.body_for("/sunset/booking-create")
check("[3] legacy rows → portal quote fetched", fake.called("/sunset/rental-price"))
check("[3] legacy rows → booking POST made", fake.called("/sunset/booking-create"))
ok, detail = assert_exact_rental(body, "board_and_suit_rental", "half_day", 2, 4000)
check("[3] legacy halves → exact offering (no halves kept)", ok, detail)

# [4] Mismatched quantities → NO booking POST.
fake = with_fake({"/sunset/rental-price": QUOTE_OK, "/sunset/booking-create": BOOKING_OK})
r = json.loads(mod.create_sunset_booking(base_payload(components={
    "surfboard": {"quantity": 2, "duration": "half_day"},
    "wetsuit": {"quantity": 1, "duration": "half_day"},
})))
check("[4] mismatched quantities → no booking POST", not fake.called("/sunset/booking-create"))
check("[4] mismatched quantities → typed error", r.get("success") is False and r.get("error") == "rental_bundle_shape_invalid", r.get("error"))

# [5] Mismatched durations → NO booking POST.
fake = with_fake({"/sunset/rental-price": QUOTE_OK, "/sunset/booking-create": BOOKING_OK})
r = json.loads(mod.create_sunset_booking(base_payload(components={
    "surfboard": {"quantity": 2, "duration": "half_day"},
    "wetsuit": {"quantity": 2, "duration": "1_day"},
})))
check("[5] mismatched durations → no booking POST", not fake.called("/sunset/booking-create"))
check("[5] mismatched durations → typed error", r.get("success") is False and r.get("error") == "rental_bundle_shape_invalid")

# [6] Portal quote unavailable → NO booking POST.
fake = with_fake({"/sunset/rental-price": QUOTE_FAIL, "/sunset/booking-create": BOOKING_OK})
r = json.loads(mod.create_sunset_booking(base_payload(rental_pricing={
    "offering_key": "board_and_suit_rental", "duration": "half_day", "quantity": 2,
})))
check("[6] quote unavailable → no booking POST", not fake.called("/sunset/booking-create"))
check("[6] quote unavailable → fail closed", r.get("success") is False and r.get("error") == "rental_bundle_price_unavailable")

# [7] No hard-coded 2000 / 4000 in create_sunset_booking production code.
src = inspect.getsource(mod.create_sunset_booking) + inspect.getsource(mod._resolve_sunset_bundle_shape)
check("[7] no hard-coded 2000 in bundle production code", "2000" not in src)
check("[7] no hard-coded 4000 in bundle production code", "4000" not in src)

# [8] Live catalog key surfboard_wetsuit_rental works via re-quote.
fake = with_fake({"/sunset/rental-price": QUOTE_SW, "/sunset/booking-create": BOOKING_OK})
r = json.loads(mod.create_sunset_booking(base_payload(rental_pricing={
    "offering_key": "surfboard_wetsuit_rental", "duration": "1_day", "quantity": 1, "quoted_total_cents": 999,
})))
body = fake.body_for("/sunset/booking-create")
ok, detail = assert_exact_rental(body, "surfboard_wetsuit_rental", "1_day", 1, 2500)
check("[8] surfboard_wetsuit_rental → exact rentals[]", ok, detail)
check("[8] surfboard_wetsuit success", r.get("success") is True)

# [9] Bike generic rental_pricing → rentals[] promote + re-quote.
QUOTE_BIKE = {"ok": True, "result": {"item": "bike_rental", "duration": "1_day", "amount_cents": 1200}}
fake = with_fake({"/sunset/rental-price": QUOTE_BIKE, "/sunset/booking-create": BOOKING_OK})
r = json.loads(mod.create_sunset_booking(base_payload(rental_pricing={
    "offering_key": "bike_rental", "duration": "1_day", "quantity": 1, "quoted_total_cents": 1200,
})))
body = fake.body_for("/sunset/booking-create")
ok, detail = assert_exact_rental(body, "bike_rental", "1_day", 1, 1200)
check("[9] bike rental_pricing → rentals[]", ok, detail)
check("[9] bike success", r.get("success") is True)

print(f"\nResults: {PASSED} passed, {FAILED} failed")
if FAILED:
    sys.exit(1)
print("PASS test_sunset_bundle_normalization\n")
