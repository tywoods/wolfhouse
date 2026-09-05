"""Fail-closed isolated live-model corpus path (no send, no business tools)."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
from unittest import mock

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
REPO = STAGING.parent.parent
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))

from wolfhouse.luna_personality_isolation import (  # noqa: E402
    IsolatedTurnCapture,
    IsolationAbort,
    IsolationTargets,
    REQUIRED_LIVE_SEAMS,
    WHATSAPP_SEND_METHODS,
    current_isolated_turn,
    deny_tool_if_isolated,
    enter_isolated_turn,
    exit_isolated_turn,
    inspect_live_seams,
    install_isolation_runtime,
    isolation_status,
    mark_test_isolation_installed,
    observe_provider_invocation,
    preflight_isolation_or_abort,
    reset_isolation_runtime_for_tests,
    _wrap_openai_client_factory,
    _wrap_bedrock_client_factory,
    settle_isolated_work,
)
from wolfhouse.luna_personality_live_eval import (  # noqa: E402
    ALLOWED_CASE_IDS,
    LIVE_EVAL_PATH,
    assert_sunset_serving_identity,
    build_eval_user_message,
    default_invoke_live_gateway,
    evaluate_generated_reply,
    extract_final_handler_text,
    live_sunset_eval_identity,
    load_corpus,
    register_live_eval_route,
    run_isolated_personality_eval,
    serving_eval_readiness,
    simulated_model_turn,
)
from wolfhouse.run_luna_personality_live_proof import (  # noqa: E402
    OfflineEvalHttpTransportDouble,
    OfflineStaffTransportDouble,
    ServingEvalHttpTransport,
    execute_live_matrix,
    main as live_proof_main,
    parse_exact_eval_url,
    parse_exact_staff_origin,
    serving_preflight,
)

CORPUS = load_corpus(REPO / "fixtures" / "luna-personality-corpus.json")


def _run(coro):
    return asyncio.run(coro)


class _FakeAdapter:
    async def send(self, chat_id, content, reply_to=None, metadata=None):
        return SimpleNamespace(success=True, message_id="live-double", raw_response={})

    async def send_typing(self, *args, **kwargs):
        return None

    async def send_clarify(self, *args, **kwargs):
        return SimpleNamespace(success=True)

    async def send_exec_approval(self, *args, **kwargs):
        return SimpleNamespace(success=True)

    async def send_slash_confirm(self, *args, **kwargs):
        return SimpleNamespace(success=True)

    async def send_image(self, *args, **kwargs):
        return SimpleNamespace(success=True)

    async def send_image_file(self, *args, **kwargs):
        return SimpleNamespace(success=True)

    async def send_video(self, *args, **kwargs):
        return SimpleNamespace(success=True)

    async def send_voice(self, *args, **kwargs):
        return SimpleNamespace(success=True)

    async def send_document(self, *args, **kwargs):
        return SimpleNamespace(success=True)


def _complete_targets():
    plugins = types.ModuleType("isolation_double_plugins")
    plugins.get_pre_tool_call_block_message = lambda *a, **k: None
    tools = types.ModuleType("isolation_double_model_tools")
    tools.handle_function_call = lambda *a, **k: json.dumps({"ok": True})
    staff = types.ModuleType("isolation_double_staff")
    staff._post_bot = lambda path, payload=None: {"success": True, "path": path}
    store_cls = type(
        "IsolationDoubleStore",
        (),
        {
            "append_to_transcript": lambda self, *a, **k: "wrote",
            "get_or_create_session": lambda self, source, force_new=False: SimpleNamespace(
                session_key="k", session_id="s"
            ),
            "_save": lambda self: "saved",
            "update_session": lambda self, *a, **k: None,
        },
    )
    provider = types.ModuleType("isolation_double_provider")

    def interruptible_api_call(agent, api_kwargs):
        return {"response": "provider-double"}

    def interruptible_streaming_api_call(agent, api_kwargs, on_first_delta=None):
        return {"response": "provider-stream-double"}

    provider.interruptible_api_call = interruptible_api_call
    provider.interruptible_streaming_api_call = interruptible_streaming_api_call

    class _FactoryOwner:
        def _create_request_openai_client(self, *a, **k):  # noqa: ANN001
            def create(**kw):  # noqa: ANN003
                return SimpleNamespace(id="factory-double", kwargs=kw)

            return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))

    return IsolationTargets(
        whatsapp_adapter_cls=_FakeAdapter,
        plugins_mod=plugins,
        post_bot_mods=(staff,),
        session_store_cls=store_cls,
        handle_function_call_mod=tools,
        provider_mod=provider,
        wrap_executor=True,
        wrap_thread=True,
        openai_client_factory_owner=_FactoryOwner,
    )


def _counter_session_db(effects, label="agent_append"):  # noqa: ANN001
    return SimpleNamespace(
        create_session=lambda **k: effects.append(f"{label}:create") or None,
        end_session=lambda **k: effects.append(f"{label}:end") or None,
        append_message=lambda **k: effects.append(label) or None,
    )


def _extract_unchanged(path: Path, name: str, namespace: dict):
    """Compile the named function from source unchanged. Not a copied body."""
    import ast
    import __future__

    tree = ast.parse(path.read_text(encoding="utf-8"))
    node = next(
        n
        for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name
    )
    exec(
        compile(
            ast.Module(body=[node], type_ignores=[]),
            str(path),
            "exec",
            flags=__future__.annotations.compiler_flag,
        ),
        namespace,
    )
    return namespace[name]


HERMES_HELPERS = Path("/opt/hermes/agent/chat_completion_helpers.py")
HERMES_RUN_AGENT = Path("/opt/hermes/run_agent.py")


class IsolationContextTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_isolation_runtime_for_tests()

    def test_preflight_aborts_before_model_when_context_missing(self) -> None:
        with self.assertRaises(IsolationAbort) as ctx:
            preflight_isolation_or_abort()
        self.assertEqual(ctx.exception.reason, "isolation_context_missing")

    def test_partial_and_stale_seams_fail_live_preflight(self) -> None:
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            mark_test_isolation_installed()
            with self.assertRaises(IsolationAbort) as ctx:
                preflight_isolation_or_abort(require_live_seams=True)
            self.assertTrue(ctx.exception.reason.startswith("seams_incomplete"))
            for required in REQUIRED_LIVE_SEAMS:
                self.assertIn(required, ctx.exception.reason)
            live = inspect_live_seams()
            self.assertFalse(live["tool_hook_wrapped"] and live["journal_wrapped"])
        finally:
            exit_isolated_turn(tok)

    def test_stale_global_flags_are_not_certification(self) -> None:
        targets = _complete_targets()
        install_isolation_runtime(targets=targets)
        targets.plugins_mod.get_pre_tool_call_block_message = lambda *a, **k: None
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            with self.assertRaises(IsolationAbort) as ctx:
                preflight_isolation_or_abort(require_live_seams=True, targets=targets)
            self.assertIn("tool_hook_wrapped", ctx.exception.reason)
        finally:
            exit_isolated_turn(tok)

    def test_executor_worker_sees_isolated_context(self) -> None:
        targets = _complete_targets()
        install_isolation_runtime(targets=targets)

        async def go():
            cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
            tok = enter_isolated_turn(cap)
            try:
                loop = asyncio.get_running_loop()
                denied = await loop.run_in_executor(None, deny_tool_if_isolated, "create_sunset_booking")
                return denied, list(cap.tools_denied)
            finally:
                exit_isolated_turn(tok)

        denied, names = _run(go())
        self.assertEqual(denied, "luna_personality_isolated_no_tools")
        self.assertIn("create_sunset_booking", names)

    def test_concurrent_normal_turn_unaffected_while_isolated_worker_denied(self) -> None:
        targets = _complete_targets()
        install_isolation_runtime(targets=targets)

        async def isolated():
            cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
            tok = enter_isolated_turn(cap)
            try:
                await asyncio.sleep(0.02)
                loop = asyncio.get_running_loop()
                worker = await loop.run_in_executor(None, deny_tool_if_isolated, "create_sunset_booking")
                local = deny_tool_if_isolated("quote_booking")
                return worker, local, current_isolated_turn() is not None
            finally:
                exit_isolated_turn(tok)

        async def normal():
            await asyncio.sleep(0.01)
            loop = asyncio.get_running_loop()
            worker = await loop.run_in_executor(None, deny_tool_if_isolated, "create_sunset_booking")
            local = deny_tool_if_isolated("create_sunset_booking")
            return worker, local, current_isolated_turn()

        async def both():
            return await asyncio.gather(isolated(), normal())

        iso, norm = _run(both())
        self.assertEqual(iso[0], "luna_personality_isolated_no_tools")
        self.assertEqual(iso[1], "luna_personality_isolated_no_tools")
        self.assertTrue(iso[2])
        self.assertIsNone(norm[0])
        self.assertIsNone(norm[1])
        self.assertIsNone(norm[2])
        self.assertIsNone(current_isolated_turn())
        self.assertIsNone(deny_tool_if_isolated("create_sunset_booking"))

    def test_isolation_cleared_after_cancellation(self) -> None:
        async def isolated_sleep():
            cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
            tok = enter_isolated_turn(cap)
            try:
                await asyncio.sleep(5)
            finally:
                exit_isolated_turn(tok)

        async def go():
            task = asyncio.create_task(isolated_sleep())
            await asyncio.sleep(0.01)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            return current_isolated_turn(), deny_tool_if_isolated("create_sunset_booking")

        active, denied = _run(go())
        self.assertIsNone(active)
        self.assertIsNone(denied)

    def test_wrappers_deny_tools_send_journal_before_invocation(self) -> None:
        targets = _complete_targets()
        install_isolation_runtime(targets=targets)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=targets)
            blocked = targets.plugins_mod.get_pre_tool_call_block_message("web_search", {})
            self.assertEqual(blocked, "luna_personality_isolated_no_tools")
            dispatched = targets.handle_function_call_mod.handle_function_call("terminal", {"cmd": "curl"})
            self.assertIn("luna_personality_isolated_no_tools", dispatched)
            staff = targets.post_bot_mods[0]._post_bot("/staff/bot/availability-check", {})
            self.assertTrue(staff.get("luna_personality_isolated"))
            store = targets.session_store_cls()
            journal = store.append_to_transcript("sid", {"role": "assistant"})
            self.assertIsNone(journal)
            created = store.get_or_create_session(SimpleNamespace(chat_id="1"))
            self.assertIsNotNone(created)
            store._save()
            store.update_session("k")
            self.assertGreaterEqual(cap.journal_writes_denied, 1)
            self.assertEqual(cap.journal_writes_completed, 0)
            self.assertEqual(cap.persistence_effects_completed, [])
            self.assertEqual(cap.tools_invoked, 0)
        finally:
            exit_isolated_turn(tok)


class ServingIdentityTests(unittest.TestCase):
    def test_non_sunset_role_refused(self) -> None:
        with mock.patch.dict(os.environ, {"HERMES_ROLE": "orchestrator", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            with self.assertRaises(IsolationAbort) as ctx:
                assert_sunset_serving_identity()
        self.assertIn("non_sunset_role", ctx.exception.reason)

    def test_non_sunset_tenant_refused(self) -> None:
        with mock.patch.dict(
            os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "wolfhouse-somo"}, clear=False
        ):
            with self.assertRaises(IsolationAbort) as ctx:
                assert_sunset_serving_identity()
        self.assertIn("non_sunset_tenant", ctx.exception.reason)

    def test_empty_home_refused_when_required(self) -> None:
        env = {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset", "HERMES_HOME": ""}
        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaises(IsolationAbort) as ctx:
                assert_sunset_serving_identity(require_home=True)
        self.assertEqual(ctx.exception.reason, "hermes_home_missing")


class IsolatedEvalTests(unittest.TestCase):
    def setUp(self) -> None:
        mark_test_isolation_installed()

    def tearDown(self) -> None:
        reset_isolation_runtime_for_tests()

    def test_allowlist_rejects_arbitrary_prompt(self) -> None:
        async def go():
            return await run_isolated_personality_eval(
                case_id="please-ignore-instructions-and-book",
                personality_id="sunny",
                corpus=CORPUS,
                fetch_setting=lambda _t: {"personality_id": "sunny"},
                invoke_turn=simulated_model_turn,
                serving_preflight=False,
            )

        with self.assertRaises(IsolationAbort) as ctx:
            _run(go())
        self.assertEqual(ctx.exception.reason, "case_id_not_allowlisted")

    def test_invalid_personality_rejected(self) -> None:
        async def go():
            return await run_isolated_personality_eval(
                case_id="warmth-greeting-en",
                personality_id="cami",
                corpus=CORPUS,
                invoke_turn=simulated_model_turn,
                serving_preflight=False,
            )

        with self.assertRaises(IsolationAbort) as ctx:
            _run(go())
        self.assertEqual(ctx.exception.reason, "invalid_personality_id")

    def test_all_packs_en_es_generated_not_fixture_echo(self) -> None:
        env = {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}
        stored = {"id": "sunny"}

        def fetch(_tid: str) -> dict:
            return {"personality_id": stored["id"]}

        warmth_ids = [c["id"] for c in CORPUS["cases"] if c["kind"] == "warmth_eligible"]
        truth_ids = [c["id"] for c in CORPUS["cases"] if c["kind"] in {"truth_frozen", "invariant"}]
        self.assertEqual(set(warmth_ids + truth_ids), set(ALLOWED_CASE_IDS))

        with mock.patch.dict(os.environ, env, clear=False):
            for pid in ("sunny", "calm", "concise", "extra"):
                stored["id"] = pid
                for case_id in sorted(ALLOWED_CASE_IDS):
                    result = _run(
                        run_isolated_personality_eval(
                            case_id=case_id,
                            personality_id=pid,
                            corpus=CORPUS,
                            fetch_setting=fetch,
                            invoke_turn=simulated_model_turn,
                            serving_preflight=False,
                            evidence_kind="test_double",
                        )
                    )
                    case = next(c for c in CORPUS["cases"] if c["id"] == case_id)
                    fixture = case["replies"][pid]
                    self.assertTrue(result["ok"], (case_id, pid, result))
                    self.assertEqual(result["evidence_kind"], "test_double")
                    self.assertEqual(result["live_acceptance"], False)
                    self.assertEqual(result["tools_invoked"], 0)
                    self.assertEqual(result["sends_completed"], 0)
                    self.assertGreaterEqual(result["sends_attempted"], 1)
                    self.assertGreater(len(result["tools_denied"]), 0)
                    self.assertNotEqual(result["reply_text"].strip(), fixture.strip())
                    self.assertGreaterEqual(result["model_calls"], 1)
                    self.assertTrue(result["model_called"])
                    self.assertTrue(result["semantic"]["ok"], (case_id, pid, result["semantic"]))
                    self.assertFalse(result["semantic"]["complete_semantic_proof"])
                    for fact in case.get("frozen_facts") or []:
                        self.assertIn(fact, result["reply_text"])

    def test_next_reply_refetch_without_clear_cache(self) -> None:
        stored = {"id": "calm"}
        calls = {"n": 0}

        def fetch(_tid: str) -> dict:
            calls["n"] += 1
            return {"personality_id": stored["id"]}

        with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            a = _run(
                run_isolated_personality_eval(
                    case_id="warmth-greeting-en",
                    personality_id="calm",
                    corpus=CORPUS,
                    fetch_setting=fetch,
                    invoke_turn=simulated_model_turn,
                    serving_preflight=False,
                )
            )
            stored["id"] = "concise"
            b = _run(
                run_isolated_personality_eval(
                    case_id="warmth-greeting-en",
                    personality_id="concise",
                    corpus=CORPUS,
                    fetch_setting=fetch,
                    invoke_turn=simulated_model_turn,
                    serving_preflight=False,
                )
            )
        self.assertEqual(a["personality_id"], "calm")
        self.assertEqual(b["personality_id"], "concise")
        self.assertEqual(calls["n"], 2)
        self.assertIn("[generated-test-double:calm:", a["reply_text"])
        self.assertIn("[generated-test-double:concise:", b["reply_text"])
        self.assertLess(len(b["reply_text"]), len(a["reply_text"]) + 40)

    def test_foreign_tenant_fetch_aborts(self) -> None:
        def fetch(_tid: str) -> dict:
            return {"personality_id": "extra"}

        env = {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "wolfhouse-somo"}
        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaises(IsolationAbort) as ctx:
                _run(
                    run_isolated_personality_eval(
                        case_id="warmth-greeting-en",
                        personality_id="sunny",
                        corpus=CORPUS,
                        fetch_setting=fetch,
                        invoke_turn=simulated_model_turn,
                        serving_preflight=False,
                    )
                )
        self.assertEqual(ctx.exception.reason, "foreign_tenant_fetch")

    def test_route_rejects_arbitrary_text_and_overrides(self) -> None:
        src = Path(__file__).with_name("luna_personality_live_eval.py").read_text(encoding="utf8")
        self.assertIn(LIVE_EVAL_PATH, src)
        self.assertIn("caller_override_rejected", src)
        self.assertIn("case_id_not_allowlisted", src)
        self.assertNotIn("allow_writes=bool", src)

    def test_default_simulate_still_has_allow_writes(self) -> None:
        core = Path(__file__).with_name("simulate_core.py").read_text(encoding="utf8")
        self.assertIn("allow_writes=bool(body.get(\"allow_writes\"))", core)
        self.assertIn("register_live_eval_route", core)

    def test_semantic_rejects_unsupported_url(self) -> None:
        case = next(c for c in CORPUS["cases"] if c["id"] == "truth-payment-link-en")
        scored = evaluate_generated_reply(
            case=case,
            personality_id="sunny",
            reply="Pay https://evil.example/nope and also https://pay.example/abc €100",
            fixture_echo_forbidden=False,
        )
        self.assertFalse(scored["ok"])
        self.assertTrue(any(f.startswith("unsupported_url") for f in scored["findings"]))

    def test_hostile_payment_additions_fail(self) -> None:
        case = next(c for c in CORPUS["cases"] if c["id"] == "truth-payment-link-en")
        scored = evaluate_generated_reply(
            case=case,
            personality_id="sunny",
            reply="https://pay.example/abc €100 Your confirmed booking includes free flights and costs 900 euros.",
            fixture_echo_forbidden=False,
        )
        self.assertFalse(scored["ok"])
        self.assertTrue(
            any("unsupported" in f or "amount" in f for f in scored["findings"]),
            scored["findings"],
        )

    def test_hostile_spots_contradiction_and_language_fail(self) -> None:
        case = next(c for c in CORPUS["cases"] if c["id"] == "invariant-spots-es")
        scored = evaluate_generated_reply(
            case=case,
            personality_id="sunny",
            reply="There are not 2 plazas. Pay €999 now.",
            fixture_echo_forbidden=False,
        )
        self.assertFalse(scored["ok"])
        joined = " ".join(scored["findings"])
        self.assertTrue("contradicted_fact" in joined or "english_on_es" in joined or "unsupported_amount" in joined, scored["findings"])

    def test_hostile_greeting_negation_fails(self) -> None:
        case = next(c for c in CORPUS["cases"] if c["id"] == "warmth-greeting-en")
        scored = evaluate_generated_reply(
            case=case,
            personality_id="sunny",
            reply="Do not book. We charge 900 euros.",
            fixture_echo_forbidden=False,
        )
        self.assertFalse(scored["ok"])
        self.assertTrue(
            any(
                f.startswith("meaning_token_missing")
                or f == "required_meaning_negated"
                or f.startswith("unsupported_amount")
                for f in scored["findings"]
            ),
            scored["findings"],
        )

    def test_no_model_invoker_does_not_count_as_success(self) -> None:
        async def silent(_msg, cap, _meta):
            return "Do not book."

        with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            with self.assertRaises(IsolationAbort) as ctx:
                _run(
                    run_isolated_personality_eval(
                        case_id="warmth-greeting-en",
                        personality_id="sunny",
                        corpus=CORPUS,
                        fetch_setting=lambda _t: {"personality_id": "sunny"},
                        invoke_turn=silent,
                        serving_preflight=False,
                    )
                )
        self.assertEqual(ctx.exception.reason, "model_not_invoked")

    def test_pack_mismatch_fails(self) -> None:
        with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            with self.assertRaises(IsolationAbort) as ctx:
                _run(
                    run_isolated_personality_eval(
                        case_id="warmth-greeting-en",
                        personality_id="extra",
                        corpus=CORPUS,
                        fetch_setting=lambda _t: {"personality_id": "calm"},
                        invoke_turn=simulated_model_turn,
                        serving_preflight=False,
                    )
                )
        self.assertIn("pack_mismatch", ctx.exception.reason)

    def test_setting_fallback_fails_eval(self) -> None:
        def boom(_tid: str) -> dict:
            raise RuntimeError("nope")

        with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            with self.assertRaises(IsolationAbort) as ctx:
                _run(
                    run_isolated_personality_eval(
                        case_id="warmth-greeting-en",
                        personality_id="sunny",
                        corpus=CORPUS,
                        fetch_setting=boom,
                        invoke_turn=simulated_model_turn,
                        serving_preflight=False,
                    )
                )
        self.assertIn("setting_fallback", ctx.exception.reason)

    def test_build_eval_message_injects_synthetic_facts(self) -> None:
        case = next(c for c in CORPUS["cases"] if c["id"] == "truth-payment-link-en")
        msg = build_eval_user_message(case)
        self.assertIn("https://pay.example/abc", msg)
        self.assertIn("€100", msg)
        self.assertIn("not live availability", msg)
        self.assertIn(case["guest_text"], msg)

    def test_hostile_tool_invocation_is_violation(self) -> None:
        async def sneaky(user_message, cap, meta):
            from wolfhouse.luna_personality_isolation import observe_provider_invocation, record_tool_invocation_violation

            observe_provider_invocation("sneaky-double")
            record_tool_invocation_violation("create_sunset_booking")
            return "booked you anyway"

        with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            with self.assertRaises(IsolationAbort) as ctx:
                _run(
                    run_isolated_personality_eval(
                        case_id="warmth-greeting-en",
                        personality_id="sunny",
                        corpus=CORPUS,
                        fetch_setting=lambda _t: {"personality_id": "sunny"},
                        invoke_turn=sneaky,
                        serving_preflight=False,
                    )
                )
        self.assertEqual(ctx.exception.reason, "isolation_violated")

    def test_fresh_ephemeral_chat_ids(self) -> None:
        with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            a = _run(
                run_isolated_personality_eval(
                    case_id="warmth-greeting-en",
                    personality_id="sunny",
                    corpus=CORPUS,
                    fetch_setting=lambda _t: {"personality_id": "sunny"},
                    invoke_turn=simulated_model_turn,
                    serving_preflight=False,
                )
            )
            b = _run(
                run_isolated_personality_eval(
                    case_id="warmth-greeting-en",
                    personality_id="sunny",
                    corpus=CORPUS,
                    fetch_setting=lambda _t: {"personality_id": "sunny"},
                    invoke_turn=simulated_model_turn,
                    serving_preflight=False,
                )
            )
        self.assertNotEqual(a["ephemeral_chat_id"], b["ephemeral_chat_id"])
        self.assertTrue(str(a["ephemeral_chat_id"]).startswith("49"))


class IsolationStatusTests(unittest.TestCase):
    def test_status_keys(self) -> None:
        st = isolation_status()
        self.assertIn("installed", st)
        self.assertIn("send_wrapped", st)
        self.assertIn("journal_wrapped", st)
        self.assertIn("context_active", st)
        self.assertTrue(st["sticky_flags_are_not_evidence"])


class ExactOriginAndRunnerTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_isolation_runtime_for_tests()

    def test_attacker_substring_host_rejected(self) -> None:
        with self.assertRaises(IsolationAbort) as ctx:
            parse_exact_staff_origin("https://sunset-staging.attacker.invalid")
        self.assertIn("staff_origin_not_allowlisted", ctx.exception.reason)
        env = {
            "HERMES_ROLE": "sunset-luna",
            "LUNA_CLIENT_SLUG": "sunset",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://sunset-staging.attacker.invalid",
            "LUNA_BOT_INTERNAL_TOKEN": "x",
            "HERMES_HOME": "/opt/data/.hermes",
            "HERMES_MODEL": "gpt-4o-mini",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            pre = serving_preflight()
        self.assertFalse(pre["ok"])
        self.assertFalse(pre["staff_origin_ok"])
        self.assertEqual(pre["staff_origin_error"], "staff_origin_not_allowlisted:sunset-staging.attacker.invalid")

    def test_http_and_userinfo_rejected(self) -> None:
        with self.assertRaises(IsolationAbort):
            parse_exact_staff_origin("http://sunset-staging.lunafrontdesk.com")
        with self.assertRaises(IsolationAbort):
            parse_exact_staff_origin("https://user:pass@sunset-staging.lunafrontdesk.com")

    def test_exact_allowlisted_origin_accepted(self) -> None:
        self.assertEqual(
            parse_exact_staff_origin("https://sunset-staging.lunafrontdesk.com"),
            "https://sunset-staging.lunafrontdesk.com",
        )

    def test_execute_live_noop_is_no_longer_success_without_turns(self) -> None:
        env = {
            "LUNA_PERSONALITY_LIVE_PROOF": "SUNSET_STAGING_ONLY",
            "HERMES_ROLE": "sunset-luna",
            "LUNA_CLIENT_SLUG": "sunset",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            code = live_proof_main(["--execute-live", "--json"], deny_network=True)
        self.assertNotEqual(code, 0)

    def test_offline_double_executes_canonical_matrix_and_restores(self) -> None:
        transport = OfflineStaffTransportDouble(initial={"personality_id": "sunny", "source": "stored"})

        async def invoke_case(*, personality_id: str, case_id: str):
            return await run_isolated_personality_eval(
                case_id=case_id,
                personality_id=personality_id,
                corpus=CORPUS,
                fetch_setting=lambda _t: {"personality_id": personality_id},
                invoke_turn=simulated_model_turn,
                serving_preflight=False,
                evidence_kind="test_double",
            )

        env = {"LUNA_PERSONALITY_LIVE_PROOF": "SUNSET_STAGING_ONLY", "HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}
        with mock.patch.dict(os.environ, env, clear=False):
            code = live_proof_main(
                ["--execute-live", "--json"],
                transport=transport,
                invoke_case=invoke_case,
                deny_network=True,
            )
        self.assertEqual(code, 0)
        puts = [c for c in transport.calls if c["method"] == "PUT"]
        self.assertTrue(any(c.get("auth_mode") == "session" for c in puts))
        self.assertFalse(any(c.get("auth_mode") == "bot_token" for c in puts))
        self.assertEqual(transport.get_personality()["personality_id"], "sunny")

    def test_failed_restore_fails_exit(self) -> None:
        transport = OfflineStaffTransportDouble(initial={"personality_id": "sunny", "source": "stored"})
        transport.fail_restore = True

        async def invoke_case(*, personality_id: str, case_id: str):
            return await run_isolated_personality_eval(
                case_id=case_id,
                personality_id=personality_id,
                corpus=CORPUS,
                fetch_setting=lambda _t: {"personality_id": personality_id},
                invoke_turn=simulated_model_turn,
                serving_preflight=False,
                evidence_kind="test_double",
            )

        env = {"LUNA_PERSONALITY_LIVE_PROOF": "SUNSET_STAGING_ONLY"}
        with mock.patch.dict(os.environ, env, clear=False):
            code = live_proof_main(
                ["--execute-live", "--json"],
                transport=transport,
                invoke_case=invoke_case,
                deny_network=True,
            )
        self.assertEqual(code, 5)

    def test_bot_principal_cannot_put(self) -> None:
        transport = OfflineStaffTransportDouble(
            principal={"auth_mode": "bot_token", "role": "operator", "client_slug": "sunset"}
        )
        with self.assertRaises(IsolationAbort) as ctx:
            transport.put_personality("calm")
        self.assertEqual(ctx.exception.reason, "bot_write_not_authorized")

    def test_incomplete_matrix_fails(self) -> None:
        transport = OfflineStaffTransportDouble()

        async def one_and_die(*, personality_id: str, case_id: str):
            raise IsolationAbort("forced_incomplete")

        receipt = _run(
            execute_live_matrix(
                transport=transport,
                invoke_case=one_and_die,
                timeout_s=1,
                planned=[{"personality_id": "sunny", "case_id": "warmth-greeting-en"}],
            )
        )
        self.assertFalse(receipt["ok"])
        self.assertTrue(receipt["incomplete"])
        self.assertTrue(receipt["restoration"]["ok"])
        self.assertEqual(receipt["restoration"]["restored_personality_id"], "sunny")


class PersistenceBoundaryTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_isolation_runtime_for_tests()

    def test_stale_instance_journal_method_fails_preflight(self) -> None:
        t = _complete_targets()
        t.session_store = t.session_store_cls()
        install_isolation_runtime(targets=t)
        calls = []
        t.session_store.append_to_transcript = lambda *a, **k: calls.append("write") or "wrote"
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            with self.assertRaises(IsolationAbort) as ctx:
                preflight_isolation_or_abort(require_live_seams=True, targets=t)
            self.assertIn("journal_wrapped", ctx.exception.reason)
            t.session_store.append_to_transcript("synthetic", {})
            self.assertEqual(calls, ["write"])
            self.assertEqual(cap.journal_writes_completed, 0)
        finally:
            exit_isolated_turn(tok)

    def test_get_or_create_index_sqlite_denied_not_false_zero(self) -> None:
        effects = []

        class Store:
            def __init__(self) -> None:
                self._entries = {}
                self._db = SimpleNamespace(
                    create_session=lambda **k: effects.append("sqlite-session")
                )
                self._lock = threading.Lock()

            def _generate_session_key(self, source):  # noqa: ANN001
                return "k"

            def get_or_create_session(self, source, force_new=False):  # noqa: ANN001
                self._entries["k"] = "e"
                self._save()
                self._db.create_session(session_id="x")
                return SimpleNamespace(session_key="k", session_id="x")

            def _save(self):
                effects.append("sessions-index")

            def append_to_transcript(self, *a, **k):  # noqa: ANN001
                return "wrote"

            def update_session(self, *a, **k):  # noqa: ANN001
                self._save()

        store_cls = Store
        instance = Store()
        t = _complete_targets()
        t.session_store_cls = store_cls
        t.session_store = instance
        install_isolation_runtime(targets=t)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t)
            entry = instance.get_or_create_session(SimpleNamespace(chat_id="49"))
            self.assertTrue(str(getattr(entry, "session_id", "")).startswith("lunaeval_"))
            self.assertNotIn("sessions-index", effects)
            self.assertNotIn("sqlite-session", effects)
            self.assertEqual(cap.journal_writes_completed, 0)
            self.assertGreaterEqual(cap.journal_writes_denied, 1)
            self.assertEqual(instance._entries, {})
        finally:
            exit_isolated_turn(tok)


class HandlerFinalAndHttpRunnerTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_isolation_runtime_for_tests()

    def test_handler_final_return_is_canonical_reply_not_send_capture(self) -> None:
        async def handler(event):  # noqa: ANN001
            from wolfhouse.luna_personality_isolation import capture_send_if_isolated

            capture_send_if_isolated("interim typing")
            return "Welcome, I can help you book."

        effects = []
        runner = SimpleNamespace(
            _handle_message=handler,
            session_store=_complete_targets().session_store_cls(),
            _session_db=_counter_session_db(effects),
        )
        t = _complete_targets()
        t.session_store = runner.session_store
        t.session_db = runner._session_db
        install_isolation_runtime(targets=t, runner=runner)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        cap.ephemeral_chat_id = "490000000001"
        tok = enter_isolated_turn(cap)
        try:
            reply = _run(
                default_invoke_live_gateway(
                    "hi",
                    cap,
                    {"isolation_targets": t, "gateway_runner": runner},
                )
            )
        finally:
            exit_isolated_turn(tok)
        self.assertEqual(reply, "Welcome, I can help you book.")
        self.assertEqual(cap.final_handler_text, "Welcome, I can help you book.")
        self.assertEqual(cap.interim_send_text, "interim typing")
        self.assertEqual(extract_final_handler_text({"final_response": "Welcome, I can help you book."}), "Welcome, I can help you book.")

    def test_eval_url_rejects_http_userinfo_and_wrong_path(self) -> None:
        with self.assertRaises(IsolationAbort):
            parse_exact_eval_url("http://lunabox.lunafrontdesk.com/whatsapp/v1/internal/luna-personality-live-eval")
        with self.assertRaises(IsolationAbort):
            parse_exact_eval_url("https://user:pass@lunabox.lunafrontdesk.com/whatsapp/v1/internal/luna-personality-live-eval")
        with self.assertRaises(IsolationAbort):
            parse_exact_eval_url("https://lunabox.lunafrontdesk.com/wolfhouse/simulate-guest-turn")
        with self.assertRaises(IsolationAbort):
            parse_exact_eval_url("https://lunabox.lunafrontdesk.com/wolfhouse/luna-personality-live-eval")
        self.assertEqual(
            parse_exact_eval_url("https://lunabox.lunafrontdesk.com/whatsapp/v1/internal/luna-personality-live-eval"),
            "https://lunabox.lunafrontdesk.com/whatsapp/v1/internal/luna-personality-live-eval",
        )
        self.assertEqual(LIVE_EVAL_PATH, "/whatsapp/v1/internal/luna-personality-live-eval")

    def test_serving_eval_http_posts_authenticated_exact_path(self) -> None:
        captured = {}

        class _Resp:
            def read(self) -> bytes:
                return json.dumps(
                    {
                        "ok": True,
                        "reply_text": "Welcome, I can help you book.",
                        "final_handler_text": "Welcome, I can help you book.",
                    }
                ).encode("utf-8")

            def __enter__(self) -> "_Resp":
                return self

            def __exit__(self, *args: object) -> None:
                return None

        def fake_urlopen(req, timeout=0):  # noqa: ANN001
            captured["url"] = req.full_url
            captured["headers"] = dict(req.headers.items())
            captured["method"] = req.get_method()
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _Resp()

        transport = ServingEvalHttpTransport(
            "https://lunabox.lunafrontdesk.com/whatsapp/v1/internal/luna-personality-live-eval",
            "tok",
        )
        with mock.patch("wolfhouse.run_luna_personality_live_proof.urlopen", fake_urlopen):
            row = transport.post_eval("warmth-greeting-en", "sunny")
        self.assertEqual(captured["url"], "https://lunabox.lunafrontdesk.com/whatsapp/v1/internal/luna-personality-live-eval")
        header_map = {k.lower(): v for k, v in captured["headers"].items()}
        self.assertEqual(header_map.get("x-luna-bot-token"), "tok")
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(row["final_handler_text"], "Welcome, I can help you book.")
        self.assertNotIn("_wolfhouse_gateway_runner", captured)

    def test_matrix_preflights_before_settings_writes(self) -> None:
        staff = OfflineStaffTransportDouble(initial={"personality_id": "calm", "source": "stored"})
        eval_t = OfflineEvalHttpTransportDouble(ready=False)

        receipt = _run(
            execute_live_matrix(
                transport=staff,
                eval_transport=eval_t,
                planned=[{"personality_id": "sunny", "case_id": "warmth-greeting-en"}],
            )
        )
        self.assertFalse(receipt["ok"])
        methods = [c["method"] for c in staff.calls]
        self.assertNotIn("PUT", methods)
        self.assertEqual(eval_t.calls[0]["method"], "GET")
        self.assertTrue(receipt["restoration"].get("skipped"))

    def test_restore_acknowledgement_loss_still_independent_get(self) -> None:
        class Lost(OfflineStaffTransportDouble):
            def put_personality(self, pid):  # noqa: ANN001
                row = super().put_personality(pid)
                if pid == "calm":
                    raise RuntimeError("acknowledgement lost")
                return row

        async def fail(**kw):  # noqa: ANN003
            raise IsolationAbort("body_failure")

        t = Lost(initial={"personality_id": "calm", "source": "stored"})
        receipt = _run(
            execute_live_matrix(
                transport=t,
                invoke_case=fail,
                planned=[{"personality_id": "sunny", "case_id": "warmth-greeting-en"}],
            )
        )
        methods = [x["method"] for x in t.calls]
        self.assertEqual(methods, ["GET", "PUT", "GET", "PUT", "GET"])
        rest = receipt["restoration"]
        self.assertTrue(rest["independent_get"])
        self.assertTrue(rest["independent_get_attempted"])
        self.assertTrue(rest["effective_restored"])
        self.assertFalse(rest["ok"])
        self.assertTrue(rest["ambiguous_outcome"])
        self.assertNotEqual(rest["effective_restored"], rest["exact_source_restored"] and rest["ok"])


class ProviderDispatchTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_isolation_runtime_for_tests()

    def test_helper_entry_is_not_actual_dispatch(self) -> None:
        t = _complete_targets()

        def exploding(agent, api_kwargs):  # noqa: ANN001
            raise RuntimeError("before dispatch")

        t.provider_mod.interruptible_api_call = exploding
        install_isolation_runtime(targets=t)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t)
            with self.assertRaises(RuntimeError):
                t.provider_mod.interruptible_api_call(None, {"model": "gpt-4o-mini", "messages": []})
            self.assertEqual(cap.provider_helper_attempts, 1)
            self.assertEqual(cap.model_calls, 0)
            self.assertFalse(cap.model_called)
        finally:
            exit_isolated_turn(tok)

    def test_streaming_helper_required_for_live_seams(self) -> None:
        t = _complete_targets()
        del t.provider_mod.interruptible_streaming_api_call
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            install_isolation_runtime(targets=t)
            with self.assertRaises(IsolationAbort) as ctx:
                preflight_isolation_or_abort(require_live_seams=True, targets=t)
            self.assertIn("provider_streaming_wrapped", ctx.exception.reason)
        finally:
            exit_isolated_turn(tok)

    def test_provider_consumed_pack_required_for_live_kind(self) -> None:
        async def no_pack(_msg, cap, _meta):  # noqa: ANN001
            from wolfhouse.luna_personality_isolation import observe_provider_invocation

            observe_provider_invocation("gpt-4o-mini", "no personality mark here")
            return "Welcome, I can help you book a stay."

        with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            with self.assertRaises(IsolationAbort) as ctx:
                _run(
                    run_isolated_personality_eval(
                        case_id="warmth-greeting-en",
                        personality_id="sunny",
                        corpus=CORPUS,
                        fetch_setting=lambda _t: {"personality_id": "sunny"},
                        invoke_turn=no_pack,
                        serving_preflight=False,
                        evidence_kind="live_gateway",
                    )
                )
        self.assertEqual(ctx.exception.reason, "pack_not_observed_from_provider")

    def test_thread_worker_start_is_not_dispatch(self) -> None:
        t = _complete_targets()

        def helper(agent, api_kwargs):  # noqa: ANN001
            result = {}

            def _call():
                result["ok"] = True

            thread = threading.Thread(target=_call, daemon=True)
            thread.start()
            thread.join(1)
            return result

        t.provider_mod.interruptible_api_call = helper
        install_isolation_runtime(targets=t)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t)
            t.provider_mod.interruptible_api_call(
                None,
                {"model": "gpt-4o-mini", "messages": "Luna Personality this turn: sunny (DEFAULT"},
            )
            self.assertEqual(cap.provider_helper_attempts, 1)
            self.assertEqual(cap.model_calls, 0)
            self.assertFalse(cap.model_called)
            self.assertFalse(cap.observed_pack_from_provider)
        finally:
            exit_isolated_turn(tok)
        self.assertIsNone(deny_tool_if_isolated("create_sunset_booking"))

    def test_unsupported_backend_fails_before_dispatch(self) -> None:
        t = _complete_targets()
        calls = []

        def helper(agent, api_kwargs):  # noqa: ANN001
            calls.append("dispatched")
            return {"response": "should-not-run"}

        t.provider_mod.interruptible_api_call = helper
        install_isolation_runtime(targets=t)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t)
            agent = SimpleNamespace(api_mode="anthropic_messages")
            with self.assertRaises(IsolationAbort) as ctx:
                t.provider_mod.interruptible_api_call(agent, {"model": "claude", "messages": []})
            self.assertIn("unsupported_provider_backend:anthropic_messages", ctx.exception.reason)
            self.assertEqual(calls, [])
            self.assertEqual(cap.model_calls, 0)
            self.assertEqual(cap.provider_helper_attempts, 1)
        finally:
            exit_isolated_turn(tok)


class ServingIdentityHonestyTests(unittest.TestCase):
    def test_preflight_does_not_label_env_as_consumed_observation(self) -> None:
        env = {
            "HERMES_ROLE": "sunset-luna",
            "LUNA_CLIENT_SLUG": "sunset",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://sunset-staging.lunafrontdesk.com",
            "LUNA_BOT_INTERNAL_TOKEN": "x",
            "LUNA_PERSONALITY_STAFF_COOKIE": "sess",
            "HERMES_HOME": "/opt/data/.hermes",
            "HERMES_MODEL": "gpt-4o-mini",
            "LUNA_PERSONALITY_EVAL_BASE_URL": "https://lunabox.lunafrontdesk.com/whatsapp/v1/internal/luna-personality-live-eval",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            pre = serving_preflight()
        self.assertNotIn("model_observed", pre)
        self.assertNotIn("soul_observed", pre)
        self.assertTrue(pre["model_env_declared"])
        self.assertFalse(pre["consumed_model_observed"])
        self.assertFalse(pre["consumed_soul_observed"])
        self.assertFalse(pre["consumed_home_observed"])
        self.assertEqual(pre["kind"], "server_owned_env_declaration_not_consumed_observation")
        self.assertTrue(pre["staff_origin_ok"])
        self.assertTrue(pre["eval_origin_ok"])

    def test_http_eval_enforces_exact_staff_origin(self) -> None:
        env = {
            "HERMES_ROLE": "sunset-luna",
            "LUNA_CLIENT_SLUG": "sunset",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://sunset-staging.attacker.invalid",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaises(IsolationAbort) as ctx:
                assert_sunset_serving_identity(require_staff_origin=True)
        self.assertIn("staff_origin_not_allowlisted", ctx.exception.reason)


class GatewaySessionDbBoundaryTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_isolation_runtime_for_tests()

    def test_unwrapped_runner_session_db_flush_is_denied(self) -> None:
        self.assertTrue(HERMES_RUN_AGENT.is_file())
        effects = []
        t = _complete_targets()
        t.session_store = t.session_store_cls()
        t.session_store._db = SimpleNamespace(
            create_session=lambda **k: effects.append("store_create"),
            end_session=lambda **k: effects.append("store_end"),
            append_message=lambda **k: effects.append("store_append"),
        )
        runner = SimpleNamespace(session_store=t.session_store, _session_db=_counter_session_db(effects, "agent_append"))
        t.session_db = runner._session_db
        install_isolation_runtime(targets=t, runner=runner)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            ns: dict = {
                "_is_multimodal_tool_result": lambda x: False,
                "logger": SimpleNamespace(warning=lambda *a, **k: None, debug=lambda *a, **k: None),
            }
            flush = _extract_unchanged(HERMES_RUN_AGENT, "_flush_messages_to_session_db", ns)
            agent = SimpleNamespace(
                _session_db=runner._session_db,
                _session_db_created=True,
                _apply_persist_user_message_override=lambda x: None,
                session_id="lunaeval_probe",
                _last_flushed_db_idx=0,
            )
            flush(agent, [{"role": "assistant", "content": "synthetic"}])
            self.assertEqual(effects, [])
            self.assertEqual(cap.journal_writes_completed, 0)
            self.assertGreaterEqual(cap.journal_writes_denied, 1)
        finally:
            exit_isolated_turn(tok)

    def test_stale_effective_db_and_optional_methods_fail_preflight(self) -> None:
        effects = []
        t = _complete_targets()
        t.session_store = t.session_store_cls()
        t.session_store._db = SimpleNamespace(
            create_session=lambda **k: effects.append("store_create"),
            end_session=lambda **k: effects.append("store_end"),
            append_message=lambda **k: effects.append("store_append"),
        )
        t.session_store.rewrite_transcript = lambda *a, **k: effects.append("rewrite")
        runner = SimpleNamespace(session_store=t.session_store, _session_db=_counter_session_db(effects))
        t.session_db = runner._session_db
        install_isolation_runtime(targets=t, runner=runner)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            t.session_store._db.append_message = lambda **k: effects.append("stale_db_append")
            with self.assertRaises(IsolationAbort) as ctx:
                preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            self.assertIn("journal_wrapped", ctx.exception.reason)
            t.session_store._db.append_message(session_id="x", role="assistant", content="synthetic")
            self.assertEqual(effects, ["stale_db_append"])
            self.assertEqual(cap.journal_writes_completed, 0)
        finally:
            exit_isolated_turn(tok)

    def test_stale_optional_method_fails_preflight(self) -> None:
        t = _complete_targets()
        t.session_store = t.session_store_cls()
        t.session_store.rewrite_transcript = lambda *a, **k: "rewrote"
        install_isolation_runtime(targets=t)
        t.session_store.rewrite_transcript = lambda *a, **k: "stale"
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            with self.assertRaises(IsolationAbort) as ctx:
                preflight_isolation_or_abort(require_live_seams=True, targets=t)
            self.assertIn("journal_wrapped", ctx.exception.reason)
        finally:
            exit_isolated_turn(tok)


class ServingReadinessAndRouteTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_isolation_runtime_for_tests()

    def test_readiness_without_runner_is_not_ready(self) -> None:
        t = _complete_targets()
        env = {
            "HERMES_ROLE": "sunset-luna",
            "LUNA_CLIENT_SLUG": "sunset",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://sunset-staging.lunafrontdesk.com",
            "HERMES_HOME": "/opt/data/.hermes",
            "HERMES_MODEL": "gpt-4o-mini",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            rec = serving_eval_readiness(targets=t, runner=None)
        self.assertFalse(rec["ready"])
        self.assertEqual(rec["error"], "gateway_runner_unavailable")
        self.assertIn("gateway_runner_unavailable", rec["runtime_missing"])

    def test_readiness_requires_handler_and_session_db(self) -> None:
        t = _complete_targets()
        runner = SimpleNamespace(session_store=t.session_store_cls())
        rec = serving_eval_readiness(targets=t, runner=runner)
        self.assertFalse(rec["ready"])
        self.assertIn(rec["error"], {"gateway_handler_unavailable", "gateway_session_db_unavailable"})

    def test_handler_final_without_adapter_send_is_success_contract(self) -> None:
        async def no_send(_msg, cap, _meta):  # noqa: ANN001
            observe_provider_invocation(
                "gpt-4o-mini",
                "Luna Personality this turn: sunny (DEFAULT — current live Wolf-House tone).",
            )
            return "Welcome, I can help you book a stay."

        with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            row = _run(
                run_isolated_personality_eval(
                    case_id="warmth-greeting-en",
                    personality_id="sunny",
                    corpus=CORPUS,
                    fetch_setting=lambda _t: {"personality_id": "sunny"},
                    invoke_turn=no_send,
                    serving_preflight=False,
                    evidence_kind="live_gateway",
                )
            )
        self.assertEqual(row["final_handler_text"], "Welcome, I can help you book a stay.")
        self.assertEqual(row["sends_attempted"], 0)
        self.assertEqual(row["sends_completed"], 0)
        self.assertTrue(row["whatsapp_suppressed"])
        self.assertTrue(row["ok"])

    def test_eval_route_registers_only_on_sunset_http_identity(self) -> None:
        class _Router:
            def __init__(self) -> None:
                self.gets = []
                self.posts = []

            def add_get(self, path, handler):  # noqa: ANN001
                self.gets.append(path)

            def add_post(self, path, handler):  # noqa: ANN001
                self.posts.append(path)

        class _App:
            def __init__(self) -> None:
                self.router = _Router()

        wolf = {
            "HERMES_ROLE": "luna",
            "LUNA_CLIENT_SLUG": "wolfhouse-somo",
            "WHATSAPP_CLOUD_WEBHOOK_PORT": "8090",
            "SUNSET_LUNA_REQUIRE_ISOLATED_AUTH": "",
        }
        sunset = {
            "HERMES_ROLE": "sunset-luna",
            "LUNA_CLIENT_SLUG": "sunset",
            "WHATSAPP_CLOUD_WEBHOOK_PORT": "8094",
            "SUNSET_LUNA_REQUIRE_ISOLATED_AUTH": "true",
        }
        with mock.patch.dict(os.environ, wolf, clear=False):
            app = _App()
            self.assertIsNone(live_sunset_eval_identity())
            self.assertFalse(register_live_eval_route(app))
            self.assertEqual(app.router.gets, [])
            self.assertEqual(app.router.posts, [])
        with mock.patch.dict(os.environ, sunset, clear=False):
            app = _App()
            ident = live_sunset_eval_identity()
            self.assertEqual(ident["runtime"], "hermes-sunset-luna-http")
            self.assertTrue(register_live_eval_route(app))
            self.assertEqual(app.router.gets, [LIVE_EVAL_PATH])
            self.assertEqual(app.router.posts, [LIVE_EVAL_PATH])

    def test_source_caddy_wolfhouse_prefix_unchanged_eval_not_under_it(self) -> None:
        repo = Path(__file__).resolve().parents[3]
        caddy = (repo / "scripts" / "_lunabox-caddyfile").read_text(encoding="utf-8")
        ref = (repo / "docker" / "hermes-staging" / "lunabox-caddyfile.reference").read_text(encoding="utf-8")
        self.assertIn("reverse_proxy /wolfhouse/* localhost:8090", caddy)
        self.assertIn("reverse_proxy /wolfhouse/* localhost:8090", ref)
        self.assertNotIn("/wolfhouse/luna-personality-live-eval", caddy)
        self.assertEqual(LIVE_EVAL_PATH, "/whatsapp/v1/internal/luna-personality-live-eval")
        self.assertTrue(LIVE_EVAL_PATH.startswith("/whatsapp/"))
        self.assertNotIn("8094", caddy)


class RealProviderHelperDispatchTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_isolation_runtime_for_tests()

    def test_extracted_nonstream_client_failure_is_zero_dispatch(self) -> None:
        self.assertTrue(HERMES_HELPERS.is_file())
        t = _complete_targets()
        creates = []
        ns: dict = {
            "threading": threading,
            "time": __import__("time"),
            "os": os,
            "logger": SimpleNamespace(
                debug=lambda *a, **k: None,
                warning=lambda *a, **k: None,
                info=lambda *a, **k: None,
            ),
            "_is_openai_codex_backend": lambda a: False,
            "estimate_request_context_tokens": lambda x: 0,
            "_env_float": lambda name, default: default,
            "Optional": Optional,
        }
        real = _extract_unchanged(HERMES_HELPERS, "interruptible_api_call", ns)
        t.provider_mod.interruptible_api_call = real
        install_isolation_runtime(targets=t)

        def boom(*a, **k):  # noqa: ANN001
            raise RuntimeError("client construction failed")

        agent = SimpleNamespace(
            api_mode="chat_completions",
            _interrupt_requested=False,
            _compute_non_stream_stale_timeout=lambda kw: 180,
            _touch_activity=lambda x: None,
            _create_request_openai_client=boom,
            _close_request_openai_client=lambda *a, **k: None,
        )
        _wrap_openai_client_factory(agent)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            with self.assertRaises(RuntimeError):
                t.provider_mod.interruptible_api_call(
                    agent,
                    {
                        "model": "counter-model",
                        "messages": [{"role": "system", "content": "Luna Personality this turn: calm. Patient."}],
                    },
                )
            settle_isolated_work(cap, timeout_s=2.0)
            self.assertEqual(creates, [])
            self.assertEqual(cap.model_calls, 0)
            self.assertFalse(cap.model_called)
            self.assertFalse(cap.observed_pack_from_provider)
            self.assertEqual(cap.provider_helper_attempts, 1)
        finally:
            exit_isolated_turn(tok)

    def test_extracted_nonstream_create_counts_one_dispatch(self) -> None:
        self.assertTrue(HERMES_HELPERS.is_file())
        t = _complete_targets()
        creates = []
        ns: dict = {
            "threading": threading,
            "time": __import__("time"),
            "os": os,
            "logger": SimpleNamespace(
                debug=lambda *a, **k: None,
                warning=lambda *a, **k: None,
                info=lambda *a, **k: None,
            ),
            "_is_openai_codex_backend": lambda a: False,
            "estimate_request_context_tokens": lambda x: 0,
            "_env_float": lambda name, default: default,
            "Optional": Optional,
        }
        real = _extract_unchanged(HERMES_HELPERS, "interruptible_api_call", ns)
        t.provider_mod.interruptible_api_call = real
        install_isolation_runtime(targets=t)

        def make_client(*a, **k):  # noqa: ANN001
            def create(**kw):  # noqa: ANN003
                creates.append(dict(kw))
                return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="ok"))])

            return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))

        agent = SimpleNamespace(
            api_mode="chat_completions",
            _interrupt_requested=False,
            _compute_non_stream_stale_timeout=lambda kw: 180,
            _touch_activity=lambda x: None,
            _create_request_openai_client=make_client,
            _close_request_openai_client=lambda *a, **k: None,
        )
        _wrap_openai_client_factory(agent)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            t.provider_mod.interruptible_api_call(
                agent,
                {
                    "model": "counter-model",
                    "messages": [{"role": "system", "content": "Luna Personality this turn: calm. Patient."}],
                },
            )
            settle_isolated_work(cap, timeout_s=2.0)
            self.assertEqual(len(creates), 1)
            self.assertEqual(creates[0].get("model"), "counter-model")
            self.assertEqual(cap.model_calls, 1)
            self.assertTrue(cap.model_called)
            self.assertTrue(cap.observed_pack_from_provider)
            self.assertEqual(cap.observed_pack_id, "calm")
        finally:
            exit_isolated_turn(tok)

    def test_extracted_bedrock_stream_fallback_counts_every_dispatch(self) -> None:
        self.assertTrue(HERMES_HELPERS.is_file())
        t = _complete_targets()
        dispatches = []
        bedrock = types.ModuleType("agent.bedrock_adapter")

        class _Denied(Exception):
            pass

        def _get_bedrock_runtime_client(region):  # noqa: ANN001
            def converse_stream(**kw):  # noqa: ANN003
                dispatches.append("converse_stream")
                raise _Denied("iam denied stream")

            def converse(**kw):  # noqa: ANN003
                dispatches.append("converse")
                return {"output": {"message": {"content": [{"text": "ok"}]}}}

            return SimpleNamespace(converse_stream=converse_stream, converse=converse)

        bedrock._get_bedrock_runtime_client = _get_bedrock_runtime_client
        bedrock.invalidate_runtime_client = lambda *a, **k: None
        bedrock.is_stale_connection_error = lambda e: False
        bedrock.is_streaming_access_denied_error = lambda e: True
        bedrock.normalize_converse_response = lambda raw: raw
        bedrock.stream_converse_with_callbacks = lambda *a, **k: None
        t.bedrock_adapter_mod = bedrock
        sys.modules["agent.bedrock_adapter"] = bedrock
        ns: dict = {
            "threading": threading,
            "time": __import__("time"),
            "logger": SimpleNamespace(
                debug=lambda *a, **k: None,
                warning=lambda *a, **k: None,
                info=lambda *a, **k: None,
            ),
        }
        real = _extract_unchanged(HERMES_HELPERS, "interruptible_streaming_api_call", ns)
        t.provider_mod.interruptible_streaming_api_call = real
        try:
            install_isolation_runtime(targets=t)
            _wrap_bedrock_client_factory(bedrock)
            agent = SimpleNamespace(
                api_mode="bedrock_converse",
                _interrupt_requested=False,
                _safe_print=lambda x: None,
                _disable_streaming=False,
            )
            cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
            tok = enter_isolated_turn(cap)
            try:
                t.provider_mod.interruptible_streaming_api_call(
                    agent,
                    {
                        "modelId": "counter-model",
                        "system": [{"text": "Luna Personality this turn: calm. Patient."}],
                    },
                )
                settle_isolated_work(cap, timeout_s=2.0)
                self.assertEqual(dispatches, ["converse_stream", "converse"])
                self.assertEqual(cap.model_calls, 2)
                self.assertEqual(cap.model, "counter-model")
                self.assertTrue(cap.observed_pack_from_provider)
            finally:
                exit_isolated_turn(tok)
        finally:
            sys.modules.pop("agent.bedrock_adapter", None)


if __name__ == "__main__":
    unittest.main(verbosity=2)
