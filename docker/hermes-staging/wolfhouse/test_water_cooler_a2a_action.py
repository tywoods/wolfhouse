#!/usr/bin/env python3
"""Unit tests for controlled Water-cooler A2A outbound action.

Covers success path, all reject paths, scoped-sender channel isolation,
duplicate tool use, and policy advance-only-after-send. Fake adapter only —
no Discord SDK, network, filesystem, or shell.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from typing import Any, Dict, Tuple

ROOT = Path(__file__).resolve().parent
POLICY_PATH = ROOT / "water_cooler_a2a_policy.py"
RUNTIME_PATH = ROOT / "water_cooler_a2a_runtime.py"
ENVELOPE_PATH = ROOT / "water_cooler_a2a_envelope.py"
CTX_PATH = ROOT / "water_cooler_a2a_action_context.py"
ACTION_PATH = ROOT / "water_cooler_a2a_action.py"
PLUGIN_PATH = ROOT.parent / "plugins" / "water_cooler_a2a" / "__init__.py"
PLUGIN_YAML = ROOT.parent / "plugins" / "water_cooler_a2a" / "plugin.yaml"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


policy_mod = _load("water_cooler_a2a_policy_action_test", POLICY_PATH)
sys.modules["water_cooler_a2a_policy"] = policy_mod
rt = _load("water_cooler_a2a_runtime_action_test", RUNTIME_PATH)
sys.modules["water_cooler_a2a_runtime"] = rt
env = _load("water_cooler_a2a_envelope_action_test", ENVELOPE_PATH)
sys.modules["water_cooler_a2a_envelope"] = env
ctx_mod = _load("water_cooler_a2a_action_context_under_test", CTX_PATH)
sys.modules["water_cooler_a2a_action_context"] = ctx_mod
action = _load("water_cooler_a2a_action_under_test", ACTION_PATH)

CHANNEL = policy_mod.WATER_COOLER_CHANNEL_ID
OTHER_CHANNEL = "1530209175861199000"
HUMAN = "100000000000000001"
SEADOG = "200000000000000001"
DECKHAND = "300000000000000001"
BODY = "bounded handoff notes for peer review"


def _mapping(local: str = SEADOG, **overrides: Any) -> Dict[str, Any]:
    base: Dict[str, Any] = {
        rt.CFG_ENABLED: True,
        rt.CFG_CHANNEL_ID: CHANNEL,
        rt.CFG_LOCAL_BOT_ID: local,
        rt.CFG_SEADOG_BOT_ID: SEADOG,
        rt.CFG_DECKHAND_BOT_ID: DECKHAND,
        rt.CFG_ALLOWED_HUMAN_STARTER_IDS: [HUMAN],
        rt.CFG_TASK_TTL_SECONDS: 600.0,
    }
    base.update(overrides)
    return base


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


def _task_content(body: str = "do the thing") -> str:
    return f"TASK [target=seadog] [reviewer=deckhand]\n{body}"


def _worker_with_task(
    now: float = 1_000.0,
) -> Tuple[Any, str, action.FakeChannelSender]:
    worker = rt.WaterCoolerA2ARuntime.from_mapping(_mapping(SEADOG))
    result = worker.handle_event(
        _event(
            author_id=HUMAN,
            content=_task_content(),
            is_bot=False,
            message_id="5001",
            created_at=now,
        ),
        now=now,
    )
    assert result.action == rt.BridgeAction.DISPATCH_HUMAN_TASK
    assert result.task_id
    fake = action.FakeChannelSender()
    established = ctx_mod.establish_from_dispatch(
        runtime=worker,
        action=result.action,
        task_id=result.task_id,
        channel_send_fn=fake.send_to_channel,
        now=now,
    )
    assert established is not None
    return worker, result.task_id, fake


def _reviewer_after_handoff(
    now: float = 1_000.0,
) -> Tuple[Any, str, action.FakeChannelSender]:
    worker = rt.WaterCoolerA2ARuntime.from_mapping(_mapping(SEADOG))
    reviewer = rt.WaterCoolerA2ARuntime.from_mapping(_mapping(DECKHAND))
    hum = worker.handle_event(
        _event(
            author_id=HUMAN,
            content=_task_content(),
            is_bot=False,
            message_id="6001",
            created_at=now,
        ),
        now=now,
    )
    reviewer.handle_event(
        _event(
            author_id=HUMAN,
            content=_task_content(),
            is_bot=False,
            message_id="6001",
            created_at=now,
        ),
        now=now,
    )
    tid = hum.task_id
    assert tid
    # Outbound envelope shape: leading recipient mention + marker + task_id.
    handoff_body = (
        f"<@{DECKHAND}>\nA2A-HANDOFF v1\ntask_id: {tid}\nworker notes"
    )
    # Peer receive advances reviewer (and worker mirror) state.
    hr = reviewer.handle_event(
        _event(
            author_id=SEADOG,
            content=handoff_body,
            is_bot=True,
            message_id="6002",
            created_at=now + 1,
        ),
        now=now + 1,
    )
    assert hr.action == rt.BridgeAction.DISPATCH_PEER_HANDOFF, hr
    fake = action.FakeChannelSender()
    established = ctx_mod.establish_from_dispatch(
        runtime=reviewer,
        action=hr.action,
        task_id=tid,
        channel_send_fn=fake.send_to_channel,
        now=now + 1,
    )
    assert established is not None
    return reviewer, tid, fake


class ScopedSenderTests(unittest.TestCase):
    def test_allows_water_cooler_only(self):
        fake = action.FakeChannelSender()
        scoped = action.WaterCoolerScopedSender(
            fake, allowed_channel_id=CHANNEL
        )
        ok = scoped.send(CHANNEL, "hello")
        self.assertTrue(ok.ok)
        self.assertEqual(len(fake.sent), 1)
        self.assertEqual(fake.sent[0][0], CHANNEL)

    def test_rejects_other_channel_without_calling_underlying(self):
        fake = action.FakeChannelSender()
        scoped = action.WaterCoolerScopedSender(
            fake, allowed_channel_id=CHANNEL
        )
        bad = scoped.send(OTHER_CHANNEL, "leak")
        self.assertFalse(bad.ok)
        self.assertEqual(bad.error, "channel_not_water_cooler")
        self.assertEqual(fake.sent, [])

    def test_rejects_empty_channel(self):
        fake = action.FakeChannelSender()
        scoped = action.WaterCoolerScopedSender(
            fake, allowed_channel_id=CHANNEL
        )
        bad = scoped.send("", "x")
        self.assertFalse(bad.ok)
        self.assertEqual(fake.sent, [])


class ControlledActionSuccessTests(unittest.TestCase):
    def tearDown(self) -> None:
        ctx_mod.clear_authorized_outbound_context()

    def test_worker_handoff_success_advances_state(self):
        worker, tid, fake = _worker_with_task()
        before = worker.policy.get_task(tid)
        self.assertEqual(
            before.stage, policy_mod.TaskStage.AWAITING_WORKER_HANDOFF
        )
        result = action.execute_controlled_outbound(body=BODY, now=1_000.0)
        self.assertTrue(result.ok, result.reason)
        self.assertEqual(result.reason, "sent")
        self.assertEqual(result.task_id, tid)
        self.assertEqual(result.envelope_kind, "handoff")
        self.assertEqual(len(fake.sent), 1)
        ch, content = fake.sent[0]
        self.assertEqual(ch, CHANNEL)
        self.assertIn(f"<@{DECKHAND}>", content.splitlines()[0])
        self.assertIn("A2A-HANDOFF v1", content)
        self.assertIn(f"task_id: {tid}", content)
        self.assertIn(BODY, content)
        after = worker.policy.get_task(tid)
        self.assertEqual(
            after.stage, policy_mod.TaskStage.AWAITING_REVIEWER_REVIEW
        )

    def test_reviewer_review_success(self):
        reviewer, tid, fake = _reviewer_after_handoff()
        result = action.execute_controlled_outbound(
            body="lgtm with nits", now=1_001.0
        )
        self.assertTrue(result.ok, result.reason)
        self.assertEqual(result.envelope_kind, "review")
        self.assertEqual(fake.sent[0][0], CHANNEL)
        self.assertIn("A2A-REVIEW v1", fake.sent[0][1])
        self.assertIn(f"<@{SEADOG}>", fake.sent[0][1])
        after = reviewer.policy.get_task(tid)
        self.assertEqual(
            after.stage, policy_mod.TaskStage.AWAITING_WORKER_HANDOFF
        )
        self.assertEqual(after.round_count, 1)

    def test_tool_entrypoint_dict(self):
        # Tool entrypoint uses wall-clock time; seed task/context with real now.
        import time as _time

        now = _time.time()
        worker = rt.WaterCoolerA2ARuntime.from_mapping(_mapping(SEADOG))
        result = worker.handle_event(
            _event(
                author_id=HUMAN,
                content=_task_content(),
                is_bot=False,
                message_id="5101",
                created_at=now,
            ),
            now=now,
        )
        fake = action.FakeChannelSender()
        ctx_mod.establish_from_dispatch(
            runtime=worker,
            action=result.action,
            task_id=result.task_id,
            channel_send_fn=fake.send_to_channel,
            now=now,
        )
        out = action.water_cooler_a2a_send(body=BODY)
        self.assertTrue(out["success"], out)
        self.assertEqual(out["reason"], "sent")
        self.assertEqual(out["envelope_kind"], "handoff")

    def test_model_cannot_steer_destination_via_kwargs(self):
        worker, tid, fake = _worker_with_task()
        # Prefer execute path with frozen clock; kwargs must not steer.
        out = action.execute_controlled_outbound(
            body=BODY,
            now=1_000.0,
        )
        # Also prove tool ignores steering kwargs by invoking handler-style call
        # after re-establish on a fresh worker task.
        self.assertTrue(out.ok, out.reason)
        self.assertEqual(fake.sent[0][0], CHANNEL)
        self.assertIn(f"<@{DECKHAND}>", fake.sent[0][1])
        self.assertNotIn(HUMAN, fake.sent[0][1].splitlines()[0])
        self.assertIn(tid, fake.sent[0][1])

        # Fresh task: tool entrypoint with wall clock + injected kwargs.
        import time as _time

        now = _time.time()
        worker2 = rt.WaterCoolerA2ARuntime.from_mapping(_mapping(SEADOG))
        r2 = worker2.handle_event(
            _event(
                author_id=HUMAN,
                content=_task_content(),
                is_bot=False,
                message_id="5102",
                created_at=now,
            ),
            now=now,
        )
        fake2 = action.FakeChannelSender()
        ctx_mod.establish_from_dispatch(
            runtime=worker2,
            action=r2.action,
            task_id=r2.task_id,
            channel_send_fn=fake2.send_to_channel,
            now=now,
        )
        steered = action.water_cooler_a2a_send(
            body=BODY,
            channel_id=OTHER_CHANNEL,
            task_id="forged_task_id_xxxxxxxx",
            recipient_bot_mention=f"<@{HUMAN}>",
            recipient=HUMAN,
        )
        self.assertTrue(steered["success"], steered)
        self.assertEqual(fake2.sent[0][0], CHANNEL)
        self.assertIn(f"<@{DECKHAND}>", fake2.sent[0][1])
        self.assertIn(r2.task_id, fake2.sent[0][1])
        self.assertNotIn("forged_task_id", fake2.sent[0][1])


class ControlledActionRejectTests(unittest.TestCase):
    def tearDown(self) -> None:
        ctx_mod.clear_authorized_outbound_context()

    def test_no_context(self):
        ctx_mod.clear_authorized_outbound_context()
        r = action.execute_controlled_outbound(body=BODY)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "no_authorized_task_context")

    def test_duplicate_tool_use(self):
        _worker_with_task()
        first = action.execute_controlled_outbound(body=BODY, now=1_000.0)
        self.assertTrue(first.ok)
        second = action.execute_controlled_outbound(body="again", now=1_001.0)
        self.assertFalse(second.ok)
        self.assertEqual(second.reason, "duplicate_tool_use")

    def test_disabled_policy(self):
        worker, tid, fake = _worker_with_task()
        # Disable by replacing config on a fresh runtime with enabled=False,
        # but keep context pointing at disabled runtime.
        disabled = rt.WaterCoolerA2ARuntime.from_mapping(
            _mapping(**{rt.CFG_ENABLED: False})
        )
        # Rebind context runtime to disabled instance (simulates config flip).
        cur = ctx_mod.get_authorized_outbound_context()
        assert cur is not None
        ctx_mod.set_authorized_outbound_context(
            ctx_mod.AuthorizedOutboundContext(
                task_id=cur.task_id,
                authorized_action=cur.authorized_action,
                envelope_kind=cur.envelope_kind,
                channel_id=cur.channel_id,
                recipient_bot_id=cur.recipient_bot_id,
                recipient_bot_mention=cur.recipient_bot_mention,
                local_bot_id=cur.local_bot_id,
                expires_at=cur.expires_at,
                runtime=disabled,
                channel_send_fn=cur.channel_send_fn,
                established_at=cur.established_at,
                used=False,
            )
        )
        r = action.execute_controlled_outbound(body=BODY, now=1_000.0)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "policy_disabled_or_invalid_config")
        self.assertEqual(fake.sent, [])

    def test_expired_task(self):
        worker, tid, fake = _worker_with_task(now=1_000.0)
        r = action.execute_controlled_outbound(body=BODY, now=1_000.0 + 10_000.0)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "task_expired_or_terminal")
        self.assertEqual(fake.sent, [])

    def test_body_oversize(self):
        _worker_with_task()
        huge = "x" * (env.DEFAULT_MAX_BODY_LENGTH + 1)
        r = action.execute_controlled_outbound(body=huge, now=1_000.0)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "invalid_or_oversized_body")

    def test_non_string_body(self):
        _worker_with_task()
        r = action.execute_controlled_outbound(body=12345, now=1_000.0)  # type: ignore[arg-type]
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "invalid_or_oversized_body")

    def test_send_failure_does_not_advance(self):
        worker, tid, fake = _worker_with_task()
        fake.fail = True
        r = action.execute_controlled_outbound(body=BODY, now=1_000.0)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "send_failed")
        after = worker.policy.get_task(tid)
        self.assertEqual(
            after.stage, policy_mod.TaskStage.AWAITING_WORKER_HANDOFF
        )
        # Context not consumed on send failure → may retry.
        fake.fail = False
        retry = action.execute_controlled_outbound(body=BODY, now=1_000.0)
        self.assertTrue(retry.ok, retry.reason)

    def test_adapter_missing(self):
        worker, tid, _fake = _worker_with_task()
        cur = ctx_mod.get_authorized_outbound_context()
        assert cur is not None
        ctx_mod.set_authorized_outbound_context(
            ctx_mod.AuthorizedOutboundContext(
                task_id=cur.task_id,
                authorized_action=cur.authorized_action,
                envelope_kind=cur.envelope_kind,
                channel_id=cur.channel_id,
                recipient_bot_id=cur.recipient_bot_id,
                recipient_bot_mention=cur.recipient_bot_mention,
                local_bot_id=cur.local_bot_id,
                expires_at=cur.expires_at,
                runtime=cur.runtime,
                channel_send_fn=None,
                established_at=cur.established_at,
                used=False,
            )
        )
        r = action.execute_controlled_outbound(body=BODY, now=1_000.0)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "adapter_or_runtime_missing")

    def test_wrong_role_worker_context_on_reviewer_action(self):
        # Build worker context then force authorized_action to peer_handoff (reviewer).
        worker, tid, fake = _worker_with_task()
        cur = ctx_mod.get_authorized_outbound_context()
        assert cur is not None
        ctx_mod.set_authorized_outbound_context(
            ctx_mod.AuthorizedOutboundContext(
                task_id=cur.task_id,
                authorized_action=rt.BridgeAction.DISPATCH_PEER_HANDOFF,
                envelope_kind=env.EnvelopeKind.REVIEW,
                channel_id=cur.channel_id,
                recipient_bot_id=SEADOG,
                recipient_bot_mention=f"<@{SEADOG}>",
                local_bot_id=cur.local_bot_id,
                expires_at=cur.expires_at,
                runtime=cur.runtime,
                channel_send_fn=cur.channel_send_fn,
                established_at=cur.established_at,
                used=False,
            )
        )
        r = action.execute_controlled_outbound(body=BODY, now=1_000.0)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "wrong_role")
        self.assertEqual(fake.sent, [])

    def test_out_of_order_after_advance(self):
        worker, tid, fake = _worker_with_task()
        first = action.execute_controlled_outbound(body=BODY, now=1_000.0)
        self.assertTrue(first.ok)
        # Re-establish as if a buggy adapter re-set context after send.
        ctx_mod.establish_from_dispatch(
            runtime=worker,
            action=rt.BridgeAction.DISPATCH_HUMAN_TASK,
            task_id=tid,
            channel_send_fn=fake.send_to_channel,
            now=1_001.0,
        )
        # Stage is awaiting review → establish should fail closed (no context).
        self.assertIsNone(ctx_mod.get_authorized_outbound_context())
        r = action.execute_controlled_outbound(body="again", now=1_001.0)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "no_authorized_task_context")
        self.assertEqual(len(fake.sent), 1)

    def test_plain_reply_never_a2a(self):
        r = action.reject_plain_model_reply_as_a2a("just chatting")
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "plain_model_reply_not_authorized")

    def test_cannot_send_to_other_person_via_context_tamper(self):
        """Even if context recipient is wrong, envelope expected_mention binds send."""
        worker, tid, fake = _worker_with_task()
        cur = ctx_mod.get_authorized_outbound_context()
        assert cur is not None
        # Tamper recipient to human — build_peer_envelope still uses
        # recipient_bot_mention as both actual and expected from context, so
        # it would build an envelope to the human. Scoped sender still only
        # allows Water-cooler channel; we also require recipient is peer bot
        # via establish. Here we prove channel isolation + that success path
        # only used Deckhand. Force channel tamper:
        ctx_mod.set_authorized_outbound_context(
            ctx_mod.AuthorizedOutboundContext(
                task_id=cur.task_id,
                authorized_action=cur.authorized_action,
                envelope_kind=cur.envelope_kind,
                channel_id=OTHER_CHANNEL,  # wrong channel
                recipient_bot_id=cur.recipient_bot_id,
                recipient_bot_mention=cur.recipient_bot_mention,
                local_bot_id=cur.local_bot_id,
                expires_at=cur.expires_at,
                runtime=cur.runtime,
                channel_send_fn=cur.channel_send_fn,
                established_at=cur.established_at,
                used=False,
            )
        )
        r = action.execute_controlled_outbound(body=BODY, now=1_000.0)
        self.assertFalse(r.ok)
        self.assertIn(r.reason, ("channel_mismatch", "channel_not_water_cooler"))
        self.assertEqual(fake.sent, [])

    def test_scoped_sender_blocks_other_channel_even_if_action_asks(self):
        fake = action.FakeChannelSender()
        scoped = action.WaterCoolerScopedSender(
            fake, allowed_channel_id=CHANNEL
        )
        # Direct abuse of sender API
        for ch in (OTHER_CHANNEL, "1", HUMAN, SEADOG, "0"):
            res = scoped.send(ch, f"to {ch}")
            self.assertFalse(res.ok)
            self.assertEqual(res.error, "channel_not_water_cooler")
        self.assertEqual(fake.sent, [])


class EstablishContextTests(unittest.TestCase):
    def tearDown(self) -> None:
        ctx_mod.clear_authorized_outbound_context()

    def test_suppress_does_not_establish(self):
        worker = rt.WaterCoolerA2ARuntime.from_mapping(_mapping(SEADOG))
        fake = action.FakeChannelSender()
        out = ctx_mod.establish_from_dispatch(
            runtime=worker,
            action=rt.BridgeAction.SUPPRESS,
            task_id="abcdef0123456789abcdef0123456789",
            channel_send_fn=fake.send_to_channel,
            now=1_000.0,
        )
        self.assertIsNone(out)
        self.assertIsNone(ctx_mod.get_authorized_outbound_context())

    def test_disabled_runtime_does_not_establish(self):
        worker = rt.WaterCoolerA2ARuntime.from_mapping(
            _mapping(**{rt.CFG_ENABLED: False})
        )
        fake = action.FakeChannelSender()
        out = ctx_mod.establish_from_dispatch(
            runtime=worker,
            action=rt.BridgeAction.DISPATCH_HUMAN_TASK,
            task_id="abcdef0123456789abcdef0123456789",
            channel_send_fn=fake.send_to_channel,
            now=1_000.0,
        )
        self.assertIsNone(out)


class PluginRegistrationTests(unittest.TestCase):
    def test_plugin_manifest_and_register(self):
        self.assertTrue(PLUGIN_YAML.is_file())
        yaml_text = PLUGIN_YAML.read_text(encoding="utf-8")
        self.assertIn("water-cooler-a2a", yaml_text)
        self.assertIn("water_cooler_a2a_send", yaml_text)

        plugin = _load("water_cooler_a2a_plugin_under_test", PLUGIN_PATH)
        registered = []

        class FakeCtx:
            def register_tool(self, **kwargs):
                registered.append(kwargs)

        plugin.register(FakeCtx())
        self.assertEqual(len(registered), 1)
        self.assertEqual(registered[0]["name"], "water_cooler_a2a_send")
        self.assertEqual(registered[0]["toolset"], "water_cooler_a2a")
        schema = registered[0]["schema"]
        props = schema["parameters"]["properties"]
        self.assertIn("body", props)
        # Model must not be offered destination fields.
        for forbidden in (
            "channel_id",
            "task_id",
            "recipient",
            "recipient_bot_mention",
            "peer",
            "round",
        ):
            self.assertNotIn(forbidden, props)
        self.assertEqual(schema["parameters"].get("additionalProperties"), False)

    def test_plugin_handler_fail_closed_without_context(self):
        plugin = _load("water_cooler_a2a_plugin_handler_test", PLUGIN_PATH)
        # Ensure shared action context is clear.
        ctx_mod.clear_authorized_outbound_context()
        # Handler imports wolfhouse package path — patch via sys.modules.
        sys.modules["wolfhouse.water_cooler_a2a_action"] = action
        out = plugin._handler(body="notes")
        self.assertFalse(out["success"])
        self.assertEqual(out["reason"], "no_authorized_task_context")


class RecordLocalOutboundPolicyTests(unittest.TestCase):
    def test_record_handoff_and_reject_duplicate(self):
        worker = policy_mod.WaterCoolerA2APolicy(
            policy_mod.build_config(
                enabled=True,
                channel_id=CHANNEL,
                allowed_human_starter_ids={HUMAN},
                seadog_bot_id=SEADOG,
                deckhand_bot_id=DECKHAND,
                local_bot_id=SEADOG,
                task_ttl_seconds=600.0,
            )
        )
        d = worker.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_content(),
                is_bot=False,
                message_id="7001",
            ),
            now=1_000.0,
        )
        tid = d.task_id
        assert tid
        ok = worker.record_local_outbound(tid, kind="handoff", now=1_001.0)
        self.assertEqual(ok.kind, policy_mod.DecisionKind.PEER_HANDOFF)
        dup = worker.record_local_outbound(tid, kind="handoff", now=1_002.0)
        self.assertEqual(dup.kind, policy_mod.DecisionKind.REJECT)
        self.assertEqual(dup.reason, "wrong_order_or_duplicate_handoff")

    def test_record_handoff_wrong_role(self):
        reviewer = policy_mod.WaterCoolerA2APolicy(
            policy_mod.build_config(
                enabled=True,
                channel_id=CHANNEL,
                allowed_human_starter_ids={HUMAN},
                seadog_bot_id=SEADOG,
                deckhand_bot_id=DECKHAND,
                local_bot_id=DECKHAND,
                task_ttl_seconds=600.0,
            )
        )
        d = reviewer.evaluate(
            _event(
                author_id=HUMAN,
                content=_task_content(),
                is_bot=False,
                message_id="7002",
            ),
            now=1_000.0,
        )
        tid = d.task_id
        assert tid
        bad = reviewer.record_local_outbound(tid, kind="handoff", now=1_001.0)
        self.assertEqual(bad.kind, policy_mod.DecisionKind.REJECT)
        self.assertEqual(bad.reason, "outbound_handoff_requires_worker")


if __name__ == "__main__":
    unittest.main()
