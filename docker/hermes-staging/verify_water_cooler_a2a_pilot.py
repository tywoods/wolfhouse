#!/usr/bin/env python3
"""Static + light runtime checks for Water-cooler A2A policy + runtime bridge.

Proves the policy/runtime/test files exist and encode fail-closed, channel,
round-limit, local_bot_id, dual-instance mirror, bridge action-contract,
adapter-patch foundation, and controlled envelope-builder concepts. Avoids
brittle whole-file hashes. Does not claim Hermes wiring or deploy activation.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
POLICY = ROOT / "wolfhouse" / "water_cooler_a2a_policy.py"
RUNTIME = ROOT / "wolfhouse" / "water_cooler_a2a_runtime.py"
ENVELOPE = ROOT / "wolfhouse" / "water_cooler_a2a_envelope.py"
HOOKS = ROOT / "wolfhouse" / "water_cooler_a2a_adapter_hooks.py"
ACTION = ROOT / "wolfhouse" / "water_cooler_a2a_action.py"
ACTION_CTX = ROOT / "wolfhouse" / "water_cooler_a2a_action_context.py"
ADAPTER_PATCH = ROOT / "apply_water_cooler_a2a_adapter_patch.py"
TESTS = ROOT / "wolfhouse" / "test_water_cooler_a2a_policy.py"
RUNTIME_TESTS = ROOT / "wolfhouse" / "test_water_cooler_a2a_runtime.py"
ENVELOPE_TESTS = ROOT / "wolfhouse" / "test_water_cooler_a2a_envelope.py"
PATCH_TESTS = ROOT / "wolfhouse" / "test_water_cooler_a2a_adapter_patch.py"
ACTION_TESTS = ROOT / "wolfhouse" / "test_water_cooler_a2a_action.py"
PLUGIN_INIT = ROOT / "plugins" / "water_cooler_a2a" / "__init__.py"
PLUGIN_YAML = ROOT / "plugins" / "water_cooler_a2a" / "plugin.yaml"
ADMISSION_FIXTURE = (
    ROOT / "wolfhouse" / "fixtures" / "water_cooler_a2a" / "discord_adapter_admission_shape.py"
)
SESSION_ROUTING = ROOT / "wolfhouse" / "discord_session_routing.py"
SESSION_VERIFY = ROOT / "verify_discord_session_continuity.py"
GATEWAY_PATCHES = ROOT / "apply_gateway_patches.py"
BOOTSTRAP = ROOT / "bootstrap.sh"
LUNA_SOUL = ROOT / "SOUL.md"
ORCH_SOUL = ROOT / "orchestrator-SOUL.md"

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        msg = f"  FAIL  {name}"
        if detail:
            msg += f" — {detail}"
        print(msg)


def _load_policy():
    spec = importlib.util.spec_from_file_location("water_cooler_a2a_policy_verify", POLICY)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = mod
    sys.modules["water_cooler_a2a_policy"] = mod
    spec.loader.exec_module(mod)
    return mod


def _load_runtime():
    # Policy must be importable as water_cooler_a2a_policy for runtime fallback.
    if "water_cooler_a2a_policy" not in sys.modules:
        _load_policy()
    spec = importlib.util.spec_from_file_location("water_cooler_a2a_runtime_verify", RUNTIME)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _load_envelope():
    if "water_cooler_a2a_policy" not in sys.modules:
        _load_policy()
    if "water_cooler_a2a_runtime_verify" not in sys.modules and RUNTIME.is_file():
        _load_runtime()
    # Ensure runtime module name used by envelope import fallback.
    if "water_cooler_a2a_runtime" not in sys.modules and RUNTIME.is_file():
        sys.modules["water_cooler_a2a_runtime"] = sys.modules.get(
            "water_cooler_a2a_runtime_verify"
        ) or _load_runtime()
    spec = importlib.util.spec_from_file_location("water_cooler_a2a_envelope_verify", ENVELOPE)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _load_patcher():
    spec = importlib.util.spec_from_file_location(
        "apply_water_cooler_a2a_adapter_patch_verify", ADAPTER_PATCH
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    check("policy module exists", POLICY.is_file())
    check("runtime bridge module exists", RUNTIME.is_file())
    check("envelope builder module exists", ENVELOPE.is_file())
    check("adapter hooks module exists", HOOKS.is_file())
    check("controlled action module exists", ACTION.is_file())
    check("action context module exists", ACTION_CTX.is_file())
    check("adapter patch module exists", ADAPTER_PATCH.is_file())
    check("unit test module exists", TESTS.is_file())
    check("runtime unit test module exists", RUNTIME_TESTS.is_file())
    check("envelope unit test module exists", ENVELOPE_TESTS.is_file())
    check("adapter patch unit test module exists", PATCH_TESTS.is_file())
    check("action unit test module exists", ACTION_TESTS.is_file())
    check("a2a plugin init exists", PLUGIN_INIT.is_file())
    check("a2a plugin.yaml exists", PLUGIN_YAML.is_file())
    check("admission-shape fixture exists", ADMISSION_FIXTURE.is_file())
    check("session routing untouched path exists", SESSION_ROUTING.is_file())
    check("session continuity verifier exists", SESSION_VERIFY.is_file())
    check("gateway patches path preserved", GATEWAY_PATCHES.is_file())

    if not POLICY.is_file():
        print(f"\nverify_water_cooler_a2a_pilot: {passed} passed, {failed} failed")
        return 1

    src = POLICY.read_text(encoding="utf-8")
    test_src = TESTS.read_text(encoding="utf-8") if TESTS.is_file() else ""
    rt_src = RUNTIME.read_text(encoding="utf-8") if RUNTIME.is_file() else ""
    rt_test_src = RUNTIME_TESTS.read_text(encoding="utf-8") if RUNTIME_TESTS.is_file() else ""
    env_src = ENVELOPE.read_text(encoding="utf-8") if ENVELOPE.is_file() else ""
    hooks_src = HOOKS.read_text(encoding="utf-8") if HOOKS.is_file() else ""
    action_src = ACTION.read_text(encoding="utf-8") if ACTION.is_file() else ""
    action_ctx_src = ACTION_CTX.read_text(encoding="utf-8") if ACTION_CTX.is_file() else ""
    action_test_src = ACTION_TESTS.read_text(encoding="utf-8") if ACTION_TESTS.is_file() else ""
    plugin_src = PLUGIN_INIT.read_text(encoding="utf-8") if PLUGIN_INIT.is_file() else ""
    plugin_yaml_src = PLUGIN_YAML.read_text(encoding="utf-8") if PLUGIN_YAML.is_file() else ""
    patch_src = ADAPTER_PATCH.read_text(encoding="utf-8") if ADAPTER_PATCH.is_file() else ""
    patch_test_src = PATCH_TESTS.read_text(encoding="utf-8") if PATCH_TESTS.is_file() else ""
    env_test_src = ENVELOPE_TESTS.read_text(encoding="utf-8") if ENVELOPE_TESTS.is_file() else ""
    gateway_src = GATEWAY_PATCHES.read_text(encoding="utf-8") if GATEWAY_PATCHES.is_file() else ""
    bootstrap_src = BOOTSTRAP.read_text(encoding="utf-8") if BOOTSTRAP.is_file() else ""

    # Central fail-closed / channel / round-limit concepts (substring presence).
    check("enabled defaults false concept", "enabled: bool = False" in src or "enabled=False" in src)
    check("fail-closed language present", "fail-closed" in src.lower() or "fail closed" in src.lower() or "is_active" in src)
    check("water-cooler channel id constant", "1530209175861199019" in src)
    check("MAX_ROUNDS is three", "MAX_ROUNDS = 3" in src)
    check("human TASK marker", "TASK" in src and "[target=seadog]" in src and "[reviewer=deckhand]" in src)
    check("peer handoff marker", "A2A-HANDOFF v1" in src)
    check("peer review marker", "A2A-REVIEW v1" in src)
    check("no ambient env reads in pure policy", "os.getenv" not in src and "os.environ" not in src)
    check("no session routing coupling", "discord_session_routing" not in src and "build_discord_session_key" not in src)
    check("TTL bounds present", "MIN_TTL_SECONDS" in src and "MAX_TTL_SECONDS" in src)
    check("state forbids content field language", "never" in src.lower() and ("task body" in src.lower() or "raw" in src.lower()))
    check("local_bot_id injected", "local_bot_id" in src)
    check("deterministic task id derivation", "derive_task_id" in src and "sha256" in src.lower())
    check("mirrored non-dispatch reason", "mirrored_task_non_dispatch" in src)
    check("no shared secret / hmac machinery", "hmac" not in src.lower() and "shared_secret" not in src.lower())

    check("tests cover round limit", "MAX_ROUNDS" in test_src and "fourth" in test_src.lower())
    check("tests cover fail closed / disabled", "disabled" in test_src.lower() or "fail" in test_src.lower())
    check("tests cover wrong channel", "wrong_channel" in test_src or "OTHER_CHANNEL" in test_src)
    check("tests cover no raw content in state", "no_raw_content" in test_src or "UNIQUE_RAW" in test_src)
    check("tests cover dual-instance mirror", "dual_instance" in test_src and "mirrored_task_non_dispatch" in test_src)
    check("tests cover restart fail closed", "restart" in test_src.lower() and "unknown_or_forged_task_id" in test_src)
    check("tests cover wrong local bot", "wrong_local_bot" in test_src or "local_bot_id" in test_src)

    # Runtime bridge static contract.
    if RUNTIME.is_file():
        check("runtime neutral WATER_COOLER_A2A_* keys", "WATER_COOLER_A2A_ENABLED" in rt_src and "WATER_COOLER_A2A_CHANNEL_ID" in rt_src)
        check("runtime action SUPPRESS", "SUPPRESS" in rt_src)
        check("runtime action DISPATCH_HUMAN_TASK", "DISPATCH_HUMAN_TASK" in rt_src)
        check("runtime action DISPATCH_PEER_HANDOFF", "DISPATCH_PEER_HANDOFF" in rt_src)
        check("runtime action DISPATCH_PEER_REVIEW", "DISPATCH_PEER_REVIEW" in rt_src)
        check("runtime no os.environ", "os.environ" not in rt_src and "os.getenv" not in rt_src)
        check("runtime no session routing coupling", "discord_session_routing" not in rt_src)
        check("runtime parse_runtime_config present", "parse_runtime_config" in rt_src)
        check("runtime from_mapping present", "from_mapping" in rt_src)
        check("runtime peer non-local consumer reasons", "peer_handoff_non_local_consumer" in rt_src and "peer_review_non_local_consumer" in rt_src)
        check(
            "runtime tests cover suppress/dispatch/isolation",
            "DISPATCH_HUMAN_TASK" in rt_test_src
            and "peer_handoff" in rt_test_src
            and "restart" in rt_test_src.lower()
            and "os.environ" in rt_test_src,
        )

    # Light runtime smoke: disabled config ignores TASK; dual mirror accepts TASK.
    try:
        m = _load_policy()
        inactive = m.WaterCoolerA2APolicy(m.build_config(enabled=False))
        secret_body = "UNIQUE_TASK_BODY_not_in_state_zz9"
        ev = m.DiscordMessageEvent(
            channel_id=m.WATER_COOLER_CHANNEL_ID,
            message_id="1",
            author_id="100000000000000001",
            content=f"TASK [target=seadog] [reviewer=deckhand]\n{secret_body}",
            is_bot=False,
            created_at=1.0,
        )
        d = inactive.evaluate(ev, now=1.0)
        check("runtime disabled fails closed (ignore)", d.kind == m.DecisionKind.IGNORE)

        seadog = "200000000000000001"
        deckhand = "300000000000000001"
        human = "100000000000000001"
        worker = m.WaterCoolerA2APolicy(
            m.build_config(
                enabled=True,
                channel_id=m.WATER_COOLER_CHANNEL_ID,
                allowed_human_starter_ids={human},
                seadog_bot_id=seadog,
                deckhand_bot_id=deckhand,
                local_bot_id=seadog,
                task_ttl_seconds=60.0,
            )
        )
        reviewer = m.WaterCoolerA2APolicy(
            m.build_config(
                enabled=True,
                channel_id=m.WATER_COOLER_CHANNEL_ID,
                allowed_human_starter_ids={human},
                seadog_bot_id=seadog,
                deckhand_bot_id=deckhand,
                local_bot_id=deckhand,
                task_ttl_seconds=60.0,
            )
        )
        dw = worker.evaluate(ev, now=1.0)
        dr = reviewer.evaluate(ev, now=1.0)
        check("runtime worker valid task accepted", dw.kind == m.DecisionKind.HUMAN_TASK)
        check(
            "runtime reviewer mirrors without dispatch",
            dr.kind == m.DecisionKind.IGNORE and dr.reason == "mirrored_task_non_dispatch",
        )
        check(
            "runtime dual task_id identity",
            dw.task_id is not None and dw.task_id == dr.task_id == m.derive_task_id(ev.channel_id, ev.message_id),
        )
        st = dw.task_state
        check(
            "runtime state has no content attrs",
            st is not None
            and not hasattr(st, "content")
            and not hasattr(st, "body")
            and secret_body not in repr(st),
        )
        check("MAX_ROUNDS runtime is 3", m.MAX_ROUNDS == 3)

        wrong = m.build_config(
            enabled=True,
            channel_id=m.WATER_COOLER_CHANNEL_ID,
            allowed_human_starter_ids={human},
            seadog_bot_id=seadog,
            deckhand_bot_id=deckhand,
            local_bot_id="400000000000000001",
        )
        check("runtime wrong local_bot_id inactive", not wrong.is_active)

        empty = m.WaterCoolerA2APolicy(
            m.build_config(
                enabled=True,
                channel_id=m.WATER_COOLER_CHANNEL_ID,
                allowed_human_starter_ids={human},
                seadog_bot_id=seadog,
                deckhand_bot_id=deckhand,
                local_bot_id=seadog,
            )
        )
        peer = m.DiscordMessageEvent(
            channel_id=m.WATER_COOLER_CHANNEL_ID,
            message_id="2",
            author_id=seadog,
            content=f"A2A-HANDOFF v1\ntask_id: {dw.task_id}\nnotes",
            is_bot=True,
            created_at=2.0,
        )
        dp = empty.evaluate(peer, now=2.0)
        check(
            "runtime empty instance rejects peer (fail closed)",
            dp.kind == m.DecisionKind.REJECT and dp.reason == "unknown_or_forged_task_id",
        )
    except Exception as exc:  # pragma: no cover - verifier diagnostics
        check("runtime smoke import/evaluate", False, detail=type(exc).__name__ + ": " + str(exc))

    # Runtime bridge smoke: mapping parser + action contract asymmetry.
    if RUNTIME.is_file():
        try:
            rmod = _load_runtime()
            m = sys.modules.get("water_cooler_a2a_policy") or _load_policy()
            seadog = "200000000000000001"
            deckhand = "300000000000000001"
            human = "100000000000000001"
            secret = "BRIDGE_SMOKE_SECRET_body_zz9"
            mapping_worker = {
                rmod.CFG_ENABLED: True,
                rmod.CFG_CHANNEL_ID: m.WATER_COOLER_CHANNEL_ID,
                rmod.CFG_LOCAL_BOT_ID: seadog,
                rmod.CFG_SEADOG_BOT_ID: seadog,
                rmod.CFG_DECKHAND_BOT_ID: deckhand,
                rmod.CFG_ALLOWED_HUMAN_STARTER_IDS: [human],
                rmod.CFG_TASK_TTL_SECONDS: 60.0,
            }
            mapping_reviewer = dict(mapping_worker)
            mapping_reviewer[rmod.CFG_LOCAL_BOT_ID] = deckhand

            check(
                "bridge default mapping inactive",
                not rmod.parse_runtime_config(None).is_active,
            )
            check(
                "bridge env-poisoned empty mapping still inactive",
                not rmod.parse_runtime_config({}).is_active,
            )

            bw = rmod.WaterCoolerA2ARuntime.from_mapping(mapping_worker)
            br = rmod.WaterCoolerA2ARuntime.from_mapping(mapping_reviewer)
            ev = m.DiscordMessageEvent(
                channel_id=m.WATER_COOLER_CHANNEL_ID,
                message_id="101",
                author_id=human,
                content=f"TASK [target=seadog] [reviewer=deckhand]\n{secret}",
                is_bot=False,
                created_at=1.0,
            )
            aw = bw.handle_event(ev, now=1.0)
            ar = br.handle_event(ev, now=1.0)
            check(
                "bridge worker dispatches human task",
                aw.action == rmod.BridgeAction.DISPATCH_HUMAN_TASK,
            )
            check(
                "bridge reviewer suppresses mirrored human task",
                ar.action == rmod.BridgeAction.SUPPRESS
                and ar.reason == "mirrored_task_non_dispatch",
            )
            check(
                "bridge result hides raw task body",
                secret not in repr(aw) and secret not in repr(ar),
            )
            tid = aw.task_id
            handoff = m.DiscordMessageEvent(
                channel_id=m.WATER_COOLER_CHANNEL_ID,
                message_id="102",
                author_id=seadog,
                content=f"A2A-HANDOFF v1\ntask_id: {tid}\nnotes",
                is_bot=True,
                created_at=2.0,
            )
            hw = bw.handle_event(handoff, now=2.0)
            hr = br.handle_event(handoff, now=2.0)
            check(
                "bridge reviewer dispatches peer handoff",
                hr.action == rmod.BridgeAction.DISPATCH_PEER_HANDOFF,
            )
            check(
                "bridge worker suppresses own handoff echo",
                hw.action == rmod.BridgeAction.SUPPRESS,
            )
            review = m.DiscordMessageEvent(
                channel_id=m.WATER_COOLER_CHANNEL_ID,
                message_id="103",
                author_id=deckhand,
                content=f"A2A-REVIEW v1\ntask_id: {tid}\nacks",
                is_bot=True,
                created_at=3.0,
            )
            rw = bw.handle_event(review, now=3.0)
            rr = br.handle_event(review, now=3.0)
            check(
                "bridge worker dispatches peer review",
                rw.action == rmod.BridgeAction.DISPATCH_PEER_REVIEW,
            )
            check(
                "bridge reviewer suppresses own review echo",
                rr.action == rmod.BridgeAction.SUPPRESS,
            )
            restarted = rmod.WaterCoolerA2ARuntime.from_mapping(mapping_reviewer)
            bad = restarted.handle_event(handoff, now=4.0)
            check(
                "bridge restart fail closed suppresses peer",
                bad.action == rmod.BridgeAction.SUPPRESS
                and bad.reason == "unknown_or_forged_task_id",
            )
        except Exception as exc:  # pragma: no cover - verifier diagnostics
            check(
                "bridge smoke import/handle_event",
                False,
                detail=type(exc).__name__ + ": " + str(exc),
            )

    # Adapter patch foundation + controlled envelope contracts.
    if HOOKS.is_file():
        check("hooks inert language", "inactive" in hooks_src.lower() or "always false" in hooks_src.lower() or "return False" in hooks_src)
        check("hooks mention bypass export", "a2a_allow_mention_bypass" in hooks_src)
        check("hooks pre-dispatch export", "a2a_pre_dispatch_intercept" in hooks_src)
        check("hooks not ambient env", "os.environ" not in hooks_src and "os.getenv" not in hooks_src)
        check("hooks activation probe false", "is_a2a_adapter_hooks_active" in hooks_src)

    if ADAPTER_PATCH.is_file():
        check("patcher not default apply", "refusing automatic apply" in patch_src or "--apply" in patch_src)
        check("patcher unique anchors", "count" in patch_src and "ambiguous" in patch_src)
        check("patcher fail-closed missing", "anchor missing" in patch_src or "AdapterPatchError" in patch_src)
        check("patcher idempotent markers", "wolfhouse_water_cooler_a2a_mention_bypass_v1" in patch_src)
        check("patcher pre-dispatch marker", "wolfhouse_water_cooler_a2a_pre_dispatch_v1" in patch_src)
        check("patcher encodes DISCORD_ALLOW_BOTS", "DISCORD_ALLOW_BOTS" in patch_src)
        check("patcher encodes mentions admit", '"mentions"' in patch_src)
        check("patcher encodes handle_message role_authorized", "role_authorized=_role_authorized" in patch_src)
        check("patcher encodes require_mention gate", "require_mention and not is_free_channel" in patch_src)
        check("patcher not imported by gateway main by default", "apply_water_cooler_a2a_adapter_patch" not in gateway_src)
        check(
            "patcher tests cover missing/duplicate/reapply",
            "anchor_missing" in patch_test_src
            and "duplicate" in patch_test_src
            and "idempotent" in patch_test_src.lower(),
        )
        check(
            "patcher tests cover injection before model dispatch",
            "before_model_dispatch" in patch_test_src or "before model dispatch" in patch_test_src.lower(),
        )

    if ENVELOPE.is_file():
        check("envelope handoff marker", "A2A-HANDOFF v1" in env_src)
        check("envelope review marker", "A2A-REVIEW v1" in env_src)
        check("envelope rejects plain model reply", "plain_model_reply_not_authorized" in env_src)
        check("envelope build_peer_envelope export", "def build_peer_envelope" in env_src)
        check("envelope no ambient env", "os.environ" not in env_src and "os.getenv" not in env_src)
        check(
            "envelope tests cover rejection cases",
            "suppress" in env_test_src.lower()
            and "recipient_mismatch" in env_test_src
            and "oversized" in env_test_src.lower()
            and "plain_model_reply" in env_test_src,
        )

    # Light smoke: patcher + envelope (in-memory only; no live write).
    if ADAPTER_PATCH.is_file() and ADMISSION_FIXTURE.is_file():
        try:
            pmod = _load_patcher()
            fixture_src = ADMISSION_FIXTURE.read_text(encoding="utf-8")
            pmod.validate_admission_shape(fixture_src)
            check("patcher fixture admission shape validates", True)
            patched, meta = pmod.patch_adapter_source(fixture_src)
            check("patcher fixture first apply changes", bool(meta.get("changed")))
            pmod.validate_patched_source(patched)
            again, meta2 = pmod.patch_adapter_source(patched)
            check("patcher fixture reapply idempotent", meta2.get("changed") is False and again == patched)
            check(
                "patcher pre-dispatch before model dispatch",
                patched.index(pmod.MARKER_PRE_DISPATCH) < patched.index(pmod.ANCHOR_PRE_DISPATCH),
            )
            # Fail-closed: missing anchor must raise and not produce a write path.
            broken = fixture_src.replace(pmod.ANCHOR_SELF_IGNORE, "# gone\n", 1)
            raised = False
            try:
                pmod.patch_adapter_source(broken)
            except pmod.AdapterPatchError:
                raised = True
            check("patcher missing anchor fail-closed", raised)
            # CLI default refuses apply.
            check("patcher CLI default refuses apply", pmod.main([]) == 2)
        except Exception as exc:  # pragma: no cover
            check("patcher smoke", False, detail=type(exc).__name__ + ": " + str(exc))

    if ENVELOPE.is_file() and RUNTIME.is_file():
        try:
            emod = _load_envelope()
            rmod = sys.modules.get("water_cooler_a2a_runtime_verify") or _load_runtime()
            m = sys.modules.get("water_cooler_a2a_policy") or _load_policy()
            tid = "abcdef0123456789abcdef0123456789"
            mention = "<@300000000000000001>"
            ok = emod.build_peer_envelope(
                authorized_action=rmod.BridgeAction.DISPATCH_HUMAN_TASK,
                channel_id=m.WATER_COOLER_CHANNEL_ID,
                recipient_bot_mention=mention,
                task_id=tid,
                body="notes",
                expected_channel_id=m.WATER_COOLER_CHANNEL_ID,
                expected_recipient_mention=mention,
            )
            check(
                "envelope smoke valid handoff",
                ok.ok and ok.content is not None and "A2A-HANDOFF v1" in ok.content,
            )
            bad = emod.build_peer_envelope(
                authorized_action=rmod.BridgeAction.SUPPRESS,
                channel_id=m.WATER_COOLER_CHANNEL_ID,
                recipient_bot_mention=mention,
                task_id=tid,
                body="notes",
                expected_channel_id=m.WATER_COOLER_CHANNEL_ID,
                expected_recipient_mention=mention,
            )
            check("envelope smoke suppress rejected", (not bad.ok) and bad.content is None)
            plain = emod.build_peer_envelope_from_model_reply("hello")
            check(
                "envelope smoke plain model reply rejected",
                (not plain.ok) and plain.reason == "plain_model_reply_not_authorized",
            )
        except Exception as exc:  # pragma: no cover
            check("envelope smoke", False, detail=type(exc).__name__ + ": " + str(exc))

    if HOOKS.is_file():
        try:
            hspec = importlib.util.spec_from_file_location("water_cooler_a2a_hooks_verify", HOOKS)
            hmod = importlib.util.module_from_spec(hspec)
            assert hspec.loader is not None
            hspec.loader.exec_module(hmod)
            check(
                "hooks smoke inert",
                hmod.is_a2a_adapter_hooks_active() is False
                and hmod.a2a_allow_mention_bypass(
                    channel_id="1530209175861199019",
                    content="TASK [target=seadog] [reviewer=deckhand]",
                    author_is_bot=False,
                )
                is False
                and hmod.a2a_pre_dispatch_intercept(None) is False,
            )
        except Exception as exc:  # pragma: no cover
            check("hooks smoke", False, detail=type(exc).__name__ + ": " + str(exc))

    # Controlled outbound action + opt-in plugin (not enabled by default).
    if ACTION.is_file() and ACTION_CTX.is_file():
        check("action body-only tool surface", "water_cooler_a2a_send" in action_src)
        check("action execute_controlled_outbound", "def execute_controlled_outbound" in action_src)
        check("action scoped sender", "WaterCoolerScopedSender" in action_src)
        check("action no ambient env", "os.environ" not in action_src and "os.getenv" not in action_src)
        check("action no urllib/http", "urllib" not in action_src and "requests" not in action_src)
        check("action no subprocess/shell", "subprocess" not in action_src and "os.system" not in action_src)
        check("action advances after send", "record_local_outbound" in action_src)
        check("action rejects plain reply", "plain_model_reply_not_authorized" in action_src)
        check("context establish_from_dispatch", "def establish_from_dispatch" in action_ctx_src)
        check("context no model destination", "never accept" in action_ctx_src.lower() or "never accepts" in action_ctx_src.lower())
        check(
            "action tests cover rejects and isolation",
            "no_authorized_task_context" in action_test_src
            and "duplicate_tool_use" in action_test_src
            and "channel_not_water_cooler" in action_test_src
            and "wrong_role" in action_test_src
            and "invalid_or_oversized_body" in action_test_src,
        )
        check("policy record_local_outbound", "def record_local_outbound" in src)

    if PLUGIN_INIT.is_file() and PLUGIN_YAML.is_file():
        check("plugin name water-cooler-a2a", "water-cooler-a2a" in plugin_yaml_src)
        check("plugin tool water_cooler_a2a_send", "water_cooler_a2a_send" in plugin_src)
        check("plugin toolset water_cooler_a2a", 'TOOLSET = "water_cooler_a2a"' in plugin_src)
        check("plugin register(ctx)", "def register" in plugin_src)
        check(
            "plugin schema body-only",
            '"body"' in plugin_src
            and "channel_id" not in plugin_src.split("properties")[1].split("required")[0]
            if "properties" in plugin_src
            else False,
        )
        # Not enabled for Luna / deckhand / orchestrator configs by default.
        check(
            "luna config does not enable a2a plugin",
            "water-cooler-a2a" not in bootstrap_src
            or (
                "wolfhouse-staff-api" in bootstrap_src
                and bootstrap_src.count("water-cooler-a2a") == 0
            ),
        )
        check(
            "bootstrap does not enable water_cooler_a2a toolset",
            "water_cooler_a2a" not in bootstrap_src
            or "toolsets:" in bootstrap_src
            and "water_cooler_a2a" not in bootstrap_src.split("write_deckhand_config")[0],
        )
        # Stronger: deckhand/luna/orchestrator heredocs must not list the plugin.
        check(
            "bootstrap enabled plugins list has no a2a",
            "water-cooler-a2a" not in bootstrap_src,
        )
        check(
            "patcher still not imported by gateway main",
            "apply_water_cooler_a2a_adapter_patch" not in gateway_src,
        )
        check(
            "a2a action not in luna soul",
            not LUNA_SOUL.is_file()
            or "water_cooler_a2a_send" not in LUNA_SOUL.read_text(encoding="utf-8"),
        )
        check(
            "a2a action not in orch soul",
            not ORCH_SOUL.is_file()
            or "water_cooler_a2a_send" not in ORCH_SOUL.read_text(encoding="utf-8"),
        )

    if ACTION.is_file() and RUNTIME.is_file() and POLICY.is_file():
        try:
            # Ensure deps under import names used by action modules.
            if "water_cooler_a2a_policy" not in sys.modules:
                _load_policy()
            if "water_cooler_a2a_runtime" not in sys.modules:
                rtmp = _load_runtime()
                sys.modules["water_cooler_a2a_runtime"] = rtmp
            if "water_cooler_a2a_envelope" not in sys.modules:
                etmp = _load_envelope()
                sys.modules["water_cooler_a2a_envelope"] = etmp
            cspec = importlib.util.spec_from_file_location(
                "water_cooler_a2a_action_context_verify", ACTION_CTX
            )
            cmod = importlib.util.module_from_spec(cspec)
            assert cspec.loader is not None
            sys.modules[cspec.name] = cmod
            sys.modules["water_cooler_a2a_action_context"] = cmod
            cspec.loader.exec_module(cmod)
            aspec = importlib.util.spec_from_file_location(
                "water_cooler_a2a_action_verify", ACTION
            )
            amod = importlib.util.module_from_spec(aspec)
            assert aspec.loader is not None
            sys.modules[aspec.name] = amod
            aspec.loader.exec_module(amod)

            cmod.clear_authorized_outbound_context()
            none_r = amod.execute_controlled_outbound(body="x")
            check(
                "action smoke fail closed without context",
                (not none_r.ok) and none_r.reason == "no_authorized_task_context",
            )

            rmod = sys.modules.get("water_cooler_a2a_runtime") or _load_runtime()
            pmod = sys.modules.get("water_cooler_a2a_policy") or _load_policy()
            mapping = {
                rmod.CFG_ENABLED: True,
                rmod.CFG_CHANNEL_ID: pmod.WATER_COOLER_CHANNEL_ID,
                rmod.CFG_LOCAL_BOT_ID: "200000000000000001",
                rmod.CFG_SEADOG_BOT_ID: "200000000000000001",
                rmod.CFG_DECKHAND_BOT_ID: "300000000000000001",
                rmod.CFG_ALLOWED_HUMAN_STARTER_IDS: ["100000000000000001"],
                rmod.CFG_TASK_TTL_SECONDS: 600.0,
            }
            worker = rmod.WaterCoolerA2ARuntime.from_mapping(mapping)
            hum = worker.handle_event(
                pmod.DiscordMessageEvent(
                    channel_id=pmod.WATER_COOLER_CHANNEL_ID,
                    message_id="88001",
                    author_id="100000000000000001",
                    content="TASK [target=seadog] [reviewer=deckhand]\nsmoke",
                    is_bot=False,
                    created_at=1_000.0,
                ),
                now=1_000.0,
            )
            fake = amod.FakeChannelSender()
            established = cmod.establish_from_dispatch(
                runtime=worker,
                action=hum.action,
                task_id=hum.task_id,
                channel_send_fn=fake.send_to_channel,
                now=1_000.0,
            )
            check("action smoke context established", established is not None)
            sent = amod.execute_controlled_outbound(body="smoke notes", now=1_000.0)
            check(
                "action smoke controlled send",
                sent.ok and sent.envelope_kind == "handoff" and len(fake.sent) == 1,
            )
            check(
                "action smoke only water-cooler channel",
                bool(fake.sent) and fake.sent[0][0] == pmod.WATER_COOLER_CHANNEL_ID,
            )
            other = amod.WaterCoolerScopedSender(
                fake, allowed_channel_id=pmod.WATER_COOLER_CHANNEL_ID
            ).send("1530209175861199000", "nope")
            check(
                "action smoke rejects other channel",
                (not other.ok) and other.error == "channel_not_water_cooler",
            )
            plain = amod.reject_plain_model_reply_as_a2a("hi")
            check(
                "action smoke plain reply rejected",
                (not plain.ok) and plain.reason == "plain_model_reply_not_authorized",
            )
            cmod.clear_authorized_outbound_context()
        except Exception as exc:  # pragma: no cover
            check("action smoke", False, detail=type(exc).__name__ + ": " + str(exc))

    print(f"\nverify_water_cooler_a2a_pilot: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
