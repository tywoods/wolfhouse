"""Regression tests for the Luna Staff API tool guards.

Covers the staging-booking fixes:
  * Fix 1 - create_booking_from_plan auto-saves BOTH transfer directions, each
    linked by booking_id AND booking_code (the portal links transfers by
    booking_id; passing only booking_code left the portal empty).
  * Fix 2 - add_service_to_booking surfaces the add-on's own payment link
    (secure_payment_url) instead of discarding it, and create_payment_link
    returns a clear wrong_id_type guidance (not a bare staff_review_needed 404)
    when handed a service_record_id.

Pure-logic: _post_bot is monkeypatched, so there is no network or DB. Run inside
the Hermes container (or any box with Python 3):

    python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_luna_tool_guards.py
"""

import json
import os
import sys

# Import the plugin package by name (parent "plugins" dir on the path).
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
    """Records every _post_bot call and returns canned responses by path."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        for key, resp in self.responses.items():
            if key in path:
                return dict(resp)
        return {"success": True}


def with_fake(responses):
    fake = FakeBot(responses)
    mod._post_bot = fake  # type: ignore[attr-defined]
    return fake


print("\n== Fix 1: pending_transfers - both directions, booking_id + booking_code ==")

fake = with_fake({
    "/transfers/save": {"success": True, "write_performed": True, "transfer": {"id": "t1"}},
})
results = mod._auto_save_pending_transfers(
    {
        "pending_transfers": [
            {"direction": "arrival", "airport": "SDR", "scheduled_at": "2026-09-15T13:00:00", "flight_number": "IB1234"},
            {"direction": "departure", "airport": "SDR", "scheduled_at": "2026-09-22T10:00:00", "flight_number": "IB5678"},
        ],
    },
    "bk-uuid-1",
    "MB-WOLFHO-20260915-cd8f5b",
)
save_calls = [c for c in fake.calls if "/transfers/save" in c[0]]
check("T1 saves exactly two directions", len(save_calls) == 2, len(save_calls))
check("T2 one arrival + one departure",
      sorted(c[1].get("direction") for c in save_calls) == ["arrival", "departure"])
check("T3 every save carries booking_id", all(c[1].get("booking_id") == "bk-uuid-1" for c in save_calls))
check("T4 every save carries booking_code",
      all(c[1].get("booking_code") == "MB-WOLFHO-20260915-cd8f5b" for c in save_calls))
check("T5 every save forces confirm_transfer_write", all(c[1].get("confirm_transfer_write") is True for c in save_calls))
check("T6 both report write_performed", len(results) == 2 and all(r.get("write_performed") for r in results))

# A single pending_transfer dict (not a list) is still handled.
fake = with_fake({"/transfers/save": {"success": True, "write_performed": True, "transfer": {"id": "t2"}}})
one = mod._auto_save_pending_transfers({"pending_transfer": {"direction": "arrival"}}, "bk-2", "WH-2")
check("T7 single pending_transfer dict accepted", len(one) == 1 and one[0]["direction"] == "arrival")


print("\n== Fix 2: add_service_to_booking surfaces the add-on payment link ==")

fake = with_fake({
    "/addon-requests/create": {
        "success": True,
        "write_performed": True,
        "payment_required": True,
        "service_type": "yoga",
        "service_record_id": "51c590a2-aaaa",
        "checkout_url": "https://checkout.stripe.com/c/pay/yoga123",
        "reply_draft": "Yoga added - pay here: https://checkout.stripe.com/c/pay/yoga123",
    },
})
res = json.loads(mod.add_service_to_booking({"booking_code": "WH-G27", "service_type": "yoga"}))
check("S1 surfaces secure_payment_url from the service result",
      res.get("secure_payment_url") == "https://checkout.stripe.com/c/pay/yoga123", res.get("secure_payment_url"))
check("S2 payment_link_created true", res.get("payment_link_created") is True)
check("S3 not flagged for staff review when a link exists", res.get("staff_review_needed") is False)
check("S4 next_action is send the link", res.get("next_action") == "send_secure_payment_link")

# A paid service that wrote but produced NO link is the one real review case.
fake = with_fake({
    "/addon-requests/create": {
        "success": True, "write_performed": True, "payment_required": True,
        "service_type": "yoga", "service_record_id": "svc-x",
    },
})
res2 = json.loads(mod.add_service_to_booking({"booking_code": "WH-G27", "service_type": "yoga"}))
check("S5 missing link on a paid service does flag review", res2.get("staff_review_needed") is True)


print("\n== Fix 2: create_payment_link rejects a service_record_id with guidance ==")

fake = with_fake({
    "/create-stripe-link": {"success": False, "status": 404, "error": "payment not found"},
})
wrong = json.loads(mod.create_payment_link({"payment_id": "51c590a2-aaaa"}))
check("P1 wrong_id_type flagged", wrong.get("wrong_id_type") is True, wrong.get("error"))
check("P2 does NOT escalate to staff", wrong.get("staff_review_needed") is False)
check("P3 marked do_not_escalate", wrong.get("do_not_escalate") is True)
check("P4 guidance points to add_service_to_booking",
      "add_service_to_booking" in (wrong.get("guidance") or ""))

# A genuine deposit/balance payment_id still mints a link normally.
fake = with_fake({
    "/create-stripe-link": {"success": True, "payment_id": "pay_1", "checkout_url": "https://checkout.stripe.com/c/pay/dep"},
})
ok = json.loads(mod.create_payment_link({"payment_id": "pay_1"}))
check("P5 valid payment_id returns a link", ok.get("secure_payment_url") == "https://checkout.stripe.com/c/pay/dep")
check("P6 valid payment_id not wrong_id_type", ok.get("wrong_id_type") is None and ok.get("success") is True)


print("\n== Surf report: on-tone reply + graceful fallback ==")

fake = with_fake({
    "/surf-report": {"success": True, "reply": "Waves are fun today 🌊 clean and chest-high!", "day": "today", "unavailable": False},
})
sr = json.loads(mod.get_surf_report({"day": "today", "message_text": "how are the waves?"}))
check("SR1 returns the on-tone reply", "Waves are fun today" in (sr.get("reply") or ""))
check("SR2 not unavailable when data present", sr.get("unavailable") is False)
check("SR3 never escalates on a surf question", sr.get("staff_review_needed") is False and sr.get("do_not_escalate") is True)
fake_t = with_fake({"/surf-report": {"success": True, "reply": "x", "unavailable": False}})
mod.get_surf_report({"day": "TOMORROW"})
check("SR4 normalizes day to tomorrow in the request",
      fake_t.calls and fake_t.calls[-1][1].get("day") == "tomorrow", fake_t.calls and fake_t.calls[-1][1])

fake = with_fake({
    "/surf-report": {"success": True, "reply": "Can't peek at the surf right now, but Somo's always worth a paddle 🏄", "unavailable": True},
})
srf = json.loads(mod.get_surf_report({"message_text": "waves?"}))
check("SR5 fallback still returns a friendly reply", bool(srf.get("reply")) and srf.get("unavailable") is True)
check("SR6 fallback does not escalate", srf.get("staff_review_needed") is False)


print("\n== Summary: {} passed, {} failed ==".format(PASSED, FAILED))
sys.exit(1 if FAILED else 0)
