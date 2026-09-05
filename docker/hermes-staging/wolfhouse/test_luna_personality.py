"""Unit tests for Luna Personality resolve/inject (stdlib only, no send)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import luna_personality as lp  # noqa: E402


class _Timeout(Exception):
    pass


class LunaPersonalityTests(unittest.TestCase):
    def setUp(self) -> None:
        lp.clear_personality_cache()
        lp.clear_bound_personality()

    def test_closed_ids_and_default(self) -> None:
        self.assertEqual(lp.DEFAULT_PERSONALITY_ID, "sunny")
        self.assertEqual(lp.CLOSED_PERSONALITY_IDS, ("sunny", "calm", "concise", "extra"))
        self.assertEqual(lp.normalize_stored_id("cami")["id"], "sunny")
        self.assertEqual(lp.normalize_stored_id("cami")["source"], "invalid_fallback")

    def test_resolve_once_uses_cache(self) -> None:
        calls = {"n": 0}

        def fetch(_tid: str) -> dict:
            calls["n"] += 1
            return {"personality_id": "calm"}

        a = lp.resolve_whatsapp_personality_once(tenant_id="sunset", fetch_setting=fetch)
        b = lp.resolve_whatsapp_personality_once(tenant_id="sunset", fetch_setting=fetch)
        self.assertEqual(a["pack"]["id"], "calm")
        self.assertEqual(b["pack"]["id"], "calm")
        self.assertEqual(calls["n"], 1)

    def test_failure_defaults_sunny(self) -> None:
        def boom(_tid: str) -> dict:
            raise RuntimeError("nope")

        out = lp.resolve_whatsapp_personality_once(tenant_id="x", fetch_setting=boom)
        self.assertEqual(out["pack"]["id"], "sunny")
        self.assertEqual(out["observability"]["fallback_reason"], "setting_failure")

    def test_timeout_defaults_sunny(self) -> None:
        def slow(_tid: str) -> dict:
            raise TimeoutError("timed out")

        out = lp.resolve_whatsapp_personality_once(tenant_id="x", fetch_setting=slow)
        self.assertEqual(out["pack"]["id"], "sunny")
        self.assertEqual(out["observability"]["fallback_reason"], "setting_timeout")

    def test_email_channel_skipped(self) -> None:
        out = lp.resolve_whatsapp_personality_once(
            tenant_id="x",
            channel="email",
            fetch_setting=lambda _t: {"personality_id": "extra"},
        )
        self.assertFalse(out["applied"])
        self.assertIsNone(out["pack"])

    def test_inject_once_and_freeze(self) -> None:
        pack = lp.get_personality_pack("extra")
        first = lp.inject_personality_pack_once("You are Luna.", pack, composer_state="greeting")
        self.assertTrue(first["injected"])
        self.assertIn(pack["instruction"], first["system_prompt"])
        second = lp.inject_personality_pack_once(
            first["system_prompt"], pack, composer_state="greeting", already_injected=True
        )
        self.assertFalse(second["injected"])
        frozen = lp.inject_personality_pack_once(
            "You are Luna.", pack, composer_state="payment_link_sent"
        )
        self.assertFalse(frozen["injected"])
        self.assertEqual(frozen["system_prompt"], "You are Luna.")

    def test_bind_whatsapp_only(self) -> None:
        source = SimpleNamespace(platform=SimpleNamespace(value="whatsapp_cloud"))
        bound = lp.bind_whatsapp_turn_personality(
            source, fetch_setting=lambda _t: {"personality_id": "concise"}
        )
        self.assertEqual(bound["pack"]["id"], "concise")
        self.assertEqual(lp.get_bound_personality()["pack"]["id"], "concise")
        soul = lp.apply_personality_to_soul_text("# Luna\n")
        self.assertIn("Luna Personality this turn: concise", soul)

        other = SimpleNamespace(platform=SimpleNamespace(value="discord"))
        skipped = lp.bind_whatsapp_turn_personality(
            other, fetch_setting=lambda _t: {"personality_id": "extra"}
        )
        self.assertFalse(skipped["applied"])


if __name__ == "__main__":
    unittest.main()
