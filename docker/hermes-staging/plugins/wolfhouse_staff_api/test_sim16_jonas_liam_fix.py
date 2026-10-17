"""SIM16 Jonas/Liam regressions at the registered Wolfhouse TEST tool boundary."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

STAGING = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(STAGING), str(STAGING / "plugins")]
import wolfhouse_staff_api as plugin


class Registry:
    def __init__(self): self.tools = {}
    def register_tool(self, **kw): self.tools[kw["name"]] = kw
    def register_hook(self, *args, **kwargs): pass


class Sim16EligibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = Registry()
        plugin.register(cls.registry)

    def replay(self, room_preference, gender_preference, room_type):
        args = {"check_in": "2026-10-25", "check_out": "2026-10-27",
                "guest_count": 1, "room_type": "shared",
                "room_preference": room_preference,
                "gender_preference": gender_preference}
        receipt = {"success": True, "has_enough_beds": True,
                   "availability_status": "available", "next_action": "ready_for_bot_create",
                   "selected_room_code": "R", "selected_bed_codes": ["R12-B1"],
                   "available_count": 1,
                   "available_beds": [{"bed_code": "R12-B1", "room_code": "R",
                                       "room_type": room_type, "selected_selling_mode": "bed"}]}
        with patch.object(plugin, "_post_bot", return_value=receipt):
            return json.loads(self.registry.tools["check_availability"]["handler"](args))

    def test_liam_gender_preference_without_guests_keeps_male_bed_available(self):
        result = self.replay("male dorm", "male", "male_only")
        self.assertTrue(result["available"], result)
        self.assertEqual(result["next_action"], "ready_for_bot_create")
        self.assertEqual(result["selected_bed_codes"], ["R12-B1"])

    def test_chloe_gender_preference_without_guests_keeps_female_bed_available(self):
        result = self.replay("female_only", "female", "female_only")
        self.assertTrue(result["available"], result)
        self.assertEqual(result["next_action"], "ready_for_bot_create")

    def test_missing_eligibility_is_not_stock_unavailability(self):
        result = self.replay("female_only", "", "female_only")
        self.assertFalse(result["unavailable"], result)
        self.assertEqual(result["availability_status"], "eligibility_required")


class Sim16AcceptancePolicyTests(unittest.TestCase):
    def test_payment_choice_question_is_not_booking_acceptance(self):
        soul = (STAGING / "SOUL.md").read_text()
        self.assertIn("A payment-choice question is not acceptance", soul)
        self.assertIn("Can I pay everything now?", soul)


if __name__ == "__main__":
    unittest.main()
