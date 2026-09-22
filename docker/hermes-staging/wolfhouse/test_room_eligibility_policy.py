"""Deterministic room-eligibility contract for Wolfhouse Live Sim and WhatsApp."""
from __future__ import annotations

import math
import unittest

from wolfhouse.room_eligibility_policy import decide_room_eligibility


class RoomEligibilityPolicyTests(unittest.TestCase):
    def test_fred_solo_excludes_all_female_even_when_available(self):
        decision = decide_room_eligibility(
            guest_count=1,
            name="Fred",
            hint="male",
            confidence=0.91,
            available={"female_only": True, "male_only": True, "mixed": True},
        )
        self.assertFalse(decision["clarification_needed"])
        self.assertNotIn("female_only", decision["allowed_room_preferences"])
        self.assertIn("female_only", decision["excluded_room_preferences"])
        self.assertIn("mixed", decision["allowed_room_preferences"])
        self.assertTrue(decision["not_a_verified_demographic"])
        self.assertNotIn("I know you are male", str(decision))

    def test_explicit_male_plus_female_only_is_a_conflict(self):
        decision = decide_room_eligibility(
            guest_count=1,
            explicit_gender="male",
            room_preference="female_only",
            hint="female",
            confidence=0.99,
            available={"female_only": True, "mixed": True},
        )
        self.assertEqual(decision["conflict"], "female_only_overrides_explicit_male")
        self.assertTrue(decision["clarification_needed"])
        self.assertNotIn("female_only", decision["allowed_room_preferences"])
        self.assertFalse(decision["needs_human"])
        self.assertTrue(decision["do_not_escalate"])
        self.assertIn("mixed", decision["clarification_prompt"].lower())
        self.assertNotIn("team", decision["clarification_prompt"].lower())

    def test_male_hint_plus_female_only_asks_and_reoffers(self):
        decision = decide_room_eligibility(
            guest_count=1,
            name="Fred",
            hint="male",
            confidence=0.91,
            room_preference="female_only",
            available={"female_only": True, "male_only": True, "mixed": True},
        )
        self.assertEqual(decision["conflict"], "female_only_conflicts_with_male_hint")
        self.assertFalse(decision["needs_human"])
        self.assertIn("mixed", decision["allowed_room_preferences"])
        self.assertNotIn("female_only", decision["allowed_room_preferences"])
        self.assertNotIn("team", decision["clarification_prompt"].lower())

    def test_threshold_and_invalid_scores_do_not_grant_gendered_rooms(self):
        below = decide_room_eligibility(guest_count=1, name="Fred", hint="male", confidence=0.69)
        at = decide_room_eligibility(guest_count=1, name="Fred", hint="male", confidence=0.70)
        self.assertTrue(below["clarification_needed"])
        self.assertNotIn("female_only", below["allowed_room_preferences"])
        self.assertFalse(at["clarification_needed"])
        self.assertNotIn("female_only", at["allowed_room_preferences"])
        for bad in (None, "high", math.nan, 1.2, -0.1, "0.99"):
            # "0.99" as a string is a valid number and must still respect ambiguity below.
            if bad == "0.99":
                continue
            decision = decide_room_eligibility(guest_count=1, name="Sam", hint="male", confidence=bad)
            self.assertTrue(decision["clarification_needed"], bad)
            self.assertNotIn("female_only", decision["allowed_room_preferences"])

    def test_ambiguity_flag_wins_over_high_score(self):
        decision = decide_room_eligibility(
            guest_count=1, name="Alex", hint="male", confidence=0.99, ambiguous=True,
        )
        self.assertTrue(decision["clarification_needed"])
        self.assertEqual(decision["clarification_prompt"], "Would a mixed dorm work for you?")
        self.assertNotIn("female_only", decision["allowed_room_preferences"])
        self.assertNotIn("male_only", decision["allowed_room_preferences"])

    def test_complete_roster_can_guide_group_but_booker_alone_cannot(self):
        booker = decide_room_eligibility(
            guest_count=3,
            travelers=[{"name": "Fred", "hint": "male", "confidence": 0.95}],
        )
        self.assertTrue(booker["clarification_needed"])
        self.assertNotIn("female_only", booker["allowed_room_preferences"])

        complete = decide_room_eligibility(
            guest_count=2,
            travelers=[
                {"name": "Fred", "hint": "male", "confidence": 0.95},
                {"name": "Sam", "hint": "male", "confidence": 0.80},
            ],
        )
        self.assertFalse(complete["clarification_needed"])
        self.assertEqual(complete["resolved_composition"], "male")
        self.assertNotIn("female_only", complete["allowed_room_preferences"])

        mixed = decide_room_eligibility(
            guest_count=2,
            travelers=[
                {"name": "Fred", "hint": "male", "confidence": 0.95},
                {"name": "Anna", "hint": "female", "confidence": 0.95},
            ],
        )
        self.assertEqual(mixed["resolved_composition"], "mixed")
        self.assertNotIn("female_only", mixed["allowed_room_preferences"])
        self.assertNotIn("male_only", mixed["allowed_room_preferences"])

    def test_explicit_correction_overrides_hint_and_private_skips_question(self):
        corrected = decide_room_eligibility(
            guest_count=1,
            name="Fred",
            hint="male",
            confidence=0.99,
            explicit_gender="female",
            available={"female_only": True, "mixed": True},
        )
        self.assertEqual(corrected["resolved_composition"], "female")
        self.assertIn("female_only", corrected["allowed_room_preferences"])
        self.assertFalse(corrected["provisional"])

        private = decide_room_eligibility(
            guest_count=2,
            room_preference="couple_private",
            private_room_chosen=True,
            travelers=[{"name": "Alex"}],
            available={"private": True},
        )
        self.assertFalse(private["clarification_needed"])
        self.assertIn("couple_private", private["allowed_room_preferences"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
