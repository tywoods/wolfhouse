"""Regression for Lucía completing her name while accepting the shown offer."""
import unittest
from copy import deepcopy

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

    def _completion_case(self, label, short_guests, completed_guests, *, hints=None):
        loop = DeterministicRegisteredLoop(self, label)
        try:
            beds = [{
                "bed_code": f"R10-B{index + 1}", "room_code": "R10",
                "room_type": "shared", "gender_strategy": "flexible",
                "selected_selling_mode": "bed",
            } for index in range(len(short_guests))]
            plan = {
                "check_in": "2026-11-02", "check_out": "2026-11-05",
                "guest_count": len(short_guests), "room_type": "shared",
                "room_preference": "mixed", "guests": deepcopy(short_guests),
                "package_code": "package_none",
            }
            loop.turn(label + "-quote", "Show me this exact offer.")
            available = loop.call("check_availability", plan, {
                "/availability-check": availability_receipt(beds)})
            self.assertTrue(available["success"], available)
            quote = checked_staff_quote(
                plan, beds, total=12000 * len(short_guests),
                deposit=10000 * len(short_guests))
            quoted = loop.call("quote_booking", plan, {
                "/availability-check": availability_receipt(beds),
                "/booking-preview": quote,
            })
            self.assertTrue(quoted["success"], quoted)
            shown = loop.present()

            args = {
                **plan, "confirm": True, "guests": deepcopy(completed_guests),
                "guest_name": completed_guests[0]["name"],
                "payment_choice": "deposit",
                "selected_bed_codes": [bed["bed_code"] for bed in beds],
            }
            if hints is not None:
                args["room_name_hints"] = deepcopy(hints)
            loop.turn(label + "-accept", "These are the full names. Deposit. Yes, book it.")

            def responses(route, body):
                if route == "/availability-check":
                    return create_recheck_receipt(beds, body)
                if route == "/booking-preview":
                    return checked_staff_quote(
                        body, beds, total=12000 * len(short_guests),
                        deposit=10000 * len(short_guests))
                if route == "/booking-create-from-plan":
                    return {"success": True, "created": True, "write_performed": True,
                            "booking_id": label, "booking_code": "WH-IDENTITY"}
                self.fail((route, body))

            result = loop.call("create_booking_from_plan", args, responses)
            if result.get("success"):
                duplicate = loop.call("create_booking_from_plan", args, responses)
                self.assertEqual(len(loop.create_dispatches), 1, (duplicate, loop.trace))
            return loop, result, shown
        except Exception:
            loop.close()
            raise

    def test_replacement_occupant_cannot_consume_shown_offer(self):
        short = [{"name": "Inés", "explicit_gender": "female"}]
        replacement = [{"name": "Carlos Pérez", "explicit_gender": "male"}]
        loop, result, _shown = self._completion_case(
            "replacement", short, replacement)
        try:
            self.assertFalse(result["success"], result)
            self.assertEqual(loop.create_dispatches, [])
        finally:
            loop.close()

    def test_replacement_without_gender_cannot_inherit_old_gender(self):
        short = [{"name": "Inés", "explicit_gender": "female"}]
        replacement = [{"name": "Carlos Pérez"}]
        loop, result, _shown = self._completion_case(
            "replacement-no-gender", short, replacement)
        try:
            self.assertFalse(result["success"], result)
            self.assertEqual(loop.create_dispatches, [])
            self.assertFalse(any(
                row["route"] == "/availability-check"
                and row["body"].get("guests") == [
                    {"name": "Carlos Pérez", "explicit_gender": "female"}]
                for row in loop.staff), loop.staff)
        finally:
            loop.close()

    def test_completed_names_cannot_swap_their_shown_slots(self):
        short = [{"name": "Inés", "explicit_gender": "female"},
                 {"name": "Mateo", "explicit_gender": "male"}]
        swapped = [{"name": "Mateo García López", "explicit_gender": "male"},
                   {"name": "Inés García López", "explicit_gender": "female"}]
        loop, result, _shown = self._completion_case("multi-swap", short, swapped)
        try:
            self.assertFalse(result["success"], result)
            self.assertEqual(loop.create_dispatches, [])
        finally:
            loop.close()

    def test_stale_supplied_hint_allows_same_person_completion(self):
        short = [{"name": "Inés", "explicit_gender": "female"}]
        completed = [{"name": "Inés García López", "explicit_gender": "female"}]
        loop, result, shown = self._completion_case(
            "single-stale", short, completed, hints=short)
        try:
            self.assertTrue(result["success"], result)
            self.assertEqual(len(loop.create_dispatches), 1, loop.trace)
            self.assertEqual(loop.create_dispatches[0]["room_name_hints"], completed)
            self.assertEqual([row for row in loop.trace if row["kind"] == "rendered_reply"],
                             [{"kind": "rendered_reply", "text": shown}])
        finally:
            loop.close()

    def test_fresh_supplied_hint_allows_same_person_completion(self):
        short = [{"name": "Inés", "explicit_gender": "female"}]
        completed = [{"name": "Inés García López", "explicit_gender": "female"}]
        loop, result, _shown = self._completion_case(
            "single-fresh", short, completed, hints=completed)
        try:
            self.assertTrue(result["success"], result)
            self.assertEqual(len(loop.create_dispatches), 1, loop.trace)
            self.assertEqual(loop.create_dispatches[0]["room_name_hints"], completed)
        finally:
            loop.close()

    def test_duplicate_short_hints_are_not_reused_for_two_people(self):
        short = [{"name": "Alex", "explicit_gender": "male"},
                 {"name": "Alex", "explicit_gender": "female"}]
        completed = [{"name": "Alex Uno"}, {"name": "Alex Dos"}]
        loop, result, _shown = self._completion_case(
            "duplicate-alex", short, completed)
        try:
            self.assertFalse(result["success"], result)
            self.assertEqual(loop.create_dispatches, [])
        finally:
            loop.close()


if __name__ == "__main__":
    unittest.main()
