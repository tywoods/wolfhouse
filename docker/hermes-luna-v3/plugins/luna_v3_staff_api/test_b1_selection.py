import importlib.util
import unittest
from pathlib import Path

PLUGIN_PATH = Path(__file__).resolve().parent / "__init__.py"
SOUL_PATH = PLUGIN_PATH.parent.parent.parent / "SOUL.md"


def load_plugin():
    spec = importlib.util.spec_from_file_location("luna_v3_staff_api_b1", PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class B1RegisteredSelectionTests(unittest.TestCase):
    def schemas(self):
        plugin = load_plugin()
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kwargs): self.tools[kwargs["name"]] = kwargs["schema"]
        registry = Registry()
        plugin.register(registry)
        return registry.tools

    def test_hold_schema_is_exact_canonical_receipt_shape(self):
        hold = self.schemas()["hold_beds"]
        params = hold["parameters"]
        self.assertEqual(
            {"operation_key", "check_in", "check_out", "guests", "assignments", "quoted_selection"},
            set(params["required"]),
        )
        assignment = params["properties"]["assignments"]
        self.assertEqual(1, assignment["minItems"])
        self.assertEqual(
            {"bed_code", "guest_name", "package_code"},
            set(assignment["items"]["required"]),
        )
        self.assertIn("package_none", assignment["items"]["properties"]["package_code"]["description"])
        self.assertIn("copy", hold["description"].lower())

    def test_dated_rental_schema_documents_units(self):
        add_on = self.schemas()["quote"]["parameters"]["properties"]["add_ons"]["items"]
        self.assertIn("distinct", add_on["properties"]["days"]["description"])
        self.assertIn("people or equipment", add_on["properties"]["quantity"]["description"])
        self.assertIn("exact service dates", add_on["properties"]["dates"]["description"])

    def test_soul_requires_bounded_recovery_and_fresh_lesson_consent(self):
        soul = SOUL_PATH.read_text()
        for phrase in (
            "A known rejected hold",
            "use a new operation key",
            "recover it with its original operation key first",
            "fresh explicit yes to the unscheduled alternative",
            "do not hold or book the older offer",
        ):
            self.assertIn(phrase, soul)


if __name__ == "__main__":
    unittest.main()
