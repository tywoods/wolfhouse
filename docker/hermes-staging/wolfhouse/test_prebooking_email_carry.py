"""Pre-booking email is admitted before package selection and carried to save."""
from copy import deepcopy
import unittest
from unittest.mock import patch

from wolfhouse import test_no_final_ask as fixture
import wolfhouse_staff_api as plugin


class PrebookingEmailCarryTests(unittest.TestCase):
    def test_quote_and_create_schema_carry_email_given_before_package_choice(self):
        class Registry:
            def __init__(self):
                self.tools = {}
                self.hooks = {}

            def register_tool(self, **kwargs):
                self.tools[kwargs["name"]] = kwargs

            def register_hook(self, name, handler, *args, **kwargs):
                self.hooks[name] = handler

        registry = Registry()
        plugin.register(registry)
        for tool_name in ("quote_booking", "create_booking_from_plan"):
            description = registry.tools[tool_name]["schema"]["parameters"]["properties"]["email"]["description"]
            lowered = description.casefold()
            self.assertIn("at any point before booking", lowered)
            self.assertIn("package", lowered)
            self.assertIn("carry", lowered)
            self.assertNotIn("after successful booking creation", lowered)


class SavedBookingPrebookingEmailTests(unittest.TestCase):
    setUp = fixture.NoFinalAskTests.setUp
    tearDown = fixture.NoFinalAskTests.tearDown
    call = fixture.NoFinalAskTests.call

    def test_email_given_before_package_choice_lands_on_saved_booking_contact(self):
        self.case = deepcopy(fixture.FIXTURES["klein"])
        early_email = "marta.before.package@example.com"
        first_quote = deepcopy(self.case["quote_args"])
        first_quote.pop("package_code", None)
        first_quote.pop("guest_packages", None)
        first_quote["email"] = early_email

        def staff(path, body):
            if path == "/package-price-preview":
                self.calls.append((path, deepcopy(body)))
                return {
                    "success": True,
                    "nights": 7,
                    "package_min_nights": 5,
                    "package_eligible": True,
                    "packages": {
                        "malibu": {"success": True, "total_cents": 59800},
                        "uluwatu": {"success": True, "total_cents": 79800},
                        "waimea": {"success": True, "total_cents": 99800},
                    },
                }
            if path == "/bookings/update-contact":
                self.calls.append((path, deepcopy(body)))
                return {"success": True, "write_performed": True,
                        "booking_code": body.get("booking_code"),
                        "email": body.get("email")}
            return fixture.NoFinalAskTests.staff(self, path, body)

        later_quote = deepcopy(self.case["quote_args"])
        later_quote.pop("email", None)
        create_args = deepcopy(self.case["create_args"])
        create_args.pop("email", None)

        with patch.object(plugin, "_post_bot", side_effect=staff):
            package_choice = self.call("quote_booking", first_quote)
            self.assertTrue(package_choice["package_choice_needed"], package_choice)
            quoted = self.call("quote_booking", later_quote)
            self.assertTrue(quoted["success"], quoted)
            saved = self.call("create_booking_from_plan", create_args)

        self.assertTrue(saved["success"], saved)
        self.assertEqual(saved["booking_id"], "offline-booking")
        self.assertTrue(saved["post_booking_email"]["saved"], saved)
        contacts = [body for path, body in self.calls if path == "/bookings/update-contact"]
        self.assertEqual(contacts, [{
            "client_slug": "wolfhouse-somo",
            "booking_code": "OFFLINE-NO-ASK",
            "email": early_email,
        }])
        creates = [body for path, body in self.calls if path == "/booking-create-from-plan"]
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]["email"], early_email)


if __name__ == "__main__":
    unittest.main()
