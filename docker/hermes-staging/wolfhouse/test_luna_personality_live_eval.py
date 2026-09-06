"""Fail-closed isolated live-model corpus path (no send, no business tools)."""

from __future__ import annotations

import asyncio
import gc
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import textwrap
import threading
import types
import unittest
import weakref
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
    INSTALLED_CORPUS_PATH,
    LIVE_EVAL_PATH,
    assert_sunset_serving_identity,
    build_eval_user_message,
    corpus_candidates,
    default_invoke_live_gateway,
    evaluate_generated_reply,
    extract_final_handler_text,
    live_sunset_eval_identity,
    load_corpus,
    register_live_eval_route,
    run_isolated_personality_eval,
    serving_eval_readiness,
    simulated_model_turn,
    _corpus_path,
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

    class _AgentCls:
        api_mode = "chat_completions"

        def _persist_session(self, *a, **k):  # noqa: ANN001
            return None

        def _save_session_log(self, *a, **k):  # noqa: ANN001
            return None

        def _flush_messages_to_session_db(self, *a, **k):  # noqa: ANN001
            return None

        def run_conversation(self, *a, **k):  # noqa: ANN001
            return {"final_response": "ok"}

        def chat(self, *a, **k):  # noqa: ANN001
            return "ok"

        def _run_codex_app_server_turn(self, **k):  # noqa: ANN003
            return {"final_response": "codex"}

        def _run_codex_stream(self, *a, **k):  # noqa: ANN001
            return None

        def _run_codex_create_stream_fallback(self, *a, **k):  # noqa: ANN001
            return None

        def _anthropic_messages_create(self, *a, **k):  # noqa: ANN001
            return None

        def switch_model(self, *a, **k):  # noqa: ANN001
            return None

        def _create_request_openai_client(self, *a, **k):  # noqa: ANN001
            return _FactoryOwner()._create_request_openai_client()

    mirror = types.ModuleType("isolation_double_mirror")
    mirror.mirror_whatsapp_thread = lambda *a, **k: None
    mirror.enqueue_mirror_payload = lambda *a, **k: True
    mirror.get_mirror_queue = lambda: SimpleNamespace(enqueue=lambda p: True, _deliver=lambda item: None)
    mirror._post_mirror_sync = lambda p: {}
    mirror.mirror_whatsapp_outbound_after_send = lambda *a, **k: None
    mirror.mirror_whatsapp_outbound_as_draft = lambda *a, **k: {"staged": False}
    mirror.mirror_raw_inbound = lambda *a, **k: None

    class _MirrorQueue:
        def enqueue(self, payload):  # noqa: ANN001
            return True

        def _deliver(self, item):  # noqa: ANN001
            return None

    mirror.MirrorQueue = _MirrorQueue

    loop_mod = types.ModuleType("isolation_double_loop")
    loop_mod.run_conversation = lambda agent, *a, **k: {"final_response": "ok"}
    codex_mod = types.ModuleType("isolation_double_codex")
    codex_mod.run_codex_app_server_turn = lambda agent, **k: {"final_response": "codex"}
    bedrock = types.ModuleType("isolation_double_bedrock")
    bedrock._get_bedrock_runtime_client = lambda region: SimpleNamespace(
        converse=lambda **k: {},
        converse_stream=lambda **k: {},
    )
    atomic = types.ModuleType("isolation_double_atomic")
    atomic.atomic_json_write = lambda *a, **k: None

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
        agent_cls=_AgentCls,
        mirror_mod=mirror,
        conversation_loop_mod=loop_mod,
        codex_runtime_mod=codex_mod,
        bedrock_adapter_mod=bedrock,
        atomic_json_mod=atomic,
    )


