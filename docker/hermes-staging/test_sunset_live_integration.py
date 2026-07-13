import importlib
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
import contextvars
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class SunsetLiveIntegrationTests(unittest.TestCase):
    def test_phone_number_id_resolves_location_and_unknown_fails_closed(self):
        routing = load(ROOT / "sunset_tenant_routing.py", "sunset_routing")
        env = {
            "HERMES_ROLE": "sunset-luna",
            "SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID": "pn-somo",
            "SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID": "pn-sardinero",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(routing.resolve_location({"metadata": {"phone_number_id": "pn-somo"}}), "sunset-somo")
            self.assertEqual(routing.resolve_location({"metadata": {"phone_number_id": "pn-sardinero"}}), "sunset-sardinero")
            with self.assertRaises(routing.TenantRoutingError):
                routing.resolve_location({"metadata": {"phone_number_id": "unknown"}})

    def test_plugin_forces_tenant_and_location_and_rejects_model_escape(self):
        plugin = load(ROOT / "plugins/wolfhouse_staff_api/__init__.py", "sunset_staff_plugin")
        env = {
            "LUNA_CLIENT_SLUG": "sunset",
            "LUNA_ALLOWED_LOCATION_IDS": "sunset-somo,sunset-sardinero",
            "LUNA_BOT_INTERNAL_TOKEN": "secret",
        }
        captured = {}
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"success":true}'
        def open_(req, timeout):
            captured.update(json.loads(req.data))
            return Response()
        routing = importlib.import_module("sunset_tenant_routing")
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(plugin.urllib.request, "urlopen", open_):
            token = routing.set_current_location("sunset-somo")
            self.assertTrue(plugin._post_bot("/availability-check", {"client_slug": "wolfhouse-somo", "location_id": "sunset-somo"})["success"])
            self.assertEqual(captured, {"client_slug": "sunset", "location_id": "sunset-somo"})
            denied = plugin._post_bot("/availability-check", {"location_id": "other"})
            self.assertFalse(denied["success"])
            self.assertEqual(denied["staff_api_status"], "tenant_scope_denied")
            routing.reset_current_location(token)

    def test_location_binding_is_context_local_across_concurrent_turn_contexts(self):
        routing = importlib.import_module("sunset_tenant_routing")
        first = contextvars.copy_context()
        second = contextvars.copy_context()
        first.run(routing.set_current_location, "sunset-somo")
        second.run(routing.set_current_location, "sunset-sardinero")
        self.assertEqual(first.run(routing.get_current_location), "sunset-somo")
        self.assertEqual(second.run(routing.get_current_location), "sunset-sardinero")
        self.assertNotIn("LUNA_LOCATION_ID", os.environ)

    def test_plugin_keeps_ingress_location_across_empty_tool_context(self):
        """Regression: Hermes tool execution may not inherit gateway ContextVars."""
        plugin = load(ROOT / "plugins/wolfhouse_staff_api/__init__.py", "sunset_staff_plugin_context_boundary")
        routing = importlib.import_module("sunset_tenant_routing")
        env = {
            "LUNA_CLIENT_SLUG": "sunset",
            "LUNA_ALLOWED_LOCATION_IDS": "sunset-somo,sunset-sardinero",
            "LUNA_BOT_INTERNAL_TOKEN": "secret",
            "SUNSET_INGRESS_LOCATION_ID": "sunset-somo",
        }
        captured = {}

        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"success":true}'

        def open_(req, timeout):
            captured.update(json.loads(req.data))
            return Response()

        routing.clear_current_location()
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(plugin.urllib.request, "urlopen", open_):
            result = contextvars.Context().run(
                plugin._post_bot,
                "/availability-check",
                {"client_slug": "wolfhouse-somo", "location_id": "sunset-somo"},
            )
        self.assertTrue(result["success"])
        self.assertEqual(captured, {"client_slug": "sunset", "location_id": "sunset-somo"})

    def test_image_and_bootstrap_own_sunset_live_paths(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        bootstrap = (ROOT / "bootstrap.sh").read_text()
        compose = (ROOT.parent / "hermes-sunset/docker-compose.vm.yml").read_text()
        self.assertIn("sunset_tenant_routing.py", dockerfile)
        self.assertIn('HERMES_ROLE" = "sunset-luna"', bootstrap)
        self.assertIn("LUNA_ALLOWED_LOCATION_IDS", bootstrap)
        self.assertIn("sunset-somo,sunset-sardinero", compose)
        self.assertNotIn("LUNA_ALLOWED_LOCATION_IDS: somo,sardinero", compose)
        self.assertNotIn("98-sunset-bootstrap", compose)
        self.assertIn("API_SERVER_KEY", bootstrap)
        self.assertIn("link_shared_auth", bootstrap)

    def test_shared_cami_contract_rejects_canned_robot_voice(self):
        sunset = (ROOT.parent / "hermes-sunset/SOUL.md").read_text()
        wolfhouse = (ROOT / "SOUL.md").read_text()
        for soul in (sunset, wolfhouse):
            self.assertIn("Start from what the guest actually said", soul)
            self.assertIn("Warmth must survive without emojis", soul)

        # Sunset SOUL: emoji + opener variation contract (anti-robot / anti-canned voice).
        # This is intentionally checked via narrow semantic substrings (not a brittle literal like "0–2 emojis").
        self.assertIn("Never repeat the same emoji in two consecutive replies", sunset)
        self.assertIn("Use 😊 at most once in any three consecutive replies", sunset)
        self.assertIn("At least one of every three ordinary replies should use no emoji", sunset)
        self.assertIn("A practical question deserves a plain, warm answer", sunset)
        self.assertIn("Openers — earn them.", sunset)
        self.assertIn("Do not habitually begin with", sunset)
        self.assertIn("Never reuse the same opener two replies running", sunset)

        # Wolfhouse SOUL still uses a numeric emoji guideline today; keep the shared anti-canned intent checks.
        self.assertIn("Do not habitually open", wolfhouse)
        self.assertIn("do not repeat the same opener", wolfhouse.lower())
        self.assertIn("0–2 emojis", wolfhouse)
        for canned in ("Ciaooo!", "Yesss,", "Amazinggg"):
            self.assertNotIn(canned, sunset)
            self.assertNotIn(canned, wolfhouse)

    def test_sunset_soul_group_lesson_component_rules(self):
        sunset = (ROOT.parent / "hermes-sunset/SOUL.md").read_text()
        self.assertIn("components.lesson", sunset)
        self.assertIn("surfers, not days", sunset)
        self.assertIn("Never send `group_lesson`", sunset)
        self.assertIn("course_id", sunset)

    def test_sunset_soul_group_lesson_quote_ordering(self):
        sunset = (ROOT.parent / "hermes-sunset/SOUL.md").read_text()
        self.assertIn("get_sunset_group_lesson_quote", sunset)
        self.assertIn("Never ask for a booking name before the authoritative group-lesson quote", sunset)
        self.assertIn("never use **create_sunset_booking** to discover a price", sunset.lower())
        self.assertIn("get_sunset_lesson_availability", sunset)

    def test_optional_anthropic_token_cannot_fail_luna_env_write(self):
        bootstrap = (ROOT / "bootstrap.sh").read_text()
        self.assertRegex(
            bootstrap,
            r'\[ -n "\$\{ANTHROPIC_TOKEN:-\}" \].*ANTHROPIC_TOKEN=.*\|\| true',
        )


if __name__ == "__main__":
    unittest.main()
