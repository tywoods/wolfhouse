#!/usr/bin/env python3
"""Unit tests for Water-cooler A2A policy foundation (stdlib only)."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from dataclasses import asdict, fields
from pathlib import Path
from typing import List

ROOT = Path(__file__).resolve().parent
MOD_PATH = ROOT / "water_cooler_a2a_policy.py"

spec = importlib.util.spec_from_file_location("water_cooler_a2a_policy_under_test", MOD_PATH)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
# Python 3.13 dataclasses require the module to be registered before exec.
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

CHANNEL = mod.WATER_COOLER_CHANNEL_ID
HUMAN = "100000000000000001"
SEADOG = "200000000000000001"
DECKHAND = "300000000000000001"
UNKNOWN_HUMAN = "100000000000000099"
UNKNOWN_BOT = "400000000000000001"
OTHER_CHANNEL = "1530209175861199000"

# Deterministic opaque IDs for tests.
_ID_SEQ: List[str] = []
_ID_I = 0


def _reset_ids(*ids: str) -> None:
    global _ID_SEQ, _ID_I
    _ID_SEQ = list(ids) if ids else [
        "taskid_round_aaa01",
        "taskid_round_bbb02",
        "taskid_round_ccc03",
        "taskid_round_ddd04",
        "taskid_round_eee05",
    ]
    _ID_I = 0


def _next_id() -> str:
    global _ID_I
    if _ID_I >= len(_ID_SEQ):
        raise AssertionError("test id generator exhausted")
    value = _ID_SEQ[_ID_I]
    _ID_I += 1
    return value


def _cfg(**overrides):
    base = dict(
        enabled=True,
        channel_id=CHANNEL,
        allowed_human_starter_ids={HUMAN},
        seadog_bot_id=SEADOG,
        deckhand_bot_id=DECKHAND,
        task_ttl_seconds=600.0,
        id_generator=_next_id,
    )
    base.update(overrides)
    return mod.build_config(**base)


def _event(
    *,
    author_id: str,
    content: str,
    is_bot: bool,
    message_id: str,
    channel_id: str = CHANNEL,
    created_at: float = 1_000.0,
) -> "mod.DiscordMessageEvent":
    return mod.DiscordMessageEvent(
        channel_id=channel_id,
        message_id=message_id,
        author_id=author_id,
        content=content,
        is_bot=is_bot,
        created_at=created_at,
    )


def _task_msg(body: str = "Investigate session key drift in staging.") -> str:
    return f"TASK [target=seadog] [reviewer=deckhand]\n{body}"


def _handoff(task_id: str, extra: str = "worker notes") -> str:
    return f"A2A-HANDOFF v1\ntask_id: {task_id}\n{extra}"


def _review(task_id: str, extra: str = "lgtm with nits") -> str:
    return f"A2A-REVIEW v1\ntask_id: {task_id}\n{extra}"


class TestWaterCoolerA2APolicy(unittest.TestCase):
    def setUp(self) -> None:
        _reset_ids()
        self.policy = mod.WaterCoolerA2APolicy(_cfg())
        self.t0 = 1_000.0

    def test_valid_human_task(self) -> None:
        secret_body = "SECRET_TASK_BODY_SHOULD_NOT_PERSIST"
        decision = self.policy.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_msg(secret_body),
                is_bot=False,
                message_id="9001",
                created_at=self.t0,
            ),
            now=self.t0,
        )
        self.assertEqual(decision.kind, mod.DecisionKind.HUMAN_TASK)
        self.assertEqual(decision.task_id, "taskid_round_aaa01")
        self.assertIsNotNone(decision.task_state)
        assert decision.task_state is not None
        self.assertEqual(decision.task_state.stage, mod.TaskStage.AWAITING_WORKER_HANDOFF)
        self.assertEqual(decision.task_state.worker_bot_id, SEADOG)
        self.assertEqual(decision.task_state.reviewer_bot_id, DECKHAND)
        self.assertEqual(decision.task_state.round_count, 0)
        self.assertEqual(decision.task_state.source_message_id, "9001")
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
            task_ttl_seconds=999_999.0,
        )
        self.assertFalse(bad_ttl.is_active)

        same_bots = mod.build_config(
            enabled=True,
            channel_id=CHANNEL,
            allowed_human_starter_ids={HUMAN},
            seadog_bot_id=SEADOG,
            deckhand_bot_id=SEADOG,
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
            "A2A-HANDOFF v2\ntask_id: taskid_round_aaa01",
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


if __name__ == "__main__":
    # Keep path stable when run from repo root or package dir.
    sys.path.insert(0, str(ROOT.parent))
    raise SystemExit(unittest.main(verbosity=2))