def _counter_session_db(effects, label="agent_append"):  # noqa: ANN001
    return SimpleNamespace(
        create_session=lambda **k: effects.append(f"{label}:create") or None,
        end_session=lambda **k: effects.append(f"{label}:end") or None,
        append_message=lambda **k: effects.append(label) or None,
        update_token_counts=lambda **k: effects.append(f"{label}:tokens") or None,
        _execute_write=lambda fn: effects.append(f"{label}:exec") or fn(None),
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
HERMES_LOOP = Path("/opt/hermes/agent/conversation_loop.py")
HERMES_GATEWAY = Path("/opt/hermes/gateway/run.py")
HERMES_STATE = Path("/opt/hermes/hermes_state.py")
HERMES_WHATSAPP = Path("/opt/hermes/gateway/platforms/whatsapp_cloud.py")
CANONICAL_MIRROR = STAGING / "wolfhouse_whatsapp_mirror.py"


def _extract_if_branch(path: Path, needle: str, fn_name: str, arg_names: list, namespace: dict):
    """Compile an unchanged AST If from production source into a tiny function."""
    import ast
    import __future__

    src = path.read_text(encoding="utf-8")
    tree = ast.parse(src)
    node = None
    for cand in ast.walk(tree):
        if not isinstance(cand, ast.If):
            continue
        try:
            text = ast.get_source_segment(src, cand.test) or ast.unparse(cand.test)
        except Exception:
            text = ""
        if needle in text:
            node = cand
            break
    if node is None:
        raise AssertionError(f"no If containing {needle!r} in {path}")
    has_await = any(isinstance(child, ast.Await) for child in ast.walk(node))
    fn_cls = ast.AsyncFunctionDef if has_await else ast.FunctionDef
    fn = fn_cls(
        name=fn_name,
        args=ast.arguments(
            posonlyargs=[],
            args=[ast.arg(arg=name) for name in arg_names],
            kwonlyargs=[],
            kw_defaults=[],
            defaults=[],
            vararg=None,
            kwarg=None,
        ),
        body=[node],
        decorator_list=[],
        returns=None,
    )
    ast.fix_missing_locations(fn)
    exec(
        compile(
            ast.Module(body=[fn], type_ignores=[]),
            str(path),
            "exec",
            flags=__future__.annotations.compiler_flag,
        ),
        namespace,
    )
    return namespace[fn_name]


def _runner_with_db(t, effects=None):  # noqa: ANN001
    effects = effects if effects is not None else []
    t.session_store = t.session_store_cls()
    db = _counter_session_db(effects)
    t.session_store._db = db
    t.session_db = db
    runner = SimpleNamespace(
        session_store=t.session_store,
        _session_db=db,
        adapters={},
        _agent_cache={},
        _running_agents={},
        _handle_message=lambda event: "final",
    )
    return runner, effects


def _eval_source_event():
    source = SimpleNamespace(user_id="491234567890", chat_id="491234567890", user_name="Eval")
    event = SimpleNamespace(
        metadata={},
        message_id="wamid.eval",
        timestamp=None,
        message_type="text",
        text="hello from eval",
    )
    return source, event


def _exec_unchanged_inbound_mirror(source, event, message_text):
    """Execute the unchanged bootstrap fragment with only the deploy path redirected."""
    import apply_gateway_patches as patches

    fragment = patches.INBOUND_MIRROR
    if "spec_from_file_location" not in fragment or "module_from_spec" not in fragment or "exec_module" not in fragment:
        raise AssertionError("INBOUND_MIRROR bootstrap fragment is not the dynamic loader")
    redirected = fragment.replace(
        "/etc/hermes-staging/wolfhouse_whatsapp_mirror.py",
        str(CANONICAL_MIRROR),
    )
    if redirected == fragment:
        raise AssertionError("failed to redirect only the deployment mirror path")
    ns = {"source": source, "event": event, "message_text": message_text}
    exec(compile(textwrap.dedent(redirected), "INBOUND_MIRROR", "exec"), ns, ns)
    return ns


def _install_fresh_queue_counter(effects, fresh):
    """Replace only the fresh module's get_mirror_queue after the real loader exec.

    Chains onto the isolation-wrapped spec_from_file_location so the unchanged
    bootstrap fragment still uses the real dynamic module loader.
    """
    orig_spec = importlib.util.spec_from_file_location

    def spec_from_file_location(name, location=None, *args, **kwargs):  # noqa: ANN001
        spec = orig_spec(name, location, *args, **kwargs)
        loader = getattr(spec, "loader", None)
        orig_exec = getattr(loader, "exec_module", None)

        def exec_module(module):  # noqa: ANN001
            orig_exec(module)
            def get_mirror_queue():
                def enqueue(payload):  # noqa: ANN001
                    effects.append("queue_enqueue")
                    return True
                return SimpleNamespace(enqueue=enqueue)
            module.get_mirror_queue = get_mirror_queue
            entry = getattr(module, "mirror_whatsapp_thread", None)
            fresh["mod"] = module
            fresh["fresh_module"] = True
            fresh["fresh_entry_wrapped"] = bool(getattr(entry, "_luna_personality_isolated", False))

        loader.exec_module = exec_module
        return spec

    importlib.util.spec_from_file_location = spec_from_file_location
    return orig_spec


def _load_canonical_fresh_mirror():
    """Load the unchanged repository mirror the same way canonical bootstrap does."""
    spec = importlib.util.spec_from_file_location(
        "wolfhouse_whatsapp_mirror",
        str(CANONICAL_MIRROR),
    )
    if spec is None or getattr(spec, "loader", None) is None:
        raise AssertionError("canonical bootstrap mirror spec/loader missing")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _count_retained_fresh_mirror_loads(loads: int = 12) -> int:
    refs = []
    for _ in range(loads):
        mod = _load_canonical_fresh_mirror()
        refs.append(weakref.ref(mod))
        del mod
    gc.collect()
    gc.collect()
    return sum(1 for ref in refs if ref() is not None)


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

    def test_responses_scalar_snapshot_success_and_typed_failure(self):
        for value in (2, None, True, -1, 2**53):
            for fail in (False, True):
                with self.subTest(value=value, fail=fail):
                    async def turn(message, cap, meta):
                        cap.responses_sdk_attempted = cap.responses_sdk_returned = value
                        if fail:
                            raise IsolationAbort("request_identity_changed")
                        return await simulated_model_turn(message, cap, meta)
                    call = run_isolated_personality_eval(
                        case_id="warmth-greeting-en", personality_id="sunny", corpus=CORPUS,
                        fetch_setting=lambda _t: {"personality_id": "sunny"}, invoke_turn=turn,
                        serving_preflight=False, evidence_kind="test_double")
                    if fail:
                        with self.assertRaises(IsolationAbort) as caught:
                            _run(call)
                        snapshot = caught.exception.counters
                    else:
                        snapshot = _run(call)
                    wire = json.loads(json.dumps(snapshot))
                    for key in ("responses_sdk_attempted", "responses_sdk_returned"):
                        self.assertIn(key, wire)
                        self.assertEqual(wire[key], 2 if type(value) is int and value == 2 else None)
                    self.assertIn("provider_http_effects", wire)
                    self.assertIsNone(wire["provider_http_effects"])

    def test_producer_fault_scalar_serialization_success_and_typed_failure(self):
        self.test_producer_scalar_serialization_success_and_typed_failure(fault=True)

    def test_producer_scalar_serialization_success_and_typed_failure(self, fault=False):
        from wolfhouse import crowsnest_ai_usage_reporter as reporter
        first = IsolationAbort("runtime_resolution_unverified")
        for fail in (False, True):
            async def turn(message, cap, meta):
                if fault:
                    cap.telemetry_producer_suppressed = object()
                reporter.enqueue_event(None, env={})
                if fail:
                    raise first
                return await simulated_model_turn(message, cap, meta)
            call = run_isolated_personality_eval(
                case_id="warmth-greeting-en", personality_id="sunny", corpus=CORPUS,
                fetch_setting=lambda _t: {"personality_id": "sunny"}, invoke_turn=turn,
                serving_preflight=False, evidence_kind="test_double")
            if fail:
                with self.assertRaises(IsolationAbort) as caught:
                    _run(call)
                self.assertIs(caught.exception, first)
                snapshot = first.counters
            else:
                snapshot = _run(call)
            wire = json.loads(json.dumps(snapshot))
            self.assertEqual(wire["telemetry_producer_suppressed"], None if fault else 1)
            self.assertIsNone(wire["telemetry_effects"])
            self.assertIsNone(wire["auth_effects"])

    def test_first_abort_survives_cleanup_with_final_bounded_counts(self) -> None:
        from wolfhouse import luna_personality_live_eval as live
        first = IsolationAbort("runtime_resolution_unverified")
        async def abort(_message, cap, _meta):
            cap.model_calls = None
            raise first
        def cleanup(cap):
            cap.sends_attempted = 2
            cap.provider_work_settled = cap.responses_terminal_verified = True
            raise IsolationAbort("provider_work_unsettled")
        with mock.patch.object(live, "settle_isolated_work", cleanup):
            with self.assertRaises(IsolationAbort) as caught:
                _run(run_isolated_personality_eval(
                    case_id="warmth-greeting-en", personality_id="sunny", corpus=CORPUS,
                    fetch_setting=lambda _t: {"personality_id": "sunny"},
                    invoke_turn=abort, serving_preflight=False))
        self.assertIs(caught.exception, first)
        self.assertEqual(first.cleanup_error, "provider_work_unsettled")
        self.assertEqual(first.counters.get("counter_snapshot_state"), "partial")
        self.assertIs(first.counters.get("provider_work_settled"), False)
        self.assertFalse(first.counters["responses_terminal_verified"])
        self.assertEqual(first.counters["sends_attempted"], 2)
        self.assertIsNone(first.counters["model_calls"])
        self.assertIsNone(first.counters["auth_effects"])
        self.assertIsNone(first.counters["telemetry_effects"])

    def test_unverified_readiness_and_admission_precede_staff(self) -> None:
        from wolfhouse import luna_personality_live_eval as live
        with mock.patch.object(live, "install_isolation_runtime"), \
             mock.patch.object(live, "serving_runtime_missing", return_value=[]), \
             mock.patch.object(live, "server_owned_serving_identity", return_value={}), \
             mock.patch.object(live, "isolation_status", return_value=dict.fromkeys(live.REQUIRED_LIVE_SEAMS, True)):
            rec = live.serving_eval_readiness(runner=SimpleNamespace(_handle_message=lambda: None))
        self.assertFalse(rec["ready"])
        self.assertEqual(rec["error"], "runtime_resolution_unverified")
        self.assertEqual(rec["missing_seams"], [])
        fetch = mock.Mock(side_effect=AssertionError("Staff reached"))
        with mock.patch.object(live, "install_isolation_runtime"), \
             mock.patch.object(live, "preflight_isolation_or_abort"):
            with self.assertRaises(IsolationAbort) as caught:
                _run(run_isolated_personality_eval(
                    case_id="warmth-greeting-en", personality_id="sunny", corpus=CORPUS,
                    fetch_setting=fetch, serving_preflight=False, require_live_seams=True))
        self.assertEqual(caught.exception.reason, "runtime_resolution_unverified")
        fetch.assert_not_called()

    def test_http_abort_retains_terminal_evidence(self) -> None:
        from wolfhouse import luna_personality_live_eval as live
        first = IsolationAbort("runtime_resolution_unverified")
        first.cleanup_error, first.counters = "provider_work_unsettled", {"auth_effects": None}
        handlers = {}
        app = SimpleNamespace(router=SimpleNamespace(
            add_get=lambda *_: None, add_post=lambda path, fn: handlers.update(post=fn)))
        request = SimpleNamespace(json=mock.AsyncMock(return_value={"case_id": "warmth-greeting-en"}))
        web = SimpleNamespace(json_response=lambda body, **kw: (body, kw))
        with mock.patch.object(live, "live_sunset_eval_identity", return_value={}), \
             mock.patch.object(live, "_eval_unauthorized", return_value=None), \
             mock.patch.object(live, "run_isolated_personality_eval", side_effect=first), \
             mock.patch.dict(sys.modules, {"aiohttp": SimpleNamespace(web=web)}):
            live.register_live_eval_route(app)
            body, options = _run(handlers["post"](request))
        self.assertEqual(body["error"], first.reason)
        self.assertEqual(body.get("cleanup_error"), first.cleanup_error)
        self.assertEqual(body.get("counters"), first.counters)
        self.assertEqual(options["status"], 503)

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
            "HERMES_HOME": os.path.join(os.environ["HOME"], "readiness-fixture"),
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


class RequestIdentityBoundaryTests(unittest.TestCase):
    """Dormant seam: real installed owners, never constructor/route admission."""

    def setUp(self):
        import run_agent
        from wolfhouse import luna_personality_isolation as iso
        self.ra, self.iso = run_agent, iso
        self.agent = object.__new__(run_agent.AIAgent)
        self.agent.model, self.agent.api_mode = "fixture-model", "chat_completions"
        self.agent.provider = "openai"
        self.agent._interrupt_requested = False
        self.agent.client = SimpleNamespace(is_closed=lambda: False)
        self.agent._client_kwargs = {"api_key": "fixture", "base_url": "https://fixture.invalid/v1", "http_client": object()}
        self.agent._client_log_context = lambda: "offline-fixture"
        self.acquisitions, self.dispatches = [], []
        def sdk(**kwargs):
            self.acquisitions.append(kwargs)
            def create(**payload):
                self.dispatches.append(payload)
                return "fixture-result"
            return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        self.sdk_patch = mock.patch.object(run_agent, "OpenAI", sdk)
        self.sdk_patch.start()
        self.addCleanup(self.sdk_patch.stop)
        self.addCleanup(reset_isolation_runtime_for_tests)
        _wrap_openai_client_factory(run_agent.AIAgent)
        _wrap_openai_client_factory(self.agent)
        self.cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")

    def request(self):
        return self.agent._create_request_openai_client(reason="offline-b2a")

    def test_codex_request_denies_before_primary_acquisition(self):
        self.agent.api_mode = "codex_responses"
        def ensure(**kwargs):
            self.acquisitions.append("ensure")
            raise AssertionError("primary acquisition reached")
        self.agent._ensure_primary_openai_client = ensure
        token = enter_isolated_turn(self.cap)
        try:
            with self.assertRaises(IsolationAbort):
                self.request()
            self.assertEqual(self.acquisitions, [])
        finally:
            exit_isolated_turn(token)

    def test_real_factory_positive_and_retained_identity(self):
        ordinary = self.request()
        self.assertEqual(ordinary.chat.completions.create(model="fixture-model"), "fixture-result")
        self.assertEqual(self.acquisitions[0]["max_retries"], 0)
        self.assertNotIn("max_retries", self.agent._client_kwargs)
        token = enter_isolated_turn(self.cap)
        try:
            client = self.request()
            create = client.chat.completions.create
            self.iso._observe_openai_client(client)
            self.assertIs(client.chat.completions.create, create)
            self.assertEqual(create(model="fixture-model"), "fixture-result")
            self.assertEqual(self.cap.model_calls, 1)
            self.agent.model = "changed-model"
            with self.assertRaises(IsolationAbort):
                create(model="fixture-model")
            with self.assertRaises(IsolationAbort):
                self.request()
            self.agent.model = "fixture-model"
        finally:
            exit_isolated_turn(token)
        with self.assertRaises(IsolationAbort):
            create(model="fixture-model")
        other = enter_isolated_turn(IsolatedTurnCapture(case_id="other", personality_id="sunny"))
        try:
            with self.assertRaises(IsolationAbort):
                create(model="fixture-model")
        finally:
            exit_isolated_turn(other)
        self.assertEqual(len(self.dispatches), 2)
        self.assertEqual(len(self.acquisitions), 2)

    def test_missing_identity_mode_change_and_other_agent_fail_closed(self):
        token = enter_isolated_turn(self.cap)
        try:
            self.agent.model = None
            with self.assertRaises(IsolationAbort):
                self.request()
            self.assertEqual(self.acquisitions, [])
            self.agent.model = "fixture-model"
            client = self.request()
            other = object.__new__(self.ra.AIAgent)
            other.model, other.api_mode = self.agent.model, self.agent.api_mode
            with self.assertRaises(IsolationAbort):
                other._create_request_openai_client(reason="other-agent")
            self.agent.api_mode = "bedrock_converse"
            with self.assertRaises(IsolationAbort):
                client.chat.completions.create(model="fixture-model")
            with self.assertRaises(IsolationAbort):
                self.request()
            self.agent.api_mode = "codex_responses"
            with self.assertRaises(IsolationAbort):
                client.chat.completions.create(model="fixture-model")
            with self.assertRaises(IsolationAbort):
                self.request()
            self.agent.api_mode = "chat_completions"
            with self.assertRaises(IsolationAbort):
                self.agent._ensure_primary_openai_client(reason="outside-request")
            self.assertEqual(len(self.acquisitions), 1)
            self.assertEqual(self.dispatches, [])
        finally:
            exit_isolated_turn(token)

    def test_retained_create_denies_reset_cross_capture_and_forged_marker(self):
        token = enter_isolated_turn(self.cap)
        try:
            client = self.request()
        finally:
            exit_isolated_turn(token)
        with self.assertRaises(IsolationAbort):
            client.chat.completions.create(model="fixture-model")
        token = enter_isolated_turn(IsolatedTurnCapture(case_id="other", personality_id="sunny"))
        try:
            self.request()
            with self.assertRaises(IsolationAbort):
                client.chat.completions.create(model="fixture-model")
            with self.assertRaises(IsolationAbort):
                self.iso._observe_openai_client(client)
            raw = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: None)))
            self.iso._mark(raw.chat.completions.create)
            with self.assertRaises(IsolationAbort):
                self.iso._observe_openai_client(raw)
            self.assertEqual(self.dispatches, [])
        finally:
            exit_isolated_turn(token)

    def test_module_explicit_raw_and_primary_denied_before_resources(self):
        from agent import codex_runtime
        self.iso._wrap_turn_entry(targets=IsolationTargets(agent_cls=self.ra.AIAgent, codex_runtime_mod=codex_runtime))
        def tripwire(*args, **kwargs):
            self.acquisitions.append("resource")
            raise AssertionError("resource reached")
        self.agent._ensure_primary_openai_client = tripwire
        raw = SimpleNamespace(responses=SimpleNamespace(create=tripwire))
        token = enter_isolated_turn(self.cap)
        try:
            for name in ("run_codex_stream", "run_codex_create_stream_fallback"):
                for client in (None, raw):
                    with self.subTest(name=name, explicit=client is not None):
                        with self.assertRaises(IsolationAbort):
                            getattr(codex_runtime, name)(self.agent, {}, client=client)
            with self.assertRaises(IsolationAbort):
                self.ra.AIAgent._ensure_primary_openai_client(self.agent, reason="raw-primary")
            self.assertEqual(self.acquisitions, [])
        finally:
            exit_isolated_turn(token)


