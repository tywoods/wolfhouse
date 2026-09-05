#!/usr/bin/env python3
"""Emitted-code AST + offline behavioral tests for personality gateway binding.

Uses the real apply_gateway_patches emission path. No provider, network,
or live Hermes imports. Synthetic sentinel AIAgent boundaries only.
"""

from __future__ import annotations

import ast
import asyncio
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))

import apply_gateway_patches as gw  # noqa: E402


STRUCTURED_RESULT = {
    "final_response": "sentinel-ok",
    "messages": [],
    "api_calls": 0,
    "tools": [],
}


def _cache_block(indent: int) -> str:
    pad = " " * indent
    return (
        f"{pad}agent = None\n"
        f'{pad}_cache_lock = getattr(self, "_agent_cache_lock", None)\n'
        f'{pad}_cache = getattr(self, "_agent_cache", None)'
    )


def skeleton(indent: int) -> str:
    """Minimal nested/method worker that owns the real cache-anchor text."""
    pad = " " * indent
    inner = " " * (indent + 4)
    body = (
        f"{pad}session_key = 'synthetic-session'\n"
        f"{_cache_block(indent)}\n"
        f"{pad}if agent is None:\n"
        f"{inner}agent = AIAgent(model='sentinel')\n"
        f"{pad}result = agent.run_conversation('synthetic')\n"
        f"{pad}return result\n"
    )
    if indent == 8:
        return "class Gateway:\n    def run_sync(self, source):\n" + body
    if indent == 12:
        return (
            "class Gateway:\n"
            "    async def _run_agent_inner(self, source):\n"
            "        def run_sync():\n"
            + body
            + "        return run_sync()\n"
        )
    raise AssertionError(f"unsupported test indent {indent}")


def malformed_twelve_with_eight_bind() -> str:
    """Production defect: 8-space bind prepended to the 12-space cache owner."""
    source = skeleton(12)
    owner_12 = gw.SOUL_RELOAD_ANCHORS[1][0]
    return source.replace(
        owner_12, gw.luna_personality_bind_patch(8) + "\n" + owner_12, 1
    )


def _apply_patches_marker_prefix() -> str:
    # Real newlines so apply_patches substring tags match; keep them inside a
    # string so the fixture remains valid Python.
    return (
        '_WH_PATCH_MARKERS = """\n'
        + gw.RUNNER_GLOBAL_VAR
        + "\n"
        + gw.INTERNAL_FILTER_TAG
        + "\n"
        + gw.MIRROR_INBOUND_TAG
        + "\n"
        + gw.OUTPUT_GUARD_TAG
        + "\n"
        + '"""\n\n'
    )


class _SentinelAgent:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        _SentinelAgent.constructed.append(kwargs)

    def run_conversation(self, message, **kwargs):
        _SentinelAgent.conversations.append((message, kwargs))
        return dict(STRUCTURED_RESULT)

    constructed: list = []
    conversations: list = []


@contextmanager
def _stub_personality(*, bind_raises: bool = False):
    calls: dict[str, list] = {"bind": [], "rebuild": []}

    def bind(source):
        calls["bind"].append(source)
        if bind_raises:
            raise RuntimeError("synthetic bind failure")
        return {"applied": True}

    def should_rebuild(role, platform):
        calls["rebuild"].append((role, platform))
        return True

    stub = types.ModuleType("wolfhouse.luna_personality")
    stub.bind_whatsapp_turn_personality = bind
    stub.should_rebuild_cached_agent = should_rebuild
    saved = sys.modules.get("wolfhouse.luna_personality")
    sys.modules["wolfhouse.luna_personality"] = stub
    _SentinelAgent.constructed = []
    _SentinelAgent.conversations = []
    try:
        yield calls
    finally:
        if saved is None:
            sys.modules.pop("wolfhouse.luna_personality", None)
        else:
            sys.modules["wolfhouse.luna_personality"] = saved


def _invoke_emitted(ns: dict, source):
    gateway_cls = ns["Gateway"]
    gw_obj = gateway_cls()
    gw_obj._agent_cache_lock = None
    gw_obj._agent_cache = {}
    gw_obj.evictions = []

    def _evict(session_key):
        gw_obj.evictions.append(session_key)

    gw_obj._evict_cached_agent = _evict
    if hasattr(gateway_cls, "_run_agent_inner"):
        return asyncio.run(gw_obj._run_agent_inner(source)), gw_obj
    return gw_obj.run_sync(source), gw_obj


