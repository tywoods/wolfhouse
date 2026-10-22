import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN_PATH = Path(__file__).resolve().parent / "__init__.py"


class LunaV3PluginContractTests(unittest.TestCase):
    def load_plugin(self):
        spec = importlib.util.spec_from_file_location("luna_v3_staff_api", PLUGIN_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_exports_only_model_led_staff_tools(self):
        plugin = self.load_plugin()
        expected = {
            "check_availability", "find_rooms", "get_pricing_catalog", "quote",
            "hold_beds", "book", "release_hold", "get_booking",
            "get_payment_status", "send_payment_link", "cancel_unpaid", "read_notes",
            "write_note", "save_transfer_request", "handoff_to_human",
        }
        self.assertEqual(set(plugin.TOOL_NAMES), expected)
        self.assertTrue(all(path.startswith("/staff/bot/luna-v3/") for path in plugin.TOOL_PATHS.values()))
        source = PLUGIN_PATH.read_text()
        self.assertNotIn("accepted_quote", source)
        self.assertNotIn("wolfhouse_staff_api", source)
        self.assertNotIn("send_whatsapp", plugin.TOOL_NAMES)
        self.assertNotIn("send_sms", plugin.TOOL_NAMES)

    def test_registers_every_contract_tool_with_hermes(self):
        plugin = self.load_plugin()

        class Context:
            def __init__(self):
                self.tools = []

            def register_tool(self, **kwargs):
                self.tools.append(kwargs)

        ctx = Context()
        plugin.register(ctx)
        self.assertEqual(set(plugin.TOOL_NAMES), {tool["name"] for tool in ctx.tools})
        self.assertEqual({"luna_v3_staff_api"}, {tool["toolset"] for tool in ctx.tools})
        for tool in ctx.tools:
            self.assertFalse(tool["schema"]["parameters"].get("additionalProperties", True))
            if tool["name"] in plugin.WRITE_TOOLS:
                self.assertIn("operation_key", tool["schema"]["parameters"]["required"])

    def test_request_is_clone_scoped_and_transport_disabled(self):
        plugin = self.load_plugin()
        captured = {}

        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def read(self): return json.dumps({"ok": True, "facts": {"rooms": []}}).encode()

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.header_items())
            captured["body"] = json.loads(request.data.decode())
            captured["timeout"] = timeout
            return Response()

        env = {
            "LUNA_V3_STAFF_API_BASE_URL": "https://staff-staging.lunafrontdesk.com",
            "LUNA_V3_STAFF_API_TOKEN": "clone-token",
            "LUNA_V3_TENANT_ID": "wolfhouse-somo",
            "LUNA_V3_SESSION_ID": "v3-test-session",
            "LUNA_V3_EXTERNAL_SEND_ENABLED": "false",
            "LUNA_V3_STAFF_ALERTS_ENABLED": "false",
        }
        with patch.dict(os.environ, env, clear=True), patch("urllib.request.urlopen", fake_urlopen):
            result = plugin.call_tool("find_rooms", {"check_in": "2027-11-05", "check_out": "2027-11-15", "party_size": 2})

        self.assertTrue(result["ok"])
        self.assertEqual(captured["url"], "https://staff-staging.lunafrontdesk.com/staff/bot/luna-v3/find-rooms")
        self.assertEqual(captured["body"]["tenant_id"], "wolfhouse-somo")
        self.assertEqual(captured["body"]["session_id"], "v3-test-session")
        self.assertFalse(captured["body"]["external_send_allowed"])
        self.assertFalse(captured["body"]["staff_alert_allowed"])

        with self.assertRaisesRegex(ValueError, "authority field"):
            plugin.call_tool("quote", {"selection": {"amount_cents": 1234}})

    def test_refuses_missing_token_and_send_flags(self):
        plugin = self.load_plugin()
        base = {
            "LUNA_V3_STAFF_API_BASE_URL": "https://staff-staging.lunafrontdesk.com",
            "LUNA_V3_TENANT_ID": "wolfhouse-somo",
            "LUNA_V3_SESSION_ID": "v3-test-session",
        }
        with patch.dict(os.environ, base, clear=True):
            with self.assertRaisesRegex(RuntimeError, "(?i)token"):
                plugin.call_tool("check_availability", {})
        enabled = {**base, "LUNA_V3_STAFF_API_TOKEN": "x", "LUNA_V3_EXTERNAL_SEND_ENABLED": "true"}
        with patch.dict(os.environ, enabled, clear=True):
            with self.assertRaisesRegex(RuntimeError, "external send"):
                plugin.call_tool("check_availability", {})


if __name__ == "__main__":
    unittest.main()