class ResponsesObservationTests(unittest.TestCase):
    """Internal dormant observation, NOT admitted Codex runtime composition."""

    def setUp(self):
        import run_agent
        from agent import codex_runtime
        from wolfhouse import luna_personality_isolation as iso
        reset_isolation_runtime_for_tests()
        self.addCleanup(reset_isolation_runtime_for_tests)
        self.iso, self.runtime = iso, codex_runtime
        iso._wrap_codex_parser(codex_runtime)
        self.agent = object.__new__(run_agent.AIAgent)
        self.agent.model, self.agent.api_mode = "fixture-model", "codex_responses"
        self.agent.provider, self.agent._interrupt_requested = "openai-codex", False
        self.agent._client_log_context = lambda: "offline-fixture"
        self.cap = IsolatedTurnCapture(case_id="fixture", personality_id="sunny")
        # Existing tuple shape, explicitly supplied internal provenance, not a
        # factory-issued/admitted capability. No constructor or resolver fakes.
        self.binding = (self.cap, self.agent, self.agent.model, self.agent.api_mode)
        self.cap._request_identity = self.binding
        self.calls = []
        self.result = SimpleNamespace(output=[])
        def create(**kwargs):
            self.calls.append(kwargs)
            if len(self.calls) == 1:
                raise ConnectionError("fixture connect failure")
            return self.result
        self.raw_create = create
        self.client = SimpleNamespace(responses=SimpleNamespace(create=create))
        self.payload = {"model": self.agent.model, "instructions": "Luna Personality this turn: sunny. PRIVATE_FIXTURE",
                        "input": [{"role": "user", "content": "fixture question"}]}

    def test_retry_alias_and_consumed_pack_are_actual_create_observations(self):
        for name in ("run_codex_stream", "run_codex_create_stream_fallback"):
            with self.subTest(helper=name):
                self.calls.clear()
                self.assertIs(getattr(self.runtime, name)(self.agent, self.payload, client=self.client), self.result)
                self.assertEqual(len(self.calls), 2)  # ordinary unchanged helper retry
                self.calls.clear()
                token = enter_isolated_turn(self.cap)
                try:
                    try:
                        self.iso._observe_openai_client(self.client)
                    except IsolationAbort as exc:
                        self.fail("dormant observer refused valid binding: " + exc.reason)
                    create = self.client.responses.create
                    self.iso._observe_openai_client(self.client)
                    self.assertIs(self.client.responses.create, create)
                    before = self.cap.model_calls
                    self.assertIs(getattr(self.runtime, name)(self.agent, self.payload, client=self.client), self.result)
                    self.assertEqual(len(self.calls), 2)
                    self.assertEqual(self.cap.model_calls - before, 2)
                    self.assertEqual(getattr(self.cap, "responses_sdk_attempted", None), self.cap.model_calls)
                    self.assertEqual(getattr(self.cap, "responses_sdk_returned", None), self.cap.model_calls // 2)
                    self.assertEqual(self.cap.provider_helper_attempts, 0)
                    self.assertEqual(self.cap.model, "fixture-model")
                    self.assertEqual(self.cap.observed_pack_id, "sunny")
                    self.assertTrue(self.cap.observed_pack_from_provider)
                    self.assertTrue(all(c["stream"] is True for c in self.calls))
                    self.assertNotIn("PRIVATE_FIXTURE", repr(self.cap))
                finally:
                    exit_isolated_turn(token)
                    self.client.responses.create = self.raw_create


    def test_each_retry_rechecks_capture_binding_effective_model_and_mode(self):
        for change in ("model", "api_mode", "binding", "capture"):
            with self.subTest(change=change):
                self.agent.model, self.agent.api_mode = "fixture-model", "codex_responses"
                self.cap._request_identity = self.binding
                self.calls.clear()
                tokens = [enter_isolated_turn(self.cap)]
                def create(**kwargs):
                    self.calls.append(kwargs)
                    if len(self.calls) == 1:
                        if change == "binding":
                            self.cap._request_identity = tuple(list(self.binding))
                        elif change == "capture":
                            tokens.append(enter_isolated_turn(IsolatedTurnCapture("other", "sunny")))
                        else:
                            setattr(self.agent, change, "changed")
                        raise ConnectionError("fixture retry after identity drift")
                    return self.result
                self.client.responses.create = create
                before = self.cap.model_calls
                try:
                    self.iso._observe_openai_client(self.client)
                    with self.assertRaises(IsolationAbort):
                        self.runtime.run_codex_stream(self.agent, self.payload, client=self.client)
                    self.assertEqual(len(self.calls), 1)
                    self.assertEqual(self.cap.model_calls - before, 1)
                    self.assertEqual(self.cap.responses_sdk_returned, 0)
                finally:
                    for token in reversed(tokens):
                        exit_isolated_turn(token)

    def test_retained_observer_rejects_payload_reset_cross_capture_and_marker(self):
        def create_edge(**kwargs):
            self.calls.append(kwargs)
            return self.result
        self.client.responses.create = create_edge
        token = enter_isolated_turn(self.cap)
        try:
            self.iso._observe_openai_client(self.client)
            create = self.client.responses.create
            for payload in ({"model": "other", "stream": True}, {"stream": True},
                            {"model": "fixture-model"}, {"model": "fixture-model", "stream": 1}):
                with self.subTest(payload=payload), self.assertRaises(IsolationAbort):
                    create(**payload)
            self.assertEqual(self.calls, [])
            self.assertEqual(self.cap.responses_sdk_attempted, 0)
            self.client.responses.create = self.raw_create
            self.iso._mark(self.raw_create)
            with self.assertRaises(IsolationAbort):
                self.iso._observe_openai_client(self.client)
        finally:
            exit_isolated_turn(token)
        with self.assertRaises(IsolationAbort):
            create(model="fixture-model", stream=True)
        token = enter_isolated_turn(IsolatedTurnCapture("other", "sunny"))
        try:
            with self.assertRaises(IsolationAbort):
                create(model="fixture-model", stream=True)
        finally:
            exit_isolated_turn(token)
        self.assertEqual(self.calls, [])

    def test_missing_model_cannot_be_observer_binding(self):
        self.agent.model = None
        self.cap._request_identity = (self.cap, self.agent, None, "codex_responses")
        token = enter_isolated_turn(self.cap)
        try:
            with self.assertRaises(IsolationAbort):
                self.iso._observe_openai_client(self.client)
        finally:
            exit_isolated_turn(token)

    def test_input_pack_and_saturation_at_sdk_boundary(self):
        token = enter_isolated_turn(self.cap)
        try:
            self.client.responses.create = lambda **kwargs: self.result
            self.iso._observe_openai_client(self.client)
            self.cap.responses_sdk_attempted = self.cap.responses_sdk_returned = 2**53 - 1
            self.client.responses.create(model="fixture-model", stream=True,
                                         input="Luna Personality this turn: calm. PRIVATE_INPUT")
            self.assertEqual(self.cap.observed_pack_id, "calm")
            self.assertEqual(self.cap.responses_sdk_attempted, 2**53 - 1)
            self.assertEqual(self.cap.responses_sdk_returned, 2**53 - 1)
            self.assertNotIn("PRIVATE_INPUT", repr(self.cap))
        finally:
            exit_isolated_turn(token)


class ResponsesTerminalTests(unittest.TestCase):
    """Pinned parser/helper; SDK event source only is synthetic."""
    setUp = ResponsesObservationTests.setUp

    def stream(self, events, error=None, close_error=None):
        class Stream:
            def __init__(self):
                self.closes = 0
            def __iter__(self):
                yield from events
                if error is not None:
                    raise error
            def close(self):
                self.closes += 1
                if close_error is not None:
                    raise close_error
        return Stream()

    def run_stream(self, stream):
        self.client.responses.create = lambda **kwargs: stream
        self.iso._observe_openai_client(self.client)
        return self.runtime.run_codex_stream(self.agent, self.payload, client=self.client)

    def test_eval_terminal_gate_and_detached_snapshots(self):
        for terminal in ('completed', 'failed', 'typed'):
            with self.subTest(terminal=terminal):
                self.setUp()
                mark_test_isolation_installed()
                cause = IsolationAbort('fixture_original')
                retained = []
                async def turn(message, cap, meta):
                    self.cap = cap
                    cap._request_identity = (cap, self.agent, self.agent.model, self.agent.api_mode)
                    retained.append(cap)
                    events = [] if terminal == 'typed' else [{'type': 'response.' + terminal}]
                    self.run_stream(self.stream(events, cause if terminal == 'typed' else None))
                    return await simulated_model_turn(message, cap, meta)
                call = run_isolated_personality_eval(
                    case_id='warmth-greeting-en', personality_id='sunny', corpus=CORPUS,
                    fetch_setting=lambda _t: {'personality_id': 'sunny'}, invoke_turn=turn,
                    serving_preflight=False, evidence_kind='test_double')
                if terminal == 'completed':
                    snapshot = _run(call)
                else:
                    with self.assertRaises(IsolationAbort) as caught:
                        _run(call)
                    if terminal == 'typed':
                        self.assertIs(caught.exception, cause)
                    else:
                        self.assertEqual(caught.exception.reason, 'responses_terminal_unverified')
                    snapshot = caught.exception.counters
                self.assertIs(snapshot.get('responses_terminal_verified'), terminal == 'completed')
                self.assertEqual(snapshot.get('responses_close_succeeded'), 1)
                wire = json.dumps(snapshot, sort_keys=True)
                retained[0].responses_close_succeeded = 999
                retained[0].responses_terminal_verified = not retained[0].responses_terminal_verified
                self.assertEqual(json.dumps(snapshot, sort_keys=True), wire)

    def test_terminal_and_close_are_required_not_returned_or_consumed(self):
        for terminal in ('completed', 'failed', 'incomplete', None, 'empty', 'concrete'):
            with self.subTest(terminal=terminal):
                self.setUp()
                events = [] if terminal == 'empty' else [{'type': 'response.output_text.delta', 'delta': 'fixture'}]
                if terminal in ('completed', 'failed', 'incomplete'):
                    events.append({'type': 'response.' + terminal, 'response': {'status': terminal}})
                stream = self.stream(events)
                if terminal == 'concrete':
                    stream = SimpleNamespace(output=[], status='completed')
                token = enter_isolated_turn(self.cap)
                try:
                    if terminal == 'empty':
                        with self.assertRaisesRegex(RuntimeError, 'terminal response'):
                            self.run_stream(stream)
                    else:
                        self.run_stream(stream)
                    self.iso.settle_isolated_work(self.cap)
                    self.assertIs(getattr(self.cap, 'responses_terminal_verified', None), terminal == 'completed')
                    self.assertEqual(getattr(self.cap, 'responses_completed', None), int(terminal == 'completed'))
                    self.assertEqual(getattr(self.cap, 'responses_close_succeeded', None), int(terminal != 'concrete'))
                    if terminal != 'concrete':
                        self.assertEqual(stream.closes, 1)
                    self.assertEqual(self.cap.responses_sdk_returned, 1)
                finally:
                    exit_isolated_turn(token)

    def test_close_failure_and_typed_iteration_cause_remain_separate(self):
        for iteration_error in (None, IsolationAbort('fixture_original')):
            with self.subTest(iteration_error=iteration_error):
                self.setUp()
                events = [] if iteration_error else [{'type': 'response.completed'}]
                stream = self.stream(events, iteration_error, RuntimeError('PRIVATE_CLOSE'))
                token = enter_isolated_turn(self.cap)
                try:
                    if iteration_error:
                        with self.assertRaises(IsolationAbort) as caught:
                            self.run_stream(stream)
                        self.assertIs(caught.exception, iteration_error)
                    else:
                        self.run_stream(stream)  # pinned helper swallows close failure
                    self.iso.settle_isolated_work(self.cap)
                    self.assertIs(getattr(self.cap, 'responses_terminal_verified', None), False)
                    self.assertEqual(getattr(self.cap, 'responses_close_failed', None), 1)
                    self.assertEqual(getattr(self.cap, 'responses_iteration_failed', None), int(iteration_error is not None))
                    self.assertEqual(stream.closes, 1)
                    self.assertNotIn('PRIVATE_CLOSE', repr(self.cap))
                finally:
                    exit_isolated_turn(token)

    def test_early_close_and_missing_close_cannot_certify_completion(self):
        for consume in (False, True):
            with self.subTest(consume=consume):
                self.setUp()
                raw = self.stream([{'type': 'response.completed'}])
                token = enter_isolated_turn(self.cap)
                try:
                    self.client.responses.create = lambda **kwargs: raw
                    self.iso._observe_openai_client(self.client)
                    observed = self.client.responses.create(**self.payload, stream=True)
                    if consume:
                        list(observed)
                    else:
                        observed.close()
                    self.iso.settle_isolated_work(self.cap)
                    self.assertIs(getattr(self.cap, 'responses_terminal_verified', None), False)
                    self.assertEqual(getattr(self.cap, 'responses_completed', None), int(consume))
                    self.assertEqual(getattr(self.cap, 'responses_close_succeeded', None), int(not consume))
                finally:
                    if consume:
                        observed.close()
                    exit_isolated_turn(token)


class TerminalReview(unittest.TestCase):
    # Consolidated from evidence/LUNA-PERSONALITY-001-prb3b-review-probe.py.
    setUp = ResponsesTerminalTests.setUp
    stream = ResponsesTerminalTests.stream
    run_stream = ResponsesTerminalTests.run_stream

    def test_parser_controls_and_conservative_retry(self):
        token = enter_isolated_turn(self.cap)
        try:
            attempts = iter([self.stream([], ConnectionError('fixture retry')), self.stream([{'type': 'response.completed', 'response': {'status': 'completed', 'id': 'fixture', 'usage': {}}}])])
            self.client.responses.create = lambda **kwargs: next(attempts)
            self.iso._observe_openai_client(self.client)
            final = self.runtime.run_codex_stream(self.agent, self.payload, client=self.client)
            self.assertEqual(final.terminal_event_type, 'response.completed')
            self.iso.settle_isolated_work(self.cap)
            self.assertFalse(self.cap.responses_terminal_verified)
            self.assertEqual((self.cap.responses_sdk_returned, self.cap._responses_unverified, self.cap.responses_iteration_failed), (2, 1, 1))
        finally:
            exit_isolated_turn(token)
        self.setUp()
        token = enter_isolated_turn(self.cap)
        try:
            final = self.run_stream(self.stream([{'type': 'response.completed'}]))
            self.iso.settle_isolated_work(self.cap)
            self.assertEqual(final.terminal_event_type, 'response.completed')
            self.assertTrue(self.cap.responses_terminal_verified)
        finally:
            exit_isolated_turn(token)

    def test_parser_seal_close_pending_and_retained_resume(self):
        observed_type = self.iso._ObservedResponsesStream
        original_iter, retained, pending = observed_type.__iter__, [], []
        def record(stream):
            iterator = original_iter(stream)
            retained.append(iterator)
            return iterator
        raw = self.stream([{'type': 'response.completed'}, {'type': 'response.failed'}])
        close = raw.close
        def pending_close():
            self.iso.settle_isolated_work(self.cap)
            pending.append(self.cap.responses_terminal_verified)
            close()
        raw.close = pending_close
        token = enter_isolated_turn(self.cap)
        try:
            with mock.patch.object(observed_type, '__iter__', record):
                result = self.run_stream(raw)
            self.iso.settle_isolated_work(self.cap)
            self.assertEqual(result.terminal_event_type, 'response.completed')
            self.assertEqual(pending, [False])
            self.assertTrue(self.cap.responses_terminal_verified)
            self.assertEqual(list(retained[0]), [])
            self.assertEqual(self.cap.responses_iteration_failed, 0)
            self.assertEqual(self.cap._responses_unverified, 0)
        finally:
            exit_isolated_turn(token)

    def test_parser_install_reset_ordinary_and_missing_wrap(self):
        wrapped = self.runtime._consume_codex_event_stream
        self.iso._wrap_codex_parser(self.runtime)
        self.assertIs(self.runtime._consume_codex_event_stream, wrapped)
        self.iso.reset_isolation_runtime_for_tests()
        original = self.runtime._consume_codex_event_stream
        self.assertIsNot(original, wrapped)
        for parser in (original, wrapped):
            result = parser(iter([{'type': 'response.completed'}]), model='ordinary')
            self.assertEqual((result.model, result.terminal_event_type), ('ordinary', 'response.completed'))
            with self.assertRaisesRegex(RuntimeError, 'terminal response'):
                parser(iter([]), model='ordinary')
        token = enter_isolated_turn(self.cap)
        try:
            self.run_stream(self.stream([{'type': 'response.completed'}]))
            self.iso.settle_isolated_work(self.cap)
            self.assertFalse(self.cap.responses_terminal_verified)
        finally:
            exit_isolated_turn(token)

    def test_helper_rejects_terminal_before_acceptance(self):
        agent = self.agent
        class InterruptedStream:
            def __iter__(self):
                agent._interrupt_requested = True
                yield {'type': 'response.completed', 'response': {'status': 'completed'}}
            def close(self):
                pass
        token = enter_isolated_turn(self.cap)
        try:
            with self.assertRaisesRegex(RuntimeError, 'terminal response'):
                self.run_stream(InterruptedStream())
            self.iso.settle_isolated_work(self.cap)
            self.assertFalse(self.cap.responses_terminal_verified, 'helper rejected terminal but observer certifies success')
        finally:
            exit_isolated_turn(token)

    def test_close_during_active_iteration_leaves_stale_true(self):
        entered, release = threading.Event(), threading.Event()
        cause, errors = IsolationAbort('fixture_late_iteration'), []
        class Stream:
            def __iter__(self):
                yield {'type': 'response.completed', 'response': {'status': 'completed'}}
                entered.set()
                if not release.wait(5):
                    raise RuntimeError('fixture barrier timeout')
                raise cause
            def close(self):
                return None
        token = enter_isolated_turn(self.cap)
        worker = None
        try:
            self.client.responses.create = lambda **kwargs: Stream()
            self.iso._observe_openai_client(self.client)
            observed = self.client.responses.create(**self.payload, stream=True)
            iterator = iter(observed)
            def advance():
                try:
                    next(iterator)
                except BaseException as exc:
                    errors.append(exc)
            worker = threading.Thread(target=advance)
            def on_event(event):
                worker.start()
                self.assertTrue(entered.wait(5))
                observed.close()
                observed.close()
            with mock.patch.object(type(observed), '__iter__', lambda stream: iterator):
                self.runtime._consume_codex_event_stream(observed, model=self.agent.model, on_event=on_event)
            self.iso.settle_isolated_work(self.cap, timeout_s=0)
            premature = self.cap.responses_terminal_verified
            release.set()
            worker.join(5)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [cause])
            self.assertEqual(self.cap.responses_close_succeeded, 1)
            self.assertEqual(self.cap.responses_iteration_failed, 1)
            self.iso.settle_isolated_work(self.cap, timeout_s=0)
            self.assertFalse(self.cap.responses_terminal_verified, 'late iteration failure never re-poisons decremented unverified count')
            self.assertFalse(premature)
        finally:
            release.set()
            if worker is not None:
                worker.join(5)
            exit_isolated_turn(token)


