"""Functional tests for create_sunset_booking board+wetsuit bundle normalization.

Commit 2 — Luna sends the board+wetsuit bundle in several shapes; the plugin must
deterministically produce EXACT surfboard+wetsuit component rows plus an
authoritative rental_pricing descriptor, or fail closed with NO booking write.

Pure logic: _post_bot is monkeypatched, so there is no network/DB. Every _post_bot
call and its exact body is recorded and inspected. Run:

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
QUOTE_OK = {"ok": True, "result": {"item": "board_and_suit_rental", "duration": "half_day", "amount_cents": 2000}}
QUOTE_FAIL = {"ok": False, "result": {}}
BOOKING_OK = {"success": True, "booking_id": "bk-1", "booking_code": "SUNSET-1", "total_cents": 4000, "currency": "EUR", "location_id": "sunset-somo"}


def base_payload(**over):
    p = {"guest_name": "Robin", "service_date": "2026-07-21", "location_id": "sunset-somo"}
    p.update(over)
    return p


print("\ntest_sunset_bundle_normalization — deterministic board+wetsuit bundle\n")

# [1] Valid rental_pricing, NO components → exact surfboard+wetsuit rows.
fake = with_fake({"/sunset/rental-price": QUOTE_OK, "/sunset/booking-create": BOOKING_OK})
r = json.loads(mod.create_sunset_booking(base_payload(rental_pricing={
    "offering_key": "board_and_suit_rental", "duration": "half day", "quantity": 2, "quoted_total_cents": 3000,
})))
body = fake.body_for("/sunset/booking-create")
check("[1] rental_pricing-only → booking POST made", fake.called("/sunset/booking-create"))
check("[1] components rebuilt to surfboard+wetsuit", bool(body) and set(body.get("components", {})) == {"surfboard", "wetsuit"}, body and body.get("components"))
check("[1] surfboard qty2 half_day", bool(body) and body["components"]["surfboard"] == {"quantity": 2, "duration": "half_day"})
check("[1] wetsuit qty2 half_day", bool(body) and body["components"]["wetsuit"] == {"quantity": 2, "duration": "half_day"})
check("[1] no board_and_suit_rental component sent", bool(body) and "board_and_suit_rental" not in body.get("components", {}))
check("[1] quoted_total_cents = unit 2000 × 2 = 4000 (stale 3000 overridden)", bool(body) and body["rental_pricing"]["quoted_total_cents"] == 4000, body and body.get("rental_pricing"))
check("[1] result success", r.get("success") is True)

# [2] Unsupported combined component key → exact surfboard+wetsuit rows.
fake = with_fake({"/sunset/rental-price": QUOTE_OK, "/sunset/booking-create": BOOKING_OK})
mod.create_sunset_booking(base_payload(components={"board_and_suit_rental": {"quantity": 2, "duration": "half_day"}}))
body = fake.body_for("/sunset/booking-create")
check("[2] combined component → booking POST made", fake.called("/sunset/booking-create"))
check("[2] combined replaced by surfboard+wetsuit", bool(body) and set(body.get("components", {})) == {"surfboard", "wetsuit"})
check("[2] combined key dropped", bool(body) and "board_and_suit_rental" not in body.get("components", {}))
check("[2] quoted_total_cents 4000", bool(body) and body["rental_pricing"]["quoted_total_cents"] == 4000)

# [3] Legacy matching surfboard+wetsuit, NO rental_pricing → quote lookup + exact descriptor.
fake = with_fake({"/sunset/rental-price": QUOTE_OK, "/sunset/booking-create": BOOKING_OK})
mod.create_sunset_booking(base_payload(components={
    "surfboard": {"quantity": 2, "duration": "half_day"},
    "wetsuit": {"quantity": 2, "duration": "half_day"},
}))
body = fake.body_for("/sunset/booking-create")
check("[3] legacy rows → portal quote fetched", fake.called("/sunset/rental-price"))
check("[3] legacy rows → booking POST made", fake.called("/sunset/booking-create"))
check("[3] rental_pricing built from quote (offering board_and_suit_rental)", bool(body) and body["rental_pricing"]["offering_key"] == "board_and_suit_rental")
check("[3] quoted_total_cents 4000", bool(body) and body["rental_pricing"]["quoted_total_cents"] == 4000)
check("[3] exact surfboard+wetsuit rows preserved", bool(body) and body["components"]["surfboard"]["quantity"] == 2 and body["components"]["wetsuit"]["quantity"] == 2)

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

# [8] Non-bundle booking (single surfboard) passes through unchanged, no quote fetch.
fake = with_fake({"/sunset/booking-create": BOOKING_OK})
mod.create_sunset_booking(base_payload(components={"surfboard": {"quantity": 1, "duration": "1_day"}}))
body = fake.body_for("/sunset/booking-create")
check("[8] single-rental booking still POSTs", fake.called("/sunset/booking-create"))
check("[8] single rental not treated as bundle (no quote fetch)", not fake.called("/sunset/rental-price"))
check("[8] single surfboard component preserved verbatim", bool(body) and body["components"] == {"surfboard": {"quantity": 1, "duration": "1_day"}})

print("\n── test_sunset_bundle_normalization %s (%d/%d) ──\n" % (
    "FAILED" if FAILED else "PASSED", PASSED, PASSED + FAILED))
sys.exit(1 if FAILED else 0)
