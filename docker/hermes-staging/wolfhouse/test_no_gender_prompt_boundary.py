"""Offline ordinary-worker prompt capture, not a model-conversation evaluation.

Real gateway patch emission/binding + real SOUL read; synthetic agent only
captures its input. No generated reply, provider call, guest send or DB write.
"""
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

STAGING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(STAGING))
import apply_gateway_patches as gw
from wolfhouse import luna_personality as lp
from wolfhouse.test_luna_personality_gateway_bind import skeleton, _invoke_emitted


class NoGenderPromptBoundaryTests(unittest.TestCase):
    def test_sunset_registered_tools_do_not_import_room_intake(self):
        sys.path.insert(0, str(STAGING / "plugins"))
        import wolfhouse_staff_api as plugin
        tools = {}
        registry = SimpleNamespace(register_tool=lambda **tool: tools.update({tool["name"]: tool}))
        with patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "sunset"}), \
                patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")) as network:
            plugin.register(registry)
        network.assert_not_called()
        self.assertIn("create_sunset_booking", tools)
        self.assertIn("get_sunset_offering_quote", tools)
        for name in ("quote_booking", "create_booking_from_plan", "check_availability"):
            self.assertNotIn(name, tools)
        for name in ("create_sunset_booking", "get_sunset_offering_quote"):
            properties = tools[name]["schema"]["parameters"]["properties"]
            for field in ("group_gender", "room_preference", "gender_preference", "room_name_hints"):
                self.assertNotIn(field, properties)

    def test_rule_survives_real_worker_binding_for_both_tenants_all_packs(self):
        original_read = Path.read_text
        installed = lp._soul_patch_installed
        lp.install_soul_append_runtime_patch()
        self.addCleanup(setattr, Path, "read_text", original_read)
        self.addCleanup(setattr, lp, "_soul_patch_installed", installed)
        self.addCleanup(lp.clear_bound_personality)
        for target in ("urllib.request.urlopen", "socket.socket.connect", "socket.create_connection"):
            tripwire = patch(target, side_effect=AssertionError("network forbidden"))
            mocked = tripwire.start()
            self.addCleanup(tripwire.stop)
            self.addCleanup(mocked.assert_not_called)
        for tenant, role, soul_path in (
            ("wolfhouse-somo", "luna", STAGING / "SOUL.md"),
            ("sunset-somo", "sunset-luna", STAGING.parent / "hermes-sunset/SOUL.md"),
        ):
            for pack in lp.CLOSED_PERSONALITY_IDS:
                for indent in (8, 12):
                    with self.subTest(tenant=tenant, pack=pack, indent=indent):
                        captured = []

                        class CaptureAgent:
                            def __init__(self, **kwargs):
                                captured.append(soul_path.read_text(encoding="utf-8"))

                            def run_conversation(self, *args, **kwargs):
                                # No prose manufactured here: this is input-boundary proof only.
                                return {"final_response": "", "messages": [], "api_calls": 0}

                        emitted, _ = gw.apply_luna_personality_gateway_patches(skeleton(indent))
                        namespace = {"AIAgent": CaptureAgent}
                        exec(emitted, namespace)
                        lp.clear_bound_personality()
                        with patch.dict(os.environ, {"LUNA_CLIENT_SLUG": tenant, "HERMES_ROLE": role}), \
                                patch.object(lp, "default_fetch_setting", return_value={"personality_id": pack}):
                            result, _ = _invoke_emitted(namespace, SimpleNamespace(platform="whatsapp"))
                        self.assertEqual(result["api_calls"], 0)
                        self.assertEqual(len(captured), 1)
                        prompt = captured[0]
                        self.assertEqual(prompt.count(lp.INJECTION_MARK), 1)
                        self.assertIn(lp.get_personality_pack(pack)["instruction"], prompt)
                        self.assertIn("After pay intent, never ask gender or group composition", prompt)
                        self.assertIn("all personality packs and guest languages", prompt)
                        if tenant == "wolfhouse-somo":
                            self.assertIn("Reuse the room choice and room-policy answers already given", prompt)
                            self.assertIn("Would a mixed dorm work for you?", prompt)
                        else:
                            self.assertIn("do not import Wolfhouse accommodation or room-composition intake", prompt)


if __name__ == "__main__":
    unittest.main(verbosity=2)
