#!/usr/bin/env python3
"""Unit tests for Water-cooler A2A policy foundation (stdlib only).

Includes dual-instance (worker + reviewer process) mirror contract tests:
separate policy objects, shared task identity, dispatch asymmetry, peer
validation against local mirrors, and restart fail-closed.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from dataclasses import asdict, fields
from pathlib import Path
from typing import Tuple

ROOT = Path(__file__).resolve().parent
MOD_PATH = ROOT / "water_cooler_a2a_policy.py"

spec = importlib.util.spec_from_file_location("water_cooler_a2a_policy_under_test", MOD_PATH)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
# Python 3.13 dataclasses require the module to be registered before exec.
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

THREAD = mod.WATER_COOLER_THREAD_ID
PARENT = mod.WATER_COOLER_PARENT_CHANNEL_ID
CHANNEL = mod.WATER_COOLER_CHANNEL_ID  # exact message channel = Navigation thread
HUMAN = "100000000000000001"
SEADOG = "200000000000000001"
DECKHAND = "300000000000000001"
UNKNOWN_HUMAN = "100000000000000099"
UNKNOWN_BOT = "400000000000000001"
OTHER_CHANNEL = "1530209175861199000"
OTHER_THREAD = "1532167084618944000"


def _cfg(**overrides):
    base = dict(
        enabled=True,
        channel_id=CHANNEL,
        parent_channel_id=PARENT,
        allowed_human_starter_ids={HUMAN},
        seadog_bot_id=SEADOG,
        deckhand_bot_id=DECKHAND,
        local_bot_id=SEADOG,
        task_ttl_seconds=600.0,
    )
    base.update(overrides)
    return mod.build_config(**base)


def _pair() -> Tuple["mod.WaterCoolerA2APolicy", "mod.WaterCoolerA2APolicy"]:
    """Independent worker (Seadog) and reviewer (Deckhand) process instances."""
    worker = mod.WaterCoolerA2APolicy(_cfg(local_bot_id=SEADOG))
    reviewer = mod.WaterCoolerA2APolicy(_cfg(local_bot_id=DECKHAND))
    return worker, reviewer


def _event(
    *,
    author_id: str,
    content: str,
    is_bot: bool,
    message_id: str,
    channel_id: str = CHANNEL,
    parent_channel_id: str = PARENT,
    created_at: float = 1_000.0,
) -> "mod.DiscordMessageEvent":
    return mod.DiscordMessageEvent(
        channel_id=channel_id,
        message_id=message_id,
        author_id=author_id,
        content=content,
        is_bot=is_bot,
        created_at=created_at,
        parent_channel_id=parent_channel_id,
    )


def _task_msg(body: str = "Investigate session key drift in staging.") -> str:
    return f"TASK [target=seadog] [reviewer=deckhand]\n{body}"


def _handoff(task_id: str, extra: str = "worker notes") -> str:
    return f"A2A-HANDOFF v1\ntask_id: {task_id}\n{extra}"


def _review(task_id: str, extra: str = "lgtm with nits") -> str:
    return f"A2A-REVIEW v1\ntask_id: {task_id}\n{extra}"


def _expected_task_id(message_id: str, channel_id: str = CHANNEL) -> str:
    return mod.derive_task_id(channel_id, message_id)


class TestWaterCoolerA2APolicy(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = mod.WaterCoolerA2APolicy(_cfg())
        self.t0 = 1_000.0

    def test_valid_human_task(self) -> None:
        secret_body = "SECRET_TASK_BODY_SHOULD_NOT_PERSIST"
        msg_id = "9001"
        decision = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(secret_body),
                is_bot=False,
                message_id=msg_id,
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(decision.kind, mod.DecisionKind.HUMAN_TASK)
        self.assertEqual(decision.task_id, _expected_task_id(msg_id))
        self.assertIsNotNone(decision.task_state)
        assert decision.task_state is not None
        self.assertEqual(decision.task_state.stage, mod.TaskStage.AWAITING_WORKER_HANDOFF)
        self.assertEqual(decision.task_state.worker_bot_id, SEADOG)
        self.assertEqual(decision.task_state.reviewer_bot_id, DECKHAND)
        self.assertEqual(decision.task_state.round_count, 0)
        self.assertEqual(decision.task_state.source_message_id, msg_id)
        self.assertEqual(decision.task_state.expires_at, self.t0 + 600.0)

    def test_casual_water_cooler_chat_ignored(self) -> None:
        decision = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content="morning all — coffee is on",
                is_bot=False,
                message_id="9002",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(decision.kind, mod.DecisionKind.IGNORE)
        self.assertEqual(decision.reason, "casual_chat")
        self.assertEqual(self.policy.active_task_ids(), frozenset())

    def test_three_round_exchange_then_terminal(self) -> None:
        d0 = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg("multi-round work"),
                is_bot=False,
                message_id="1000",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        tid = d0.task_id
        self.assertEqual(d0.kind, mod.DecisionKind.HUMAN_TASK)
        assert tid is not None

        now = self.t0
        for round_i in range(1, mod.MAX_ROUNDS + 1):
            now += 1
            dh = self.policy.evaluate(
                _event(
                    author_id=SEADOG,
                    content=_handoff(tid, f"handoff-{round_i}"),
                    is_bot=True,
                    message_id=str(2000 + round_i),
                    created_at=now,
                ),
                now=now,
            )
            self.assertEqual(dh.kind, mod.DecisionKind.PEER_HANDOFF, msg=dh.reason)
            assert dh.task_state is not None
            self.assertEqual(dh.task_state.stage, mod.TaskStage.AWAITING_REVIEWER_REVIEW)

            now += 1
            dr = self.policy.evaluate(
                _event(
                    author_id=DECKHAND,
                    content=_review(tid, f"review-{round_i}"),
                    is_bot=True,
                    message_id=str(3000 + round_i),
                    created_at=now,
                ),
                now=now,
            )
            self.assertEqual(dr.kind, mod.DecisionKind.PEER_REVIEW, msg=dr.reason)
            assert dr.task_state is not None
            self.assertEqual(dr.task_state.round_count, round_i)
            if round_i < mod.MAX_ROUNDS:
                self.assertEqual(dr.task_state.stage, mod.TaskStage.AWAITING_WORKER_HANDOFF)
            else:
                self.assertEqual(dr.task_state.stage, mod.TaskStage.TERMINAL)

        # Fourth handoff rejected.
        now += 1
        d4h = self.policy.evaluate(
            _event(
                author_id=SEADOG,
                content=_handoff(tid, "handoff-4"),
                is_bot=True,
                message_id="2004",
                created_at=now,
            ),
            now=now,
        )
        self.assertEqual(d4h.kind, mod.DecisionKind.REJECT)
        self.assertIn(d4h.reason, {"task_expired_or_terminal", "round_limit_exceeded"})

        # Fourth review also rejected.
        now += 1
        d4r = self.policy.evaluate(
            _event(
                author_id=DECKHAND,
                content=_review(tid, "review-4"),
                is_bot=True,
                message_id="3004",
                created_at=now,
            ),
            now=now,
        )
        self.assertEqual(d4r.kind, mod.DecisionKind.REJECT)

    def test_self_bot_review_by_worker_rejected(self) -> None:
        d0 = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1100",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        tid = d0.task_id
        assert tid is not None
        self.policy.evaluate(
            _event(
                author_id=SEADOG,
                content=_handoff(tid),
                is_bot=True,
                message_id="1101",
                created_at=self.t0 + 1,
            ),
            now=self.t0 + 1,
        )
        # Worker tries to review own handoff.
        bad = self.policy.evaluate(
            _event(
                author_id=SEADOG,
                content=_review(tid),
                is_bot=True,
                message_id="1102",
                created_at=self.t0 + 2,
            ),
            now=self.t0 + 2,
        )
        self.assertEqual(bad.kind, mod.DecisionKind.REJECT)
        self.assertEqual(bad.reason, "self_bot_or_wrong_role")
        st = self.policy.get_task(tid)
        assert st is not None
        self.assertEqual(st.stage, mod.TaskStage.AWAITING_REVIEWER_REVIEW)

    def test_self_bot_handoff_by_reviewer_rejected(self) -> None:
        d0 = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1200",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        tid = d0.task_id
        assert tid is not None
        bad = self.policy.evaluate(
            _event(
                author_id=DECKHAND,
                content=_handoff(tid),
                is_bot=True,
                message_id="1201",
                created_at=self.t0 + 1,
            ),
            now=self.t0 + 1,
        )
        self.assertEqual(bad.kind, mod.DecisionKind.REJECT)
        self.assertEqual(bad.reason, "self_bot_or_wrong_role")

    def test_unknown_bot_rejected(self) -> None:
        d0 = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1300",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        tid = d0.task_id
        assert tid is not None
        bad = self.policy.evaluate(
            _event(
                author_id=UNKNOWN_BOT,
                content=_handoff(tid),
                is_bot=True,
                message_id="1301",
                created_at=self.t0 + 1,
            ),
            now=self.t0 + 1,
        )
        self.assertEqual(bad.kind, mod.DecisionKind.REJECT)
        self.assertEqual(bad.reason, "unknown_bot")

    def test_wrong_channel_ignored(self) -> None:
        decision = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1400",
                channel_id=OTHER_CHANNEL,
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(decision.kind, mod.DecisionKind.IGNORE)
        self.assertEqual(decision.reason, "wrong_channel")
        self.assertEqual(self.policy.active_task_ids(), frozenset())

    def test_valid_navigation_thread_accepted(self) -> None:
        """Exact Navigation thread under Water-cooler parent passes."""
        self.assertEqual(CHANNEL, THREAD)
        decision = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1401",
                channel_id=THREAD,
                parent_channel_id=PARENT,
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(decision.kind, mod.DecisionKind.HUMAN_TASK)
        self.assertEqual(decision.task_id, _expected_task_id("1401", THREAD))
        assert decision.task_state is not None
        self.assertEqual(decision.task_state.source_channel_id, THREAD)

    def test_direct_parent_channel_rejected(self) -> None:
        """Protocol posted directly in parent Water-cooler is not accepted."""
        decision = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1402",
                channel_id=PARENT,
                parent_channel_id="",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(decision.kind, mod.DecisionKind.IGNORE)
        self.assertEqual(decision.reason, "wrong_channel")
        self.assertEqual(self.policy.active_task_ids(), frozenset())

    def test_other_thread_under_water_cooler_rejected(self) -> None:
        """A different thread under the same parent is not the Navigation thread."""
        decision = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1403",
                channel_id=OTHER_THREAD,
                parent_channel_id=PARENT,
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(decision.kind, mod.DecisionKind.IGNORE)
        self.assertEqual(decision.reason, "wrong_channel")
        self.assertEqual(self.policy.active_task_ids(), frozenset())

    def test_navigation_wrong_parent_rejected(self) -> None:
        """Navigation thread id with a non-Water-cooler parent fails closed."""
        decision = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1404",
                channel_id=THREAD,
                parent_channel_id=OTHER_CHANNEL,
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(decision.kind, mod.DecisionKind.REJECT)
        self.assertEqual(decision.reason, "wrong_thread_parent")
        self.assertEqual(self.policy.active_task_ids(), frozenset())

    def test_navigation_missing_parent_rejected(self) -> None:
        decision = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1405",
                channel_id=THREAD,
                parent_channel_id="",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(decision.kind, mod.DecisionKind.REJECT)
        self.assertEqual(decision.reason, "not_navigation_thread")

    def test_unknown_human_rejected(self) -> None:
        decision = self.policy.evaluate(
            _event(
                author_id=UNKNOWN_HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1500",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(decision.kind, mod.DecisionKind.REJECT)
        self.assertEqual(decision.reason, "unknown_human")

    def test_missing_and_forged_task_id(self) -> None:
        d0 = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1600",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(d0.kind, mod.DecisionKind.HUMAN_TASK)

        missing = self.policy.evaluate(
            _event(
                author_id=SEADOG,
                content="A2A-HANDOFF v1\nno id here",
                is_bot=True,
                message_id="1601",
                created_at=self.t0 + 1,
            ),
            now=self.t0 + 1,
        )
        self.assertEqual(missing.kind, mod.DecisionKind.REJECT)
        self.assertEqual(missing.reason, "missing_or_invalid_task_id")

        forged = self.policy.evaluate(
            _event(
                author_id=SEADOG,
                content=_handoff("forged_task_id_zzz99"),
                is_bot=True,
                message_id="1602",
                created_at=self.t0 + 2,
            ),
            now=self.t0 + 2,
        )
        self.assertEqual(forged.kind, mod.DecisionKind.REJECT)
        self.assertEqual(forged.reason, "unknown_or_forged_task_id")

    def test_wrong_order_review_before_handoff(self) -> None:
        d0 = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1700",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        tid = d0.task_id
        assert tid is not None
        bad = self.policy.evaluate(
            _event(
                author_id=DECKHAND,
                content=_review(tid),
                is_bot=True,
                message_id="1701",
                created_at=self.t0 + 1,
            ),
            now=self.t0 + 1,
        )
        self.assertEqual(bad.kind, mod.DecisionKind.REJECT)
        self.assertEqual(bad.reason, "wrong_order_or_duplicate_review")

    def test_duplicate_message_rejected(self) -> None:
        content = _task_msg()
        first = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=content,
                is_bot=False,
                message_id="1800",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(first.kind, mod.DecisionKind.HUMAN_TASK)
        dup = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=content,
                is_bot=False,
                message_id="1800",
                created_at=self.t0 + 1,
            ),
            now=self.t0 + 1,
        )
        self.assertEqual(dup.kind, mod.DecisionKind.REJECT)
        self.assertEqual(dup.reason, "duplicate_message")

    def test_expiry_rejects_late_peer(self) -> None:
        policy = mod.WaterCoolerA2APolicy(_cfg(task_ttl_seconds=30.0))
        d0 = policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="1900",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        tid = d0.task_id
        assert tid is not None
        late = policy.evaluate(
            _event(
                author_id=SEADOG,
                content=_handoff(tid),
                is_bot=True,
                message_id="1901",
                created_at=self.t0 + 100,
            ),
            now=self.t0 + 100,
        )
        self.assertEqual(late.kind, mod.DecisionKind.REJECT)
        self.assertEqual(late.reason, "task_expired_or_terminal")
        st = policy.get_task(tid)
        assert st is not None
        self.assertEqual(st.stage, mod.TaskStage.TERMINAL)

    def test_disabled_and_missing_config_fail_closed(self) -> None:
        disabled = mod.WaterCoolerA2APolicy(_cfg(enabled=False))
        d1 = disabled.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="2000",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(d1.kind, mod.DecisionKind.IGNORE)
        self.assertEqual(d1.reason, "policy_disabled_or_invalid_config")

        incomplete = mod.WaterCoolerA2APolicy(
            mod.build_config(
                enabled=True,
                channel_id=CHANNEL,
                allowed_human_starter_ids=set(),
                seadog_bot_id=SEADOG,
                deckhand_bot_id=DECKHAND,
                local_bot_id=SEADOG,
            )
        )
        d2 = incomplete.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="2001",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(d2.kind, mod.DecisionKind.IGNORE)
        self.assertFalse(incomplete.config.is_active)

        bad_ttl = mod.build_config(
            enabled=True,
            channel_id=CHANNEL,
            allowed_human_starter_ids={HUMAN},
            seadog_bot_id=SEADOG,
            deckhand_bot_id=DECKHAND,
            local_bot_id=SEADOG,
            task_ttl_seconds=999_999.0,
        )
        self.assertFalse(bad_ttl.is_active)

        same_bots = mod.build_config(
            enabled=True,
            channel_id=CHANNEL,
            allowed_human_starter_ids={HUMAN},
            seadog_bot_id=SEADOG,
            deckhand_bot_id=SEADOG,
            local_bot_id=SEADOG,
        )
        self.assertFalse(same_bots.is_active)

    def test_oversize_input_rejected(self) -> None:
        huge = "x" * (mod.MAX_CONTENT_LENGTH + 1)
        decision = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=huge,
                is_bot=False,
                message_id="2100",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(decision.kind, mod.DecisionKind.REJECT)
        self.assertEqual(decision.reason, "oversize_content")

    def test_no_raw_content_in_state(self) -> None:
        secret = "UNIQUE_RAW_PAYLOAD_xyzzy_do_not_store"
        d0 = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(secret),
                is_bot=False,
                message_id="2200",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        tid = d0.task_id
        assert tid is not None
        self.policy.evaluate(
            _event(
                author_id=SEADOG,
                content=_handoff(tid, "PEER_OUTPUT_SECRET_abc"),
                is_bot=True,
                message_id="2201",
                created_at=self.t0 + 1,
            ),
            now=self.t0 + 1,
        )
        self.policy.evaluate(
            _event(
                author_id=DECKHAND,
                content=_review(tid, "MODEL_OUTPUT_SECRET_def"),
                is_bot=True,
                message_id="2202",
                created_at=self.t0 + 2,
            ),
            now=self.t0 + 2,
        )
        state = self.policy.get_task(tid)
        assert state is not None
        blob = repr(asdict(state))
        self.assertNotIn(secret, blob)
        self.assertNotIn("PEER_OUTPUT_SECRET_abc", blob)
        self.assertNotIn("MODEL_OUTPUT_SECRET_def", blob)
        field_names = {f.name for f in fields(state)}
        for forbidden in ("content", "body", "text", "payload", "output", "prompt"):
            self.assertNotIn(forbidden, field_names)

    def test_malformed_protocol_rejected(self) -> None:
        cases = [
            "TASK [target=deckhand] [reviewer=seadog]\nnope",
            "TASK [target=seadog]\nmissing reviewer",
            "A2A-HANDOFF v2\ntask_id: " + _expected_task_id("2300"),
            "A2A-REVIEW v1 task_id: embedded",
        ]
        for i, content in enumerate(cases):
            with self.subTest(content=content[:40]):
                d = self.policy.evaluate(
                    _event(
                        author_id=HUMAN if content.startswith("TASK") else SEADOG,
                        content=content,
                        is_bot=not content.startswith("TASK"),
                        message_id=str(2300 + i),
                        created_at=self.t0,
                    ),
                    now=self.t0,
                )
                self.assertEqual(d.kind, mod.DecisionKind.REJECT)

    def test_ttl_bounds(self) -> None:
        self.assertTrue(
            mod.build_config(
                enabled=True,
                channel_id=CHANNEL,
                allowed_human_starter_ids={HUMAN},
                seadog_bot_id=SEADOG,
                deckhand_bot_id=DECKHAND,
                local_bot_id=SEADOG,
                task_ttl_seconds=mod.MIN_TTL_SECONDS,
            ).is_active
        )
        self.assertTrue(
            mod.build_config(
                enabled=True,
                channel_id=CHANNEL,
                allowed_human_starter_ids={HUMAN},
                seadog_bot_id=SEADOG,
                deckhand_bot_id=DECKHAND,
                local_bot_id=DECKHAND,
                task_ttl_seconds=mod.MAX_TTL_SECONDS,
            ).is_active
        )
        self.assertFalse(
            mod.build_config(
                enabled=True,
                channel_id=CHANNEL,
                allowed_human_starter_ids={HUMAN},
                seadog_bot_id=SEADOG,
                deckhand_bot_id=DECKHAND,
                local_bot_id=SEADOG,
                task_ttl_seconds=mod.MIN_TTL_SECONDS - 0.1,
            ).is_active
        )

    def test_policy_does_not_import_session_routing(self) -> None:
        """Policy foundation must not mutate or depend on Discord session routing."""
        src = MOD_PATH.read_text(encoding="utf-8")
        self.assertNotIn("discord_session_routing", src)
        self.assertNotIn("build_discord_session_key", src)
        self.assertNotIn("gateway.session", src)
        # Module under test must not pull ambient env inside pure logic.
        self.assertNotIn("os.environ", src)
        self.assertNotIn("os.getenv", src)
        # No shared-secret / signed-token machinery in this slice.
        self.assertNotIn("hmac", src.lower())
        self.assertNotIn("shared_secret", src.lower())

    # ------------------------------------------------------------------
    # Dual-instance mirror contract (cross-process without shared memory)
    # ------------------------------------------------------------------

    def test_dual_instance_same_task_identity_without_shared_memory(self) -> None:
        """(1) Both instances observe the same human task; same task_id/state."""
        worker, reviewer = _pair()
        # Prove separate process-local stores (no shared dict).
        self.assertIsNot(worker, reviewer)
        self.assertIsNot(worker._tasks, reviewer._tasks)

        msg_id = "5001"
        human_ev = _event(
            author_id=HUMAN,
            content=_task_msg("shared identity work"),
            is_bot=False,
            message_id=msg_id,
            created_at=self.t0,
        )
        dw = worker.evaluate(human_ev, now=self.t0)
        dr = reviewer.evaluate(human_ev, now=self.t0)

        expected = _expected_task_id(msg_id)
        self.assertEqual(dw.task_id, expected)
        self.assertEqual(dr.task_id, expected)
        self.assertEqual(dw.task_id, dr.task_id)

        sw = worker.get_task(expected)
        sr = reviewer.get_task(expected)
        self.assertIsNotNone(sw)
        self.assertIsNotNone(sr)
        assert sw is not None and sr is not None
        # Value identity (same facts), not object identity.
        self.assertEqual(sw, sr)
        self.assertIsNot(sw, sr)
        self.assertEqual(sw.stage, mod.TaskStage.AWAITING_WORKER_HANDOFF)
        self.assertEqual(sw.worker_bot_id, SEADOG)
        self.assertEqual(sw.reviewer_bot_id, DECKHAND)
        self.assertEqual(sw.source_message_id, msg_id)
        self.assertEqual(sw.round_count, 0)

    def test_only_worker_gets_dispatchable_human_task(self) -> None:
        """(2) Only worker receives HUMAN_TASK; reviewer mirrors with ignore."""
        worker, reviewer = _pair()
        human_ev = _event(
            author_id=HUMAN,
            content=_task_msg("dispatch asymmetry"),
            is_bot=False,
            message_id="5002",
            created_at=self.t0,
        )
        dw = worker.evaluate(human_ev, now=self.t0)
        dr = reviewer.evaluate(human_ev, now=self.t0)

        self.assertEqual(dw.kind, mod.DecisionKind.HUMAN_TASK)
        self.assertEqual(dw.reason, "human_task_accepted")
        self.assertEqual(dr.kind, mod.DecisionKind.IGNORE)
        self.assertEqual(dr.reason, "mirrored_task_non_dispatch")
        # Reviewer still recorded mirror state (non-dispatch).
        self.assertIsNotNone(dr.task_state)
        self.assertEqual(dr.task_id, dw.task_id)
        self.assertEqual(worker.active_task_ids(), reviewer.active_task_ids())

    def test_reviewer_validates_first_worker_handoff_via_mirror(self) -> None:
        """(3) Reviewer validates first handoff using its local mirror only."""
        worker, reviewer = _pair()
        human_ev = _event(
            author_id=HUMAN,
            content=_task_msg("handoff via mirror"),
            is_bot=False,
            message_id="5003",
            created_at=self.t0,
        )
        dw = worker.evaluate(human_ev, now=self.t0)
        reviewer.evaluate(human_ev, now=self.t0)
        tid = dw.task_id
        assert tid is not None

        handoff_ev = _event(
            author_id=SEADOG,
            content=_handoff(tid, "first handoff body"),
            is_bot=True,
            message_id="5004",
            created_at=self.t0 + 1,
        )
        # Reviewer alone can accept — its mirror is sufficient.
        dh_r = reviewer.evaluate(handoff_ev, now=self.t0 + 1)
        self.assertEqual(dh_r.kind, mod.DecisionKind.PEER_HANDOFF, msg=dh_r.reason)
        assert dh_r.task_state is not None
        self.assertEqual(dh_r.task_state.stage, mod.TaskStage.AWAITING_REVIEWER_REVIEW)

        # Worker also advances independently from the same envelope.
        dh_w = worker.evaluate(handoff_ev, now=self.t0 + 1)
        self.assertEqual(dh_w.kind, mod.DecisionKind.PEER_HANDOFF)
        self.assertEqual(worker.get_task(tid), reviewer.get_task(tid))

    def test_dual_instance_three_rounds_through_terminal(self) -> None:
        """(4) Worker validates reviews; both stay in sync through third round."""
        worker, reviewer = _pair()
        human_ev = _event(
            author_id=HUMAN,
            content=_task_msg("three round dual"),
            is_bot=False,
            message_id="5100",
            created_at=self.t0,
        )
        dw = worker.evaluate(human_ev, now=self.t0)
        reviewer.evaluate(human_ev, now=self.t0)
        tid = dw.task_id
        assert tid is not None

        now = self.t0
        for round_i in range(1, mod.MAX_ROUNDS + 1):
            now += 1
            handoff_ev = _event(
                author_id=SEADOG,
                content=_handoff(tid, f"handoff-{round_i}"),
                is_bot=True,
                message_id=str(5200 + round_i),
                created_at=now,
            )
            dh_w = worker.evaluate(handoff_ev, now=now)
            dh_r = reviewer.evaluate(handoff_ev, now=now)
            self.assertEqual(dh_w.kind, mod.DecisionKind.PEER_HANDOFF, msg=dh_w.reason)
            self.assertEqual(dh_r.kind, mod.DecisionKind.PEER_HANDOFF, msg=dh_r.reason)

            now += 1
            review_ev = _event(
                author_id=DECKHAND,
                content=_review(tid, f"review-{round_i}"),
                is_bot=True,
                message_id=str(5300 + round_i),
                created_at=now,
            )
            # Worker validates review against its mirror.
            dr_w = worker.evaluate(review_ev, now=now)
            dr_r = reviewer.evaluate(review_ev, now=now)
            self.assertEqual(dr_w.kind, mod.DecisionKind.PEER_REVIEW, msg=dr_w.reason)
            self.assertEqual(dr_r.kind, mod.DecisionKind.PEER_REVIEW, msg=dr_r.reason)
            self.assertEqual(worker.get_task(tid), reviewer.get_task(tid))
            st = worker.get_task(tid)
            assert st is not None
            self.assertEqual(st.round_count, round_i)
            if round_i < mod.MAX_ROUNDS:
                self.assertEqual(st.stage, mod.TaskStage.AWAITING_WORKER_HANDOFF)
            else:
                self.assertEqual(st.stage, mod.TaskStage.TERMINAL)

        # Fourth handoff rejected on both.
        now += 1
        fourth = _event(
            author_id=SEADOG,
            content=_handoff(tid, "handoff-4"),
            is_bot=True,
            message_id="5299",
            created_at=now,
        )
        self.assertEqual(worker.evaluate(fourth, now=now).kind, mod.DecisionKind.REJECT)
        self.assertEqual(reviewer.evaluate(fourth, now=now).kind, mod.DecisionKind.REJECT)

    def test_restart_or_empty_instance_rejects_peer_fail_closed(self) -> None:
        """(5) Fresh/restarted instance has no mirror — peer envelopes rejected."""
        worker, reviewer = _pair()
        human_ev = _event(
            author_id=HUMAN,
            content=_task_msg("pre-restart task"),
            is_bot=False,
            message_id="5400",
            created_at=self.t0,
        )
        dw = worker.evaluate(human_ev, now=self.t0)
        reviewer.evaluate(human_ev, now=self.t0)
        tid = dw.task_id
        assert tid is not None

        # Worker "restarts" — empty local state.
        restarted_worker = mod.WaterCoolerA2APolicy(_cfg(local_bot_id=SEADOG))
        self.assertEqual(restarted_worker.active_task_ids(), frozenset())
        peer = _event(
            author_id=SEADOG,
            content=_handoff(tid),
            is_bot=True,
            message_id="5401",
            created_at=self.t0 + 1,
        )
        bad_w = restarted_worker.evaluate(peer, now=self.t0 + 1)
        self.assertEqual(bad_w.kind, mod.DecisionKind.REJECT)
        self.assertEqual(bad_w.reason, "unknown_or_forged_task_id")

        # Reviewer restart after handoff exists only on the other side.
        worker.evaluate(peer, now=self.t0 + 1)
        restarted_reviewer = mod.WaterCoolerA2APolicy(_cfg(local_bot_id=DECKHAND))
        review_peer = _event(
            author_id=DECKHAND,
            content=_review(tid),
            is_bot=True,
            message_id="5402",
            created_at=self.t0 + 2,
        )
        bad_r = restarted_reviewer.evaluate(review_peer, now=self.t0 + 2)
        self.assertEqual(bad_r.kind, mod.DecisionKind.REJECT)
        self.assertEqual(bad_r.reason, "unknown_or_forged_task_id")

        # Brand-new empty pair never accepts a peer for an unknown task_id.
        empty_w, empty_r = _pair()
        ghost = _event(
            author_id=SEADOG,
            content=_handoff(_expected_task_id("9999")),
            is_bot=True,
            message_id="5499",
            created_at=self.t0,
        )
        self.assertEqual(empty_w.evaluate(ghost, now=self.t0).reason, "unknown_or_forged_task_id")
        self.assertEqual(empty_r.evaluate(ghost, now=self.t0).reason, "unknown_or_forged_task_id")

    def test_wrong_local_bot_config_fails_closed(self) -> None:
        """(6) local_bot_id must be exactly Seadog or Deckhand."""
        missing_local = mod.build_config(
            enabled=True,
            channel_id=CHANNEL,
            allowed_human_starter_ids={HUMAN},
            seadog_bot_id=SEADOG,
            deckhand_bot_id=DECKHAND,
            local_bot_id="",
        )
        self.assertFalse(missing_local.is_active)
        self.assertIsNone(missing_local.local_role)

        wrong_local = mod.build_config(
            enabled=True,
            channel_id=CHANNEL,
            allowed_human_starter_ids={HUMAN},
            seadog_bot_id=SEADOG,
            deckhand_bot_id=DECKHAND,
            local_bot_id=UNKNOWN_BOT,
        )
        self.assertFalse(wrong_local.is_active)
        self.assertIsNone(wrong_local.local_role)

        policy = mod.WaterCoolerA2APolicy(wrong_local)
        d = policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(),
                is_bot=False,
                message_id="5500",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(d.kind, mod.DecisionKind.IGNORE)
        self.assertEqual(d.reason, "policy_disabled_or_invalid_config")
        self.assertEqual(policy.active_task_ids(), frozenset())

        ok_worker = mod.build_config(
            enabled=True,
            channel_id=CHANNEL,
            allowed_human_starter_ids={HUMAN},
            seadog_bot_id=SEADOG,
            deckhand_bot_id=DECKHAND,
            local_bot_id=SEADOG,
        )
        ok_reviewer = mod.build_config(
            enabled=True,
            channel_id=CHANNEL,
            allowed_human_starter_ids={HUMAN},
            seadog_bot_id=SEADOG,
            deckhand_bot_id=DECKHAND,
            local_bot_id=DECKHAND,
        )
        self.assertTrue(ok_worker.is_active)
        self.assertEqual(ok_worker.local_role, mod.ROLE_WORKER)
        self.assertTrue(ok_worker.is_local_worker)
        self.assertTrue(ok_reviewer.is_active)
        self.assertEqual(ok_reviewer.local_role, mod.ROLE_REVIEWER)
        self.assertTrue(ok_reviewer.is_local_reviewer)

    def test_derive_task_id_stable_and_opaque(self) -> None:
        a = mod.derive_task_id(CHANNEL, "9001")
        b = mod.derive_task_id(CHANNEL, "9001")
        c = mod.derive_task_id(CHANNEL, "9002")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)
        self.assertRegex(a, r"^[A-Za-z0-9_-]{8,64}$")
        # Must not embed raw message content or snowflake as the sole id form
        # in a way that stores task body (derivation uses ids only).
        self.assertNotIn("TASK", a)


if __name__ == "__main__":
    # Keep path stable when run from repo root or package dir.
    sys.path.insert(0, str(ROOT.parent))
    raise SystemExit(unittest.main(verbosity=2))
