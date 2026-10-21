"""Regression for Lucía completing her name while accepting the shown offer."""
import unittest

from wolfhouse_staff_api.test_sim16_jonas_liam_fix import (
    DeterministicRegisteredLoop,
    availability_receipt,
    checked_staff_quote,
    create_recheck_receipt,
)


class LuciaSameTurnCompletionTests(unittest.TestCase):
    def test_availability_hints_survive_full_name_deposit_and_yes_on_one_turn(self):
        loop = DeterministicRegisteredLoop(self, "lucia-same-turn-completion")
        try:
            beds = [{
                "bed_code": "R10-B2",
                "room_code": "R10",
                "room_type": "shared",
                "gender_strategy": "flexible",
                "selected_selling_mode": "bed",
            }]
            short_guest = [{"name": "Lucía", "explicit_gender": "female"}]
            availability_plan = {
                "check_in": "2026-11-02",
                "check_out": "2026-11-05",
                "guest_count": 1,
                "room_type": "shared",
                "room_preference": "mixed",
                "guests": short_guest,
            }
            quoted_plan = {
                **availability_plan,
                "package_code": "package_none",
            }
            first_quote = checked_staff_quote(
                quoted_plan, beds, total=12000, deposit=10000)

            loop.turn(
                "lucia-quote",
                "¡Hola Luna! Soy Lucía, de Sevilla. Busco 1 cama en el dormitorio "
                "mixto del 2 al 5 de noviembre de 2026. Soy mujer y viajo sola. "
                "¿Cuánto cuesta?",
            )
            available = loop.call(
                "check_availability",
                availability_plan,
                {"/availability-check": availability_receipt(beds)},
            )
            self.assertTrue(available["success"], available)
            quoted = loop.call(
                "quote_booking",
                quoted_plan,
                {"/availability-check": availability_receipt(beds),
                 "/booking-preview": first_quote},
            )
            self.assertTrue(quoted["success"], quoted)
            shown = loop.present()
            self.assertIn("€120", shown)

            full_guest = [{"name": "Lucía Fernández Ruiz", "explicit_gender": "female"}]
            create_args = {
                "confirm": True,
                "check_in": "2026-11-02",
                "check_out": "2026-11-05",
                "guest_count": 1,
                "guest_name": "Lucía Fernández Ruiz",
                "guests": full_guest,
                "room_type": "shared",
                "room_preference": "mixed",
                "package_code": "package_none",
                "payment_choice": "deposit",
                "selected_bed_codes": ["R10-B2"],
                "language": "es",
            }
            refreshed_plan = {**quoted_plan, "guests": full_guest,
                              "guest_name": "Lucía Fernández Ruiz",
                              "payment_choice": "deposit",
                              "selected_bed_codes": ["R10-B2"], "language": "es"}
            refreshed_quote = checked_staff_quote(
                refreshed_plan, beds, total=12000, deposit=10000)

            loop.turn(
                "lucia-accept",
                "Perfecto. Me llamo Lucía Fernández Ruiz. Prefiero pagar el "
                "depósito. ¡Sí, resérvalo!",
            )

            def responses(route, body):
                if route == "/availability-check":
                    return create_recheck_receipt(beds, body)
                if route == "/booking-preview":
                    return refreshed_quote
                if route == "/booking-create-from-plan":
                    return {"success": True, "created": True, "write_performed": True,
                            "booking_id": "lucia-one", "booking_code": "WH-LUCIA"}
                self.fail((route, body))

            created = loop.call("create_booking_from_plan", create_args, responses)
            self.assertTrue(created["success"], created)
            self.assertEqual(len(loop.create_dispatches), 1, loop.trace)
            self.assertEqual(loop.create_dispatches[0]["guests"], full_guest)
            self.assertEqual(loop.create_dispatches[0]["payment_choice"], "deposit")
            self.assertEqual(
                [entry for entry in loop.trace if entry["kind"] == "rendered_reply"],
                [{"kind": "rendered_reply", "text": shown}],
                "the accepted offer must not be wiped and rendered again",
            )
        finally:
            loop.close()


if __name__ == "__main__":
    unittest.main()