class LunaPersonalityGatewayBindTests(unittest.TestCase):
    def test_cache_anchors_match_patcher_layouts(self) -> None:
        self.assertEqual(_cache_block(8), gw.SOUL_RELOAD_ANCHORS[0][0])
        self.assertEqual(_cache_block(12), gw.SOUL_RELOAD_ANCHORS[1][0])
        self.assertEqual(gw.luna_personality_bind_patch(8), gw.LUNA_PERSONALITY_BIND_PATCH)
        self.assertEqual(
            gw.luna_personality_bind_patch(12), gw.LUNA_PERSONALITY_BIND_PATCH_12
        )

    def test_both_layouts_emit_worker_owned_bind_rebuild_cache_agent(self) -> None:
        for indent in (8, 12):
            with self.subTest(indent=indent):
                emitted, meta = gw.apply_luna_personality_gateway_patches(skeleton(indent))
                self.assertTrue(meta["changed"])
                self.assertEqual(meta["owner_indent"], indent)
                info = gw.validate_luna_personality_emitted_ast(emitted)
                self.assertEqual(info["worker_name"], "run_sync")
                self.assertEqual(info["owner_indent"], indent)
                self.assertTrue(info["bind_in_worker"])
                self.assertTrue(info["rebuild_in_worker"])
                self.assertTrue(info["cache_in_worker"])
                self.assertTrue(info["aiagent_in_worker"])
                self.assertTrue(info["conversation_in_worker"])
                self.assertFalse(info["conversation_in_bind_except"])
                self.assertTrue(info["return_in_worker"])
                tree = ast.parse(emitted)
                worker = next(
                    n
                    for n in ast.walk(tree)
                    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and n.name == "run_sync"
                )
                bind = next(stmt for stmt in worker.body if gw._is_bind_try(stmt))
                self.assertFalse(gw._walk_except_bind_conversation(bind))
                pad = " " * indent
                self.assertIn(
                    f"{pad}# Wolfhouse Luna Personality: bind WhatsApp style pack once per turn.",
                    emitted,
                )
                self.assertIn(
                    f"{pad}# Wolfhouse Luna: rebuild agent each turn so SOUL.md changes apply.",
                    emitted,
                )

    def test_idempotent_reapply_on_both_layouts(self) -> None:
        for indent in (8, 12):
            with self.subTest(indent=indent):
                once, meta1 = gw.apply_luna_personality_gateway_patches(skeleton(indent))
                self.assertTrue(meta1["changed"])
                twice, meta2 = gw.apply_luna_personality_gateway_patches(once)
                self.assertFalse(meta2["changed"])
                self.assertEqual(once, twice)
                gw.validate_luna_personality_emitted_ast(twice)

    def test_successful_and_failing_bind_reach_sentinel_agent(self) -> None:
        source = SimpleNamespace(
            platform=SimpleNamespace(value="whatsapp"),
        )
        for indent in (8, 12):
            for bind_raises in (False, True):
                with self.subTest(indent=indent, bind_raises=bind_raises):
                    emitted, _ = gw.apply_luna_personality_gateway_patches(
                        skeleton(indent)
                    )
                    gw.validate_luna_personality_emitted_ast(emitted)
                    with _stub_personality(bind_raises=bind_raises) as calls:
                        ns = {"AIAgent": _SentinelAgent, "getattr": getattr}
                        exec(
                            compile(emitted, "<luna-personality-emitted>", "exec"),
                            ns,
                            ns,
                        )
                        result, gw_obj = _invoke_emitted(ns, source)
                    self.assertEqual(result, STRUCTURED_RESULT)
                    self.assertEqual(len(_SentinelAgent.constructed), 1)
                    self.assertEqual(len(_SentinelAgent.conversations), 1)
                    self.assertEqual(_SentinelAgent.conversations[0][0], "synthetic")
                    self.assertEqual(len(calls["bind"]), 1)
                    self.assertEqual(len(calls["rebuild"]), 1)
                    self.assertEqual(gw_obj.evictions, ["synthetic-session"])
                    self.assertIs(result.get("final_response"), STRUCTURED_RESULT["final_response"])

    def test_malformed_prepatch_is_rejected_without_write(self) -> None:
        bad = malformed_twelve_with_eight_bind()
        self.assertIn(gw.LUNA_PERSONALITY_BIND_TAG, bad)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.py"
            path.write_text(bad, encoding="utf-8")
            before = path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "luna personality emitted AST invalid"):
                gw.apply_luna_personality_gateway_file(path)
            self.assertEqual(path.read_bytes(), before)
            with self.assertRaisesRegex(RuntimeError, "luna personality emitted AST invalid"):
                gw.apply_luna_personality_gateway_patches(bad)
            self.assertEqual(path.read_bytes(), before)

    def test_malformed_prepatch_mutations_rejected(self) -> None:
        good, _ = gw.apply_luna_personality_gateway_patches(skeleton(12))
        tagged_no_try = skeleton(12).replace(
            "AIAgent(model='sentinel')",
            "bind_whatsapp_turn_personality\n            agent = AIAgent(model='sentinel')",
            1,
        )
        tagged_no_try = tagged_no_try.replace(
            _cache_block(12),
            gw.LUNA_SOUL_RELOAD_PATCH_12.lstrip("\n") + _cache_block(12),
            1,
        )
        mutations = {
            "dedented_bind": good.replace(
                gw.luna_personality_bind_patch(12),
                gw.luna_personality_bind_patch(8),
                1,
            ),
            "bind_try_turned_into_if": good.replace(
                "            try:\n"
                "                from wolfhouse.luna_personality import "
                "bind_whatsapp_turn_personality as _wh_bind_lp\n",
                "            if True:\n"
                "                from wolfhouse.luna_personality import "
                "bind_whatsapp_turn_personality as _wh_bind_lp\n",
                1,
            ),
            "conversation_in_except": malformed_twelve_with_eight_bind(),
            "tag_without_bind_try": tagged_no_try,
        }
        for name, mutant in mutations.items():
            with self.subTest(mutation=name):
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / "run.py"
                    path.write_text(mutant, encoding="utf-8")
                    before = path.read_bytes()
                    with self.assertRaisesRegex(RuntimeError, "luna personality"):
                        gw.apply_luna_personality_gateway_file(path)
                    self.assertEqual(path.read_bytes(), before)

    def test_duplicate_owner_rejected_without_write(self) -> None:
        src = skeleton(12)
        src = src.replace(
            _cache_block(12),
            _cache_block(12) + "\n" + _cache_block(12),
            1,
        )
        self.assertEqual(src.count(_cache_block(12)), 2)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.py"
            path.write_text(src, encoding="utf-8")
            before = path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "duplicate"):
                gw.apply_luna_personality_gateway_file(path)
            self.assertEqual(path.read_bytes(), before)

    def test_ambiguous_owners_rejected_without_write(self) -> None:
        src = skeleton(8) + "\n" + skeleton(12)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.py"
            path.write_text(src, encoding="utf-8")
            before = path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "ambiguous"):
                gw.apply_luna_personality_gateway_file(path)
            self.assertEqual(path.read_bytes(), before)

    def test_missing_owner_rejected_without_write(self) -> None:
        src = "class Gateway:\n    def run_sync(self, source):\n        return None\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.py"
            path.write_text(src, encoding="utf-8")
            before = path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "missing"):
                gw.apply_luna_personality_gateway_file(path)
            self.assertEqual(path.read_bytes(), before)

    def test_apply_patches_rejects_malformed_without_write(self) -> None:
        body = _apply_patches_marker_prefix() + malformed_twelve_with_eight_bind()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.py"
            path.write_text(body, encoding="utf-8")
            before = path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "luna personality emitted AST invalid"):
                gw.apply_patches(path)
            self.assertEqual(path.read_bytes(), before)

    def test_apply_patches_writes_valid_layout_and_is_idempotent(self) -> None:
        body = _apply_patches_marker_prefix() + skeleton(12)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.py"
            path.write_text(body, encoding="utf-8")
            first = gw.apply_patches(path)
            once = path.read_bytes()
            self.assertTrue(first["luna_soul_reload"])
            info = gw.validate_luna_personality_emitted_ast(path.read_text(encoding="utf-8"))
            self.assertEqual(info["owner_indent"], 12)
            second = gw.apply_patches(path)
            self.assertEqual(path.read_bytes(), once)
            self.assertTrue(second["luna_soul_reload"])

    def test_apply_patches_source_uses_real_personality_emitter(self) -> None:
        src = Path(gw.__file__).read_text(encoding="utf-8")
        self.assertIn("s, lp_meta = apply_luna_personality_gateway_patches(s)", src)
        self.assertNotRegex(
            src,
            r"s = s\.replace\(soul_anchor, LUNA_PERSONALITY_BIND_PATCH \+ \"\\n\" \+ soul_anchor, 1\)",
        )


if __name__ == "__main__":
    unittest.main()
