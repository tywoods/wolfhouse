#!/usr/bin/env python3
"""Unit tests for Discord bot-wake adapter patcher (stdlib only)."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
FIXTURE = ROOT / "fixtures" / "water_cooler_a2a" / "discord_adapter_admission_shape.py"
PATCHER_PATH = STAGING / "apply_discord_bot_wake_patch.py"
A2A_PATCHER_PATH = STAGING / "apply_water_cooler_a2a_adapter_patch.py"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


patcher = _load("discord_bot_wake_patcher_under_test", PATCHER_PATH)
a2a = _load("water_cooler_a2a_adapter_patcher_for_bot_wake", A2A_PATCHER_PATH)


class DiscordBotWakePatchTests(unittest.TestCase):
    def test_fixture_patches_idempotently(self):
        src = FIXTURE.read_text(encoding="utf-8")
        once, meta1 = patcher.patch_adapter_source(src)
        self.assertTrue(meta1["changed"])
        self.assertIn(patcher.MARKER, once)
        patcher.validate_patched_source(once)

        twice, meta2 = patcher.patch_adapter_source(once)
        self.assertFalse(meta2["changed"])
        self.assertEqual(once, twice)

    def test_preserves_a2a_admission_anchors(self):
        src = FIXTURE.read_text(encoding="utf-8")
        patched, _ = patcher.patch_adapter_source(src)
        # A2A still needs comment + mentions anchors unique.
        self.assertEqual(patched.count(a2a.ANCHOR_ALLOW_BOTS_COMMENT), 1)
        self.assertEqual(patched.count(a2a.ANCHOR_ALLOW_BOTS_MENTIONS), 1)
        # After bot-wake, bare assign anchor is gone — A2A validate_admission_shape
        # is for unpatched adapters. Patched source must still compile and keep
        # mentions gate.
        self.assertIn('elif allow_bots == "mentions":', patched)
        self.assertIn("bot_wake_admit as _wh_bot_wake", patched)
        # Must not rewrite the env default to all — only promote per-message.
        self.assertNotIn('os.getenv("DISCORD_ALLOW_BOTS", "all")', patched)
        self.assertIn('os.getenv("DISCORD_ALLOW_BOTS", "none")', patched)

    def test_missing_anchor_fail_closed(self):
        with self.assertRaises(patcher.AdapterPatchError):
            patcher.patch_adapter_source("no anchors here")

    def test_file_write_idempotent(self):
        src = FIXTURE.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "adapter.py"
            path.write_text(src, encoding="utf-8")
            meta1 = patcher.patch_adapter_file(path)
            self.assertTrue(meta1["changed"])
            body1 = path.read_text(encoding="utf-8")
            meta2 = patcher.patch_adapter_file(path)
            self.assertFalse(meta2["changed"])
            self.assertEqual(body1, path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
