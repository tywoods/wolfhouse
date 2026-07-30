#!/usr/bin/env python3
"""High-fidelity tests for gated Water-cooler A2A activation (stdlib only).

Proves: disabled → byte-for-byte unchanged adapter and no tool; enabled target
roles → patched + plugin tool; excluded roles unchanged; valid human/peer
route; wrong bot/channel/plain chat suppressed pre-model; replay/terminal;
tool-controlled send only; missing ID config blocks start.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Optional

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
FIXTURE = ROOT / "fixtures" / "water_cooler_a2a" / "discord_adapter_admission_shape.py"
PATCHER_PATH = STAGING / "apply_water_cooler_a2a_adapter_patch.py"
PLUGIN_SRC = STAGING / "plugins" / "water_cooler_a2a"
BOOTSTRAP = STAGING / "bootstrap.sh"
OVERLAY = STAGING / "99z-wh-vm-post-bootstrap.sh"
DOCKERFILE = STAGING / "Dockerfile"
LUNA_SOUL = STAGING / "SOUL.md"
ORCH_SOUL = STAGING / "orchestrator-SOUL.md"
DECKHAND_SOUL = STAGING / "deckhand-SOUL.md"
SEADOG_SOUL = STAGING / "seadog-SOUL.md"

PARENT = "1530209175861199019"
THREAD = "1532167084618944734"
CHANNEL = THREAD  # exact message channel = Navigation thread
HUMAN = "100000000000000001"
SEADOG = "200000000000000001"
DECKHAND = "300000000000000001"
OTHER_CHANNEL = "1530209175861199000"
OTHER_THREAD = "1532167084618944000"
UNKNOWN_BOT = "400000000000000001"
SECRET = "SECRET_TASK_BODY_activation_zz9"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = mod
    # Package-style names for relative imports inside modules.
    if name.endswith("policy"):
        sys.modules["water_cooler_a2a_policy"] = mod
    if name.endswith("runtime"):
        sys.modules["water_cooler_a2a_runtime"] = mod
    if name.endswith("envelope"):
        sys.modules["water_cooler_a2a_envelope"] = mod
    if name.endswith("action_context"):
        sys.modules["water_cooler_a2a_action_context"] = mod
    if name.endswith("action") and "context" not in name:
        sys.modules["water_cooler_a2a_action"] = mod
    if name.endswith("activation"):
        sys.modules["water_cooler_a2a_activation"] = mod
    if name.endswith("hooks"):
        sys.modules["water_cooler_a2a_adapter_hooks"] = mod
    spec.loader.exec_module(mod)
    return mod


# Load dependency chain once for hook/runtime tests.
policy = _load("wc_a2a_policy_act", ROOT / "water_cooler_a2a_policy.py")
sys.modules["water_cooler_a2a_policy"] = policy
runtime = _load("wc_a2a_runtime_act", ROOT / "water_cooler_a2a_runtime.py")
sys.modules["water_cooler_a2a_runtime"] = runtime
envelope = _load("wc_a2a_envelope_act", ROOT / "water_cooler_a2a_envelope.py")
sys.modules["water_cooler_a2a_envelope"] = envelope
actx = _load("wc_a2a_actx_act", ROOT / "water_cooler_a2a_action_context.py")
sys.modules["water_cooler_a2a_action_context"] = actx
action = _load("wc_a2a_action_act", ROOT / "water_cooler_a2a_action.py")
sys.modules["water_cooler_a2a_action"] = action
activation = _load("wc_a2a_activation_act", ROOT / "water_cooler_a2a_activation.py")
sys.modules["water_cooler_a2a_activation"] = activation
# Hooks import activation + runtime by relative or flat name.
hooks = _load("wc_a2a_hooks_act", ROOT / "water_cooler_a2a_adapter_hooks.py")
patcher = _load("wc_a2a_patcher_act", PATCHER_PATH)


def _valid_env(role: str = "seadog", **overrides: str) -> Dict[str, str]:
    local = SEADOG if role == "seadog" else DECKHAND
    base = {
        "HERMES_ROLE": role,
        activation.CFG_ENABLED: "true",
        activation.CFG_PARENT_CHANNEL_ID: PARENT,
        activation.CFG_THREAD_ID: THREAD,
        activation.CFG_CHANNEL_ID: THREAD,
        activation.CFG_LOCAL_BOT_ID: local,
        activation.CFG_SEADOG_BOT_ID: SEADOG,
        activation.CFG_DECKHAND_BOT_ID: DECKHAND,
        activation.CFG_ALLOWED_HUMAN_STARTER_IDS: HUMAN,
        activation.CFG_TASK_TTL_SECONDS: "600",
    }
    base.update(overrides)
    return base


def _raw_message(
    *,
    author_id: str,
    content: str,
    is_bot: bool,
    message_id: str,
    channel_id: str = CHANNEL,
    parent_id: Optional[str] = PARENT,
    created_at: float = 1_000.0,
):
    return SimpleNamespace(
        id=message_id,
        content=content,
        created_at=created_at,
        author=SimpleNamespace(id=author_id, bot=is_bot),
        channel=SimpleNamespace(id=channel_id, parent_id=parent_id),
    )


class GateAndValidationTests(unittest.TestCase):
    def test_disabled_by_default(self):
        self.assertFalse(activation.should_activate_a2a(role="seadog", enabled_value=""))
        self.assertFalse(activation.should_activate_a2a(role="seadog", enabled_value=None))
        self.assertFalse(activation.should_activate_a2a(role="seadog", enabled_value="false"))
        self.assertFalse(activation.should_activate_a2a(role="seadog", enabled_value="TRUE"))
        self.assertFalse(activation.should_activate_a2a(role="seadog", enabled_value="1"))
        self.assertFalse(activation.should_activate_a2a(role="seadog", enabled_value="yes"))

    def test_excluded_roles_never_activate(self):
        for role in ("luna", "sunset-luna", "orchestrator", "skipper", "unknown", ""):
            self.assertFalse(
                activation.should_activate_a2a(role=role, enabled_value="true"),
                msg=role,
            )

    def test_target_roles_require_exact_true(self):
        self.assertTrue(activation.should_activate_a2a(role="seadog", enabled_value="true"))
        self.assertTrue(activation.should_activate_a2a(role="deckhand", enabled_value="true"))
        self.assertTrue(activation.should_activate_a2a(role="SEADOG", enabled_value="true"))

    def test_missing_ids_block_validation(self):
        with self.assertRaises(activation.ActivationError):
            activation.validate_activation_ids(
                role="seadog",
                mapping={activation.CFG_ENABLED: "true"},
            )
        for key in (
            activation.CFG_PARENT_CHANNEL_ID,
            activation.CFG_THREAD_ID,
        ):
            env = _valid_env()
            del env[key]
            with self.assertRaises(activation.ActivationError) as cm:
                activation.validate_activation_ids(role="seadog", mapping=env)
            self.assertIn("missing", str(cm.exception), msg=key)

    def test_malformed_ids_block_validation(self):
        env = _valid_env(**{activation.CFG_THREAD_ID: "not-a-snowflake"})
        with self.assertRaises(activation.ActivationError):
            activation.validate_activation_ids(role="seadog", mapping=env)
        env = _valid_env(**{activation.CFG_PARENT_CHANNEL_ID: "not-a-snowflake"})
        with self.assertRaises(activation.ActivationError):
            activation.validate_activation_ids(role="seadog", mapping=env)

    def test_legacy_channel_must_match_thread(self):
        env = _valid_env(**{activation.CFG_CHANNEL_ID: PARENT})
        with self.assertRaises(activation.ActivationError) as cm:
            activation.validate_activation_ids(role="seadog", mapping=env)
        self.assertIn("match_thread", str(cm.exception))

    def test_local_bot_must_match_role(self):
        env = _valid_env(role="seadog", **{activation.CFG_LOCAL_BOT_ID: DECKHAND})
        with self.assertRaises(activation.ActivationError):
            activation.validate_activation_ids(role="seadog", mapping=env)

    def test_valid_ids_ok(self):
        v = activation.validate_activation_ids(role="seadog", mapping=_valid_env())
        self.assertEqual(v[activation.CFG_LOCAL_BOT_ID], SEADOG)
        lines = activation.emit_a2a_env_lines(v)
        self.assertIn("DISCORD_ALLOW_BOTS=mentions", lines)
        self.assertNotIn("DISCORD_ALLOWED_USERS", lines)


class BootstrapSideEffectTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.td = Path(self._tmpdir.name)
        self.home = self.td / "home"
        self.home.mkdir()
        (self.home / "config.yaml").write_text(
            "model:\n  default: grok-4.5\n  provider: xai\n",
            encoding="utf-8",
        )
        self.staging = self.td / "staging"
        self.staging.mkdir()
        (self.staging / "plugins").mkdir()
        shutil.copytree(PLUGIN_SRC, self.staging / "plugins" / "water_cooler_a2a")
        shutil.copy(PATCHER_PATH, self.staging / "apply_water_cooler_a2a_adapter_patch.py")
        self.adapter = self.td / "adapter.py"
        self.adapter.write_text(FIXTURE.read_text(encoding="utf-8"), encoding="utf-8")
        self.adapter_bytes = self.adapter.read_bytes()

    def tearDown(self):
        self._tmpdir.cleanup()

    def test_disabled_byte_for_byte_adapter_no_plugin(self):
        meta = activation.run_bootstrap_activation(
            role="seadog",
            env={"HERMES_ROLE": "seadog", activation.CFG_ENABLED: "false"},
            hermes_home=self.home,
            staging_root=self.staging,
            adapter_path=self.adapter,
        )
        self.assertFalse(meta["activated"])
        self.assertEqual(self.adapter.read_bytes(), self.adapter_bytes)
        self.assertFalse((self.home / "plugins" / "water_cooler_a2a").exists())
        cfg = (self.home / "config.yaml").read_text(encoding="utf-8")
        self.assertNotIn("water_cooler_a2a", cfg)
        self.assertNotIn("water-cooler-a2a", cfg)

    def test_excluded_role_luna_unchanged_even_if_enabled_true(self):
        meta = activation.run_bootstrap_activation(
            role="luna",
            env=_valid_env(role="luna"),
            hermes_home=self.home,
            staging_root=self.staging,
            adapter_path=self.adapter,
        )
        self.assertFalse(meta["activated"])
        self.assertEqual(self.adapter.read_bytes(), self.adapter_bytes)
        self.assertFalse((self.home / "plugins" / "water_cooler_a2a").exists())

    def test_excluded_roles_matrix(self):
        for role in ("luna", "sunset-luna", "orchestrator", "unknown"):
            self.adapter.write_bytes(self.adapter_bytes)
            meta = activation.run_bootstrap_activation(
                role=role,
                env=_valid_env(role=role if role in ("seadog", "deckhand") else "luna")
                | {"HERMES_ROLE": role, activation.CFG_ENABLED: "true"},
                hermes_home=self.home,
                staging_root=self.staging,
                adapter_path=self.adapter,
            )
            self.assertFalse(meta["activated"], msg=role)
            self.assertEqual(self.adapter.read_bytes(), self.adapter_bytes, msg=role)

    def test_enabled_seadog_patches_and_installs_plugin(self):
        meta = activation.run_bootstrap_activation(
            role="seadog",
            env=_valid_env("seadog"),
            hermes_home=self.home,
            staging_root=self.staging,
            adapter_path=self.adapter,
            write_env_file=True,
        )
        self.assertTrue(meta["activated"])
        self.assertTrue(meta["plugin_installed"])
        self.assertTrue(meta["config_merged"])
        self.assertNotEqual(self.adapter.read_bytes(), self.adapter_bytes)
        patcher.validate_patched_source(self.adapter.read_text(encoding="utf-8"))
        self.assertTrue((self.home / "plugins" / "water_cooler_a2a" / "plugin.yaml").is_file())
        cfg = (self.home / "config.yaml").read_text(encoding="utf-8")
        self.assertIn("water_cooler_a2a", cfg)
        self.assertIn("water-cooler-a2a", cfg)
        env_txt = (self.home / ".env").read_text(encoding="utf-8")
        self.assertIn("DISCORD_ALLOW_BOTS=mentions", env_txt)
        self.assertIn("WATER_COOLER_A2A_ENABLED=true", env_txt)
        # Idempotent reapply
        again = activation.run_bootstrap_activation(
            role="seadog",
            env=_valid_env("seadog"),
            hermes_home=self.home,
            staging_root=self.staging,
            adapter_path=self.adapter,
        )
        self.assertTrue(again["activated"])
        patcher.validate_patched_source(self.adapter.read_text(encoding="utf-8"))

    def test_enabled_deckhand_same(self):
        meta = activation.run_bootstrap_activation(
            role="deckhand",
            env=_valid_env("deckhand"),
            hermes_home=self.home,
            staging_root=self.staging,
            adapter_path=self.adapter,
        )
        self.assertTrue(meta["activated"])
        self.assertTrue((self.home / "plugins" / "water_cooler_a2a").is_dir())
        patcher.validate_patched_source(self.adapter.read_text(encoding="utf-8"))

    def test_missing_ids_raise_and_do_not_patch(self):
        env = _valid_env("seadog")
        del env[activation.CFG_SEADOG_BOT_ID]
        with self.assertRaises(activation.ActivationError):
            activation.run_bootstrap_activation(
                role="seadog",
                env=env,
                hermes_home=self.home,
                staging_root=self.staging,
                adapter_path=self.adapter,
            )
        self.assertEqual(self.adapter.read_bytes(), self.adapter_bytes)
        self.assertFalse((self.home / "plugins" / "water_cooler_a2a").exists())


class HookRoutingTests(unittest.TestCase):
    def setUp(self):
        hooks._reset_activation_state_for_tests()
        actx.clear_authorized_outbound_context()
        self._env_backup = dict(os.environ)

    def tearDown(self):
        hooks._reset_activation_state_for_tests()
        actx.clear_authorized_outbound_context()
        # Restore env
        for k in list(os.environ.keys()):
            if k.startswith("WATER_COOLER_A2A_") or k == "HERMES_ROLE":
                os.environ.pop(k, None)
        os.environ.clear()
        os.environ.update(self._env_backup)

    def _activate(self, role: str = "seadog"):
        for k, v in _valid_env(role).items():
            os.environ[k] = v
        hooks._reset_activation_state_for_tests()
        self.assertTrue(hooks.is_a2a_adapter_hooks_active())

    def test_hooks_inactive_without_env(self):
        os.environ.pop("WATER_COOLER_A2A_ENABLED", None)
        os.environ["HERMES_ROLE"] = "seadog"
        hooks._reset_activation_state_for_tests()
        self.assertFalse(hooks.is_a2a_adapter_hooks_active())
        self.assertFalse(
            hooks.a2a_allow_mention_bypass(
                channel_id=CHANNEL,
                parent_channel_id=PARENT,
                content="TASK [target=seadog] [reviewer=deckhand]\nbody",
                author_is_bot=False,
            )
        )
        self.assertFalse(hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=None))

    def test_valid_human_task_worker_dispatches_reviewer_suppresses(self):
        # Worker
        self._activate("seadog")
        msg = _raw_message(
            author_id=HUMAN,
            content=f"TASK [target=seadog] [reviewer=deckhand]\n{SECRET}",
            is_bot=False,
            message_id="91001",
        )
        # Mention bypass requires Navigation thread + Water-cooler parent
        self.assertTrue(
            hooks.a2a_allow_mention_bypass(
                channel_id=CHANNEL,
                parent_channel_id=PARENT,
                content=msg.content,
                author_is_bot=False,
            )
        )
        # Pre-dispatch: False means allow model (dispatch)
        intercepted = hooks.a2a_pre_dispatch_intercept(
            SimpleNamespace(raw_message=msg),
            adapter=None,
            message=msg,
        )
        self.assertFalse(intercepted)
        ctx = actx.get_authorized_outbound_context()
        self.assertIsNotNone(ctx)
        self.assertEqual(ctx.task_id, policy.derive_task_id(CHANNEL, "91001"))
        self.assertNotIn(SECRET, repr(ctx))

        # Reviewer instance
        hooks._reset_activation_state_for_tests()
        actx.clear_authorized_outbound_context()
        self._activate("deckhand")
        msg2 = _raw_message(
            author_id=HUMAN,
            content=f"TASK [target=seadog] [reviewer=deckhand]\n{SECRET}",
            is_bot=False,
            message_id="91001",
        )
        intercepted_r = hooks.a2a_pre_dispatch_intercept(
            SimpleNamespace(),
            adapter=None,
            message=msg2,
        )
        self.assertTrue(intercepted_r)  # mirrored non-dispatch → suppress
        self.assertIsNone(actx.get_authorized_outbound_context())

    def test_wrong_channel_passthrough_not_suppress(self):
        self._activate("seadog")
        msg = _raw_message(
            author_id=HUMAN,
            content=f"TASK [target=seadog] [reviewer=deckhand]\n{SECRET}",
            is_bot=False,
            message_id="91002",
            channel_id=OTHER_CHANNEL,
            parent_id=None,
        )
        # Wrong channel: no mention bypass, no intercept
        self.assertFalse(
            hooks.a2a_allow_mention_bypass(
                channel_id=OTHER_CHANNEL,
                parent_channel_id=PARENT,
                content=msg.content,
                author_is_bot=False,
            )
        )
        self.assertFalse(
            hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=msg)
        )

    def test_direct_parent_channel_rejected_no_bypass(self):
        self._activate("seadog")
        msg = _raw_message(
            author_id=HUMAN,
            content=f"TASK [target=seadog] [reviewer=deckhand]\n{SECRET}",
            is_bot=False,
            message_id="91012",
            channel_id=PARENT,
            parent_id=None,
        )
        self.assertFalse(
            hooks.a2a_allow_mention_bypass(
                channel_id=PARENT,
                parent_channel_id="",
                content=msg.content,
                author_is_bot=False,
            )
        )
        # Parent channel is not Navigation thread → wrong_channel passthrough
        self.assertFalse(
            hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=msg)
        )

    def test_other_thread_under_parent_rejected(self):
        self._activate("seadog")
        msg = _raw_message(
            author_id=HUMAN,
            content=f"TASK [target=seadog] [reviewer=deckhand]\n{SECRET}",
            is_bot=False,
            message_id="91013",
            channel_id=OTHER_THREAD,
            parent_id=PARENT,
        )
        self.assertFalse(
            hooks.a2a_allow_mention_bypass(
                channel_id=OTHER_THREAD,
                parent_channel_id=PARENT,
                content=msg.content,
                author_is_bot=False,
            )
        )
        self.assertFalse(
            hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=msg)
        )

    def test_navigation_wrong_parent_suppressed(self):
        self._activate("seadog")
        msg = _raw_message(
            author_id=HUMAN,
            content=f"TASK [target=seadog] [reviewer=deckhand]\n{SECRET}",
            is_bot=False,
            message_id="91014",
            channel_id=THREAD,
            parent_id=OTHER_CHANNEL,
        )
        self.assertFalse(
            hooks.a2a_allow_mention_bypass(
                channel_id=THREAD,
                parent_channel_id=OTHER_CHANNEL,
                content=msg.content,
                author_is_bot=False,
            )
        )
        # Channel matches Navigation but wrong parent → suppress (not passthrough)
        self.assertTrue(
            hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=msg)
        )

    def test_plain_chat_suppressed_in_navigation_thread(self):
        self._activate("seadog")
        msg = _raw_message(
            author_id=HUMAN,
            content="hey what is for lunch",
            is_bot=False,
            message_id="91003",
        )
        self.assertFalse(
            hooks.a2a_allow_mention_bypass(
                channel_id=CHANNEL,
                parent_channel_id=PARENT,
                content=msg.content,
                author_is_bot=False,
            )
        )
        self.assertTrue(
            hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=msg)
        )

    def test_wrong_bot_suppressed(self):
        self._activate("seadog")
        # Establish a task first so peer path is reachable, then wrong bot.
        hum = _raw_message(
            author_id=HUMAN,
            content=f"TASK [target=seadog] [reviewer=deckhand]\n{SECRET}",
            is_bot=False,
            message_id="91004",
        )
        hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=hum)
        tid = policy.derive_task_id(CHANNEL, "91004")
        bad = _raw_message(
            author_id=UNKNOWN_BOT,
            content=f"A2A-HANDOFF v1\ntask_id: {tid}\nnotes",
            is_bot=True,
            message_id="91005",
        )
        self.assertTrue(
            hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=bad)
        )

    def test_peer_handoff_reaches_reviewer_only(self):
        # Worker establishes task via human TASK
        self._activate("seadog")
        hum = _raw_message(
            author_id=HUMAN,
            content=f"TASK [target=seadog] [reviewer=deckhand]\n{SECRET}",
            is_bot=False,
            message_id="92001",
        )
        hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=hum)
        tid = policy.derive_task_id(CHANNEL, "92001")
        # Controlled send advances worker state
        fake = action.FakeChannelSender()
        # re-establish context with fake sender
        rt = hooks._runtime
        hum_result = rt.handle_event(
            policy.DiscordMessageEvent(
                channel_id=CHANNEL,
                message_id="92001",
                author_id=HUMAN,
                content=f"TASK [target=seadog] [reviewer=deckhand]\n{SECRET}",
                is_bot=False,
                created_at=1_000.0,
                parent_channel_id=PARENT,
            ),
            now=1_000.0,
        )
        # Task already exists from first dispatch — use record via tool path
        # Fresh runtime pair for clean peer test:
        hooks._reset_activation_state_for_tests()
        actx.clear_authorized_outbound_context()
        self._activate("seadog")
        hum2 = _raw_message(
            author_id=HUMAN,
            content=f"TASK [target=seadog] [reviewer=deckhand]\n{SECRET}",
            is_bot=False,
            message_id="92010",
        )
        self.assertFalse(
            hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=hum2)
        )
        tid = actx.get_authorized_outbound_context().task_id
        # Tool-controlled send only
        actx.get_authorized_outbound_context()
        # Bind fake sender by re-establishing
        actx.establish_from_dispatch(
            runtime=hooks._runtime,
            action=runtime.BridgeAction.DISPATCH_HUMAN_TASK,
            task_id=tid,
            channel_send_fn=fake.send_to_channel,
            now=1_000.0,
        )
        sent = action.execute_controlled_outbound(body="handoff notes", now=1_000.0)
        self.assertTrue(sent.ok)
        self.assertEqual(len(fake.sent), 1)
        self.assertIn("A2A-HANDOFF v1", fake.sent[0][1])
        self.assertEqual(fake.sent[0][0], CHANNEL)

        # Mirror handoff on reviewer
        handoff_content = fake.sent[0][1]
        hooks._reset_activation_state_for_tests()
        actx.clear_authorized_outbound_context()
        self._activate("deckhand")
        # Reviewer must first mirror the human TASK
        self.assertTrue(
            hooks.a2a_pre_dispatch_intercept(
                None,
                adapter=None,
                message=_raw_message(
                    author_id=HUMAN,
                    content=f"TASK [target=seadog] [reviewer=deckhand]\n{SECRET}",
                    is_bot=False,
                    message_id="92010",
                ),
            )
        )
        # Peer handoff → dispatch on reviewer
        peer_msg = _raw_message(
            author_id=SEADOG,
            content=handoff_content,
            is_bot=True,
            message_id="92011",
        )
        self.assertFalse(
            hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=peer_msg)
        )
        self.assertIsNotNone(actx.get_authorized_outbound_context())

    def test_replay_fail_closed(self):
        self._activate("seadog")
        hum = _raw_message(
            author_id=HUMAN,
            content=f"TASK [target=seadog] [reviewer=deckhand]\n{SECRET}",
            is_bot=False,
            message_id="93001",
        )
        hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=hum)
        tid = policy.derive_task_id(CHANNEL, "93001")
        # Fresh process (reset runtime) rejects peer
        hooks._reset_activation_state_for_tests()
        self._activate("deckhand")
        peer = _raw_message(
            author_id=SEADOG,
            content=f"A2A-HANDOFF v1\ntask_id: {tid}\nnotes",
            is_bot=True,
            message_id="93002",
        )
        self.assertTrue(
            hooks.a2a_pre_dispatch_intercept(None, adapter=None, message=peer)
        )

    def test_tool_body_only_no_context_fails(self):
        actx.clear_authorized_outbound_context()
        r = action.execute_controlled_outbound(body="x")
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "no_authorized_task_context")


class StaticWiringInvariantTests(unittest.TestCase):
    def test_bootstrap_gate_present(self):
        src = BOOTSTRAP.read_text(encoding="utf-8")
        self.assertIn("maybe_activate_water_cooler_a2a", src)
        self.assertIn('WATER_COOLER_A2A_ENABLED:-}" != "true"', src)
        self.assertIn('HERMES_ROLE" != "seadog"', src)
        self.assertIn('HERMES_ROLE" != "deckhand"', src)
        # Luna plugin install excludes a2a
        self.assertIn('water_cooler_a2a', src)
        self.assertIn("continue", src)
        # The bootstrap itself must not write transport admission from any
        # default role env-writer; the validated activation module owns it.
        self.assertNotIn("printf 'DISCORD_ALLOW_BOTS=mentions", src)

    def test_dockerfile_does_not_apply_a2a_at_build(self):
        src = DOCKERFILE.read_text(encoding="utf-8")
        self.assertIn("apply_water_cooler_a2a_adapter_patch.py", src)
        # Must not RUN the patcher apply at build time
        self.assertNotIn(
            "apply_water_cooler_a2a_adapter_patch.py --apply", src
        )
        self.assertIn("intentionally NOT applied at image", src)

    def test_overlay_plugin_only_when_enabled(self):
        src = OVERLAY.read_text(encoding="utf-8")
        self.assertIn('WATER_COOLER_A2A_ENABLED:-}" = "true"', src)
        self.assertIn("water-cooler-a2a", src)
        self.assertIn("water_cooler_a2a", src)

    def test_souls_scope(self):
        self.assertIn("water_cooler_a2a_send", DECKHAND_SOUL.read_text(encoding="utf-8"))
        self.assertIn("water_cooler_a2a_send", SEADOG_SOUL.read_text(encoding="utf-8"))
        self.assertNotIn(
            "water_cooler_a2a_send", LUNA_SOUL.read_text(encoding="utf-8")
        )
        self.assertNotIn(
            "water_cooler_a2a_send", ORCH_SOUL.read_text(encoding="utf-8")
        )

    def test_patcher_passes_raw_message(self):
        src = PATCHER_PATH.read_text(encoding="utf-8")
        self.assertIn("message=message", src)
        patched, _ = patcher.patch_adapter_source(FIXTURE.read_text(encoding="utf-8"))
        self.assertIn("message=message", patched)
        self.assertIn("_wh_a2a_pd(event, adapter=self, message=message)", patched)

    def test_gateway_still_does_not_import_a2a_patcher(self):
        gw = (STAGING / "apply_gateway_patches.py").read_text(encoding="utf-8")
        self.assertNotIn("apply_water_cooler_a2a_adapter_patch", gw)

    def test_require_mention_default_untouched_in_configs(self):
        # Deckhand/seadog overlay still require_mention: false is their existing
        # Discord profile — A2A must not set free-response or allow_bots in yaml.
        overlay = OVERLAY.read_text(encoding="utf-8")
        self.assertNotIn("DISCORD_ALLOW_BOTS", overlay)
        self.assertNotIn("free_response", overlay)


if __name__ == "__main__":
    unittest.main()
