"""Pre-booking email is admitted before package selection and carried to save."""
import unittest

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


if __name__ == "__main__":
    unittest.main()
