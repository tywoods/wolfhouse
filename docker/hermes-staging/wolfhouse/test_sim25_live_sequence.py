"""Offline Sim25 sequence witnesses derived from the supplied masked captures."""
import json
from pathlib import Path
import unittest

from wolfhouse_staff_api.test_sim16_jonas_liam_fix import (
    DeterministicRegisteredLoop, availability_receipt, checked_staff_quote,
    create_recheck_receipt,
)

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "fixtures/booking-cleanup-step4/slice1-cases.json"


class Sim25LiveSequenceTests(unittest.TestCase):
    def test_lucia_captured_order_first_valid_yes_needs_no_interpreter(self):
        """Replay the captured registered argument shapes, including both create forms."""
        loop = DeterministicRegisteredLoop(self, "sim25-lucia")
        try:
            beds = [{"bed_code": "R3-B3", "room_code": "R3", "room_type": "shared",
                     "gender_strategy": "mixed", "selected_selling_mode": "bed"}]
            available = availability_receipt(beds)
            short = [{"name": "Lucía", "explicit_gender": "female"}]
            full = [{"name": "Lucía Fernández Ruiz", "explicit_gender": "female"}]
            first = {"check_in": "2026-11-16", "check_out": "2026-11-19",
                     "guest_count": 1, "room_type": "shared", "room_preference": "mixed",
                     "guests": short, "guest_name": "Lucía", "room_name_hints": short,
                     "package_code": "package_none", "add_ons": [],
                     "catalog_selections": [], "selected_bed_codes": ["R3-B3"],
                     "source": "agent_luna_whatsapp"}
            first_quote = checked_staff_quote(first, beds, total=12000, deposit=10000)
            loop.turn("lucia-1", "¡Hola Luna! Soy Lucía. Busco 1 cama del 16 al 19 de noviembre. ¿Cuánto cuesta?")
            loop.call("check_availability", {key: first[key] for key in (
                "check_in", "check_out", "guest_count", "room_type", "room_preference",
                "guests", "guest_name", "room_name_hints")}, {"/availability-check": available})
            loop.call("check_availability", {key: first[key] for key in (
                "check_in", "check_out", "guest_count", "room_type", "room_preference",
                "guests", "room_name_hints")}, {"/availability-check": available})
            loop.call("quote_booking", first, {"/booking-preview": first_quote})
            shown = loop.present()
            self.assertIn("120.00 EUR", shown)

            accepted = {**first, "guests": full, "guest_name": full[0]["name"],
                        "room_name_hints": full, "payment_choice": "deposit",
                        "language": "es"}
            second_quote = checked_staff_quote(accepted, beds, total=12000, deposit=10000)
            raw = "Perfecto. Me llamo Lucía Fernández Ruiz. Prefiero pagar el depósito. ¡Sí, resérvalo!"
            loop.turn("lucia-2", raw)
            loop.call("check_availability", {key: accepted[key] for key in (
                "check_in", "check_out", "guest_count", "room_type", "room_preference",
                "guests", "room_name_hints")}, {"/availability-check": available})
            loop.call("quote_booking", accepted, {"/booking-preview": second_quote})

            create_args = {key: accepted[key] for key in (
                "add_ons", "catalog_selections", "check_in", "check_out", "guest_count",
                "guests", "language", "package_code", "payment_choice", "room_name_hints",
                "room_preference", "room_type")}
            # Captured stale display metadata is same-slot only and cannot rename the occupant.
            create_args["room_name_hints"] = short
            dispatched = []
            def responses(route, body):
                if route == "/booking-preview":
                    return second_quote
                if route == "/availability-check":
                    return create_recheck_receipt(beds, body)
                if route == "/booking-create-from-plan":
                    dispatched.append(body)
                    return {"success": True, "created": True, "write_performed": True,
                            "booking_id": "booking-lucia", "booking_code": "WH-LUCIA",
                            "payment_id": "payment-lucia", "payment_status": "pending"}
                if route == "/payments/payment-lucia/create-stripe-link":
                    return {"success": True, "booking_id": "booking-lucia",
                            "booking_code": "WH-LUCIA", "payment_id": "payment-lucia",
                            "secure_payment_url": "https://payments.invalid/lucia",
                            "amount_due_cents": 10000, "currency": "EUR",
                            "payment_status": "pending"}
                self.fail(route)
            created = loop.call("create_booking_from_plan", create_args, responses)
            self.assertTrue(created["success"], created)
            self.assertEqual(len(dispatched), 1)
            self.assertEqual(dispatched[0]["guests"], full)
            self.assertEqual(dispatched[0]["selected_bed_codes"], ["R3-B3"])
            self.assertEqual([row["tool"] for row in loop.trace if row["kind"] == "tool_call"], [
                "check_availability", "check_availability", "quote_booking",
                "check_availability", "quote_booking", "create_booking_from_plan"])
        finally:
            loop.close()

    def test_committed_provenance_hashes_all_supplied_sim25_sources(self):
        fixture = json.loads(FIXTURE.read_text())
        self.assertEqual(set(fixture["sources"]),
                         {"guest1", "guest2", "guest3", "guest4", "guest5", "guest9", "sim24_guest1_control"})
        self.assertTrue(all(len(row["sha256"]) == 64 for row in fixture["sources"].values()))


if __name__ == "__main__":
    unittest.main()
