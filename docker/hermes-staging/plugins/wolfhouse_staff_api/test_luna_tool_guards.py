"""Regression tests for the Luna Staff API tool guards.

Covers the staging-booking fixes:
  * Fix 1 - create_booking_from_plan auto-saves BOTH transfer directions, each
    linked by booking_id AND booking_code (the portal links transfers by
    booking_id; passing only booking_code left the portal empty).
  * Fix 2 - add_service_to_booking steers Luna to create_balance_payment_link (one
    /pay/<booking_code> link for all unpaid add-ons), not per-service checkout URLs

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


print("\n== Fix 2: add_service_to_booking → create_balance_payment_link ==")

fake = with_fake({
    "/addon-requests/create": {
        "success": True,
        "write_performed": True,
        "payment_required": True,
        "booking_code": "MB-WOLFHO-20261001-8801A6",
        "service_type": "yoga",
        "service_record_id": "51c590a2-aaaa",
        "checkout_url": "https://checkout.stripe.com/c/pay/yoga123",
        "guest_payment_url": "https://staff-staging.lunafrontdesk.com/pay/MB-WOLFHO-20261001-8801A6-yoga",
        "reply_draft": "Yoga added - pay here: https://staff-staging.lunafrontdesk.com/pay/MB-WOLFHO-20261001-8801A6-yoga",
    },
})
res = json.loads(mod.add_service_to_booking({"booking_code": "MB-WOLFHO-20261001-8801A6", "service_type": "yoga"}))
check("S1 records per-service checkout internally",
      res.get("per_service_checkout_url") == "https://staff-staging.lunafrontdesk.com/pay/MB-WOLFHO-20261001-8801A6-yoga",
      res.get("per_service_checkout_url"))
check("S2 use_balance_payment_link true", res.get("use_balance_payment_link") is True)
check("S3 not flagged for staff review when write ok", res.get("staff_review_needed") is False)
check("S4 next_action is create_balance_payment_link", res.get("next_action") == "create_balance_payment_link")
check("S5 guidance mentions balance link", "create_balance_payment_link" in (res.get("guidance") or ""))

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
check("P4 guidance points to create_balance_payment_link",
      "create_balance_payment_link" in (wrong.get("guidance") or ""))

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


print("\n== list_my_bookings + update_booking_contact ==")

fake = with_fake({
    "/bookings/by-phone": {"success": True, "count": 2, "bookings": [
        {"booking_code": "MB-A", "check_in": "2026-09-15", "check_out": "2026-09-22"},
        {"booking_code": "MB-B", "check_in": "2026-10-01", "check_out": "2026-10-09"},
    ]},
})
lb = json.loads(mod.list_my_bookings({"phone": "+491726422307"}))
check("L1 returns both bookings", lb.get("count") == 2 and len(lb.get("bookings") or []) == 2)
check("L2 passes a normalized phone to the route", bool(fake.calls[-1][1].get("phone")))
check("L3 listing never escalates", lb.get("do_not_escalate") is True)

fake = with_fake({
    "/bookings/update-contact": {"success": True, "updated_fields": ["email"], "write_performed": True,
                                 "booking": {"booking_code": "MB-B", "email": "ana@example.com"}},
})
uc = json.loads(mod.update_booking_contact({"booking_code": "MB-B", "email": "ana@example.com"}))
check("U1 update succeeds", uc.get("success") is True and uc.get("write_performed") is True)
check("U2 reports updated field", uc.get("updated_fields") == ["email"])
check("U3 no review needed on success", uc.get("staff_review_needed") is False)

fake = with_fake({"/bookings/update-contact": {"success": False, "error": "email format is invalid"}})
ucf = json.loads(mod.update_booking_contact({"booking_code": "MB-B", "email": "bad"}))
check("U4 failed update flags review", ucf.get("staff_review_needed") is True)


print("\n== flag_needs_human ==")

fake = with_fake({"/conversation/needs-human": {"success": True, "needs_human": True, "conversation_id": "conv-1"}})
nh = json.loads(mod.flag_needs_human({"reason": "date_change", "phone": "+491726422307"}))
check("NH1 flags needs_human", nh.get("success") is True and nh.get("needs_human") is True)
check("NH2 sends a normalized phone", bool(fake.calls[-1][1].get("phone")))
check("NH3 is never a guest-facing error", nh.get("staff_review_needed") is False and nh.get("do_not_escalate") is True)


print("\n== create_balance_payment_link ==")

fake = with_fake({
    "/create-balance-link": {
        "success": True,
        "booking_id": "bk-1",
        "booking_code": "MB-TEST",
        "payment_id": "pay-bal-1",
        "amount_due_cents": 52000,
        "balance_due_cents": 52000,
        "guest_payment_url": "https://staff-staging.lunafrontdesk.com/pay/MB-TEST",
        "idempotent": False,
        "next_action": "send_secure_payment_link",
    },
})
bal = json.loads(mod.create_balance_payment_link({"booking_code": "MB-TEST"}))
check("BAL1 mints balance link", bal.get("success") is True and bal.get("secure_payment_url"))
check("BAL2 amount is remaining balance", bal.get("amount_cents") == 52000, bal.get("amount_cents"))
check("BAL3 next_action send link", bal.get("next_action") == "send_secure_payment_link")
check("BAL4 does not escalate on success", bal.get("staff_review_needed") is False)
check("BAL5 posts to create-balance-link route",
      fake.calls and "/create-balance-link" in fake.calls[-1][0])

fake = with_fake({
    "/create-balance-link": {
        "success": True,
        "idempotent": True,
        "booking_code": "MB-TEST",
        "amount_due_cents": 52000,
        "guest_payment_url": "https://staff-staging.lunafrontdesk.com/pay/MB-TEST",
    },
})
bal_idem = json.loads(mod.create_balance_payment_link({"booking_id": "bk-1"}))
check("BAL6 idempotent reuse", bal_idem.get("idempotent") is True and bal_idem.get("success") is True)

fake = with_fake({
    "/create-balance-link": {
        "success": False,
        "error": "no_balance_due",
        "reason": "no_balance_due",
        "booking_code": "MB-PAID",
        "amount_due_cents": 0,
    },
})
bal_paid = json.loads(mod.create_balance_payment_link({"booking_code": "MB-PAID"}))
check("BAL7 no_balance_due does not escalate", bal_paid.get("staff_review_needed") is False)
check("BAL8 no_balance_due reason", bal_paid.get("reason") == "no_balance_due")

missing = json.loads(mod.create_balance_payment_link({}))
check("BAL9 missing booking flags review", missing.get("staff_review_needed") is True)
check("BAL10 missing booking error", missing.get("error") == "booking_id_or_code_required")


print("\n== Post-booking add-ons: two services → one balance link ==")

BOOKING = "MB-WOLFHO-20261001-8801A6"
BALANCE_URL = "https://staff-staging.lunafrontdesk.com/pay/" + BOOKING
YOGA_CENTS = 1500
LESSON_CENTS = 3500
TOTAL_CENTS = YOGA_CENTS + LESSON_CENTS

addon_responses = {
    "/addon-requests/create": [
        {
            "success": True,
            "write_performed": True,
            "payment_required": True,
            "booking_code": BOOKING,
            "service_type": "yoga",
            "amount_due_cents": YOGA_CENTS,
            "guest_payment_url": BALANCE_URL + "-yoga-only",
        },
        {
            "success": True,
            "write_performed": True,
            "payment_required": True,
            "booking_code": BOOKING,
            "service_type": "surf_lesson",
            "amount_due_cents": LESSON_CENTS,
            "guest_payment_url": BALANCE_URL + "-lesson-only",
        },
    ],
}


class SequentialFakeBot:
    def __init__(self, path_responses):
        self.path_responses = path_responses
        self.calls = []
        self._addon_idx = 0

    def __call__(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        if "/addon-requests/create" in path:
            seq = self.path_responses.get("/addon-requests/create") or []
            resp = seq[min(self._addon_idx, len(seq) - 1)]
            self._addon_idx += 1
            return dict(resp)
        for key, resp in self.path_responses.items():
            if key != "/addon-requests/create" and key in path:
                return dict(resp)
        return {"success": True}


seq_fake = SequentialFakeBot({
    "/addon-requests/create": addon_responses["/addon-requests/create"],
    "/create-balance-link": {
        "success": True,
        "booking_code": BOOKING,
        "amount_due_cents": TOTAL_CENTS,
        "balance_due_cents": TOTAL_CENTS,
        "guest_payment_url": BALANCE_URL,
        "next_action": "send_secure_payment_link",
    },
})
mod._post_bot = seq_fake  # type: ignore[attr-defined]

yoga = json.loads(mod.add_service_to_booking({"booking_code": BOOKING, "service_type": "yoga"}))
lesson = json.loads(mod.add_service_to_booking({"booking_code": BOOKING, "service_type": "surf_lesson"}))
check("A1 yoga steers to balance link", yoga.get("next_action") == "create_balance_payment_link")
check("A2 lesson steers to balance link", lesson.get("next_action") == "create_balance_payment_link")
check("A3 two addon writes", len([c for c in seq_fake.calls if "/addon-requests/create" in c[0]]) == 2)

bal = json.loads(mod.create_balance_payment_link({"booking_code": BOOKING}))
check("A4 one balance link URL", bal.get("secure_payment_url") == BALANCE_URL, bal.get("secure_payment_url"))
check("A5 balance sums both services", bal.get("amount_cents") == TOTAL_CENTS, bal.get("amount_cents"))
check("A6 balance link is booking-level /pay path", "/pay/" + BOOKING in (bal.get("secure_payment_url") or ""))
check("A7 guest must not get per-service URLs from addon tool",
      yoga.get("use_balance_payment_link") is True and lesson.get("use_balance_payment_link") is True)


print("\n== Summary: {} passed, {} failed ==".format(PASSED, FAILED))
sys.exit(1 if FAILED else 0)
