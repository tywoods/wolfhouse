import importlib.util
import json
import os
import sys
import unittest
import io
import urllib.error
from pathlib import Path
from unittest import mock
from unittest.mock import patch

PLUGIN_PATH = Path(__file__).resolve().parent / "__init__.py"
PLUGIN_ROOT = PLUGIN_PATH.parent.parent


class LunaV3PluginContractTests(unittest.TestCase):
    def test_corrected_schemas_and_dispatch_contract(self):
        plugin = self.load_plugin()
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kwargs): self.tools[kwargs["name"]] = kwargs["schema"]["parameters"]
        registry = Registry(); plugin.register(registry)
        self.assertIn("guest_id", registry.tools["send_payment_link"]["required"])
        self.assertEqual("object", registry.tools["write_note"]["properties"]["context"]["type"])
        self.assertEqual("object", registry.tools["handoff_to_human"]["properties"]["context"]["type"])
        self.assertNotIn("operation_reference", registry.tools["recover_operation"]["properties"])
        self.assertIn("tool", registry.tools["recover_operation"]["required"])
        self.assertIn("operation_key", registry.tools["recover_operation"]["required"])
        for name in ("write_note", "handoff_to_human"):
            context = registry.tools[name]["properties"]["context"]
            self.assertEqual({"topic", "kind", "detail"}, set(context["properties"]))
            self.assertFalse(context["additionalProperties"])
            self.assertTrue(all(field["maxLength"] == 500 for field in context["properties"].values()))

    def test_http_error_fields_and_cross_host_redirect(self):
        plugin = self.load_plugin()
        error = urllib.error.HTTPError("https://staff.example/x", 409, "Conflict", None, io.BytesIO(b'{"code":"booking_paid","reason_code":"money_uncertain","error":"refused","outcome_unknown":true,"evil":"drop"}'))
        env = {"LUNA_V3_STAFF_API_BASE_URL":"https://staff.example","LUNA_V3_STAFF_API_TOKEN":"token","LUNA_V3_TENANT_ID":"wolfhouse-somo","LUNA_V3_SESSION_ID":"luna-v3:test"}
        with patch.dict(os.environ, env, clear=True), patch.object(plugin, "_open_staff", side_effect=error):
            result = plugin.call_tool("get_payment_status", {"booking_id":"b1"})
        self.assertEqual({"ok":False,"status":409,"code":"booking_paid","reason_code":"money_uncertain","error":"refused","outcome_unknown":True,"recoveryStatus":"rejected","outcome":"rejected"}, result)
        handler = plugin._SameHostRedirectHandler("https://staff.example")
        for unsafe in ("https://evil.example/x", "https://staff.example:444/x", "http://staff.example/x", "https://user@staff.example/x"):
            with self.assertRaises(urllib.error.HTTPError):
                handler.redirect_request(mock.Mock(), None, 302, "Found", {}, unsafe)
        server_error = urllib.error.HTTPError("https://staff.example/x", 503, "Unavailable", {}, io.BytesIO(b'{"outcome":"applied","recoveryStatus":"saved","code":"temporary"}'))
        with patch.dict(os.environ, env, clear=True), patch.object(plugin, "_open_staff", side_effect=server_error):
            failed = plugin.call_tool("get_payment_status", {"booking_id":"b1"})
        self.assertEqual("unknown", failed["outcome"])
        self.assertEqual("unknown", failed["recoveryStatus"])

    def test_staff_409_preserves_bounded_handoff_receipt(self):
        plugin = self.load_plugin()
        body = {
            "reason": "payment evidence needs Staff review",
            "requiredHumanHandoff": True,
            "handoffId": "handoff-123",
            "handoffOperationKey": "cancel-refusal:abc",
            "ignored": "not admitted",
        }
        error = urllib.error.HTTPError("https://staff.example/x", 409, "Conflict", None,
                                      io.BytesIO(json.dumps(body).encode()))
        env = {"LUNA_V3_STAFF_API_BASE_URL":"https://staff.example","LUNA_V3_STAFF_API_TOKEN":"token","LUNA_V3_TENANT_ID":"wolfhouse-somo","LUNA_V3_SESSION_ID":"luna-v3:test"}
        with patch.dict(os.environ, env, clear=True), patch.object(plugin, "_open_staff", side_effect=error):
            result = plugin.call_tool("cancel_unpaid", {"operation_key":"cancel-1"})
        for field in ("reason", "requiredHumanHandoff", "handoffId", "handoffOperationKey"):
            self.assertEqual(body[field], result[field])
        self.assertNotIn("ignored", result)

        body["reason"] = "r" * 161
        body["handoffId"] = 7
        body["handoffOperationKey"] = "k" * 161
        error = urllib.error.HTTPError("https://staff.example/x", 409, "Conflict", None,
                                      io.BytesIO(json.dumps(body).encode()))
        with patch.dict(os.environ, env, clear=True), patch.object(plugin, "_open_staff", side_effect=error):
            bounded = plugin.call_tool("cancel_unpaid", {"operation_key":"cancel-2"})
        self.assertNotIn("reason", bounded)
        self.assertNotIn("handoffId", bounded)
        self.assertNotIn("handoffOperationKey", bounded)
        self.assertTrue(bounded["requiredHumanHandoff"])

    def test_recover_operation_rejects_missing_key_before_transport(self):
        plugin = self.load_plugin()
        with patch.object(plugin, "_open_staff") as transport:
            with self.assertRaisesRegex(ValueError, "tool and operation_key are required"):
                plugin.call_tool("recover_operation", {})
        transport.assert_not_called()
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
            "recover_operation",
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
            params = tool["schema"]["parameters"]
            self.assertFalse(params.get("additionalProperties", True))
            if tool["name"] in plugin.WRITE_TOOLS:
                self.assertIn("operation_key", params["required"])
        by_name = {tool["name"]: tool["schema"]["parameters"] for tool in ctx.tools}
        self.assertIn("quoted_selection", by_name["hold_beds"]["required"])
        self.assertEqual({"type": "string", "minLength": 1}, by_name["hold_beds"]["properties"]["quoted_selection"])
        for field in ("package_ids", "service_ids"):
            self.assertEqual("array", by_name["get_pricing_catalog"]["properties"][field]["type"])
            self.assertEqual("string", by_name["get_pricing_catalog"]["properties"][field]["items"]["type"])
        self.assertNotIn("phone", by_name["get_booking"]["properties"])

    def test_quote_schema_teaches_clone_the_strict_staff_shape(self):
        plugin = self.load_plugin()

        class Context:
            def __init__(self): self.tools = []
            def register_tool(self, **kwargs): self.tools.append(kwargs)

        ctx = Context()
        plugin.register(ctx)
        quote = next(tool for tool in ctx.tools if tool["name"] == "quote")["schema"]["parameters"]
        guest = quote["properties"]["guests"]["items"]
        selection = quote["properties"]["selection"]
        add_on = quote["properties"]["add_ons"]["items"]

        self.assertEqual({"type": "string", "minLength": 1}, quote["properties"]["package_id"])

        self.assertEqual({"name", "explicit_gender"}, set(guest["properties"]))
        self.assertFalse(guest["additionalProperties"])
        self.assertNotIn("guest_id", guest["properties"])
        self.assertEqual(
            {"room_id", "bed_ids", "selected_bed_codes", "room_type", "room_preference", "keep_together"},
            set(selection["properties"]),
        )
        self.assertFalse(selection["additionalProperties"])
        self.assertNotIn("assignments", selection["properties"])
        self.assertNotIn("same_room_required", selection["properties"])
        self.assertEqual({"type": "boolean"}, selection["properties"]["keep_together"])
        self.assertEqual(1, selection["properties"]["selected_bed_codes"]["minItems"])
        self.assertTrue(selection["properties"]["selected_bed_codes"]["uniqueItems"])
        self.assertIn("anyOf", selection)
        preferences = next(tool for tool in ctx.tools if tool["name"] == "find_rooms")["schema"]["parameters"]["properties"]["preferences"]
        self.assertFalse(preferences["additionalProperties"])
        self.assertEqual({"room_type", "room_preference", "keep_together", "group_gender", "guests"}, set(preferences["properties"]))
        self.assertNotIn("same_room", preferences["properties"])
        self.assertEqual({"code", "days", "quantity", "dates"}, set(add_on["properties"]))
        self.assertEqual("date", add_on["properties"]["dates"]["items"]["format"])
        self.assertFalse(add_on["additionalProperties"])

    def test_soul_enforces_staff_truth_and_guest_safe_wording(self):
        soul = (PLUGIN_ROOT.parent / "SOUL.md").read_text()
        for phrase in (
            "current Staff Pricing is the sole authority",
            "do not infer open or closed and do not quote it",
            "After every `book` result, call `get_booking`",
            "call `read_notes` for the late-check-in procedure",
            "exact requested calendar dates in the quote `add_ons[].dates` field",
            "never mention an internal label mismatch to a guest",
            "For accommodation-only, omit `guest_packages` and `package_id`",
            "copy only `room_id` and `bed_ids` from the selected `find_rooms` result",
        ):
            self.assertIn(phrase, soul)

    def test_authentic_hermes_scanner_discovers_native_manifest(self):
        sys.path.insert(0, "/opt/hermes")
        try:
            from hermes_cli.plugins import PluginManager

            manifests = PluginManager()._scan_directory(PLUGIN_ROOT, "user")
        finally:
            sys.path.remove("/opt/hermes")
        self.assertEqual(["luna-v3-staff-api"], [manifest.name for manifest in manifests])
        self.assertEqual(["luna-v3-staff-api"], [manifest.key for manifest in manifests])
        bootstrap = PLUGIN_ROOT.parent / "bootstrap.sh"
        self.assertIn(
            'plugin.yaml "$HERMES_HOME/plugins/luna_v3_staff_api/plugin.yaml"',
            bootstrap.read_text(),
        )

    def test_every_handler_uses_authentic_registry_dispatch_contract(self):
        plugin = self.load_plugin()
        sys.path.insert(0, "/opt/hermes")
        try:
            from tools.registry import ToolRegistry

            registry = ToolRegistry()
        finally:
            sys.path.remove("/opt/hermes")
        plugin.register(type("Context", (), {"register_tool": registry.register})())
        calls = []

        def fake_call_tool(name, arguments):
            calls.append((name, arguments))
            return {"ok": False, "code": "offline_transport_sink"}

        with patch.object(plugin, "call_tool", fake_call_tool):
            outcomes = {
                name: json.loads(registry.dispatch(name, {"probe": name}, task_id="synthetic-runtime"))
                for name in plugin.TOOL_NAMES
            }
        self.assertEqual(16, len(calls))
        self.assertEqual(set(plugin.TOOL_NAMES), {name for name, _arguments in calls})
        self.assertTrue(all(arguments == {"probe": name} for name, arguments in calls))
        self.assertTrue(all(value["code"] == "offline_transport_sink" for value in outcomes.values()))

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
        with patch.dict(os.environ, env, clear=True), patch.object(plugin, "_open_staff", side_effect=lambda request, _base: fake_urlopen(request, 20)):
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
