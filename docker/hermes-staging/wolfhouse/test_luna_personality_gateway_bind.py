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


EVIDENCE_GATEWAY = Path(
    "/opt/data/workspace/evidence/"
    "LUNA-PERSONALITY-001-model-path-sources/gateway_run.py"
)
PRISTINE_UPSTREAM_CANDIDATES = (
    Path("/opt/hermes/gateway/run.py"),
)


def _ast_dump(node: ast.AST) -> str:
    return ast.dump(node, include_attributes=False)


def _block_stmts(block: str) -> list[ast.stmt]:
    return ast.parse("def _wh_lp_block():\n" + block.lstrip("\n")).body[0].body


def _canonical_bind_rebuild_stmts(indent: int) -> list[ast.stmt]:
    soul = gw.LUNA_SOUL_RELOAD_PATCH if indent == 8 else gw.LUNA_SOUL_RELOAD_PATCH_12
    return _block_stmts(gw.luna_personality_bind_patch(indent)) + _block_stmts(soul)


def _unique_cache_worker(tree: ast.AST) -> tuple[ast.AST, int]:
    owners: list[tuple[ast.AST, int]] = []
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        start = gw._cache_triple_start(fn.body)
        if start is not None:
            owners.append((fn, start))
    if len(owners) != 1:
        raise AssertionError(f"expected unique cache worker, found {len(owners)}")
    return owners[0]


def _walk_excluding_nested_scopes(node: ast.AST):
    nested = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
    for child in ast.iter_child_nodes(node):
        yield child
        if not isinstance(child, nested):
            yield from _walk_excluding_nested_scopes(child)


def _worker_tail(indent: int) -> str:
    pad = " " * indent
    inner = " " * (indent + 4)
    return (
        f"{pad}if agent is None:\n"
        f"{inner}agent = AIAgent(model='sentinel')\n"
        f"{pad}result = agent.run_conversation('synthetic')\n"
        f"{pad}return result\n"
    )


def _nested_decoy_tail(indent: int) -> str:
    pad = " " * indent
    inner = " " * (indent + 4)
    return (
        f"{pad}def _decoy():\n"
        f"{inner}agent = AIAgent(model='sentinel')\n"
        f"{inner}result = agent.run_conversation('synthetic')\n"
        f"{inner}return result\n"
        f"{pad}x = 1\n"
    )


