"""Pass 5 registered contract regressions for payment distribution and shuttle facts."""
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "docker/hermes-staging"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wolfhouse_staff_api as plugin


class Registry:
    def __init__(self):
        self.tools = {}
        self.hooks = {}

    def register_tool(self, **tool):
        self.tools[tool["name"]] = tool

    def register_hook(self, name, fn):
        self.hooks[name] = fn


class Pass5RegisteredContractTests(unittest.TestCase):
    def setUp(self):
        self.registry = Registry()
        with patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "wolfhouse-somo",
                                     "SUNSET_INGRESS_LOCATION_ID": ""}):
            plugin.register(self.registry)

    def parameters(self, tool):
        return self.registry.tools[tool]["schema"]["parameters"]["properties"]

    def test_quote_and_create_advertise_independent_typed_distribution(self):
        for tool in ("quote_booking", "create_booking_from_plan"):
            with self.subTest(tool=tool):
                params = self.parameters(tool)
                self.assertEqual(params["payment_link_distribution"]["type"], "string")
                self.assertEqual(params["payment_link_distribution"]["enum"],
                                 ["together", "separate"])
                self.assertEqual(params["per_guest_payment_links"]["type"], "boolean")
                self.assertIn("payment_choice", params)

    def test_quote_and_create_advertise_resolved_shuttle_choice(self):
        for tool in ("quote_booking", "create_booking_from_plan"):
            with self.subTest(tool=tool):
                shuttle = self.parameters(tool)["shuttle_choice"]
                self.assertEqual(shuttle["type"], "string")
                self.assertEqual(shuttle["enum"], ["accepted", "declined"])

    def test_interpreter_exposes_distribution_and_shuttle_completions(self):
        completions = self.parameters("interpret_booking_turn")["completions"]["properties"]
        self.assertEqual(completions["payment_link_distribution"]["properties"]["value"]["enum"],
                         ["together", "separate"])
        self.assertEqual(completions["shuttle_choice"]["properties"]["value"]["enum"],
                         ["accepted", "declined"])

    def test_registered_quote_carries_distribution_independently_of_amount(self):
        handler = plugin.quote_booking.__wrapped__
        captured = []
        preview = {"success": True, "total_cents": 40000,
                   "deposit_required_cents": 20000, "currency": "EUR",
                   "offer_revision": {}}

        def staff(path, body):
            captured.append((path, dict(body)))
            if path == "/availability-check":
                return {"success": True, "has_enough_beds": True,
                        "available_beds": [{"bed_code": "M1", "room_code": "M"},
                                           {"bed_code": "M2", "room_code": "M"}],
                        "selected_bed_codes": ["M1", "M2"],
                        "room_eligibility": {"status": "yes"},
                        "exact_bed_eligibility": {
                            "eligible": True,
                            "selected_bed_codes": ["M1", "M2"],
                            "guest_bed_assignments": [
                                {"guest_index": 0, "guest_name": "Alex", "bed_code": "M1"},
                                {"guest_index": 1, "guest_name": "Sam", "bed_code": "M2"}]}}
            self.assertEqual(path, "/booking-preview")
            return {**preview, "payment_link_amount_cents":
                    20000 if body["payment_choice"] == "deposit" else 40000}

        with patch.object(plugin, "_post_bot", side_effect=staff):
            for amount in ("deposit", "full"):
                for distribution in ("together", "separate"):
                    captured.clear()
                    result = json.loads(handler({
                        "check_in": "2026-11-01", "check_out": "2026-11-03",
                        "guest_count": 2, "room_type": "shared",
                        "package_code": "package_none", "payment_choice": amount,
                        "payment_link_distribution": distribution,
                        "shuttle_choice": "declined"}))
                    self.assertTrue(result["success"], result)
                    body = captured[-1][1]
                    self.assertEqual(body["payment_choice"], amount)
                    self.assertEqual(body["payment_link_distribution"], distribution)
                    self.assertNotIn("payment_distribution", body)
                    self.assertIs(body["per_guest_payment_links"], distribution == "separate")
                    self.assertEqual(result["payment_link_distribution"], distribution)
                    self.assertIs(result["per_guest_payment_links"], distribution == "separate")


if __name__ == "__main__":
    unittest.main()
