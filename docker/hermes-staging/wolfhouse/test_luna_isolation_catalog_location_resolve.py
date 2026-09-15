"""Ordinary-entrypoint catalog location resolution before isolation auth.

Drives agent.tool_executor.execute_tool_calls_sequential with a stub
handle_function_call. Never calls the executor directly. Flags stay OFF.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import types
import unittest
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))
if "/opt/hermes" not in sys.path:
    sys.path.insert(0, "/opt/hermes")

os.environ["LUNA_APPEND_BODY_RECEIPT_ENABLED"] = "0"
os.environ["LUNA_LIVE_LOOP_TRACE_ENABLED"] = "0"

from wolfhouse.luna_group_lesson_live_eval import (  # noqa: E402
    READ_ONLY_STAFF_PATHS,
    READ_ONLY_TOOL_ALLOWLIST,
    run_isolated_group_lesson_eval,
)
from wolfhouse.luna_personality_isolation import (  # noqa: E402
    IsolatedTurnCapture,
    current_isolated_turn,
    deny_tool_if_isolated,
    enter_isolated_turn,
    exit_isolated_turn,
    reset_isolation_runtime_for_tests,
)

CATALOG = "get_sunset_lesson_catalog"
AVAILABILITY = "get_sunset_lesson_availability"
DENY = "luna_personality_isolated_no_tools"


def _module(name: str, **attrs: Any):
    value = types.ModuleType(name)
    for key, item in attrs.items():
        setattr(value, key, item)
    sys.modules[name] = value
    return value


def _prepare_ordinary_owner():
    noop = lambda *a, **kw: None  # noqa: E731

    class Decision:
        def __init__(self, allows_execution=True):
            self.allows_execution = allows_execution

        @classmethod
        def allow(cls):
            return cls(True)

    class Budget:
        pass

    _module(
        "agent.display",
        KawaiiSpinner=object,
        build_tool_preview=lambda *a: "",
        get_cute_tool_message=lambda *a, **kw: "",
        get_tool_emoji=lambda *a: "",
        _detect_tool_failure=lambda name, result: (
            isinstance(result, str) and ('Error executing' in result or '"error"' in result),
            None,
        ),
    )
    _module("agent.tool_guardrails", ToolGuardrailDecision=Decision)
    _module(
        "agent.tool_dispatch_helpers",
        _is_destructive_command=lambda *a: False,
        _is_multimodal_tool_result=lambda *a: False,
        _multimodal_text_summary=str,
        _append_subdir_hint_to_multimodal=noop,
        make_tool_result_message=lambda name, content, cid: {
            "role": "tool", "name": name, "content": content, "tool_call_id": cid,
        },
    )
    tools = _module("tools")
    tools.__path__ = []
    _module("tools.terminal_tool", get_active_env=lambda *a: None)
    _module("tools.thread_context", propagate_context_to_thread=lambda fn: fn)
    _module(
        "tools.tool_result_storage",
        maybe_persist_tool_result=lambda content, **kw: content,
        enforce_turn_budget=noop,
    )
    _module(
        "tools.budget_config",
        BudgetConfig=Budget,
        DEFAULT_BUDGET=Budget(),
        budget_for_context_window=lambda *a: Budget(),
    )
    _module(
        "tools.tool_search",
        TOOL_CALL_NAME="tool_search",
        resolve_underlying_call=lambda a: (None, None, None),
    )
    plugins_pkg = _module("hermes_cli")
    plugins_pkg.__path__ = []
    plugins = _module("hermes_cli.plugins", get_pre_tool_call_block_message=lambda *a, **kw: None)
    _module("agent.agent_runtime_helpers", agent_runtime_owns_post_tool_hook=lambda *a: False)
    _module("model_tools", _emit_post_tool_call_hook=noop)

    from agent import tool_executor as owner
    from wolfhouse import luna_personality_isolation as iso

    iso.reset_isolation_runtime_for_tests()
    if not iso._wrap_pre_tool_call_block(plugins):
        raise RuntimeError("ordinary validator wrap failed")

    stub_tls = threading.local()

    def stub_executor(name, args, *a, **kw):
        bucket = getattr(stub_tls, "calls", None)
        if bucket is None:
            raise RuntimeError("stub executor used outside run_ordinary")
        bucket.append((name, dict(args or {})))
        return json.dumps({"success": True, "stub": True, "tool": name}, ensure_ascii=False)

    owner._ra = lambda: types.SimpleNamespace(handle_function_call=stub_executor)
    owner._apply_tool_request_middleware_for_agent = (
        lambda agent, **kw: (kw["function_args"], [])
    )
    owner.maybe_persist_tool_result = lambda content, **kw: content
    owner.enforce_turn_budget = lambda *a, **kw: None
    owner.get_active_env = lambda *a, **kw: None

    def make_agent():
        agent = MagicMock()
        agent._interrupt_requested = False
        agent.quiet_mode = True
        agent.verbose_logging = False
        agent.tool_progress_callback = None
        agent.tool_start_callback = None
        agent.tool_complete_callback = None
        agent.tool_delay = 0
        agent.session_id = "offline-location-resolve"
        agent.valid_tool_names = set()
        agent._context_engine_tool_names = set()
        agent._memory_manager = None
        agent._current_turn_id = "turn"
        agent._current_api_request_id = "offline-location-resolve-api"
        agent._tool_guardrails.before_call.return_value = Decision.allow()
        agent._append_guardrail_observation.side_effect = lambda n, a, result, **kw: result
        agent._tool_result_content_for_active_model.side_effect = lambda n, result: result
        agent._subdirectory_hints.check_tool_call.return_value = ""
        agent._should_emit_quiet_tool_messages.return_value = False
        agent._should_use_spinner.return_value = False
        agent._checkpoint_mgr.enabled = False
        agent._apply_pending_steer_to_tool_results.return_value = None
        agent._record_file_mutation_result.return_value = None
        agent._touch_activity.return_value = None
        return agent

    def run_ordinary(
        *,
        tenant_id: Any = "sunset",
        location_id: Any = None,
        allowlist=READ_ONLY_TOOL_ALLOWLIST,
        tool_name: str = CATALOG,
        args: Optional[Dict[str, Any]] = None,
        case_id: str = "sunset-group-lesson-09-es",
        personality_id: str = "sunny",
        bind_location: bool = True,
    ) -> dict[str, Any]:
        local_calls: list[tuple[str, dict[str, Any]]] = []
        stub_tls.calls = local_calls
        cap = IsolatedTurnCapture(
            case_id=case_id,
            personality_id=personality_id,
            tenant_id=tenant_id,
        )
        if bind_location:
            cap.location_id = location_id
        if allowlist is not None:
            cap.read_only_tool_allowlist = frozenset(allowlist)
            cap.read_only_staff_paths = READ_ONLY_STAFF_PATHS
        token = enter_isolated_turn(cap)
        try:
            agent = make_agent()
            payload = dict(args or {})
            tc = types.SimpleNamespace(
                id="call-catalog-resolve",
                function=types.SimpleNamespace(
                    name=tool_name,
                    arguments=json.dumps(payload),
                ),
            )
            messages: list[Any] = []
            owner.execute_tool_calls_sequential(
                agent,
                types.SimpleNamespace(tool_calls=[tc]),
                messages,
                "task",
            )
            appended = messages[0]["content"] if messages else None
            parsed = appended
            if isinstance(appended, str):
                try:
                    parsed = json.loads(appended)
                except json.JSONDecodeError:
                    parsed = appended
            return {
                "stub_count": len(local_calls),
                "stub_calls": list(local_calls),
                "executed_args": local_calls[0][1] if local_calls else None,
                "appended": appended,
                "parsed": parsed,
                "tools_denied": list(cap.tools_denied),
                "read_tools_invoked": list(cap.read_tools_invoked),
            }
        finally:
            stub_tls.calls = None
            exit_isolated_turn(token)
            if current_isolated_turn() is not None:
                raise RuntimeError("isolation leaked")

    return {
        "iso": iso,
        "owner": owner,
        "plugins": plugins,
        "run_ordinary": run_ordinary,
        "make_agent": make_agent,
    }


class CatalogLocationResolveOrdinaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.harness = _prepare_ordinary_owner()
        cls._run_ordinary = staticmethod(cls.harness["run_ordinary"])

    def run_ordinary(self, **kwargs):
        return self._run_ordinary(**kwargs)

    @classmethod
    def tearDownClass(cls):
        reset_isolation_runtime_for_tests()

    def setUp(self):
        os.environ["LUNA_APPEND_BODY_RECEIPT_ENABLED"] = "0"
        os.environ["LUNA_LIVE_LOOP_TRACE_ENABLED"] = "0"

    def test_omitted_location_with_verified_server_bound_context_reaches_stub_once(self):
        result = self.run_ordinary(
            tenant_id="sunset",
            location_id="sunset-somo",
            args={},
        )
        self.assertEqual(result["stub_count"], 1)
        self.assertEqual(result["stub_calls"][0][0], CATALOG)
        self.assertEqual(result["executed_args"], {"location_id": "sunset-somo"})
        self.assertNotIn(DENY, str(result["parsed"]))

    def test_quantity_without_location_id_resolves_from_bound_context(self):
        result = self.run_ordinary(
            tenant_id="sunset",
            location_id="sunset-somo",
            args={"quantity": 2},
        )
        self.assertEqual(result["stub_count"], 1)
        self.assertEqual(
            result["executed_args"],
            {"quantity": 2, "location_id": "sunset-somo"},
        )

    def test_explicit_authorized_location_id_reaches_stub_once_unchanged(self):
        original = {"location_id": "sunset-somo"}
        result = self.run_ordinary(
            tenant_id="sunset",
            location_id="sunset-somo",
            args=original,
        )
        self.assertEqual(result["stub_count"], 1)
        self.assertEqual(result["executed_args"], original)
        self.assertEqual(list(result["executed_args"].keys()), ["location_id"])

    def test_missing_context_does_not_execute(self):
        result = self.run_ordinary(tenant_id="sunset", location_id=None, args={})
        self.assertEqual(result["stub_count"], 0)
        self.assertEqual((result["parsed"] or {}).get("error"), DENY)

    def test_unbound_location_attribute_does_not_execute(self):
        result = self.run_ordinary(
            tenant_id="sunset",
            location_id=None,
            args={},
            bind_location=False,
        )
        self.assertEqual(result["stub_count"], 0)

    def test_ambiguous_context_does_not_execute(self):
        for location in ("", "sunset-somo ", "SUNSET-SOMO", ["sunset-somo"], "sunset-sardinero"):
            result = self.run_ordinary(
                tenant_id="sunset",
                location_id=location,
                args={},
            )
            self.assertEqual(result["stub_count"], 0, location)
            self.assertEqual((result["parsed"] or {}).get("error"), DENY, location)

    def test_cross_tenant_context_does_not_execute(self):
        result = self.run_ordinary(
            tenant_id="wolfhouse-somo",
            location_id="sunset-somo",
            args={},
        )
        self.assertEqual(result["stub_count"], 0)
        self.assertEqual((result["parsed"] or {}).get("error"), DENY)

    def test_explicit_conflicting_location_is_not_rewritten(self):
        original = {"location_id": "sunset-sardinero"}
        result = self.run_ordinary(
            tenant_id="sunset",
            location_id="sunset-somo",
            args=original,
        )
        self.assertEqual(result["stub_count"], 0)
        self.assertEqual((result["parsed"] or {}).get("error"), DENY)
        self.assertIsNone(result["executed_args"])

    def test_alias_key_location_without_location_id_does_not_execute(self):
        result = self.run_ordinary(
            tenant_id="sunset",
            location_id="sunset-somo",
            args={"location": "sunset-somo"},
        )
        self.assertEqual(result["stub_count"], 0)
        self.assertEqual((result["parsed"] or {}).get("error"), DENY)

    def test_genuine_personality_no_tools_context_does_not_execute(self):
        omitted = self.run_ordinary(
            tenant_id="sunset",
            location_id="sunset-somo",
            allowlist=None,
            args={},
            case_id="warmth-greeting-en",
        )
        explicit = self.run_ordinary(
            tenant_id="sunset",
            location_id="sunset-somo",
            allowlist=None,
            args={"location_id": "sunset-somo"},
            case_id="warmth-greeting-en",
        )
        self.assertEqual(omitted["stub_count"], 0)
        self.assertEqual(explicit["stub_count"], 0)
        self.assertEqual((omitted["parsed"] or {}).get("error"), DENY)
        self.assertEqual((explicit["parsed"] or {}).get("error"), DENY)

    def test_prohibited_write_and_send_tools_do_not_execute(self):
        for name in ("create_sunset_booking", "create_sunset_payment_link", "send_email"):
            result = self.run_ordinary(
                tenant_id="sunset",
                location_id="sunset-somo",
                tool_name=name,
                args={"location_id": "sunset-somo"},
            )
            self.assertEqual(result["stub_count"], 0, name)
            self.assertEqual((result["parsed"] or {}).get("error"), DENY, name)

    def test_terminal_does_not_execute(self):
        result = self.run_ordinary(
            tenant_id="sunset",
            location_id="sunset-somo",
            tool_name="terminal",
            args={"cmd": "id"},
        )
        self.assertEqual(result["stub_count"], 0)
        self.assertEqual((result["parsed"] or {}).get("error"), DENY)

    def test_availability_omitted_location_is_not_broadened(self):
        result = self.run_ordinary(
            tenant_id="sunset",
            location_id="sunset-somo",
            tool_name=AVAILABILITY,
            args={},
        )
        self.assertEqual(result["stub_count"], 0)
        self.assertEqual((result["parsed"] or {}).get("error"), DENY)

    def test_ambient_env_and_routing_are_not_location_sources(self):
        with patch.dict(os.environ, {"SUNSET_INGRESS_LOCATION_ID": "sunset-somo"}, clear=False):
            env_result = self.run_ordinary(
                tenant_id="sunset",
                location_id=None,
                args={},
            )
        self.assertEqual(env_result["stub_count"], 0)

        from sunset_tenant_routing import reset_current_location, set_current_location

        token = set_current_location("sunset-somo")
        try:
            routing_result = self.run_ordinary(
                tenant_id="sunset",
                location_id=None,
                args={},
            )
        finally:
            reset_current_location(token)
        self.assertEqual(routing_result["stub_count"], 0)

    def test_direct_deny_gate_still_requires_explicit_location_id(self):
        cap = IsolatedTurnCapture(
            case_id="sunset-group-lesson-09-es",
            personality_id="sunny",
            tenant_id="sunset",
        )
        cap.location_id = "sunset-somo"
        cap.read_only_tool_allowlist = READ_ONLY_TOOL_ALLOWLIST
        token = enter_isolated_turn(cap)
        try:
            self.assertIsNotNone(deny_tool_if_isolated(CATALOG, {}))
            self.assertIsNone(deny_tool_if_isolated(CATALOG, {"location_id": "sunset-somo"}))
        finally:
            exit_isolated_turn(token)

    def test_concurrent_contexts_do_not_leak_or_cross_talk(self):
        barrier = threading.Barrier(2, timeout=5)
        results: dict[str, dict[str, Any]] = {}
        errors: list[BaseException] = []

        def authorized():
            try:
                barrier.wait()
                results["auth"] = self.run_ordinary(
                    tenant_id="sunset",
                    location_id="sunset-somo",
                    args={},
                    case_id="auth-context",
                )
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        def denied():
            try:
                barrier.wait()
                results["deny"] = self.run_ordinary(
                    tenant_id="wolfhouse-somo",
                    location_id="sunset-somo",
                    args={},
                    case_id="deny-context",
                )
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [
            threading.Thread(target=authorized),
            threading.Thread(target=denied),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(results["auth"]["stub_count"], 1)
        self.assertEqual(results["auth"]["executed_args"], {"location_id": "sunset-somo"})
        self.assertEqual(results["deny"]["stub_count"], 0)
        self.assertEqual((results["deny"]["parsed"] or {}).get("error"), DENY)
        self.assertIsNone(current_isolated_turn())

    def test_group_lesson_owner_binds_closed_corpus_location_on_capture(self):
        seen: dict[str, Any] = {}

        async def invoke(_message, cap, _context):
            seen["tenant_id"] = cap.tenant_id
            seen["location_id"] = getattr(cap, "location_id", None)
            cap.model_called = True
            cap.model_calls = 1
            cap.model = "gpt-5.6-sol"
            return "not evidence"

        env = {"HERMES_MODEL": "gpt-5.6-sol", "LUNA_CLIENT_SLUG": "sunset"}
        module = "wolfhouse.luna_group_lesson_live_eval"
        with patch.dict(os.environ, env, clear=False), \
                patch(f"{module}.assert_staging_environment"), \
                patch(f"{module}.assert_sunset_serving_identity",
                      return_value={"runtime": "hermes-sunset-luna-http"}):
            with self.assertRaisesRegex(Exception, "required_tool_sequence_incomplete"):
                import asyncio
                asyncio.run(run_isolated_group_lesson_eval(
                    case_id="sunset-group-lesson-09-es",
                    invoke_turn=invoke,
                    require_live_seams=False,
                ))
        self.assertEqual(seen["tenant_id"], "sunset")
        self.assertEqual(seen["location_id"], "sunset-somo")


if __name__ == "__main__":
    unittest.main()
