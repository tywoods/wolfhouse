"""RED-first contract for the Wolfhouse :8090 no-send personality probe."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))


class Wolfhouse8090PersonalityProbeTests(unittest.TestCase):
    def test_wolfhouse_only_probe_observes_selected_pack_once_without_send_or_model(self) -> None:
        from wolfhouse.luna_personality_8090_probe import run_no_send_injection_probe

        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            os.environ,
            {"HERMES_ROLE": "luna", "LUNA_CLIENT_SLUG": "wolfhouse-somo"},
            clear=False,
        ):
            soul = Path(tmp) / "SOUL.md"
            soul.write_text("# Luna\nIdentity and booking truth stay here.\n", encoding="utf-8")
            conversationalist = run_no_send_injection_probe("conversationalist", soul_path=soul)
            sunny = run_no_send_injection_probe("sunny", soul_path=soul)

        self.assertTrue(conversationalist["ok"])
        self.assertTrue(conversationalist["no_send"])
        self.assertEqual(conversationalist["requested_personality_id"], "conversationalist")
        self.assertEqual(conversationalist["observed_personality_id"], "conversationalist")
        self.assertEqual(conversationalist["injection_count"], 1)
        self.assertEqual(conversationalist["sends_attempted"], 0)
        self.assertEqual(conversationalist["tools_invoked"], 0)
        self.assertEqual(conversationalist["model_calls"], 0)
        self.assertNotEqual(conversationalist["prompt_sha256"], sunny["prompt_sha256"])
        self.assertEqual(sunny["observed_personality_id"], "sunny")

    def test_probe_refuses_non_wolfhouse_identity_and_invalid_pack(self) -> None:
        from wolfhouse.luna_personality_8090_probe import ProbeRefusal, run_no_send_injection_probe

        with mock.patch.dict(
            os.environ,
            {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"},
            clear=False,
        ):
            with self.assertRaisesRegex(ProbeRefusal, "wolfhouse_8090_identity_required"):
                run_no_send_injection_probe("sunny")
        with mock.patch.dict(
            os.environ,
            {"HERMES_ROLE": "luna", "LUNA_CLIENT_SLUG": "wolfhouse-somo"},
            clear=False,
        ):
            with self.assertRaisesRegex(ProbeRefusal, "invalid_personality_id"):
                run_no_send_injection_probe("guest_supplied_style")

    def test_route_registers_only_for_wolfhouse_8090_identity(self) -> None:
        from wolfhouse.luna_personality_8090_probe import PROBE_PATH, register_wolfhouse_8090_probe_route

        class Router:
            def __init__(self) -> None:
                self.routes = []

            def add_post(self, path, handler) -> None:
                self.routes.append((path, handler))

        class App:
            def __init__(self) -> None:
                self.router = Router()

        app = App()
        with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            self.assertFalse(register_wolfhouse_8090_probe_route(app))
        self.assertEqual(app.router.routes, [])
        with mock.patch.dict(os.environ, {"HERMES_ROLE": "luna", "LUNA_CLIENT_SLUG": "wolfhouse-somo"}, clear=False):
            self.assertTrue(register_wolfhouse_8090_probe_route(app))
            self.assertTrue(register_wolfhouse_8090_probe_route(app))
        self.assertEqual([row[0] for row in app.router.routes], [PROBE_PATH])

    def test_base_soul_defers_optional_tone_to_the_selected_pack(self) -> None:
        soul = (STAGING / "SOUL.md").read_text(encoding="utf-8")
        self.assertIn("Selected Luna Personality pack is the sole authority", soul)
        self.assertNotIn("warm, bubbly, ONE friendly ask", soul)
        self.assertNotIn("bubbly surfer-girl voice", soul)
        self.assertNotIn("sunny, emoji-warm welcome", soul)

    def test_gateway_patcher_registers_the_probe_without_registering_sunset_route(self) -> None:
        import apply_whatsapp_fresh_start_route as patcher

        self.assertIn("WOLFHOUSE_8090_PROBE_ROUTE_TAG", patcher.__dict__)
        self.assertIn("register_wolfhouse_8090_probe_route", patcher.WOLFHOUSE_8090_PROBE_ROUTE)
        self.assertNotIn("luna_personality_live_eval", patcher.WOLFHOUSE_8090_PROBE_ROUTE)


if __name__ == "__main__":
    unittest.main()