class CancellationEvidenceTests(unittest.TestCase):
    setUp = ResponsesTerminalTests.setUp
    stream = ResponsesTerminalTests.stream

    def test_late_failure_snapshot_stays_partial_after_bounded_settlement(self):
        self._late_failure(tracked=True)

    def test_untracked_observer_failure_is_partial_even_after_thread_drain(self):
        self._late_failure(tracked=False)

    def _late_failure(self, tracked):
        from contextvars import copy_context
        from wolfhouse import luna_personality_live_eval as live
        first, late = IsolationAbort("request_identity_changed"), IsolationAbort("fixture_late_failure")
        entered, release = threading.Event(), threading.Event()
        receipts, workers, captures = [], [], []
        raw = self.stream([])
        def events():
            entered.set()
            if not release.wait(8):
                raise AssertionError("fixture barrier expired")
            raise late
            yield  # actual lazy SDK stream, not a copied parser
        raw.__class__.__iter__ = lambda _self: events()
        start = threading.Thread.start
        self.iso._wrap_thread_context_propagation()
        async def turn(_message, cap, _meta):
            captures.append(cap)
            cap._request_identity = (cap, self.agent, self.agent.model, self.agent.api_mode)
            self.client.responses.create = lambda **kwargs: raw
            self.iso._observe_openai_client(self.client)
            def worker():
                try:
                    self.runtime.run_codex_stream(self.agent, self.payload, client=self.client)
                except BaseException as exc:
                    receipts.append(exc)
            ctx = copy_context()
            thread = threading.Thread(target=lambda: ctx.run(worker))
            workers.append(thread)
            thread.start() if tracked else start(thread)
            self.assertTrue(entered.wait(2))
            raise first
        try:
            with self.assertRaises(IsolationAbort) as caught:
                _run(live.run_isolated_personality_eval(
                    case_id="warmth-greeting-en", personality_id="sunny", corpus=CORPUS,
                    fetch_setting=lambda _t: {"personality_id": "sunny"}, invoke_turn=turn,
                    serving_preflight=False, evidence_kind="test_double"))
            self.assertIs(caught.exception, first)
            self.assertEqual(first.cleanup_error, "provider_work_unsettled" if tracked else None)
            snapshot = json.loads(json.dumps(first.counters))
            self.assertEqual(snapshot.get("counter_snapshot_state"), "partial")
            self.assertIs(snapshot.get("provider_work_settled"), not tracked)
            self.assertFalse(snapshot["responses_terminal_verified"])
            self.assertEqual(snapshot["responses_iteration_failed"], 0)  # observed, NOT final zero
            self.assertIsNone(snapshot["provider_http_effects"])
            release.set()
            workers[0].join(2)
            self.assertFalse(workers[0].is_alive())
            self.assertEqual(receipts, [late])
            self.iso.settle_isolated_work(captures[0])
            self.assertEqual(captures[0].responses_iteration_failed, 1)
            self.assertEqual(captures[0].responses_close_succeeded, 1)
            self.assertFalse(captures[0].responses_terminal_verified)
            self.assertEqual(first.counters, snapshot)  # no retroactive final certification
        finally:
            release.set()
            for thread in workers:
                thread.join(2)

    def test_settled_failure_snapshot_labels_only_tracked_work(self):
        first = IsolationAbort("request_identity_changed")
        async def turn(_message, _cap, _meta):
            raise first
        with self.assertRaises(IsolationAbort):
            _run(run_isolated_personality_eval(
                case_id="warmth-greeting-en", personality_id="sunny", corpus=CORPUS,
                fetch_setting=lambda _t: {"personality_id": "sunny"}, invoke_turn=turn,
                serving_preflight=False))
        self.assertEqual(first.counters.get("counter_snapshot_state"), "settled_tracked_work")
        self.assertIs(first.counters.get("provider_work_settled"), True)
        self.assertFalse(first.counters["responses_terminal_verified"])
        for key in ("auth_effects", "telemetry_effects", "provider_http_effects"):
            self.assertIsNone(first.counters[key])


class PinnedCancellationOwnerTests(unittest.TestCase):
    """Pinned ordinary helper: late-registration cancellation and worker ownership."""
    def tearDown(self):
        reset_isolation_runtime_for_tests()

    def test_actual_registration_reset_and_owner_cleanup(self):
        import run_agent
        from agent.chat_completion_helpers import interruptible_api_call
        reset_isolation_runtime_for_tests()
        from agent import chat_completion_helpers as helper
        for phase in ("factory", "registration", "registered", "ordering"):
            with self.subTest(phase=phase):
                entered, release, contender = threading.Event(), threading.Event(), threading.Event()
                class OrderedLock:
                    def __init__(self):
                        self.lock, self.first = threading.Lock(), True
                    def __enter__(self):
                        if self.lock.locked() and threading.get_ident() == controller.ident:
                            contender.set()
                        self.lock.acquire()
                        if self.first and phase == "ordering" and len(kwargs_seen) == 1:
                            self.first = False
                            entered.set()  # registration holds lock BEFORE reading cancel flag
                            if not contender.wait(8):
                                raise AssertionError("cancellation contender missing")
                        return self
                    def __exit__(self, *_exc):
                        self.lock.release()
                calls, closes, shutdowns, workers, kwargs_seen, outcome = [], [], [], [], [], []
                agent = object.__new__(run_agent.AIAgent)
                agent.model, agent.api_mode, agent.provider = "fixture-model", "chat_completions", "openai"
                agent._interrupt_requested = False
                agent.client = SimpleNamespace(is_closed=False)
                agent._client_kwargs = {"api_key": "fixture", "http_client": object()}
                agent._compute_non_stream_stale_timeout = lambda _kw: 100
                payload = {"model": agent.model, "messages": []}
                def wait():
                    workers.append(threading.current_thread())
                    entered.set()
                    if not release.wait(8):
                        raise AssertionError("fixture cancellation barrier expired")
                def sdk(**kwargs):
                    index = len(kwargs_seen)
                    kwargs_seen.append(kwargs)
                    def create(**_kwargs):
                        calls.append((index, threading.get_ident()))
                        if index == 0 and phase in ("registered", "ordering"):
                            wait()
                            raise ConnectionError("fixture cancelled transport")
                        return index
                    sock = SimpleNamespace(shutdown=lambda how: shutdowns.append((index, threading.get_ident(), how)),
                                           close=lambda: self.fail("socket FD released by abort"))
                    pool = SimpleNamespace(_connections=[SimpleNamespace(_network_stream=SimpleNamespace(_sock=sock))])
                    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)),
                        _client=SimpleNamespace(_transport=SimpleNamespace(_pool=pool)),
                        close=lambda: closes.append((index, threading.get_ident())))
                    if index == 0 and phase == "factory":
                        wait()
                    return client
                factory = agent._create_request_openai_client
                def after_factory(**kwargs):
                    client = factory(**kwargs)  # genuine original acquisition before registration barrier
                    if len(kwargs_seen) == 1 and phase == "registration":
                        wait()
                    return client
                agent._create_request_openai_client = after_factory
                def invoke():
                    try:
                        outcome.append(interruptible_api_call(agent, payload))
                    except BaseException as exc:
                        outcome.append(exc)
                controller = threading.Thread(target=invoke)
                with mock.patch.object(run_agent, "OpenAI", sdk), mock.patch.object(
                        helper, "threading", SimpleNamespace(Lock=OrderedLock, Thread=threading.Thread,
                                                             get_ident=threading.get_ident)):
                    try:
                        controller.start()
                        self.assertTrue(entered.wait(2))
                        agent._interrupt_requested = True
                        controller.join(2)
                        self.assertFalse(controller.is_alive())
                        self.assertIsInstance(outcome[0], InterruptedError)
                        self.assertEqual(closes, [])  # stranger MUST NOT full-close/pop
                        self.assertEqual(len(shutdowns), 1 if phase in ("registered", "ordering") else 0)
                        agent._interrupt_requested = False  # next cached turn, old worker still retained
                        self.assertEqual(interruptible_api_call(agent, payload), 1)
                        release.set()
                        workers[0].join(2)
                        self.assertFalse(workers[0].is_alive())
                        self.assertEqual([i for i, _ in closes].count(0), 1)
                        self.assertIn((0, workers[0].ident), closes)
                        self.assertTrue(all(kw["max_retries"] == 0 for kw in kwargs_seen))
                        # Registration-first admits one; cancellation-first admits none.
                        self.assertEqual([i for i, _ in calls].count(0), int(phase in ("registered", "ordering")))
                        self.assertEqual([i for i, _ in calls].count(1), 1)
                        self.assertIsInstance(outcome[0], InterruptedError)
                        print("PINNED_CANCEL_OWNER", phase, "old_create", [i for i, _ in calls].count(0), flush=True)
                    finally:
                        release.set()
                        controller.join(2)
                        for worker in workers:
                            worker.join(2)


