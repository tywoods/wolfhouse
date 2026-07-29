#!/usr/bin/env python3
"""Unit tests for Water-cooler A2A runtime bridge (stdlib only).

Proves config parsing (injected mapping only), action contract mapping,
role-asymmetric dispatch, content non-leakage, process isolation, and
restart fail-closed — without LLM, Discord SDK, network, or env reads.
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import sys
import unittest
from pathlib import Path
from typing import Any, Dict, Tuple

ROOT = Path(__file__).resolve().parent
POLICY_PATH = ROOT / "water_cooler_a2a_policy.py"
RUNTIME_PATH = ROOT / "water_cooler_a2a_runtime.py"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


# Load policy first so runtime relative import fallback can resolve.
policy_mod = _load("water_cooler_a2a_policy_rt_test", POLICY_PATH)
# Ensure package-style name used by runtime import fallback.
sys.modules["water_cooler_a2a_policy"] = policy_mod
rt = _load("water_cooler_a2a_runtime_under_test", RUNTIME_PATH)

CHANNEL = policy_mod.WATER_COOLER_CHANNEL_ID
HUMAN = "100000000000000001"
SEADOG = "200000000000000001"
DECKHAND = "300000000000000001"
UNKNOWN_HUMAN = "100000000000000099"
UNKNOWN_BOT = "400000000000000001"
OTHER_CHANNEL = "1530209175861199000"

SECRET_BODY = "SECRET_TASK_BODY_should_never_appear_in_bridge_output"
PEER_SECRET = "PEER_NOTES_raw_must_not_leak_zzz"
REVIEW_SECRET = "MODEL_REVIEW_raw_must_not_leak_yyy"


def _valid_mapping(**overrides: Any) -> Dict[str, Any]:
    base: Dict[str, Any] = {
        rt.CFG_ENABLED: True,
        rt.CFG_CHANNEL_ID: CHANNEL,
        rt.CFG_LOCAL_BOT_ID: SEADOG,
        rt.CFG_SEADOG_BOT_ID: SEADOG,
        rt.CFG_DECKHAND_BOT_ID: DECKHAND,
        rt.CFG_ALLOWED_HUMAN_STARTER_IDS: [HUMAN],
        rt.CFG_TASK_TTL_SECONDS: 600.0,
    }
    base.update(overrides)
    return base


def _pair() -> Tuple[Any, Any]:
    worker = rt.WaterCoolerA2ARuntime.from_mapping(
        _valid_mapping(**{rt.CFG_LOCAL_BOT_ID: SEADOG})
    )
    reviewer = rt.WaterCoolerA2ARuntime.from_mapping(
        _valid_mapping(**{rt.CFG_LOCAL_BOT_ID: DECKHAND})
    )
    return worker, reviewer


def _event(
    *,
    author_id: str,
    content: str,
    is_bot: bool,
    message_id: str,
    channel_id: str = CHANNEL,
    created_at: float = 1_000.0,
):
    return policy_mod.DiscordMessageEvent(
        channel_id=channel_id,
        message_id=message_id,
        author_id=author_id,
        content=content,
        is_bot=is_bot,
        created_at=created_at,
    )


def _task_msg(body: str = SECRET_BODY) -> str:
    return f"TASK [target=seadog] [reviewer=deckhand]\n{body}"


def _handoff(task_id: str, extra: str = PEER_SECRET) -> str:
    return f"A2A-HANDOFF v1\ntask_id: {task_id}\n{extra}"


def _review(task_id: str, extra: str = REVIEW_SECRET) -> str:
    return f"A2A-REVIEW v1\ntask_id: {task_id}\n{extra}"


def _assert_no_secrets(test: unittest.TestCase, obj: object) -> None:
    blob = repr(obj)
    test.assertNotIn(SECRET_BODY, blob)
    test.assertNotIn(PEER_SECRET, blob)
    test.assertNotIn(REVIEW_SECRET, blob)
    test.assertNotIn("SECRET_", blob)
    # Dataclass fields must not include content carriers.
    if hasattr(obj, "__dataclass_fields__"):
        names = set(obj.__dataclass_fields__)
        for forbidden in ("content", "body", "text", "payload", "output", "prompt", "raw"):
            test.assertNotIn(forbidden, names)


class TestParseRuntimeConfig(unittest.TestCase):
    def test_default_and_missing_mapping_disabled(self) -> None:
        cfg = rt.parse_runtime_config(None)
        self.assertFalse(cfg.enabled)
        self.assertFalse(cfg.is_active)

        cfg2 = rt.parse_runtime_config({})
        self.assertFalse(cfg2.enabled)
        self.assertFalse(cfg2.is_active)

        cfg3 = rt.parse_runtime_config({rt.CFG_ENABLED: False})
        self.assertFalse(cfg3.is_active)

    def test_invalid_mapping_type_fails_closed(self) -> None:
        self.assertFalse(rt.parse_runtime_config("not-a-map").is_active)  # type: ignore[arg-type]
        self.assertFalse(rt.parse_runtime_config([1, 2, 3]).is_active)  # type: ignore[arg-type]

    def test_malformed_bool_fails_closed(self) -> None:
        for bad in ("maybe", "TRUEISH", 2, 1.5, object(), "ENABLE_POISON_TOKEN"):
            cfg = rt.parse_runtime_config(_valid_mapping(**{rt.CFG_ENABLED: bad}))
            self.assertFalse(cfg.is_active, msg=repr(bad))
            if isinstance(bad, str):
                self.assertNotIn(bad, repr(cfg))

    def test_malformed_list_fails_closed(self) -> None:
        for bad in (123, True, {"a": "b"}, [1, 2], [HUMAN, 99], object()):
            cfg = rt.parse_runtime_config(
                _valid_mapping(**{rt.CFG_ALLOWED_HUMAN_STARTER_IDS: bad})
            )
            self.assertFalse(cfg.is_active, msg=repr(type(bad)))

    def test_malformed_ttl_fails_closed(self) -> None:
        for bad in ("not-a-number", "", True, "1e9999x", object(), "forever"):
            cfg = rt.parse_runtime_config(_valid_mapping(**{rt.CFG_TASK_TTL_SECONDS: bad}))
            self.assertFalse(cfg.is_active, msg=repr(bad))
            if isinstance(bad, str) and bad:
                self.assertNotIn(bad, repr(cfg))

        # Out of policy bounds also inactive.
        self.assertFalse(
            rt.parse_runtime_config(
                _valid_mapping(**{rt.CFG_TASK_TTL_SECONDS: 999_999.0})
            ).is_active
        )
        self.assertFalse(
            rt.parse_runtime_config(
                _valid_mapping(**{rt.CFG_TASK_TTL_SECONDS: 0})
            ).is_active
        )

    def test_missing_required_ids_inactive(self) -> None:
        for drop in (
            rt.CFG_CHANNEL_ID,
            rt.CFG_LOCAL_BOT_ID,
            rt.CFG_SEADOG_BOT_ID,
            rt.CFG_DECKHAND_BOT_ID,
            rt.CFG_ALLOWED_HUMAN_STARTER_IDS,
        ):
            m = _valid_mapping()
            del m[drop]
            cfg = rt.parse_runtime_config(m)
            self.assertFalse(cfg.is_active, msg=drop)

    def test_exact_valid_config_active(self) -> None:
        cfg = rt.parse_runtime_config(_valid_mapping())
        self.assertTrue(cfg.is_active)
        self.assertTrue(cfg.is_local_worker)
        self.assertEqual(cfg.channel_id, CHANNEL)
        self.assertEqual(cfg.seadog_bot_id, SEADOG)
        self.assertEqual(cfg.deckhand_bot_id, DECKHAND)
        self.assertEqual(cfg.local_bot_id, SEADOG)
        self.assertIn(HUMAN, cfg.allowed_human_starter_ids)
        self.assertEqual(cfg.task_ttl_seconds, 600.0)

    def test_string_bool_and_csv_humans(self) -> None:
        cfg = rt.parse_runtime_config(
            _valid_mapping(
                **{
                    rt.CFG_ENABLED: "true",
                    rt.CFG_ALLOWED_HUMAN_STARTER_IDS: f"{HUMAN}, 100000000000000002",
                    rt.CFG_TASK_TTL_SECONDS: "120",
                    rt.CFG_LOCAL_BOT_ID: DECKHAND,
                }
            )
        )
        self.assertTrue(cfg.is_active)
        self.assertTrue(cfg.is_local_reviewer)
        self.assertEqual(cfg.task_ttl_seconds, 120.0)
        self.assertEqual(len(cfg.allowed_human_starter_ids), 2)

    def test_config_output_does_not_reveal_raw_malformed_inputs(self) -> None:
        poison = "LEAK_ME_raw_config_value_xyzzy"
        cfg = rt.parse_runtime_config(
            _valid_mapping(**{rt.CFG_ENABLED: poison, rt.CFG_CHANNEL_ID: poison})
        )
        self.assertFalse(cfg.is_active)
        self.assertNotIn(poison, repr(cfg))
        self.assertNotIn(poison, str(cfg))

    def test_parser_source_has_no_environ_filesystem_network(self) -> None:
        src = RUNTIME_PATH.read_text(encoding="utf-8")
        self.assertNotIn("os.environ", src)
        self.assertNotIn("os.getenv", src)
        self.assertNotIn("os.environb", src)
        # No network / process helpers.
        for banned in (
            "socket.",
            "urllib",
            "requests.",
            "http.client",
            "subprocess",
            "pathlib.Path(",
            "open(",
            "logging.",
        ):
            self.assertNotIn(banned, src)

        # AST: parse_runtime_config must not reference os module.
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertNotIn(alias.name.split(".")[0], {"os", "socket", "urllib", "requests", "subprocess", "logging"})
            if isinstance(node, ast.ImportFrom) and node.module:
                self.assertNotIn(node.module.split(".")[0], {"os", "socket", "urllib", "requests", "subprocess", "logging"})

        # Callable inspect: no default env pull.
        sig = inspect.signature(rt.parse_runtime_config)
        self.assertIn("mapping", sig.parameters)


class TestRuntimeBridgeActions(unittest.TestCase):
    def setUp(self) -> None:
        self.t0 = 1_000.0
        self.worker = rt.WaterCoolerA2ARuntime.from_mapping(
            _valid_mapping(**{rt.CFG_LOCAL_BOT_ID: SEADOG})
        )
        self.reviewer = rt.WaterCoolerA2ARuntime.from_mapping(
            _valid_mapping(**{rt.CFG_LOCAL_BOT_ID: DECKHAND})
        )

    def test_default_config_suppresses(self) -> None:
        bridge = rt.WaterCoolerA2ARuntime.from_mapping()
        result = bridge.handle_event(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(result.action, rt.BridgeAction.SUPPRESS)
        self.assertEqual(result.reason, "policy_disabled_or_invalid_config")

    def test_invalid_config_suppresses(self) -> None:
        bridge = rt.WaterCoolerA2ARuntime.from_mapping(
            _valid_mapping(**{rt.CFG_TASK_TTL_SECONDS: "nope"})
        )
        result = bridge.handle_event(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="2",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(result.action, rt.BridgeAction.SUPPRESS)

    def test_valid_human_task_worker_dispatch_reviewer_suppress(self) -> None:
        ev = _event(
            author_id=HUMAN,
            content=_task_msg(SECRET_BODY),
            is_bot=False,
            message_id="10",
            created_at=self.t0,
        )
        rw = self.worker.handle_event(ev, now=self.t0)
        rr = self.reviewer.handle_event(ev, now=self.t0)

        self.assertEqual(rw.action, rt.BridgeAction.DISPATCH_HUMAN_TASK)
        self.assertEqual(rw.reason, "human_task_accepted")
        self.assertIsNotNone(rw.task_id)
        self.assertEqual(rr.action, rt.BridgeAction.SUPPRESS)
        self.assertEqual(rr.reason, "mirrored_task_non_dispatch")
        self.assertEqual(rw.task_id, rr.task_id)
        expected = policy_mod.derive_task_id(CHANNEL, "10")
        self.assertEqual(rw.task_id, expected)
        _assert_no_secrets(self, rw)
        _assert_no_secrets(self, rr)

    def test_casual_wrong_channel_unknown_bot_human_malformed_suppress(self) -> None:
        # Seed a task so unknown-bot handoff has a plausible task_id path.
        seed = self.worker.handle_event(
            _event(
                author_id=HUMAN,
                content=_task_msg("seed"),
                is_bot=False,
                message_id="20",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        tid = seed.task_id
        assert tid is not None

        cases = [
            (
                "casual",
                _event(
                    author_id=HUMAN,
                    content="morning — coffee?",
                    is_bot=False,
                    message_id="21",
                    created_at=self.t0,
                ),
            ),
            (
                "wrong_channel",
                _event(
                    author_id=HUMAN,
                    content=_task_msg(),
                    is_bot=False,
                    message_id="22",
                    channel_id=OTHER_CHANNEL,
                    created_at=self.t0,
                ),
            ),
            (
                "unknown_human",
                _event(
                    author_id=UNKNOWN_HUMAN,
                    content=_task_msg(),
                    is_bot=False,
                    message_id="23",
                    created_at=self.t0,
                ),
            ),
            (
                "unknown_bot",
                _event(
                    author_id=UNKNOWN_BOT,
                    content=_handoff(tid),
                    is_bot=True,
                    message_id="24",
                    created_at=self.t0 + 1,
                ),
            ),
            (
                "malformed_task",
                _event(
                    author_id=HUMAN,
                    content="TASK [target=deckhand] [reviewer=seadog]\nnope",
                    is_bot=False,
                    message_id="25",
                    created_at=self.t0,
                ),
            ),
            (
                "malformed_peer",
                _event(
                    author_id=SEADOG,
                    content="A2A-HANDOFF v2\ntask_id: " + tid,
                    is_bot=True,
                    message_id="26",
                    created_at=self.t0 + 1,
                ),
            ),
        ]
        for label, ev in cases:
            with self.subTest(label=label):
                result = self.worker.handle_event(ev, now=ev.created_at)
                self.assertEqual(result.action, rt.BridgeAction.SUPPRESS, msg=result.reason)
                _assert_no_secrets(self, result)

    def test_peer_handoff_and_review_dispatch_only_on_expected_instance(self) -> None:
        worker, reviewer = _pair()
        human_ev = _event(
            author_id=HUMAN,
            content=_task_msg(SECRET_BODY),
            is_bot=False,
            message_id="30",
            created_at=self.t0,
        )
        dw = worker.handle_event(human_ev, now=self.t0)
        reviewer.handle_event(human_ev, now=self.t0)
        self.assertEqual(dw.action, rt.BridgeAction.DISPATCH_HUMAN_TASK)
        tid = dw.task_id
        assert tid is not None

        handoff_ev = _event(
            author_id=SEADOG,
            content=_handoff(tid, PEER_SECRET),
            is_bot=True,
            message_id="31",
            created_at=self.t0 + 1,
        )
        hw = worker.handle_event(handoff_ev, now=self.t0 + 1)
        hr = reviewer.handle_event(handoff_ev, now=self.t0 + 1)
        # Only reviewer (expected consumer) dispatches peer handoff.
        self.assertEqual(hr.action, rt.BridgeAction.DISPATCH_PEER_HANDOFF)
        self.assertEqual(hr.reason, "peer_handoff_accepted")
        self.assertEqual(hr.task_id, tid)
        self.assertEqual(hw.action, rt.BridgeAction.SUPPRESS)
        self.assertEqual(hw.reason, "peer_handoff_non_local_consumer")
        # Both mirrors advanced.
        self.assertEqual(
            worker.policy.get_task(tid),
            reviewer.policy.get_task(tid),
        )

        review_ev = _event(
            author_id=DECKHAND,
            content=_review(tid, REVIEW_SECRET),
            is_bot=True,
            message_id="32",
            created_at=self.t0 + 2,
        )
        rw = worker.handle_event(review_ev, now=self.t0 + 2)
        rr = reviewer.handle_event(review_ev, now=self.t0 + 2)
        # Only worker (expected consumer) dispatches peer review.
        self.assertEqual(rw.action, rt.BridgeAction.DISPATCH_PEER_REVIEW)
        self.assertEqual(rw.reason, "peer_review_accepted")
        self.assertEqual(rw.task_id, tid)
        self.assertEqual(rr.action, rt.BridgeAction.SUPPRESS)
        self.assertEqual(rr.reason, "peer_review_non_local_consumer")

        for obj in (hw, hr, rw, rr):
            _assert_no_secrets(self, obj)

    def test_no_raw_content_in_action_metadata_or_repr(self) -> None:
        worker, reviewer = _pair()
        human_ev = _event(
            author_id=HUMAN,
            content=_task_msg(SECRET_BODY),
            is_bot=False,
            message_id="40",
            created_at=self.t0,
        )
        results = [
            worker.handle_event(human_ev, now=self.t0),
            reviewer.handle_event(human_ev, now=self.t0),
        ]
        tid = results[0].task_id
        assert tid is not None
        handoff_ev = _event(
            author_id=SEADOG,
            content=_handoff(tid, PEER_SECRET),
            is_bot=True,
            message_id="41",
            created_at=self.t0 + 1,
        )
        results.append(worker.handle_event(handoff_ev, now=self.t0 + 1))
        results.append(reviewer.handle_event(handoff_ev, now=self.t0 + 1))
        review_ev = _event(
            author_id=DECKHAND,
            content=_review(tid, REVIEW_SECRET),
            is_bot=True,
            message_id="42",
            created_at=self.t0 + 2,
        )
        results.append(worker.handle_event(review_ev, now=self.t0 + 2))
        results.append(reviewer.handle_event(review_ev, now=self.t0 + 2))

        for r in results:
            _assert_no_secrets(self, r)
            self.assertNotIn(SECRET_BODY, r.reason)
            self.assertNotIn(PEER_SECRET, r.reason)
            self.assertNotIn(REVIEW_SECRET, r.reason)
            if r.task_id:
                self.assertNotIn(SECRET_BODY, r.task_id)

        # Policy state on both also free of raw content.
        st_w = worker.policy.get_task(tid)
        st_r = reviewer.policy.get_task(tid)
        assert st_w is not None and st_r is not None
        _assert_no_secrets(self, st_w)
        _assert_no_secrets(self, st_r)

    def test_policy_state_isolated_per_bridge_and_restart_fail_closed(self) -> None:
        worker, reviewer = _pair()
        # Separate process-local stores.
        self.assertIsNot(worker, reviewer)
        self.assertIsNot(worker.policy, reviewer.policy)
        self.assertIsNot(worker.policy._tasks, reviewer.policy._tasks)

        human_ev = _event(
            author_id=HUMAN,
            content=_task_msg("isolation"),
            is_bot=False,
            message_id="50",
            created_at=self.t0,
        )
        dw = worker.handle_event(human_ev, now=self.t0)
        reviewer.handle_event(human_ev, now=self.t0)
        tid = dw.task_id
        assert tid is not None

        # Mutating worker state does not touch reviewer store object identity.
        handoff_ev = _event(
            author_id=SEADOG,
            content=_handoff(tid),
            is_bot=True,
            message_id="51",
            created_at=self.t0 + 1,
        )
        worker.handle_event(handoff_ev, now=self.t0 + 1)
        # Reviewer has not yet seen handoff — still awaiting handoff on its mirror.
        st_r = reviewer.policy.get_task(tid)
        assert st_r is not None
        self.assertEqual(st_r.stage, policy_mod.TaskStage.AWAITING_WORKER_HANDOFF)
        st_w = worker.policy.get_task(tid)
        assert st_w is not None
        self.assertEqual(st_w.stage, policy_mod.TaskStage.AWAITING_REVIEWER_REVIEW)

        # Restart empties local state → peer fail closed (SUPPRESS / reject path).
        restarted = rt.WaterCoolerA2ARuntime.from_mapping(
            _valid_mapping(**{rt.CFG_LOCAL_BOT_ID: DECKHAND})
        )
        self.assertEqual(restarted.policy.active_task_ids(), frozenset())
        late = restarted.handle_event(handoff_ev, now=self.t0 + 2)
        self.assertEqual(late.action, rt.BridgeAction.SUPPRESS)
        self.assertEqual(late.reason, "unknown_or_forged_task_id")

    def test_invalid_event_type_suppresses(self) -> None:
        bridge = rt.WaterCoolerA2ARuntime.from_mapping(_valid_mapping())
        result = bridge.handle_event("not-an-event", now=self.t0)  # type: ignore[arg-type]
        self.assertEqual(result.action, rt.BridgeAction.SUPPRESS)
        self.assertEqual(result.reason, "invalid_event")

    def test_runtime_does_not_import_discord_or_session_routing(self) -> None:
        src = RUNTIME_PATH.read_text(encoding="utf-8")
        self.assertNotIn("import discord", src)
        self.assertNotIn("from discord", src)
        self.assertNotIn("discord_session_routing", src)
        self.assertNotIn("build_discord_session_key", src)
        self.assertNotIn("hmac", src.lower())
        self.assertNotIn("shared_secret", src.lower())


class TestParserHasNoSideEffectDeps(unittest.TestCase):
    def test_parse_does_not_read_environ_even_if_set(self) -> None:
        import os

        key = rt.CFG_ENABLED
        previous = os.environ.get(key)
        try:
            os.environ[key] = "true"
            os.environ[rt.CFG_CHANNEL_ID] = CHANNEL
            os.environ[rt.CFG_LOCAL_BOT_ID] = SEADOG
            os.environ[rt.CFG_SEADOG_BOT_ID] = SEADOG
            os.environ[rt.CFG_DECKHAND_BOT_ID] = DECKHAND
            os.environ[rt.CFG_ALLOWED_HUMAN_STARTER_IDS] = HUMAN
            # Empty mapping must stay disabled despite env.
            cfg = rt.parse_runtime_config({})
            self.assertFalse(cfg.is_active)
            cfg2 = rt.parse_runtime_config(None)
            self.assertFalse(cfg2.is_active)
        finally:
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous
            for k in (
                rt.CFG_CHANNEL_ID,
                rt.CFG_LOCAL_BOT_ID,
                rt.CFG_SEADOG_BOT_ID,
                rt.CFG_DECKHAND_BOT_ID,
                rt.CFG_ALLOWED_HUMAN_STARTER_IDS,
            ):
                os.environ.pop(k, None)


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT.parent))
    raise SystemExit(unittest.main(verbosity=2))
