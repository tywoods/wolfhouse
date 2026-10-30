"""Bounded quote presentation contract for Step 4 Slice 2."""
import unittest
from wolfhouse import accepted_quote as owner


class Slice2PresentationTests(unittest.TestCase):
    def test_quote_final_copy_api_is_not_a_prose_owner(self):
        self.assertFalse(hasattr(owner, '_final_copy'))

    def test_success_copy_omits_routine_confirmation_boilerplate_all_languages(self):
        forbidden = ("Availability checked", "Disponibilidad comprobada",
                     "Disponibilité vérifiée", "Verfügbarkeit geprüft")
        for language in ("en", "es", "fr", "de"):
            self.assertFalse(any(phrase in owner._style_copy(language).values()
                                 for phrase in forbidden))

    def test_authoritative_numbered_room_is_disclosed_without_bed_code(self):
        plan = {"guest_count": 1, "guests": [{"name": "Raj"}],
                "selected_bed_codes": ["R1-B2"], "room_preference": "room 1"}
        offer = {"guest_count": 1,
                 "room_arrangement": [{"bed_code": "R1-B2", "room_code": "R1",
                                        "room_type": "shared", "gender_strategy": "mixed"}],
                 "guest_bed_assignments": [{"guest_index": 0, "guest_name": "Raj",
                                             "bed_code": "R1-B2"}]}
        text = " ".join(owner._guest_room_lines(plan, offer))
        self.assertIn("Room 1", text)
        self.assertNotIn("R1-B2", text)
        self.assertNotIn("Raj:", text)
        self.assertTrue(text[0].isupper(), text)

    def test_requested_room_mismatch_and_missing_identity_are_truthful(self):
        plan = {"room_preference": "room 1"}
        mismatch = {"room_arrangement": [{"room_code": "R3"}]}
        self.assertIn("Room 1 is not available", owner._requested_room_change_line(plan, mismatch))
        self.assertIsNone(owner._requested_room_change_line(plan, {"room_arrangement": []}))

    def test_whole_euro_and_fractional_money_boundaries(self):
        self.assertEqual(owner._guest_money(12000), "€120")
        self.assertEqual(owner._guest_money(10000), "€100")
        self.assertEqual(owner._guest_money(12099), "€120.99")
        self.assertNotEqual(owner._guest_money(12000), "€1200")
        self.assertNotEqual(owner._guest_money(10000), "€1000")


if __name__ == "__main__":
    unittest.main()
