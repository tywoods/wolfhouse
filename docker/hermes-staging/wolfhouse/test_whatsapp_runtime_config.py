"""Offline tests for the selected WhatsApp runtime mapping. No network."""

from __future__ import annotations

import os
import socket
import unittest
from pathlib import Path

from wolfhouse.whatsapp_runtime_config import (
    WhatsAppRuntimeConfigError,
    apply_whatsapp_runtime_config,
)


def synthetic(**overrides):
    env = {
        "WA_PHONE_NUMBER_ID": "2000000000000001",
        "WA_BUSINESS_ACCOUNT_ID": "2000000000000002",
        "WA_APP_ID": "2000000000000003",
        "WA_ACCESS_TOKEN": "sentinel-access-token",
        "WA_APP_SECRET": "sentinel-app-secret",
    }
    env.update(overrides)
    return env


class RuntimeConfigTests(unittest.TestCase):
    def test_absent_profile_is_a_noop(self):
        env = {"WHATSAPP_CLOUD_PHONE_NUMBER_ID": "keep-other-role"}
        self.assertEqual(apply_whatsapp_runtime_config(env), {"applied": False})
        self.assertEqual(env["WHATSAPP_CLOUD_PHONE_NUMBER_ID"], "keep-other-role")

    def test_maps_before_adapter_capture_and_is_idempotent(self):
        env = synthetic(WHATSAPP_CLOUD_ACCESS_TOKEN="stale-token", WHATSAPP_CLOUD_APP_SECRET="stale-secret")
        first = apply_whatsapp_runtime_config(env)
        second = apply_whatsapp_runtime_config(env)
        self.assertEqual(first, second)
        self.assertEqual(env["WHATSAPP_CLOUD_PHONE_NUMBER_ID"], "2000000000000001")
        self.assertEqual(env["WHATSAPP_CLOUD_ACCESS_TOKEN"], "sentinel-access-token")
        self.assertEqual(env["WHATSAPP_CLOUD_APP_SECRET"], "sentinel-app-secret")
        self.assertEqual(env["WHATSAPP_CLOUD_APP_ID"], "2000000000000003")
        self.assertNotEqual(env["WHATSAPP_CLOUD_ACCESS_TOKEN"], "stale-token")

    def test_missing_empty_and_alias_conflict_fail_closed(self):
        with self.assertRaises(WhatsAppRuntimeConfigError) as missing:
            apply_whatsapp_runtime_config(synthetic(WA_ACCESS_TOKEN=""))
        self.assertEqual(missing.exception.code, "secret_missing")
        with self.assertRaises(WhatsAppRuntimeConfigError) as malformed:
            apply_whatsapp_runtime_config(synthetic(WA_PHONE_NUMBER_ID="not-an-id"))
        self.assertEqual(malformed.exception.code, "identity_malformed")
        with self.assertRaises(WhatsAppRuntimeConfigError) as conflict:
            apply_whatsapp_runtime_config(synthetic(WHATSAPP_PHONE_NUMBER_ID="2000000000000099"))
        self.assertEqual(conflict.exception.code, "identity_alias_conflict")

    def test_apply_does_not_open_a_socket(self):
        def blocked(*_args, **_kwargs):
            raise AssertionError("network_forbidden")

        original = socket.socket
        socket.socket = blocked
        try:
            apply_whatsapp_runtime_config(synthetic())
            apply_whatsapp_runtime_config({})
        finally:
            socket.socket = original

    def test_hook_install_is_idempotent_and_code_only(self):
        import importlib.util
        script = Path(__file__).resolve().parents[1] / "apply_whatsapp_runtime_config.py"
        spec = importlib.util.spec_from_file_location("apply_whatsapp_runtime_config", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        source = 'whatsapp_cloud_phone_id = os.getenv("WHATSAPP_CLOUD_PHONE_NUMBER_ID")\n'
        once = module.install_hook(source)
        twice = module.install_hook(once)
        self.assertEqual(once, twice)
        self.assertEqual(once.count(module.MARKER), 1)
        compile(once, "<column0>", "exec")
        self.assertNotIn("sentinel", once)
        self.assertNotIn("keyvault", once.lower())
        indented = (
            "import os\n"
            "def load():\n"
            "    whatsapp_cloud_phone_id = os.getenv(\"WHATSAPP_CLOUD_PHONE_NUMBER_ID\")\n"
            "    return whatsapp_cloud_phone_id\n"
        )
        patched = module.install_hook(indented)
        compile(patched, "<indented>", "exec")
        self.assertEqual(module.install_hook(patched), patched)
        try_line = next(line for line in patched.splitlines() if line.strip() == "try:")
        import_line = next(line for line in patched.splitlines() if "import wolfhouse.whatsapp_runtime_config" in line)
        anchor_line = next(line for line in patched.splitlines() if line.strip() == module.ANCHOR)
        self.assertEqual(len(try_line) - len(try_line.lstrip(" ")), 4)
        self.assertEqual(len(import_line) - len(import_line.lstrip(" ")), 8)
        self.assertTrue(anchor_line.startswith("    "))
        self.assertLess(patched.index("try:"), patched.index(module.ANCHOR))
        with self.assertRaises(SystemExit):
            module.install_hook("no anchor here\n")
        with self.assertRaises(SystemExit):
            module.install_hook(indented + indented)
        text = Path(__file__).with_name("whatsapp_runtime_config.py").read_text(encoding="utf-8")
        self.assertNotIn("keyvault", text.lower())
        self.assertNotIn("graph.facebook.com", text)
        self.assertNotIn("dotenv", text.lower())
        self.assertNotIn("print(", text)


if __name__ == "__main__":
    raise SystemExit(unittest.main())
