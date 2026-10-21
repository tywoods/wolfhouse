"""Offline regressions for default solo shared placement.

No network, Staff write, payment, or booking-create path is exercised here.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "docker/hermes-staging"))
sys.path.insert(0, str(ROOT / "docker/hermes-staging/plugins"))

import wolfhouse_staff_api as plugin
from wolfhouse.room_eligibility_policy import decide_room_eligibility


class Registry:
    def __init__(self):
        self.tools = {}

    def register_tool(self, **tool):
        self.tools[tool["name"]] = tool


class SoloSharedDefaultTests(unittest.TestCase):
    def setUp(self):
        for target in ("urllib.request.urlopen", "socket.socket.connect", "socket.create_connection"):
            tripwire = patch(target, side_effect=AssertionError("network forbidden"))
            mocked = tripwire.start()
            self.addCleanup(tripwire.stop)
            self.addCleanup(mocked.assert_not_called)
        env = patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "wolfhouse-somo"})
        env.start()
        self.addCleanup(env.stop)
        registry = Registry()
        plugin.register(registry)
        self.tools = registry.tools
        self.base = {
            "client_slug": "wolfhouse-somo",
            "check_in": "2027-07-05",
            "check_out": "2027-07-08",
            "guest_count": 1,
            "package_code": "package_none",
            "guest_name": "Fabio",
            "guests": [{"name": "Fabio"}],
        }
        self.mixed_bed = {
            "bed_code": "M1", "room_code": "MIX", "room_type": "mixed",
        }

    def test_policy_defaults_unknown_solo_to_available_shared_without_gender_claim(self):
        decision = decide_room_eligibility(
            guest_count=1,
            name="Fabio",
            available={"mixed": True, "female_only": True},
        )
        self.assertFalse(decision["clarification_needed"])
        self.assertIsNone(decision["clarification_prompt"])
        self.assertEqual(decision["resolved_composition"], "unknown")
        self.assertEqual(decision["allowed_room_preferences"], ["mixed", "shared"])
        self.assertEqual(decision["excluded_room_preferences"], ["female_only", "male_only"])

    def test_registered_quote_defaults_unknown_and_explicit_male_solos_to_mixed(self):
        availability = {
            "success": True,
            "has_enough_beds": True,
            "selected_room_code": "MIX",
            "selected_bed_codes": ["M1"],
            "available_beds": [self.mixed_bed],
        }
        preview = {
            "success": True,
            "offer_revision": "solo-mixed-r1",
            "quote_status": "ready",
            "quote": {
                "total_cents": 12000,
                "deposit_required_cents": 3000,
                "balance_due_cents": 12000,
            },
        }
        for explicit_gender in (None, "male"):
            with self.subTest(explicit_gender=explicit_gender):
                payload = dict(self.base)
                if explicit_gender:
                    payload["explicit_gender"] = explicit_gender
                calls = []

                def transport(path, body):
                    calls.append((path, dict(body)))
                    return availability if path == "/availability-check" else preview

                with patch.object(plugin, "_post_bot", side_effect=transport):
                    result = json.loads(self.tools["quote_booking"]["handler"](payload))

                self.assertEqual([path for path, _ in calls],
                                 ["/availability-check", "/booking-preview"])
                for _, sent in calls:
                    self.assertEqual(sent["room_preference"], "mixed")
                    self.assertNotIn("name_hint", sent)
                    if explicit_gender is None:
                        self.assertNotIn("group_gender", sent)
                self.assertTrue(result["success"], result)
                self.assertEqual(result["quote_status"], "ready")
                self.assertNotEqual(result.get("reply_draft"),
                                    "Would a mixed dorm work for you?")
                self.assertFalse(result["room_decision"]["clarification_needed"])

    def test_default_helper_preserves_female_private_specific_and_group_requests(self):
        cases = (
            {"guest_count": 1, "guests": [{"name": "A", "explicit_gender": "female"}]},
            {"guest_count": 1, "explicit_gender": "female"},
            {"guest_count": 1, "room_type": "private"},
            {"guest_count": 1, "room_preference": "room 3"},
            {"guest_count": 2, "guests": [{"name": "A"}, {"name": "B"}]},
        )
        for original in cases:
            with self.subTest(original=original):
                payload = json.loads(json.dumps(original))
                plugin._default_solo_shared_placement(payload)
                self.assertEqual(payload, original)

    def test_no_mixed_stock_remains_truthful_and_does_not_quote(self):
        sold_out = {
            "success": True,
            "has_enough_beds": False,
            "availability_status": "unavailable",
            "selected_bed_codes": [],
            "available_beds": [],
        }
        with patch.object(plugin, "_post_bot", return_value=sold_out) as transport:
            result = json.loads(self.tools["quote_booking"]["handler"](dict(self.base)))
        transport.assert_called_once()
        self.assertEqual(transport.call_args.args[0], "/availability-check")
        self.assertEqual(transport.call_args.args[1]["room_preference"], "mixed")
        self.assertFalse(result["success"])
        self.assertTrue(result["unavailable"])
        self.assertIsNone(result["total_cents"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