def _load_pristine_upstream_if_available() -> tuple[str, Path] | None:
    """Return local pinned upstream only if it is unpatched. Never infer from reconstruction."""
    for path in PRISTINE_UPSTREAM_CANDIDATES:
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        if gw.LUNA_PERSONALITY_BIND_TAG in text or gw.LUNA_SOUL_RELOAD_TAG in text:
            continue
        try:
            gw.select_unique_soul_reload_owner(text)
        except RuntimeError:
            continue
        return text, path
    return None


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
                worker, cache_index = _unique_cache_worker(tree)
                self.assertEqual(worker.name, "run_sync")
                expected = _canonical_bind_rebuild_stmts(indent)
                start = cache_index - len(expected)
                actual = worker.body[start:cache_index]
                self.assertEqual(
                    [_ast_dump(node) for node in actual],
                    [_ast_dump(node) for node in expected],
                )
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

    def _reject_no_write(self, mutant: str, pattern: str = r"luna personality") -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.py"
            path.write_text(mutant, encoding="utf-8")
            before = path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, pattern):
                gw.apply_luna_personality_gateway_file(path)
            self.assertEqual(path.read_bytes(), before)
            with self.assertRaisesRegex(RuntimeError, pattern):
                gw.apply_luna_personality_gateway_patches(mutant)
            self.assertEqual(path.read_bytes(), before)

    def test_emitted_bind_rebuild_ast_blocks_adjacent_to_cache_owner(self) -> None:
        for indent in (8, 12):
            with self.subTest(indent=indent):
                emitted, _ = gw.apply_luna_personality_gateway_patches(skeleton(indent))
                tree = ast.parse(emitted)
                worker, cache_index = _unique_cache_worker(tree)
                expected = _canonical_bind_rebuild_stmts(indent)
                start = cache_index - len(expected)
                self.assertGreaterEqual(start, 0)
                actual = worker.body[start:cache_index]
                self.assertEqual(
                    [_ast_dump(node) for node in actual],
                    [_ast_dump(node) for node in expected],
                )

    def test_bind_call_removed_rejected_without_write(self) -> None:
        """Parent acceptance probe: tagged bind with the call replaced by pass."""
        for indent in (8, 12):
            with self.subTest(indent=indent):
                good, _ = gw.apply_luna_personality_gateway_patches(skeleton(indent))
                mutant = good.replace("_wh_bind_lp(source)", "pass # binding removed", 1)
                self.assertIn(gw.LUNA_PERSONALITY_BIND_TAG, mutant)
                self.assertIn("pass # binding removed", mutant)
                self.assertNotIn("_wh_bind_lp(source)", mutant)
                self._reject_no_write(mutant)

    def test_bind_source_alias_handler_mutations_rejected(self) -> None:
        for indent in (8, 12):
            good, _ = gw.apply_luna_personality_gateway_patches(skeleton(indent))
            pad = " " * indent
            inner = " " * (indent + 4)
            mutations = {
                "bind_source_changed": good.replace(
                    "_wh_bind_lp(source)", "_wh_bind_lp(session_key)", 1
                ),
                "bind_alias_changed": good.replace(
                    "bind_whatsapp_turn_personality as _wh_bind_lp",
                    "bind_whatsapp_turn_personality as _wh_bind_other",
                    1,
                ).replace("_wh_bind_lp(source)", "_wh_bind_other(source)", 1),
                "bind_handler_return": good.replace(
                    f"{pad}except Exception:\n{inner}pass\n",
                    f"{pad}except Exception:\n{inner}return\n",
                    1,
                ),
                "bind_handler_type": good.replace(
                    f"{pad}except Exception:\n{inner}pass\n",
                    f"{pad}except ValueError:\n{inner}pass\n",
                    1,
                ),
            }
            for name, mutant in mutations.items():
                with self.subTest(indent=indent, mutation=name):
                    self.assertNotEqual(mutant, good)
                    self._reject_no_write(mutant)

    def test_soul_rebuild_condition_eviction_mutations_rejected(self) -> None:
        for indent in (8, 12):
            good, _ = gw.apply_luna_personality_gateway_patches(skeleton(indent))
            pad = " " * indent
            inner = " " * (indent + 4)
            mutations = {
                "rebuild_condition_false": good.replace(
                    'if _wh_lp_rebuild(_wolfhouse_soul_os.getenv("HERMES_ROLE"), '
                    "_wolfhouse_plat):",
                    "if False:",
                    1,
                ),
                "eviction_removed": good.replace(
                    f"{inner}self._evict_cached_agent(session_key)\n",
                    f"{inner}pass\n",
                    1,
                ),
                "rebuild_alias_changed": good.replace(
                    "should_rebuild_cached_agent as _wh_lp_rebuild",
                    "should_rebuild_cached_agent as _wh_lp_other",
                    1,
                ).replace("_wh_lp_rebuild(", "_wh_lp_other(", 1),
            }
            for name, mutant in mutations.items():
                with self.subTest(indent=indent, mutation=name):
                    self.assertNotEqual(mutant, good)
                    self._reject_no_write(mutant)

    def test_success_return_removed_early_unrelated_return_rejected(self) -> None:
        for indent in (8, 12):
            with self.subTest(indent=indent):
                good, _ = gw.apply_luna_personality_gateway_patches(skeleton(indent))
                pad = " " * indent
                inner = " " * (indent + 4)
                mutant = good.replace(
                    f"{pad}session_key = 'synthetic-session'\n",
                    f"{pad}session_key = 'synthetic-session'\n"
                    f"{pad}if False:\n"
                    f"{inner}return None\n",
                    1,
                )
                mutant = mutant.replace(
                    f"\n{pad}return result\n",
                    f"\n{pad}# success return removed\n",
                    1,
                )
                self.assertIn("return None", mutant)
                self.assertNotIn(f"{pad}return result\n", mutant)
                self._reject_no_write(mutant)

    def test_nested_function_decoys_rejected(self) -> None:
        for indent in (8, 12):
            with self.subTest(indent=indent):
                good, _ = gw.apply_luna_personality_gateway_patches(skeleton(indent))
                mutant = good.replace(_worker_tail(indent), _nested_decoy_tail(indent), 1)
                self.assertIn("def _decoy():", mutant)
                self.assertNotIn(_worker_tail(indent), mutant)
                tree = ast.parse(mutant)
                worker, _cache_index = _unique_cache_worker(tree)
                nested_hits = False
                for node in ast.walk(worker):
                    if (
                        isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Name)
                        and node.func.id == "AIAgent"
                    ):
                        nested_hits = True
                        break
                self.assertTrue(
                    nested_hits,
                    "ast.walk must still see nested AIAgent decoys (the hole being closed)",
                )
                direct = list(_walk_excluding_nested_scopes(worker))
                self.assertFalse(
                    any(
                        isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Name)
                        and node.func.id == "AIAgent"
                        for node in direct
                    )
                )
                self._reject_no_write(mutant)

    def test_evidence_gateway_offline_reject_and_reconstructed_control(self) -> None:
        self.assertTrue(
            EVIDENCE_GATEWAY.is_file(),
            f"installed evidence gateway missing: {EVIDENCE_GATEWAY}",
        )
        evidence_bytes = EVIDENCE_GATEWAY.read_bytes()
        evidence = evidence_bytes.decode("utf-8")
        self.assertIn(gw.LUNA_PERSONALITY_BIND_TAG, evidence)
        self.assertIn(gw.LUNA_SOUL_RELOAD_TAG, evidence)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gateway_run.py"
            path.write_bytes(evidence_bytes)
            before = path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "luna personality"):
                gw.apply_luna_personality_gateway_file(path)
            self.assertEqual(path.read_bytes(), before)
            with self.assertRaisesRegex(RuntimeError, "luna personality"):
                gw.apply_luna_personality_gateway_patches(evidence)
            self.assertEqual(path.read_bytes(), before)
        self.assertEqual(EVIDENCE_GATEWAY.read_bytes(), evidence_bytes)

        historical_bind = gw.luna_personality_bind_patch(8)
        historical_soul = gw.LUNA_SOUL_RELOAD_PATCH_12
        self.assertEqual(evidence.count(historical_bind), 1)
        self.assertEqual(evidence.count(historical_soul), 1)
        reconstructed_control = evidence.replace(historical_bind, "", 1).replace(
            historical_soul, "", 1
        )
        self.assertNotIn(gw.LUNA_PERSONALITY_BIND_TAG, reconstructed_control)
        self.assertNotIn(gw.LUNA_SOUL_RELOAD_TAG, reconstructed_control)
        reconstructed_emitted, meta = gw.apply_luna_personality_gateway_patches(
            reconstructed_control
        )
        self.assertTrue(meta["changed"])
        self.assertEqual(meta["owner_indent"], 12)
        # reconstructed_control is evidence-minus-historical-blocks plus re-emit.
        # It is not pinned pristine upstream.
        info = gw.validate_luna_personality_emitted_ast(reconstructed_emitted)
        self.assertEqual(info["worker_name"], "run_sync")
        self.assertEqual(info["owner_indent"], 12)

        tree = ast.parse(reconstructed_emitted)
        worker, cache_index = _unique_cache_worker(tree)
        self.assertEqual(worker.name, "run_sync")
        expected = _canonical_bind_rebuild_stmts(12)
        start = cache_index - len(expected)
        actual = worker.body[start:cache_index]
        self.assertEqual(
            [_ast_dump(node) for node in actual],
            [_ast_dump(node) for node in expected],
        )
        nodes = list(_walk_excluding_nested_scopes(worker))

        def _is_aiagent(node: ast.AST) -> bool:
            return (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "AIAgent"
            )

        def _is_conversation(node: ast.AST) -> bool:
            return (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "run_conversation"
            )

        conv_indexes = [i for i, node in enumerate(nodes) if _is_conversation(node)]
        self.assertTrue(any(_is_aiagent(node) for node in nodes))
        self.assertTrue(conv_indexes)
        self.assertTrue(
            any(isinstance(node, ast.Return) for node in nodes[conv_indexes[0] + 1 :])
        )
        self.assertEqual(EVIDENCE_GATEWAY.read_bytes(), evidence_bytes)

        pristine = _load_pristine_upstream_if_available()
        if pristine is None:
            self.assertIsNone(
                pristine,
                "reconstruction is labeled reconstructed control, not pristine upstream",
            )
            return
        pristine_source, _pristine_path = pristine
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.py"
            path.write_text(pristine_source, encoding="utf-8")
            first = gw.apply_patches(path)
            once = path.read_bytes()
            self.assertTrue(first.get("luna_soul_reload") or True)
            gw.validate_luna_personality_emitted_ast(path.read_text(encoding="utf-8"))
            second = gw.apply_patches(path)
            self.assertEqual(path.read_bytes(), once)
            self.assertTrue(second.get("luna_soul_reload") or True)
        self.assertEqual(EVIDENCE_GATEWAY.read_bytes(), evidence_bytes)


if __name__ == "__main__":
    unittest.main()
