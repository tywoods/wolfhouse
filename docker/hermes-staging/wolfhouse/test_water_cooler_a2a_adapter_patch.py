#!/usr/bin/env python3
"""Unit tests for Water-cooler A2A adapter patch foundation (stdlib only).

Covers: captured live-adapter admission shape, unique-anchor validation,
missing/duplicate/ambiguous fail-closed (no write), idempotent reapply,
injection placement before model dispatch, and inert hooks by default.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
FIXTURE = ROOT / "fixtures" / "water_cooler_a2a" / "discord_adapter_admission_shape.py"
LIVE_ADAPTER = Path("/opt/hermes/plugins/platforms/discord/adapter.py")
PATCHER_PATH = STAGING / "apply_water_cooler_a2a_adapter_patch.py"
HOOKS_PATH = ROOT / "water_cooler_a2a_adapter_hooks.py"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


patcher = _load("water_cooler_a2a_adapter_patcher_under_test", PATCHER_PATH)
hooks = _load("water_cooler_a2a_adapter_hooks_under_test", HOOKS_PATH)


class AdmissionShapeAndPatchTests(unittest.TestCase):
    def test_fixture_matches_admission_shape(self):
        src = FIXTURE.read_text(encoding="utf-8")
        patcher.validate_admission_shape(src)
        for _, anchor in patcher.ADMISSION_SHAPE_ANCHORS:
            self.assertEqual(src.count(anchor), 1)

    def test_fixture_patches_idempotently(self):
        src = FIXTURE.read_text(encoding="utf-8")
        once, meta1 = patcher.patch_adapter_source(src)
        self.assertTrue(meta1["changed"])
        self.assertIn(patcher.MARKER_MENTION_BYPASS, once)
        self.assertIn(patcher.MARKER_PRE_DISPATCH, once)
        patcher.validate_patched_source(once)

        twice, meta2 = patcher.patch_adapter_source(once)
        self.assertFalse(meta2["changed"])
        self.assertEqual(once, twice)

    def test_injection_placement_before_model_dispatch(self):
        src = FIXTURE.read_text(encoding="utf-8")
        patched, _ = patcher.patch_adapter_source(src)
        pre = patched.index(patcher.MARKER_PRE_DISPATCH)
        dispatch = patched.index(patcher.ANCHOR_PRE_DISPATCH)
        self.assertLess(pre, dispatch, "pre-dispatch seam must precede model dispatch")
        # Mention bypass lives inside require_mention gate, still before dispatch.
        mb = patched.index(patcher.MARKER_MENTION_BYPASS)
        self.assertLess(mb, dispatch)
        self.assertIn("a2a_allow_mention_bypass as _wh_a2a_mb", patched)
        self.assertIn("a2a_pre_dispatch_intercept as _wh_a2a_pd", patched)

    def test_narrow_bypass_does_not_widen_global_admission(self):
        src = FIXTURE.read_text(encoding="utf-8")
        patched, _ = patcher.patch_adapter_source(src)
        # Must not rewrite require_mention defaults, free_response, or ALLOW_BOTS.
        self.assertIn("DISCORD_ALLOW_BOTS", patched)
        self.assertIn('elif allow_bots == "mentions":', patched)
        self.assertIn("def _discord_require_mention(self)", patched)
        self.assertIn("def _discord_free_response_channels(self)", patched)
        self.assertIn("Does NOT change require_mention defaults", patched)
        self.assertNotIn("require_mention = False", patched)
        self.assertNotIn("DISCORD_ALLOW_BOTS=all", patched)

    def test_anchor_missing_fails_closed_no_write(self):
        src = FIXTURE.read_text(encoding="utf-8")
        broken = src.replace(patcher.ANCHOR_SELF_IGNORE, "# self ignore removed\n", 1)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "adapter.py"
            path.write_text(broken, encoding="utf-8")
            before = path.read_bytes()
            with self.assertRaisesRegex(patcher.AdapterPatchError, "anchor missing|self_ignore"):
                patcher.patch_adapter_file(path)
            self.assertEqual(path.read_bytes(), before)

    def test_anchor_duplicate_fails_closed_no_write(self):
        src = FIXTURE.read_text(encoding="utf-8")
        # Duplicate the require_mention gate.
        dup = src.replace(
            patcher.ANCHOR_REQUIRE_MENTION,
            patcher.ANCHOR_REQUIRE_MENTION + patcher.ANCHOR_REQUIRE_MENTION,
            1,
        )
        self.assertEqual(dup.count(patcher.ANCHOR_REQUIRE_MENTION), 2)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "adapter.py"
            path.write_text(dup, encoding="utf-8")
            before = path.read_bytes()
            with self.assertRaisesRegex(patcher.AdapterPatchError, "ambiguous|require_mention"):
                patcher.patch_adapter_file(path)
            self.assertEqual(path.read_bytes(), before)

    def test_unknown_source_fails_closed(self):
        unknown = "print('not a discord adapter')\n"
        with self.assertRaisesRegex(patcher.AdapterPatchError, "anchor missing"):
            patcher.patch_adapter_source(unknown)

    def test_partial_markers_fail_closed_no_write(self):
        src = FIXTURE.read_text(encoding="utf-8")
        patched, _ = patcher.patch_adapter_source(src)
        # Remove only pre-dispatch marker comment line content to create partial state.
        partial = patched.replace(patcher.MARKER_PRE_DISPATCH, "wolfhouse_water_cooler_a2a_CORRUPT", 1)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "adapter.py"
            path.write_text(partial, encoding="utf-8")
            before = path.read_bytes()
            with self.assertRaisesRegex(patcher.AdapterPatchError, "partial markers|corruption"):
                patcher.patch_adapter_file(path)
            self.assertEqual(path.read_bytes(), before)

    def test_post_patch_corruption_fails_closed_on_reapply(self):
        src = FIXTURE.read_text(encoding="utf-8")
        patched, _ = patcher.patch_adapter_source(src)
        corrupt = patched.replace(
            "a2a_allow_mention_bypass as _wh_a2a_mb",
            "a2a_allow_mention_bypass_corrupted as _wh_a2a_mb",
            1,
        )
        with self.assertRaisesRegex(patcher.AdapterPatchError, "corruption"):
            patcher.patch_adapter_source(corrupt)

    def test_file_write_and_reapply(self):
        src = FIXTURE.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "adapter.py"
            path.write_text(src, encoding="utf-8")
            r1 = patcher.patch_adapter_file(path)
            self.assertTrue(r1["changed"])
            on_disk = path.read_text(encoding="utf-8")
            patcher.validate_patched_source(on_disk)
            r2 = patcher.patch_adapter_file(path)
            self.assertFalse(r2["changed"])
            self.assertEqual(path.read_text(encoding="utf-8"), on_disk)

    def test_cli_refuses_default_apply(self):
        code = patcher.main([])
        self.assertEqual(code, 2)

    def test_hooks_inert_by_default(self):
        self.assertFalse(hooks.is_a2a_adapter_hooks_active())
        self.assertFalse(
            hooks.a2a_allow_mention_bypass(
                channel_id="1532167084618944734",
                parent_channel_id="1530209175861199019",
                content="TASK [target=seadog] [reviewer=deckhand]\nbody",
                author_is_bot=False,
            )
        )
        self.assertFalse(hooks.a2a_pre_dispatch_intercept(object(), adapter=None))

    @unittest.skipUnless(LIVE_ADAPTER.is_file(), "live Hermes adapter not present")
    def test_live_adapter_admission_shape_and_in_memory_patch(self):
        live = LIVE_ADAPTER.read_text(encoding="utf-8")
        patcher.validate_admission_shape(live)
        # Confirmed live facts encoded as anchors.
        self.assertIn("DISCORD_ALLOW_BOTS", live)
        self.assertIn('elif allow_bots == "mentions":', live)
        self.assertIn(
            "await self._handle_message(message, role_authorized=_role_authorized)",
            live,
        )
        self.assertIn("if require_mention and not is_free_channel and not in_bot_thread:", live)
        patched, meta = patcher.patch_adapter_source(live)
        self.assertTrue(meta["changed"])
        patcher.validate_patched_source(patched)
        # Never write the live path in tests.
        self.assertEqual(LIVE_ADAPTER.read_text(encoding="utf-8"), live)
        # Placement: marker before the unique model-dispatch block.
        self.assertLess(
            patched.index(patcher.MARKER_PRE_DISPATCH),
            patched.index(patcher.ANCHOR_PRE_DISPATCH),
        )


if __name__ == "__main__":
    unittest.main()
