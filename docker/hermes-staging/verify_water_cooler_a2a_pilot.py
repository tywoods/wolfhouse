#!/usr/bin/env python3
"""Static + light runtime checks for Water-cooler A2A policy + runtime bridge.

Proves the policy/runtime/test files exist and encode fail-closed, channel,
round-limit, local_bot_id, dual-instance mirror, and bridge action-contract
concepts. Avoids brittle whole-file hashes. Does not claim Hermes wiring.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
POLICY = ROOT / "wolfhouse" / "water_cooler_a2a_policy.py"
RUNTIME = ROOT / "wolfhouse" / "water_cooler_a2a_runtime.py"
TESTS = ROOT / "wolfhouse" / "test_water_cooler_a2a_policy.py"
RUNTIME_TESTS = ROOT / "wolfhouse" / "test_water_cooler_a2a_runtime.py"
SESSION_ROUTING = ROOT / "wolfhouse" / "discord_session_routing.py"
SESSION_VERIFY = ROOT / "verify_discord_session_continuity.py"

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


def main() -> int:
    check("policy module exists", POLICY.is_file())
    check("runtime bridge module exists", RUNTIME.is_file())
    check("unit test module exists", TESTS.is_file())
    check("runtime unit test module exists", RUNTIME_TESTS.is_file())
    check("session routing untouched path exists", SESSION_ROUTING.is_file())
    check("session continuity verifier exists", SESSION_VERIFY.is_file())

    if not POLICY.is_file():
        print(f"\nverify_water_cooler_a2a_pilot: {passed} passed, {failed} failed")
        return 1

    src = POLICY.read_text(encoding="utf-8")
    test_src = TESTS.read_text(encoding="utf-8") if TESTS.is_file() else ""
    rt_src = RUNTIME.read_text(encoding="utf-8") if RUNTIME.is_file() else ""
    rt_test_src = RUNTIME_TESTS.read_text(encoding="utf-8") if RUNTIME_TESTS.is_file() else ""

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

    print(f"\nverify_water_cooler_a2a_pilot: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
