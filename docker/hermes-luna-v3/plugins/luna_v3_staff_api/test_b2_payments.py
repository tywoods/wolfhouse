import importlib.util
import unittest
from pathlib import Path

PLUGIN = Path(__file__).with_name("__init__.py")


def load_plugin():
    spec = importlib.util.spec_from_file_location("luna_v3_b2_plugin", PLUGIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class B2PaymentSchemaTests(unittest.TestCase):
    def schema(self):
        plugin = load_plugin()
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kwargs): self.tools[kwargs["name"]] = kwargs["schema"]
        registry = Registry(); plugin.register(registry)
        return registry.tools["send_payment_link"]["parameters"]

    def test_payment_scope_and_choice_are_closed_enums(self):
        params = self.schema()
        self.assertEqual(["individual", "booking"], params["properties"]["payment_scope"]["enum"])
        self.assertEqual(["deposit", "full", "balance"], params["properties"]["payment_choice"]["enum"])
        self.assertEqual("uuid", params["properties"]["guest_id"]["format"])
        self.assertNotIn("guest_id", params["required"])
        self.assertIn("booking_id", params["required"])

    def test_model_money_remains_forbidden(self):
        plugin = load_plugin()
        for field in ("amount", "amount_cents", "currency"):
            with self.assertRaisesRegex(ValueError, "authority field"):
                plugin.call_tool("send_payment_link", {field: 100, "operation_key": "x"})


if __name__ == "__main__":
    unittest.main()
