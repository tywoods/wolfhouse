"""Receipt conservation and idempotent retry tests for booking cleanup Step 4."""
import unittest

from wolfhouse import accepted_quote as owner

from wolfhouse_staff_api.test_sim16_jonas_liam_fix import (
    DeterministicRegisteredLoop, availability_receipt, checked_staff_quote,
    create_recheck_receipt,
)


class Step4ReceiptRecoveryTests(unittest.TestCase):
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
