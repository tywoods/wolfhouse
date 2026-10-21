"""Receipt conservation and idempotent retry tests for booking cleanup Step 4."""
import json
import re
import unittest

from wolfhouse import accepted_quote as owner

from wolfhouse_staff_api.test_sim16_jonas_liam_fix import (
    DeterministicRegisteredLoop, availability_receipt, checked_staff_quote,
    create_recheck_receipt,
)


class Step4ReceiptRecoveryTests(unittest.TestCase):
    def test_confirmation_balance_respects_selected_payment_choice(self):
        for choice, expected, forbidden in (
                ("deposit", ("Depósito: €100.", "Pendiente: €20."), ()),
                ("full", (), ("Pendiente: €20.", "Depósito: €100.")),
                ("pay_on_arrival", ("Pendiente: €120.",), ("Pendiente: €20.",))):
            with self.subTest(choice=choice):
                loop = DeterministicRegisteredLoop(self, "step4-balance-" + choice)
                try:
                    beds = [{"bed_code": "R3-B3", "room_code": "R3", "room_type": "shared",
                             "gender_strategy": "mixed", "selected_selling_mode": "bed"}]
                    guests = [{"name": "Lucía Fernández Ruiz"}]
                    plan = {"check_in": "2026-11-16", "check_out": "2026-11-19",
                            "guest_count": 1, "room_type": "shared", "room_preference": "mixed",
                            "guests": guests, "package_code": "package_none", "payment_choice": choice,
                            "selected_bed_codes": ["R3-B3"], "language": "es"}
                    quote = checked_staff_quote(plan, beds, total=12000, deposit=10000)
                    loop.turn("offer", "oferta"); loop.call("quote_booking", plan, {
                        "/availability-check": availability_receipt(beds), "/booking-preview": quote}); loop.present()
                    loop.turn("accept", "sí")
                    result = loop.call("create_booking_from_plan", {}, lambda route, body: (
                        quote if route == "/booking-preview" else
                        create_recheck_receipt(beds, body) if route == "/availability-check" else
                        {"success": True, "created": True, "write_performed": True,
                         "booking_id": "booking-balance", "booking_code": "WH-BALANCE",
                         "payment_id": "pay-balance", "payment_status": "pending"}))
                    rendered = owner.finalize_offer_response({"completed": True, "final_response": "draft",
                        "messages": [{"role": "user", "content": "sí"},
                                     {"role": "tool", "content": __import__('json').dumps(result)},
                                     {"role": "assistant", "content": "draft"}]})["final_response"]
                    exact_total = re.compile(r"(?<!\d)€120(?!\d|[.,]\d)")
                    expected_total_tokens = 2 if choice == "pay_on_arrival" else 1
                    self.assertEqual(exact_total.findall(rendered), ["€120"] * expected_total_tokens,
                                     rendered)
                    self.assertNotIn("€120.00", rendered)
                    for text in expected: self.assertIn(text, rendered)
                    for text in forbidden: self.assertNotIn(text, rendered)
                finally:
                    loop.close()

    def test_partial_per_guest_links_are_retained_and_only_failure_is_retried(self):
        loop = DeterministicRegisteredLoop(self, "step4-partial-split")
        try:
            beds = [{"bed_code": "R1-B1", "room_code": "R1", "room_type": "shared", "gender_strategy": "mixed", "selected_selling_mode": "bed"},
                    {"bed_code": "R1-B2", "room_code": "R1", "room_type": "shared", "gender_strategy": "mixed", "selected_selling_mode": "bed"}]
            guests = [{"name": "Guest One"}, {"name": "Guest Two"}]
            plan = {"check_in":"2026-11-16","check_out":"2026-11-19","guest_count":2,"room_type":"shared",
                    "room_preference":"mixed","guests":guests,"package_code":"package_none","payment_choice":"per_guest",
                    "per_guest_payment_links":True,"selected_bed_codes":["R1-B1","R1-B2"],"language":"en"}
            quote = checked_staff_quote(plan, beds, total=24000, deposit=20000)
            loop.turn("offer", "offer"); loop.call("quote_booking", plan, {"/availability-check":availability_receipt(beds), "/booking-preview":quote}); loop.present(); loop.turn("yes", "yes")
            creates, links = [], {"guest-1": 0, "guest-2": 0}
            def responses(route, body):
                if route == "/booking-preview": return quote
                if route == "/availability-check": return create_recheck_receipt(beds, body)
                if route == "/booking-create-from-plan":
                    creates.append(body); return {"success":True,"created":True,"write_performed":True,"booking_id":"booking-split","booking_code":"WH-SPLIT","payment_status":"pending","uses_per_guest_model":True,
                        "booking_guests":[{"booking_guest_id":"guest-1","guest_number":1,"guest_name":"Guest One"},{"booking_guest_id":"guest-2","guest_number":2,"guest_name":"Guest Two"}]}
                gid = route.split('/')[2]; links[gid] += 1
                if gid == "guest-2" and links[gid] == 1: return {"success":False,"error":"payment_link_timeout"}
                return {"success":True,"booking_guest_id":gid,"guest_name":"Guest One" if gid == "guest-1" else "Guest Two","guest_payment_url":"https://payments.invalid/"+gid,"amount_due_cents":10000,"currency":"EUR","payment_status":"pending"}
            first = loop.call("create_booking_from_plan", {}, responses)
            first_text = owner.finalize_offer_response({"completed":True,"final_response":"draft","messages":[{"role":"user","content":"yes"},{"role":"tool","content":json.dumps(first)},{"role":"assistant","content":"draft"}]})["final_response"]
            self.assertEqual([(row["booking_guest_id"], row["amount_due_cents"], row["payment_status"])
                              for row in first["guest_payment_links"]],
                             [("guest-1", 10000, "pending")])
            self.assertRegex(first_text, r"(?<!\d)€100(?!\d|[.,]\d)")
            self.assertIn("https://payments.invalid/guest-1", first_text)
            loop.turn("retry", "retry failed link")
            second = loop.call("create_booking_from_plan", {}, responses)
            self.assertEqual(len(creates), 1)
            self.assertEqual(links, {"guest-1": 1, "guest-2": 2})
            self.assertEqual([(row["booking_guest_id"], row["amount_due_cents"], row["payment_status"])
                              for row in second["guest_payment_links"]],
                             [("guest-1", 10000, "pending"), ("guest-2", 10000, "pending")])
            self.assertEqual(sum(row["amount_due_cents"] for row in second["guest_payment_links"]), 20000)
            self.assertTrue(all(row["payment_status"] != "paid" for row in second["guest_payment_links"]))
            self.assertNotEqual(second.get("payment_status"), "paid")
            final_text = owner.finalize_offer_response({"completed":True,"final_response":"draft",
                "messages":[{"role":"user","content":"retry failed link"},
                            {"role":"tool","content":json.dumps(second)},
                            {"role":"assistant","content":"draft"}]})["final_response"]
            for url in ("https://payments.invalid/guest-1", "https://payments.invalid/guest-2"):
                self.assertIn(url, final_text)
            self.assertEqual(re.findall(r"(?<!\d)€100(?!\d|[.,]\d)", final_text), ["€100", "€100"])
        finally:
            loop.close()

    def test_saved_booking_link_failure_retries_link_not_booking(self):
        loop = DeterministicRegisteredLoop(self, "step4-link-retry")
        try:
            beds = [{"bed_code": "R3-B3", "room_code": "R3", "room_type": "shared",
                     "gender_strategy": "mixed", "selected_selling_mode": "bed"}]
            guests = [{"name": "Lucía Fernández Ruiz", "explicit_gender": "female"}]
            plan = {"check_in": "2026-11-16", "check_out": "2026-11-19",
                    "guest_count": 1, "room_type": "shared", "room_preference": "mixed",
                    "guests": guests, "guest_name": guests[0]["name"],
                    "room_name_hints": guests, "package_code": "package_none",
                    "payment_choice": "deposit", "selected_bed_codes": ["R3-B3"],
                    "language": "es"}
            quote = checked_staff_quote(plan, beds, total=12000, deposit=10000)
            loop.turn("offer", "Enséñame la oferta")
            loop.call("quote_booking", plan, {
                "/availability-check": availability_receipt(beds),
                "/booking-preview": quote})
            loop.present()

            create_calls, link_calls = [], []
            def responses(route, body):
                if route == "/booking-preview":
                    return quote
                if route == "/availability-check":
                    return create_recheck_receipt(beds, body)
                if route == "/booking-create-from-plan":
                    create_calls.append(body)
                    return {"success": True, "created": True, "write_performed": True,
                            "booking_id": "booking-lucia", "booking_code": "WH-LUCIA",
                            "payment_id": "payment-lucia", "payment_status": "pending"}
                if route == "/payments/payment-lucia/create-stripe-link":
                    link_calls.append(body)
                    if len(link_calls) == 1:
                        return {"success": False, "error": "payment_link_timeout"}
                    return {"success": True, "booking_id": "booking-lucia",
                            "booking_code": "WH-LUCIA", "payment_id": "payment-lucia",
                            "guest_payment_url": "https://payments.invalid/lucia",
                            "amount_due_cents": 10000, "currency": "EUR",
                            "payment_status": "pending"}
                self.fail(route)

            loop.turn("accept", "Sí, resérvalo con el depósito")
            first = loop.call("create_booking_from_plan", {}, responses)
            self.assertTrue(first["success"], first)
            self.assertEqual(first["booking_code"], "WH-LUCIA")
            self.assertFalse(first["payment_link_created"])
            self.assertTrue(first["no_payment_truth_recorded"])
            state = owner._transaction(lambda current, _ingress: dict(current))
            self.assertNotIn("completion", state, {"first": first, "state": state})

            loop.turn("retry", "Reintenta el enlace, por favor")
            retried = loop.call("create_booking_from_plan", {}, responses)
            self.assertTrue(retried["success"], retried)
            self.assertEqual(len(create_calls), 1, "saved booking must not be created twice")
            self.assertEqual(len(link_calls), 2, {"retried": retried, "state": state})
            self.assertEqual(retried["secure_payment_url"], "https://payments.invalid/lucia")
            self.assertEqual(create_calls[0]["idempotency_key"],
                             loop.create_dispatches[0]["idempotency_key"])
            self.assertNotEqual(retried.get("payment_status"), "paid")
        finally:
            loop.close()


if __name__ == "__main__":
    unittest.main()
