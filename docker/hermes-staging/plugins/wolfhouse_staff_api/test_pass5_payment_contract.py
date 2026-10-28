"""Pass 5 registered contract regressions for payment distribution and shuttle facts."""
from copy import deepcopy
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

        def staff(path, body):
            captured.append((path, deepcopy(body)))
            if path == "/availability-check":
                guests = body["guests"]
                codes = [f"M{index + 1}" for index in range(len(guests))]
                return {"success": True, "has_enough_beds": True,
                        "available_beds": [{"bed_code": code, "room_code": "M"}
                                           for code in codes],
                        "selected_bed_codes": codes,
                        "room_eligibility": {"status": "yes"},
                        "exact_bed_eligibility": {
                            "eligible": True, "selected_bed_codes": codes,
                            "guest_bed_assignments": [
                                {"guest_index": index, "guest_name": guest["name"],
                                 "bed_code": codes[index]}
                                for index, guest in enumerate(guests)]}}
            self.assertEqual(path, "/booking-preview")
            total = 20000 * body["guest_count"]
            return {"success": True, "total_cents": total,
                    "deposit_required_cents": 10000 * body["guest_count"],
                    "payment_link_amount_cents": (
                        10000 * body["guest_count"]
                        if body["payment_choice"] == "deposit" else total),
                    "currency": "EUR", "offer_revision": {}}

        with patch.object(plugin, "_post_bot", side_effect=staff):
            for party_size in (2, 3):
                guests = [{"name": name} for name in ("Alex", "Sam", "Jo")[:party_size]]
                for amount in ("deposit", "full"):
                    for distribution in ("together", "separate"):
                        captured.clear()
                        result = json.loads(handler({
                            "check_in": "2026-11-01", "check_out": "2026-11-03",
                            "guest_count": party_size, "guests": guests,
                            "room_type": "shared", "package_code": "package_none",
                            "payment_choice": amount,
                            "payment_link_distribution": distribution,
                            "shuttle_choice": "declined"}))
                        self.assertTrue(result["success"], result)
                        body = captured[-1][1]
                        self.assertEqual(body["guests"], guests)
                        self.assertEqual(body["payment_choice"], amount)
                        self.assertEqual(body["payment_link_distribution"], distribution)
                        self.assertNotIn("payment_distribution", body)
                        self.assertIs(body["per_guest_payment_links"], distribution == "separate")
                        self.assertEqual(result["payment_link_distribution"], distribution)
                        self.assertIs(result["per_guest_payment_links"], distribution == "separate")


if __name__ == "__main__":
    unittest.main()