class CodexCancellationTests(unittest.TestCase):
    def test_retained_stream_and_retry_reset_with_ordinary_controls(self):
        import run_agent
        from agent.chat_completion_helpers import interruptible_api_call
        from wolfhouse import crowsnest_ai_usage_reporter as reporter
        reset_isolation_runtime_for_tests()
        for phase in ('stream', 'retry', 'ordinary', 'ordinary-retry'):
            with self.subTest(phase=phase):
                entered, release = threading.Event(), threading.Event()
                calls, closes, workers, outcomes, deltas = [], [], [], [], []
                agent = object.__new__(run_agent.AIAgent)
                agent.__dict__.update(vars(PatcherAgent := SimpleNamespace(
                    model='fixture-model', api_mode='codex_responses', provider='openai',
                    _interrupt_requested=False, client=SimpleNamespace(is_closed=False),
                    _client_kwargs={'api_key': 'fixture'},
                    _compute_non_stream_stale_timeout=lambda _kw: 100,
                    _touch_activity=lambda _reason: None, _client_log_context=lambda: 'fixture',
                    _fire_stream_delta=deltas.append, _fire_reasoning_delta=lambda _text: None)))
                def hold():
                    workers.append(threading.current_thread())
                    entered.set()
                    if not release.wait(5):
                        raise AssertionError('OLD release missing')
                def sdk(**kwargs):
                    index = len(closes) if phase.startswith('ordinary') else len(clients)
                    class Stream:
                        def __iter__(self):
                            if index == 0 and phase == 'stream':
                                hold()
                                yield {'type': 'response.output_text.delta', 'delta': 'OLD'}
                            yield {'type': 'response.completed', 'response': {'status': 'completed'}}
                        def close(self):
                            stream_closes.append(index)
                    def create(**_kwargs):
                        calls.append(index)
                        if 'retry' in phase and calls.count(index) == 1 and index == 0:
                            raise ConnectionError('original transport cause')
                        return Stream()
                    client = SimpleNamespace(responses=SimpleNamespace(create=create),
                        close=lambda: closes.append((index, threading.get_ident())))
                    clients.append(client)
                    return client
                def failed(*_args, **_kwargs):
                    if phase == 'retry':
                        hold()
                def invoke():
                    try:
                        outcomes.append(interruptible_api_call(agent, {'model': agent.model}))
                    except BaseException as exc:
                        outcomes.append(exc)
                clients, stream_closes = [], []
                controller = threading.Thread(target=invoke)
                with mock.patch.object(run_agent, 'OpenAI', sdk), mock.patch.object(reporter, 'observe_attempt_failure', failed):
                    try:
                        controller.start()
                        if not phase.startswith('ordinary'):
                            self.assertTrue(entered.wait(2))
                            agent._interrupt_requested = True
                            controller.join(2)
                            self.assertFalse(controller.is_alive())
                            self.assertIsInstance(outcomes[0], InterruptedError)
                            self.assertEqual(closes, [])
                            agent._interrupt_requested = False
                            next_result = interruptible_api_call(agent, {'model': agent.model})
                            self.assertEqual(next_result.terminal_event_type, 'response.completed')
                            self.assertTrue(workers[0].is_alive())
                            release.set()
                            workers[0].join(2)
                            self.assertFalse(workers[0].is_alive())
                            self.assertEqual(calls, [0, 1], 'OLD cannot regain retry permission')
                            self.assertEqual(deltas, [], 'OLD cannot regain event permission')
                            self.assertEqual(closes.count((0, workers[0].ident)), 1)
                        else:
                            controller.join(2)
                            self.assertFalse(controller.is_alive())
                            self.assertEqual(outcomes[0].terminal_event_type, 'response.completed')
                            self.assertEqual(calls, [0, 0] if phase == 'ordinary-retry' else [0])
                        self.assertEqual(len(closes), len(clients))
                        self.assertEqual(len(stream_closes), 2 if phase == 'stream' else 1)
                    finally:
                        release.set()
                        controller.join(2)
                        for worker in workers:
                            worker.join(2)


class RevocationBoundaryTests(unittest.TestCase):
    """B3a settlement revocation, not stream terminal or HTTP cancellation proof."""
    setUp = ResponsesObservationTests.setUp

    def test_settlement_revokes_copied_context_even_after_parent_reset(self):
        from contextvars import copy_context
        self.client.responses.create = lambda **kwargs: self.result
        token = enter_isolated_turn(self.cap)
        try:
            self.iso._observe_openai_client(self.client)
            retained = copy_context()
            self.assertIs(self.runtime.run_codex_stream(self.agent, self.payload, client=self.client), self.result)
            settle_isolated_work(self.cap)
        finally:
            exit_isolated_turn(token)
        before = self.cap.responses_sdk_attempted
        with self.assertRaises(IsolationAbort):
            retained.run(self.runtime.run_codex_stream, self.agent, self.payload, client=self.client)
        self.assertEqual(self.cap.responses_sdk_attempted, before)
        self.assertTrue(self.cap.provider_work_settled)
        ordinary = SimpleNamespace(responses=SimpleNamespace(create=lambda **kwargs: self.result))
        self.assertIs(self.runtime.run_codex_stream(self.agent, self.payload, client=ordinary), self.result)

    def test_accepted_create_can_finish_but_revoked_retry_cannot_start(self):
        from contextvars import copy_context
        import threading
        for outcome in ("return", "retry", "typed"):
            with self.subTest(outcome=outcome):
                self.setUp()
                entered, release = threading.Event(), threading.Event()
                receipts, results = [], []
                cause = IsolationAbort("fixture_typed_cause")
                def edge(**kwargs):
                    receipts.append(threading.get_ident())
                    entered.set()
                    if not release.wait(3):
                        raise AssertionError("fixture release missing")
                    if outcome == "retry":
                        raise ConnectionError("fixture retry")
                    if outcome == "typed":
                        raise cause
                    return self.result
                self.client.responses.create = edge
                token = enter_isolated_turn(self.cap)
                try:
                    self.iso._observe_openai_client(self.client)
                    context = copy_context()
                finally:
                    exit_isolated_turn(token)
                def work():
                    try:
                        results.append(context.run(self.runtime.run_codex_stream, self.agent, self.payload, client=self.client))
                    except BaseException as exc:
                        results.append(exc)
                worker = threading.Thread(target=work)
                worker.start()
                try:
                    self.assertTrue(entered.wait(3))
                    with self.assertRaises(IsolationAbort) as failure:
                        settle_isolated_work(self.cap, timeout_s=0.02)
                    self.assertEqual(failure.exception.reason, "provider_work_unsettled")
                    # An unrelated ordinary call overlaps the accepted old create.
                    ordinary = SimpleNamespace(responses=SimpleNamespace(create=lambda **kwargs: self.result))
                    self.assertIs(self.runtime.run_codex_stream(self.agent, self.payload, client=ordinary), self.result)
                finally:
                    release.set()
                    worker.join(3)
                self.assertFalse(worker.is_alive())
                self.assertEqual(len(receipts), 1)
                if outcome == "return":
                    self.assertIs(results[0], self.result)
                elif outcome == "typed":
                    self.assertIs(results[0], cause)
                else:
                    self.assertIsInstance(results[0], IsolationAbort)
                settle_isolated_work(self.cap)
                self.assertEqual(self.cap.responses_sdk_attempted, 1)
                self.assertEqual(self.cap.responses_sdk_returned, int(outcome == "return"))

    def test_settlement_has_one_deadline_and_denies_new_thread_start(self):
        import threading
        import time
        release = threading.Event()
        workers = [threading.Thread(target=lambda: release.wait(3)) for _ in range(3)]
        for worker in workers:
            worker.start()
        self.cap.in_flight_threads.extend(workers)
        started = time.monotonic()
        try:
            with self.assertRaises(IsolationAbort):
                settle_isolated_work(self.cap, timeout_s=0.1)
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 0.23)
        finally:
            release.set()
            for worker in workers:
                worker.join(3)
        settle_isolated_work(self.cap)
        self.iso._wrap_thread_context_propagation()
        token = enter_isolated_turn(self.cap)
        late = threading.Thread(target=lambda: None)
        try:
            with self.assertRaises(IsolationAbort):
                late.start()
        finally:
            exit_isolated_turn(token)
            if late.ident is not None:
                late.join(3)
        self.assertIsNone(late.ident)


class AcquisitionRevocationTests(unittest.TestCase):
    setUp = RequestIdentityBoundaryTests.setUp
    request = RequestIdentityBoundaryTests.request

    def test_copied_acquisition_extent_cannot_acquire_after_settlement(self):
        from contextvars import copy_context
        token = enter_isolated_turn(self.cap)
        try:
            client = self.request()
            acquisition = self.iso._REQUEST_ACQUISITION.set(self.cap._request_identity)
            try:
                retained = copy_context()
            finally:
                self.iso._REQUEST_ACQUISITION.reset(acquisition)
            settle_isolated_work(self.cap)
        finally:
            exit_isolated_turn(token)
        before = len(self.acquisitions)
        for call in (self.request, lambda: self.agent._ensure_primary_openai_client(reason="offline-revocation"),
                     lambda: client.chat.completions.create(model="fixture-model")):
            with self.subTest(call=call), self.assertRaises(IsolationAbort):
                retained.run(call)
        self.assertEqual(len(self.acquisitions), before)
        self.assertEqual(self.dispatches, [])

    def test_accepted_factory_returns_observed_client_to_existing_owner(self):
        from contextvars import copy_context
        import threading
        entered, release = threading.Event(), threading.Event()
        results = []
        edge = self.ra.OpenAI
        def sdk(**kwargs):
            entered.set()
            if not release.wait(3):
                raise AssertionError("fixture release missing")
            return edge(**kwargs)
        token = enter_isolated_turn(self.cap)
        context = copy_context()
        exit_isolated_turn(token)
        def work():
            try:
                results.append(context.run(self.request))
            except BaseException as exc:
                results.append(exc)
        with mock.patch.object(self.ra, "OpenAI", sdk):
            worker = threading.Thread(target=work)
            worker.start()
            try:
                self.assertTrue(entered.wait(3))
                with self.assertRaises(IsolationAbort):
                    settle_isolated_work(self.cap, timeout_s=0.02)
            finally:
                release.set()
                worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(results), 1)
        self.assertNotIsInstance(results[0], BaseException)
        with self.assertRaises(IsolationAbort):
            context.run(results[0].chat.completions.create, model="fixture-model")
        self.assertEqual(len(self.acquisitions), 1)
        self.assertEqual(self.dispatches, [])
        settle_isolated_work(self.cap)


