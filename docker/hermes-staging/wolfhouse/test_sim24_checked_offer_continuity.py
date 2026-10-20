"""Constructed Sim24 contract witnesses; captured evidence is only provenance.

These tests do not claim historical Staff response bodies.  They exercise the existing
owner rendering path with offline, constructed receipts derived from the approved cases.
"""
import json
from pathlib import Path
import unittest

from wolfhouse import accepted_quote as owner


class Sim24CheckedOfferContinuityTests(unittest.TestCase):
    def test_committed_five_case_fixture_is_loaded(self):
        fixture = json.loads((Path(__file__).parents[3] /
            "fixtures/booking-cleanup-step3/sim24-cases.json").read_text())
        self.assertEqual([case["case"] for case in fixture["sources"]],
                         ["guest1", "guest2", "guest3", "guest4", "guest5"])
        self.assertTrue(all(case["facts"]["create_and_link"]
                            for case in fixture["sources"]))

    def test_trusted_slot_keeps_guest_spelling_without_moving_bed(self):
        plan = {"guests": [{"name": "Lucía Fernández Ruiz"}]}
        offer = {
            "room_type": "shared",
            "guest_bed_assignments": [{"guest_index": 0, "guest_name": "lucía fernández ruiz", "bed_code": "R3-B1"}],
            "room_arrangement": [{"bed_code": "R3-B1", "room_code": "R3", "gender_strategy": "mixed"}],
        }
        self.assertEqual(owner._guest_room_lines(plan, offer, "es"),
                         ["Lucía Fernández Ruiz: una cama en una habitación mixta."])
        stale = {"guests": [{"name": "Camille Martin"}]}
        self.assertEqual(owner._guest_room_lines(stale, offer, "es"),
                         ["lucía fernández ruiz: una cama en una habitación mixta."])

    def test_duplicate_names_do_not_reassign_occupant_slots(self):
        plan = {"guests": [{"name": "Alex"}, {"name": "Alex"}]}
        offer = {"room_type": "shared", "guest_bed_assignments": [
            {"guest_index": 0, "guest_name": "Alex", "bed_code": "R1-B1"},
            {"guest_index": 1, "guest_name": "Alex", "bed_code": "R2-B1"}],
            "room_arrangement": [
                {"bed_code": "R1-B1", "room_code": "R1", "gender_strategy": "mixed"},
                {"bed_code": "R2-B1", "room_code": "R2", "gender_strategy": "mixed"}]}
        lines = owner._guest_room_lines(plan, offer)
        self.assertEqual(len(lines), 1)
        self.assertIn("two separate mixed rooms", lines[0])

    def test_missing_package_selection_explains_staff_backed_options_before_question(self):
        result = {"success": False, "package_choice_needed": True,
                  "next_action": "explain_packages_then_ask_choice",
                  "packages": {"malibu": {"total_cents": 12000, "includes_line": "Breakfast and board hire"},
                               "uluwatu": {"total_cents": 18000, "includes_line": "Breakfast, lessons and board hire"}}}
        text = owner._blocked_clarification_copy(result, {}, "en")
        self.assertIn("Malibu", text)
        self.assertIn("€120", text)
        self.assertIn("Uluwatu", text)
        self.assertIn("€180", text)
        self.assertIn("Breakfast and board hire", text)
        self.assertIn("Breakfast, lessons and board hire", text)
        self.assertEqual(text.count("?"), 1)

    def test_package_outcomes_remain_typed(self):
        unavailable = owner._blocked_clarification_copy({"package_choice_needed": True,
            "next_action": "package_eligibility_unavailable"}, {}, "en")
        ineligible = owner._blocked_clarification_copy({"package_choice_needed": True,
            "package_eligible": False, "next_action": "offer_accommodation_or_change_dates"}, {}, "en")
        self.assertIn("couldn't retrieve", unavailable)
        self.assertIn("not eligible", ineligible)
        self.assertNotEqual(unavailable, ineligible)

    def test_preferred_room_never_renders_as_exclusive(self):
        offer = {"room_type": "shared"}
        self.assertEqual(owner._room_kind(offer, {"gender_strategy": "female preferred"}), "shared room")
        self.assertEqual(owner._room_kind(offer, {"gender_strategy": "male preferred"}), "shared room")
        self.assertEqual(owner._room_kind(offer, {"gender_strategy": "female_only"}), "women's room")
        self.assertEqual(owner._room_kind(offer, {"gender_strategy": "male_only"}), "men's room")


if __name__ == "__main__":
    unittest.main()
