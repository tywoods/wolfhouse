"""Unit tests for Luna Personality resolve/inject (stdlib only, no send)."""

from __future__ import annotations

import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

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

    def test_new_turn_refetches_authoritative_setting(self) -> None:
        calls = {"n": 0}
        stored = {"id": "calm"}

        def fetch(_tid: str) -> dict:
            calls["n"] += 1
            return {"personality_id": stored["id"]}

        a = lp.resolve_whatsapp_personality_once(tenant_id="sunset", fetch_setting=fetch, now=1.0)
        stored["id"] = "concise"
        b = lp.resolve_whatsapp_personality_once(tenant_id="sunset", fetch_setting=fetch, now=1.0)
        self.assertEqual(a["pack"]["id"], "calm")
        self.assertEqual(b["pack"]["id"], "concise")
        self.assertEqual(calls["n"], 2)

    def test_within_turn_soul_reads_reuse_bound_pack(self) -> None:
        calls = {"n": 0}

        def fetch(_tid: str) -> dict:
            calls["n"] += 1
            return {"personality_id": "calm"}

        source = SimpleNamespace(platform=SimpleNamespace(value="whatsapp"))
        lp.bind_whatsapp_turn_personality(source, fetch_setting=fetch)
        first = lp.apply_personality_to_soul_text("# Luna\n")
        second = lp.apply_personality_to_soul_text("# Luna\n")
        self.assertEqual(calls["n"], 1)
        self.assertEqual(first.count(lp.INJECTION_MARK), 1)
        self.assertEqual(second.count(lp.INJECTION_MARK), 1)
        self.assertIn("Luna Personality this turn: calm", first)
        self.assertEqual(first, second)

    def test_canonical_bot_auth_headers_match_require_bot_auth(self) -> None:
        headers = lp.canonical_bot_auth_headers("tok")
        self.assertEqual(headers["X-Luna-Bot-Token"], "tok")
        self.assertEqual(headers["Accept"], "application/json")
        self.assertNotIn("Cookie", headers)
        self.assertNotIn("cookie", headers)

    def test_default_fetch_setting_sends_canonical_header(self) -> None:
        captured = {}

        class _Resp:
            def read(self) -> bytes:
                return b'{"personality_id":"calm","source":"stored"}'

            def __enter__(self) -> "_Resp":
                return self

            def __exit__(self, *args: object) -> None:
                return None

        def fake_urlopen(req, timeout=0):  # noqa: ANN001
            captured["url"] = req.full_url
            captured["headers"] = dict(req.headers.items())
            captured["method"] = req.get_method()
            return _Resp()

        env = {
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://sunset-staging.lunafrontdesk.com",
            "LUNA_BOT_INTERNAL_TOKEN": "tok",
        }
        with mock.patch.dict(os.environ, env, clear=False), mock.patch(
            "urllib.request.urlopen", fake_urlopen
        ):
            parsed = lp.default_fetch_setting("sunset")
        self.assertEqual(parsed["personality_id"], "calm")
        self.assertEqual(captured["method"], "GET")
        self.assertTrue(captured["url"].endswith("/staff/bot/luna-personality"))
        header_map = {k.lower(): v for k, v in captured["headers"].items()}
        self.assertEqual(header_map.get("x-luna-bot-token"), "tok")
        self.assertNotIn("cookie", header_map)

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

    def test_sunset_luna_cached_agent_rebuilds_next_pack(self) -> None:
        """Production path: Sunset WhatsApp turns must evict the cached agent.

        docker/hermes-sunset/docker-compose.vm.yml sets HERMES_ROLE=sunset-luna.
        Personality is appended during SOUL.md read, so a setting change only
        reaches the next reply if that role evicts and rebuilds the agent.
        """
        import apply_gateway_patches as gw_patches

        stored = {"id": "calm"}
        calls = {"n": 0}

        def fetch(_tid: str) -> dict:
            calls["n"] += 1
            return {"personality_id": stored["id"]}

        lp.install_soul_append_runtime_patch()
        source = SimpleNamespace(platform=SimpleNamespace(value="whatsapp_cloud"))

        class CachedAgentRunner:
            def __init__(self) -> None:
                self._agent_cache: dict = {}
                self.evictions: list = []
                self.soul_reads = 0

            def _evict_cached_agent(self, session_key: str) -> None:
                self.evictions.append(session_key)
                self._agent_cache.pop(session_key, None)

            def _apply_patch(self, patch: str, session_key: str) -> None:
                ns = {"self": self, "source": source, "session_key": session_key}
                exec(compile(textwrap.dedent(patch), "<luna-soul-reload>", "exec"), ns, ns)

            def run_turn(self, session_key: str, soul_path: Path, patch: str) -> dict:
                lp.clear_bound_personality()
                lp.bind_whatsapp_turn_personality(source, fetch_setting=fetch)
                self._apply_patch(patch, session_key)
                cached = self._agent_cache.get(session_key)
                if cached is not None:
                    return cached
                self.soul_reads += 1
                agent = {"soul": soul_path.read_text(encoding="utf-8")}
                self._agent_cache[session_key] = agent
                return agent

        patches = (gw_patches.LUNA_SOUL_RELOAD_PATCH, gw_patches.LUNA_SOUL_RELOAD_PATCH_12)
        with tempfile.TemporaryDirectory() as tmp:
            soul_path = Path(tmp) / "SOUL.md"
            soul_path.write_text("# Luna\nYou are Luna.\n", encoding="utf-8")
            for patch in patches:
                stored["id"] = "calm"
                calls["n"] = 0
                runner = CachedAgentRunner()
                with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna"}, clear=False):
                    first = runner.run_turn("sunset-guest", soul_path, patch)
                    stored["id"] = "concise"
                    second = runner.run_turn("sunset-guest", soul_path, patch)
                self.assertIn("Luna Personality this turn: calm", first["soul"])
                self.assertEqual(first["soul"].count(lp.INJECTION_MARK), 1)
                self.assertIn("Luna Personality this turn: concise", second["soul"])
                self.assertEqual(second["soul"].count(lp.INJECTION_MARK), 1)
                self.assertNotIn("this turn: calm", second["soul"])
                self.assertEqual(calls["n"], 2)
                self.assertEqual(runner.soul_reads, 2)
                self.assertEqual(runner.evictions, ["sunset-guest", "sunset-guest"])

            role_cases = (
                ("luna", "whatsapp", True),
                ("sunset-luna", "whatsapp", True),
                ("sunset-luna", "whatsapp_cloud", True),
                ("luna", "discord", False),
                ("orchestrator", "whatsapp", False),
                ("deckhand", "whatsapp", False),
                ("sunset-email-luna", "whatsapp", False),
                ("seadog", "whatsapp", False),
            )
            for role, plat, should_evict in role_cases:
                evict_runner = CachedAgentRunner()
                plat_source = SimpleNamespace(platform=SimpleNamespace(value=plat))

                def _apply(patch: str, session_key: str, src=plat_source, runner=evict_runner) -> None:
                    ns = {"self": runner, "source": src, "session_key": session_key}
                    exec(compile(textwrap.dedent(patch), "<luna-soul-reload>", "exec"), ns, ns)

                with mock.patch.dict(os.environ, {"HERMES_ROLE": role}, clear=False):
                    _apply(gw_patches.LUNA_SOUL_RELOAD_PATCH, "sk")
                self.assertEqual(
                    bool(evict_runner.evictions),
                    should_evict,
                    f"role={role} platform={plat}",
                )


if __name__ == "__main__":
    unittest.main()