class ResponsesConcurrencyTests(unittest.TestCase):
    setUp = ResponsesObservationTests.setUp

    def test_concurrent_sdk_counts(self):
        from wolfhouse.responses_concurrency_probe import check_concurrent_counts
        check_concurrent_counts(self)


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
            model="counter-model",
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
            model="counter-model",
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

    def test_stale_bedrock_factory_refuses_before_dispatch(self) -> None:
        self.assertTrue(HERMES_HELPERS.is_file())
        t = _complete_targets()
        dispatches = []
        bedrock = types.ModuleType("agent.bedrock_adapter")

        class _Denied(Exception):
            pass

        def _live_factory(region):  # noqa: ANN001
            def converse_stream(**kw):  # noqa: ANN003
                dispatches.append("converse_stream")
                raise _Denied("iam denied stream")

            def converse(**kw):  # noqa: ANN003
                dispatches.append("converse")
                return {"output": {"message": {"content": [{"text": "ok"}]}}}

            return SimpleNamespace(converse_stream=converse_stream, converse=converse)

        bedrock._get_bedrock_runtime_client = _live_factory
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
            "logger": SimpleNamespace(debug=lambda *a, **k: None, warning=lambda *a, **k: None, info=lambda *a, **k: None),
        }
        real = _extract_unchanged(HERMES_HELPERS, "interruptible_streaming_api_call", ns)
        t.provider_mod.interruptible_streaming_api_call = real
        try:
            install_isolation_runtime(targets=t)
            wrapped_factory = bedrock._get_bedrock_runtime_client
            bedrock._get_bedrock_runtime_client = _live_factory
            cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
            tok = enter_isolated_turn(cap)
            try:
                with self.assertRaises(IsolationAbort) as ctx:
                    preflight_isolation_or_abort(require_live_seams=True, targets=t)
                self.assertIn("provider_dispatch_wrapped", ctx.exception.reason)
                agent = SimpleNamespace(api_mode="bedrock_converse", _interrupt_requested=False, _safe_print=lambda x: None)
                with self.assertRaises(IsolationAbort) as helper_ctx:
                    t.provider_mod.interruptible_streaming_api_call(
                        agent,
                        {
                            "modelId": "counter-model",
                            "system": [{"text": "Luna Personality this turn: calm. Patient."}],
                        },
                    )
                self.assertIn("stale_bedrock_client_factory", helper_ctx.exception.reason)
                self.assertEqual(dispatches, [])
                self.assertEqual(cap.model_calls, 0)
                self.assertFalse(cap.observed_pack_from_provider)
            finally:
                exit_isolated_turn(tok)
            bedrock._get_bedrock_runtime_client = wrapped_factory
        finally:
            sys.modules.pop("agent.bedrock_adapter", None)


class SnapshotAndMirrorIsolationTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_isolation_runtime_for_tests()

    def test_extracted_persist_session_denies_snapshot_and_db(self) -> None:
        self.assertTrue(HERMES_RUN_AGENT.is_file())
        t = _complete_targets()
        runner, effects = _runner_with_db(t)
        agent = SimpleNamespace(
            _session_json_enabled=True,
            _session_db=runner._session_db,
            _session_db_created=True,
            _last_flushed_db_idx=0,
            session_id="lunaeval_probe",
            _drop_trailing_empty_response_scaffolding=lambda messages: None,
            _apply_persist_user_message_override=lambda messages: None,
            _save_session_log=lambda messages=None: effects.append("agent_json_snapshot"),
            _flush_messages_to_session_db=lambda messages, conv=None: runner._session_db.append_message(
                session_id="x", role="assistant", content="synthetic"
            ),
        )
        runner._agent_cache["k"] = (agent, "sig", 0)
        install_isolation_runtime(targets=t, runner=runner)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            ns: dict = {"logger": SimpleNamespace(warning=lambda *a, **k: None, debug=lambda *a, **k: None)}
            persist = _extract_unchanged(HERMES_RUN_AGENT, "_persist_session", ns)
            persist(agent, [{"role": "assistant", "content": "synthetic"}])
            self.assertEqual(effects, [])
            self.assertEqual(cap.journal_writes_completed, 0)
            self.assertGreaterEqual(cap.journal_writes_denied, 1)
            self.assertNotIn("agent_json_snapshot", cap.persistence_effects_completed)
        finally:
            exit_isolated_turn(tok)

    def test_stale_snapshot_method_fails_preflight(self) -> None:
        t = _complete_targets()
        runner, effects = _runner_with_db(t)
        agent = SimpleNamespace(
            api_mode="chat_completions",
            _persist_session=lambda *a, **k: effects.append("persist"),
            _save_session_log=lambda *a, **k: effects.append("agent_json_snapshot"),
            _flush_messages_to_session_db=lambda *a, **k: effects.append("flush"),
            _run_codex_app_server_turn=lambda **k: effects.append("codex"),
            run_conversation=lambda *a, **k: {"final_response": "ok"},
            chat=lambda *a, **k: "ok",
            _run_codex_stream=lambda *a, **k: None,
            _run_codex_create_stream_fallback=lambda *a, **k: None,
            _anthropic_messages_create=lambda *a, **k: None,
            switch_model=lambda *a, **k: None,
            _create_request_openai_client=t.openai_client_factory_owner()._create_request_openai_client,
        )
        runner._agent_cache["k"] = (agent, "sig", 0)
        install_isolation_runtime(targets=t, runner=runner)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            agent._save_session_log = lambda *a, **k: effects.append("stale_snapshot")
            with self.assertRaises(IsolationAbort) as ctx:
                preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            self.assertIn("snapshot_wrapped", ctx.exception.reason)
            agent._save_session_log([{"role": "assistant", "content": "synthetic"}])
            self.assertEqual(effects, ["stale_snapshot"])
            self.assertEqual(cap.journal_writes_completed, 0)
        finally:
            exit_isolated_turn(tok)

    def test_update_token_counts_denied_not_fake_zero(self) -> None:
        t = _complete_targets()
        runner, effects = _runner_with_db(t)
        install_isolation_runtime(targets=t, runner=runner)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            runner._session_db.update_token_counts(session_id="x", input_tokens=3, output_tokens=1)
            self.assertEqual(effects, [])
            self.assertGreaterEqual(cap.persistence_denied.get("sqlite:update_token_counts", 0), 1)
            self.assertEqual(cap.journal_writes_completed, 0)
        finally:
            exit_isolated_turn(tok)

    def test_canonical_mirror_denied_before_queue(self) -> None:
        import wolfhouse_whatsapp_mirror as mirror

        t = _complete_targets()
        t.mirror_mod = mirror
        http = []
        runner, _effects = _runner_with_db(t)
        install_isolation_runtime(targets=t, runner=runner)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            source = SimpleNamespace(user_id="491234567890", chat_id="491234567890", user_name="Eval")
            event = SimpleNamespace(metadata={}, message_id="wamid.eval", timestamp=None, message_type="text")
            with mock.patch.object(mirror, "get_mirror_queue", side_effect=AssertionError("queue must not be created")):
                with mock.patch("urllib.request.urlopen", side_effect=lambda *a, **k: http.append("http") or (_ for _ in ()).throw(AssertionError("http"))):
                    mirror.mirror_whatsapp_thread(source, event, "inbound", "hello from eval")
            self.assertEqual(http, [])
            self.assertGreaterEqual(cap.journal_writes_denied, 1)
            self.assertEqual(cap.journal_writes_completed, 0)
        finally:
            exit_isolated_turn(tok)

    def test_ordinary_mirror_passthrough_when_not_isolated(self) -> None:
        t = _complete_targets()
        calls = []
        t.mirror_mod.mirror_whatsapp_thread = lambda *a, **k: calls.append("mirror")
        t.mirror_mod.enqueue_mirror_payload = lambda payload: calls.append("enqueue") or True
        install_isolation_runtime(targets=t)
        t.mirror_mod.mirror_whatsapp_thread("s", "e", "inbound", "hi")
        t.mirror_mod.enqueue_mirror_payload({"guest_phone": "+1"})
        self.assertEqual(calls, ["mirror", "enqueue"])

    def test_dynamic_loader_required_missing_owner_fails_closed(self) -> None:
        import wolfhouse.luna_personality_isolation as iso
        import wolfhouse_whatsapp_mirror as mirror

        t = _complete_targets()
        t.mirror_mod = mirror
        runner, _effects = _runner_with_db(t)
        install_isolation_runtime(targets=t, runner=runner)
        live = inspect_live_seams(targets=t, runner=runner)
        self.assertTrue(live["mirror_wrapped"])
        self.assertTrue(getattr(importlib.util.spec_from_file_location, "_luna_personality_isolated", False))
        orig_spec = None
        for owner, attr, orig in iso._ORIG_OWNERS:
            if owner is importlib.util and attr == "spec_from_file_location":
                orig_spec = orig
                break
        self.assertIsNotNone(orig_spec)
        importlib.util.spec_from_file_location = orig_spec
        live = inspect_live_seams(targets=t, runner=runner)
        self.assertFalse(live["mirror_wrapped"])
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            with self.assertRaises(IsolationAbort) as ctx:
                preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            self.assertIn("mirror_wrapped", ctx.exception.reason)
        finally:
            exit_isolated_turn(tok)

    def test_unchanged_bootstrap_inbound_mirror_fresh_module_denied_before_queue(self) -> None:
        import wolfhouse_whatsapp_mirror as mirror

        self.assertTrue(CANONICAL_MIRROR.is_file())
        t = _complete_targets()
        t.mirror_mod = mirror
        runner, _effects = _runner_with_db(t)
        install_isolation_runtime(targets=t, runner=runner)
        effects = []
        fresh = {}
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            _install_fresh_queue_counter(effects, fresh)
            source, event = _eval_source_event()
            with mock.patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "sunset"}, clear=False):
                _exec_unchanged_inbound_mirror(source, event, "hello from eval")
            self.assertTrue(fresh.get("fresh_module"))
            self.assertIsNot(fresh.get("mod"), mirror)
            self.assertTrue(fresh.get("fresh_entry_wrapped"))
            self.assertEqual(effects, [])
            self.assertGreaterEqual(cap.journal_writes_denied, 1)
            self.assertEqual(cap.journal_writes_completed, 0)
        finally:
            exit_isolated_turn(tok)

    def test_ordinary_dynamic_bootstrap_mirror_passthrough(self) -> None:
        import wolfhouse_whatsapp_mirror as mirror

        self.assertTrue(CANONICAL_MIRROR.is_file())
        t = _complete_targets()
        t.mirror_mod = mirror
        runner, _effects = _runner_with_db(t)
        install_isolation_runtime(targets=t, runner=runner)
        effects = []
        fresh = {}
        _install_fresh_queue_counter(effects, fresh)
        source, event = _eval_source_event()
        with mock.patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            _exec_unchanged_inbound_mirror(source, event, "hello from eval")
        self.assertTrue(fresh.get("fresh_module"))
        self.assertEqual(effects, ["queue_enqueue"])
        self.assertIsNone(current_isolated_turn())


class DynamicMirrorLifecycleTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_isolation_runtime_for_tests()

    def test_repeated_ordinary_dynamic_mirror_loads_are_not_rooted_by_originals_registry(self) -> None:
        import wolfhouse.luna_personality_isolation as iso

        self.assertTrue(CANONICAL_MIRROR.is_file())
        self.assertIsNone(current_isolated_turn())
        before_install = _count_retained_fresh_mirror_loads(12)
        self.assertEqual(before_install, 0)

        t = _complete_targets()
        runner, _effects = _runner_with_db(t)
        install_isolation_runtime(targets=t, runner=runner)
        self.assertIsNone(current_isolated_turn())
        registry_before = len(iso._ORIG_OWNERS)
        self.assertGreater(registry_before, 0)
        after_install = _count_retained_fresh_mirror_loads(12)
        registry_added = len(iso._ORIG_OWNERS) - registry_before
        self.assertEqual(
            after_install,
            0,
            "ephemeral bootstrap mirrors must be collectable without test-only reset",
        )
        self.assertEqual(registry_added, 0)
        self.assertIsNone(current_isolated_turn())

    def test_repeated_isolated_dynamic_mirror_loads_are_not_rooted_by_originals_registry(self) -> None:
        import wolfhouse.luna_personality_isolation as iso

        self.assertTrue(CANONICAL_MIRROR.is_file())
        t = _complete_targets()
        runner, _effects = _runner_with_db(t)
        install_isolation_runtime(targets=t, runner=runner)
        registry_before = len(iso._ORIG_OWNERS)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            self.assertIsNotNone(current_isolated_turn())
            retained = _count_retained_fresh_mirror_loads(12)
            registry_added = len(iso._ORIG_OWNERS) - registry_before
            self.assertEqual(retained, 0)
            self.assertEqual(registry_added, 0)
        finally:
            exit_isolated_turn(tok)
        self.assertIsNone(current_isolated_turn())

    def test_retained_fresh_module_wrapped_functions_remain_usable(self) -> None:
        self.assertTrue(CANONICAL_MIRROR.is_file())
        t = _complete_targets()
        runner, _effects = _runner_with_db(t)
        install_isolation_runtime(targets=t, runner=runner)
        mod = _load_canonical_fresh_mirror()
        self.assertTrue(getattr(mod.mirror_whatsapp_thread, "_luna_personality_isolated", False))
        source, event = _eval_source_event()
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            with mock.patch.object(mod, "get_mirror_queue", side_effect=AssertionError("queue must not be created")):
                with mock.patch.object(mod, "enqueue_mirror_payload", side_effect=AssertionError("enqueue must not run")):
                    mod.mirror_whatsapp_thread(source, event, "inbound", "hello from eval")
            self.assertGreaterEqual(cap.journal_writes_denied, 1)
            self.assertEqual(cap.journal_writes_completed, 0)
        finally:
            exit_isolated_turn(tok)

        effects = []

        def get_mirror_queue():
            def enqueue(payload):  # noqa: ANN001
                effects.append("queue_enqueue")
                return True

            return SimpleNamespace(enqueue=enqueue)

        mod.get_mirror_queue = get_mirror_queue
        with mock.patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            mod.mirror_whatsapp_thread(source, event, "inbound", "hello from eval")
        self.assertEqual(effects, ["queue_enqueue"])
        self.assertIsNone(current_isolated_turn())

    def test_missing_dynamic_mirror_owner_fails_closed_before_effects(self) -> None:
        t = _complete_targets()
        runner, _effects = _runner_with_db(t)
        install_isolation_runtime(targets=t, runner=runner)

        class EmptyMirrorLoader:
            def create_module(self, spec):  # noqa: ANN001
                return None

            def exec_module(self, module):  # noqa: ANN001
                module.loaded = True

        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            spec = importlib.util.spec_from_file_location(
                name="wolfhouse_whatsapp_mirror",
                location=str(CANONICAL_MIRROR),
                loader=EmptyMirrorLoader(),
            )
            mod = importlib.util.module_from_spec(spec)
            with self.assertRaises(IsolationAbort) as ctx:
                spec.loader.exec_module(mod)
            self.assertEqual(ctx.exception.reason, "missing_isolation_owner")
            self.assertGreaterEqual(cap.journal_writes_denied, 1)
            self.assertEqual(cap.journal_writes_completed, 0)
            self.assertTrue(getattr(mod, "loaded", False))
            self.assertIsNone(getattr(mod, "mirror_whatsapp_thread", None))
        finally:
            exit_isolated_turn(tok)

    def test_unrelated_importlib_loader_kwargs_remain_compatible(self) -> None:
        t = _complete_targets()
        runner, _effects = _runner_with_db(t)
        install_isolation_runtime(targets=t, runner=runner)

        class OrdinaryLoader:
            def create_module(self, spec):  # noqa: ANN001
                return None

            def exec_module(self, module):  # noqa: ANN001
                module.answer = 42
                return "loader-result"

        loader = OrdinaryLoader()
        spec = importlib.util.spec_from_file_location(
            name="ordinary_plugin",
            location="ordinary_plugin.py",
            loader=loader,
            submodule_search_locations=["ordinary_plugin"],
        )
        self.assertIs(spec.loader, loader)
        self.assertFalse(getattr(spec.loader.exec_module, "_luna_personality_isolated", False))
        mod = importlib.util.module_from_spec(spec)
        result = spec.loader.exec_module(mod)
        self.assertEqual(result, "loader-result")
        self.assertEqual(mod.answer, 42)
        self.assertEqual(getattr(spec, "name", None), "ordinary_plugin")
        self.assertFalse(getattr(mod, "_luna_personality_isolated", False))

    def test_repeated_install_reset_restores_long_lived_owners_only(self) -> None:
        import wolfhouse.luna_personality_isolation as iso
        import wolfhouse_whatsapp_mirror as mirror

        self.assertTrue(CANONICAL_MIRROR.is_file())
        t = _complete_targets()
        t.mirror_mod = mirror
        runner, _effects = _runner_with_db(t)
        install_isolation_runtime(targets=t, runner=runner)
        self.assertTrue(iso._is_wrapped(mirror.mirror_whatsapp_thread))
        self.assertTrue(iso._is_wrapped(importlib.util.spec_from_file_location))
        self.assertTrue(any(owner is mirror for owner, _attr, _orig in iso._ORIG_OWNERS))
        self.assertTrue(
            any(
                owner is importlib.util and attr == "spec_from_file_location"
                for owner, attr, _orig in iso._ORIG_OWNERS
            )
        )

        fresh = _load_canonical_fresh_mirror()
        self.assertTrue(getattr(fresh.mirror_whatsapp_thread, "_luna_personality_isolated", False))
        self.assertFalse(any(owner is fresh for owner, _attr, _orig in iso._ORIG_OWNERS))
        queue_cls = getattr(fresh, "MirrorQueue", None)
        self.assertFalse(any(owner is queue_cls for owner, _attr, _orig in iso._ORIG_OWNERS))
        fresh_ref = weakref.ref(fresh)
        del fresh
        gc.collect()
        gc.collect()
        self.assertIsNone(fresh_ref())

        reset_isolation_runtime_for_tests()
        self.assertEqual(iso._ORIG_OWNERS, [])
        self.assertFalse(iso._is_wrapped(mirror.mirror_whatsapp_thread))
        self.assertFalse(iso._is_wrapped(importlib.util.spec_from_file_location))

        install_isolation_runtime(targets=t, runner=runner)
        self.assertTrue(iso._is_wrapped(mirror.mirror_whatsapp_thread))
        self.assertTrue(iso._is_wrapped(importlib.util.spec_from_file_location))
        self.assertTrue(any(owner is mirror for owner, _attr, _orig in iso._ORIG_OWNERS))
        reset_isolation_runtime_for_tests()
        self.assertEqual(iso._ORIG_OWNERS, [])
        self.assertFalse(iso._is_wrapped(mirror.mirror_whatsapp_thread))
        self.assertFalse(iso._is_wrapped(importlib.util.spec_from_file_location))


class _HashPlatform:
    def __init__(self, value: str = "whatsapp_cloud") -> None:
        self.value = value

    def __hash__(self) -> int:
        return hash(self.value)

    def __eq__(self, other: object) -> bool:
        return getattr(other, "value", other) == self.value


class AdapterMapAndTurnEntryTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_isolation_runtime_for_tests()

    def test_stale_adapter_map_send_fails_preflight(self) -> None:
        t = _complete_targets()
        runner, _effects = _runner_with_db(t)
        adapter = _FakeAdapter()
        platform = _HashPlatform()
        runner.adapters = {platform: adapter}
        install_isolation_runtime(targets=t, runner=runner)

        async def stale_send(*a, **k):  # noqa: ANN001
            return SimpleNamespace(success=True)

        adapter.send = stale_send
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            with self.assertRaises(IsolationAbort) as ctx:
                preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            self.assertIn("send_methods_wrapped", ctx.exception.reason)
        finally:
            exit_isolated_turn(tok)

    def test_pairing_branch_refuses_before_delivery(self) -> None:
        self.assertTrue(HERMES_GATEWAY.is_file())
        t = _complete_targets()
        runner, _effects = _runner_with_db(t)
        adapter = _FakeAdapter()
        platform = _HashPlatform()
        runner.adapters = {platform: adapter}
        install_isolation_runtime(targets=t, runner=runner)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            ns: dict = {"logger": SimpleNamespace(debug=lambda *a, **k: None, warning=lambda *a, **k: None)}
            source = SimpleNamespace(
                platform=platform,
                user_id="49eval",
                user_name="Eval",
                chat_id="49eval",
                chat_type="dm",
            )
            runner._is_user_authorized = lambda src: False
            runner._get_unauthorized_dm_behavior = lambda plat: "pair"
            runner.pairing_store = SimpleNamespace(
                _is_rate_limited=lambda *a, **k: False,
                generate_code=lambda *a, **k: "PAIR1",
                _record_rate_limit=lambda *a, **k: None,
            )
            branch = _extract_if_branch(
                HERMES_GATEWAY,
                "_get_unauthorized_dm_behavior",
                "_pair_branch",
                ["self", "source"],
                ns,
            )
            _run(branch(runner, source))
            self.assertGreaterEqual(cap.sends_attempted, 1)
            self.assertEqual(cap.sends_completed, 0)
        finally:
            exit_isolated_turn(tok)

    def test_codex_app_server_branch_zero_alternate_work(self) -> None:
        self.assertTrue(HERMES_LOOP.is_file())
        t = _complete_targets()
        effects = []

        def _codex_orig(self, **k):  # noqa: ANN001
            effects.append("alternate_provider_turn")
            return {"final_response": "codex"}

        t.agent_cls._run_codex_app_server_turn = _codex_orig
        runner, _db_effects = _runner_with_db(t)
        install_isolation_runtime(targets=t, runner=runner)
        agent = t.agent_cls()  # Pre-existing instance: test the independent turn defense.
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            agent.api_mode = "codex_app_server"
            ns: dict = {
                "user_message": "hi",
                "original_user_message": "hi",
                "messages": [],
                "effective_task_id": "t1",
                "_should_review_memory": False,
            }
            branch = _extract_if_branch(
                HERMES_LOOP,
                "codex_app_server",
                "_codex_branch",
                ["agent"],
                ns,
            )
            with self.assertRaises(IsolationAbort) as ctx:
                branch(agent)
            self.assertIn("unsupported_provider_backend:codex_app_server", ctx.exception.reason)
            self.assertEqual(effects, [])
            self.assertEqual(cap.model_calls, 0)
            self.assertEqual(cap.provider_helper_attempts, 0)
        finally:
            exit_isolated_turn(tok)

    def test_supported_cached_agent_turn_entry_is_ready(self) -> None:
        t = _complete_targets()
        runner, _effects = _runner_with_db(t)
        agent = t.agent_cls()
        agent.api_mode = "chat_completions"
        runner._agent_cache["k"] = (agent, "sig", 0)
        install_isolation_runtime(targets=t, runner=runner)
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            with self.assertRaises(IsolationAbort) as ctx:
                agent._run_codex_app_server_turn(user_message="hi")
            self.assertIn("unsupported_turn_owner:_run_codex_app_server_turn", ctx.exception.reason)
        finally:
            exit_isolated_turn(tok)

    def test_stale_codex_turn_owner_fails_preflight(self) -> None:
        t = _complete_targets()
        runner, effects = _runner_with_db(t)
        agent = t.agent_cls()
        agent.api_mode = "chat_completions"
        runner._agent_cache["k"] = (agent, "sig", 0)
        install_isolation_runtime(targets=t, runner=runner)
        agent._run_codex_app_server_turn = lambda **k: effects.append("alternate_provider_turn")
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            with self.assertRaises(IsolationAbort) as ctx:
                preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            self.assertIn("turn_entry_wrapped", ctx.exception.reason)
            agent._run_codex_app_server_turn(user_message="hi")
            self.assertEqual(effects, ["alternate_provider_turn"])
        finally:
            exit_isolated_turn(tok)

    def test_extracted_whatsapp_send_bound_instance_preserves_keyword_and_returns(self) -> None:
        self.assertTrue(HERMES_WHATSAPP.is_file())

        class SendResult:
            def __init__(self, success=True, message_id=None, error=None, raw_response=None, **_k):  # noqa: ANN003
                self.success = success
                self.message_id = message_id
                self.error = error
                self.raw_response = raw_response

        ns = {"SendResult": SendResult, "Optional": Optional, "Dict": dict, "Any": object}
        send_fn = _extract_unchanged(HERMES_WHATSAPP, "send", ns)
        adapter = SimpleNamespace(_http_client=None)
        adapter.send = types.MethodType(send_fn, adapter)
        before = _run(adapter.send(chat_id="49111", content="hello"))
        self.assertFalse(before.success)
        self.assertEqual(before.error, "Not connected")

        t = _complete_targets()
        runner, _effects = _runner_with_db(t)
        platform = _HashPlatform()
        runner.adapters = {platform: adapter}
        install_isolation_runtime(targets=t, runner=runner)
        after_kw = _run(adapter.send(chat_id="49111", content="hello"))
        self.assertFalse(after_kw.success)
        self.assertEqual(after_kw.error, "Not connected")
        after_pos = _run(adapter.send("49111", "hello"))
        self.assertFalse(after_pos.success)
        self.assertEqual(after_pos.error, "Not connected")

        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            _run(adapter.send(chat_id="49111", content="hello"))
            self.assertGreaterEqual(cap.sends_attempted, 1)
            self.assertEqual(cap.sends_completed, 0)
            with self.assertRaises(IsolationAbort) as ctx:
                runner.adapters.get(platform)
                adapter.send = send_fn
                preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            self.assertIn("send_methods_wrapped", ctx.exception.reason)
        finally:
            exit_isolated_turn(tok)

    def test_bound_counter_send_preserves_original_return_and_call_args(self) -> None:
        t = _complete_targets()
        runner, _effects = _runner_with_db(t)
        calls = []

        async def counter_send(*args, **kwargs):  # noqa: ANN001
            calls.append({"args": args, "kwargs": dict(kwargs)})
            return "original-result"

        adapter = SimpleNamespace()
        adapter.send = counter_send
        platform = _HashPlatform()
        runner.adapters = {platform: adapter}
        install_isolation_runtime(targets=t, runner=runner)
        result_kw = _run(adapter.send(chat_id="c1", content="hello"))
        self.assertEqual(result_kw, "original-result")
        self.assertEqual(calls, [{"args": (), "kwargs": {"chat_id": "c1", "content": "hello"}}])
        calls.clear()
        result_pos = _run(adapter.send("c1", "hello"))
        self.assertEqual(result_pos, "original-result")
        self.assertEqual(calls, [{"args": ("c1", "hello"), "kwargs": {}}])
        class_adapter = t.whatsapp_adapter_cls()
        class_kw = _run(class_adapter.send(chat_id="c2", content="hi"))
        self.assertTrue(getattr(class_kw, "success", False))

    def test_stale_adapter_map_refusal_still_at_use(self) -> None:
        t = _complete_targets()
        runner, _effects = _runner_with_db(t)
        adapter = _FakeAdapter()
        platform = _HashPlatform()
        runner.adapters = {platform: adapter}
        install_isolation_runtime(targets=t, runner=runner)

        async def stale_send(*a, **k):  # noqa: ANN001
            return SimpleNamespace(success=True)

        adapter.send = stale_send
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            with self.assertRaises(IsolationAbort) as ctx:
                runner.adapters.get(platform)
            self.assertIn("stale_adapter_send", ctx.exception.reason)
        finally:
            exit_isolated_turn(tok)

    def test_new_shadowed_factory_refused_before_canonical_prologue(self) -> None:
        self.assertTrue(HERMES_LOOP.is_file())
        t = _complete_targets()
        runner, _effects = _runner_with_db(t)
        self.assertEqual(runner._agent_cache, {})
        prologue = []
        provider = []

        class StopProbe(Exception):
            pass

        def build_turn_context(*a, **k):  # noqa: ANN001
            prologue.append("canonical_turn_prologue")
            raise StopProbe()

        ns: dict = {
            "build_turn_context": build_turn_context,
            "_restore_or_build_system_prompt": object(),
            "_install_safe_stdio": object(),
            "_sanitize_surrogates": object(),
            "_summarize_user_message_for_log": object(),
            "set_session_context": object(),
            "set_current_write_origin": object(),
            "_ra": object(),
        }
        real = _extract_unchanged(HERMES_LOOP, "run_conversation", ns)
        t.conversation_loop_mod.run_conversation = real
        install_isolation_runtime(targets=t, runner=runner)
        agent = t.agent_cls()  # Independent turn defense, not constructor admission.
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            self.assertEqual(runner._agent_cache, {})

            def unwrapped_factory(*a, **k):  # noqa: ANN001
                provider.append("factory")
                return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: provider.append("sdk"))))

            agent.api_mode = "chat_completions"
            agent._create_request_openai_client = unwrapped_factory
            with self.assertRaises(IsolationAbort) as module_ctx:
                t.conversation_loop_mod.run_conversation(agent, "hi")
            self.assertIn("stale_openai_client_factory", module_ctx.exception.reason)
            self.assertEqual(prologue, [])
            self.assertEqual(provider, [])

            with self.assertRaises(IsolationAbort) as agent_ctx:
                agent.run_conversation("hi")
            self.assertIn("stale_openai_client_factory", agent_ctx.exception.reason)
            self.assertEqual(prologue, [])
            self.assertEqual(provider, [])
            self.assertEqual(cap.model_calls, 0)
            self.assertEqual(cap.provider_helper_attempts, 0)
        finally:
            exit_isolated_turn(tok)

    def test_accepted_factory_module_turn_reaches_prologue(self) -> None:
        self.assertTrue(HERMES_LOOP.is_file())
        t = _complete_targets()
        runner, _effects = _runner_with_db(t)

        class StopProbe(Exception):
            pass

        prologue = []

        def build_turn_context(*a, **k):  # noqa: ANN001
            prologue.append("canonical_turn_prologue")
            raise StopProbe("StopProbe:")

        ns: dict = {
            "build_turn_context": build_turn_context,
            "_restore_or_build_system_prompt": object(),
            "_install_safe_stdio": object(),
            "_sanitize_surrogates": object(),
            "_summarize_user_message_for_log": object(),
            "set_session_context": object(),
            "set_current_write_origin": object(),
            "_ra": object(),
        }
        real = _extract_unchanged(HERMES_LOOP, "run_conversation", ns)
        t.conversation_loop_mod.run_conversation = real
        install_isolation_runtime(targets=t, runner=runner)
        agent = t.agent_cls()  # Independent turn defense, not constructor admission.
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            preflight_isolation_or_abort(require_live_seams=True, targets=t, runner=runner)
            agent.api_mode = "chat_completions"
            with self.assertRaises(StopProbe):
                t.conversation_loop_mod.run_conversation(agent, "hi")
            self.assertEqual(prologue, ["canonical_turn_prologue"])
        finally:
            exit_isolated_turn(tok)

        prologue.clear()
        agent_plain = t.agent_cls()
        agent_plain.api_mode = "chat_completions"
        with self.assertRaises(StopProbe):
            t.conversation_loop_mod.run_conversation(agent_plain, "hi")
        self.assertEqual(prologue, ["canonical_turn_prologue"])


CANONICAL_CORPUS = REPO / "fixtures" / "luna-personality-corpus.json"
CONTEXT_CORPUS = STAGING / "fixtures" / "luna-personality-corpus.json"
INSTALLED_COPY = (
    "COPY fixtures/luna-personality-corpus.json "
    "/etc/hermes-staging/fixtures/luna-personality-corpus.json"
)
STAGING_BUILD_CALLERS = (
    REPO / "scripts" / "deploy-staging-hermes-vm.js",
    REPO / "scripts" / "deploy-staging-hermes.js",
    REPO / "docs" / "MAIL-MVP-007-SUNSET-EMAIL-SOL-RUNBOOK.md",
)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _dockerfile_copy_pairs(text: str) -> list:
    pairs = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("COPY "):
            continue
        parts = line.split()
        if len(parts) < 3 or parts[1].startswith("--from"):
            continue
        src = parts[1]
        dest = parts[-1]
        pairs.append((src, dest))
    return pairs


class CorpusImagePackagingTests(unittest.TestCase):
    """Image-context + installed-path packaging. Not live model acceptance."""

    def test_dockerfile_copies_context_corpus_to_installed_path(self) -> None:
        dockerfile = (STAGING / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn(INSTALLED_COPY, dockerfile)
        pairs = _dockerfile_copy_pairs(dockerfile)
        matching = [
            (src, dest)
            for src, dest in pairs
            if src == "fixtures/luna-personality-corpus.json"
            or src.rstrip("/") == "fixtures"
        ]
        self.assertEqual(len(matching), 1, matching)
        src, dest = matching[0]
        self.assertEqual(src, "fixtures/luna-personality-corpus.json")
        self.assertEqual(dest, str(INSTALLED_CORPUS_PATH))
        self.assertFalse(any(src == "." for src, _dest in pairs))
        self.assertFalse(any(src.startswith("..") for src, _dest in pairs))
        self.assertIn("COPY wolfhouse /etc/hermes-staging/wolfhouse", dockerfile)

    def test_hermes_staging_build_context_contains_canonical_bytes(self) -> None:
        self.assertTrue(CANONICAL_CORPUS.is_file())
        self.assertTrue(
            CONTEXT_CORPUS.is_file(),
            "corpus must be inside docker/hermes-staging so ACR context can COPY it",
        )
        self.assertEqual(CONTEXT_CORPUS.read_bytes(), CANONICAL_CORPUS.read_bytes())
        self.assertEqual(_sha256(CONTEXT_CORPUS), _sha256(CANONICAL_CORPUS))
        context_root = STAGING.resolve()
        self.assertTrue(str(CONTEXT_CORPUS.resolve()).startswith(str(context_root) + os.sep))
        dockerfile = (STAGING / "Dockerfile").read_text(encoding="utf-8")
        for src, dest in _dockerfile_copy_pairs(dockerfile):
            if src != "fixtures/luna-personality-corpus.json":
                continue
            src_path = context_root / src
            self.assertTrue(src_path.is_file(), src_path)
            self.assertEqual(src_path.read_bytes(), CANONICAL_CORPUS.read_bytes())
            self.assertEqual(dest, str(INSTALLED_CORPUS_PATH))

    def test_packaged_corpus_preserves_allowlisted_matrix(self) -> None:
        packaged = load_corpus(CONTEXT_CORPUS)
        canonical = load_corpus(CANONICAL_CORPUS)
        self.assertEqual(packaged, canonical)
        ids = {item.get("id") for item in packaged.get("cases") or []}
        self.assertEqual(ids, set(ALLOWED_CASE_IDS))
        self.assertEqual(packaged.get("closed_ids"), ["sunny", "calm", "concise", "extra"])

    def test_installed_loader_resolves_image_path_not_repo_checkout(self) -> None:
        self.assertEqual(
            INSTALLED_CORPUS_PATH,
            Path("/etc/hermes-staging/fixtures/luna-personality-corpus.json"),
        )
        self.assertIn(INSTALLED_CORPUS_PATH, corpus_candidates())
        with tempfile.TemporaryDirectory() as raw:
            staging = Path(raw) / "etc" / "hermes-staging"
            wolf = staging / "wolfhouse"
            fixtures = staging / "fixtures"
            wolf.mkdir(parents=True)
            fixtures.mkdir(parents=True)
            fake_mod = wolf / "luna_personality_live_eval.py"
            fake_mod.write_text("# installed layout\n", encoding="utf-8")
            installed = fixtures / "luna-personality-corpus.json"
            installed.write_bytes(CANONICAL_CORPUS.read_bytes())
            checkout = Path(raw) / "fixtures" / "luna-personality-corpus.json"
            self.assertFalse(checkout.is_file())
            resolved = _corpus_path(here=fake_mod)
            self.assertEqual(resolved, installed)
            self.assertNotEqual(resolved, CANONICAL_CORPUS)
            self.assertEqual(resolved.read_bytes(), CANONICAL_CORPUS.read_bytes())
            self.assertEqual(_sha256(resolved), _sha256(CANONICAL_CORPUS))
            loaded = load_corpus(here=fake_mod)
            self.assertEqual(loaded, load_corpus(CANONICAL_CORPUS))

    def test_staging_build_callers_keep_hermes_staging_context(self) -> None:
        for path in STAGING_BUILD_CALLERS:
            text = path.read_text(encoding="utf-8")
            self.assertTrue(path.is_file(), path)
            self.assertIn("docker/hermes-staging/Dockerfile", text)
            self.assertRegex(
                text,
                r"(--file|-f) docker/hermes-staging/Dockerfile docker/hermes-staging",
            )
            self.assertNotRegex(
                text,
                r"(--file|-f) docker/hermes-staging/Dockerfile \.",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
