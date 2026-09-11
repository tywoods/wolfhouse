"""LR2.1 case-09 closed read-only route contract."""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
REPO = STAGING.parent.parent
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))

from wolfhouse.luna_personality_isolation import (  # noqa: E402
    IsolatedTurnCapture,
    IsolationAbort,
    deny_post_bot_if_isolated,
    deny_tool_if_isolated,
    enter_isolated_turn,
    exit_isolated_turn,
)
from wolfhouse.luna_group_lesson_live_eval import (  # noqa: E402
    ALLOWED_CASE_IDS,
    BoundedMetadataCapture,
    CAPTURE_LIMIT,
    DIAGNOSTIC_CONTROL_NAME,
    GROUP_LESSON_DIAGNOSTIC_PATH,
    GROUP_LESSON_EVAL_PATH,
    READ_ONLY_STAFF_PATHS,
    READ_ONLY_TOOL_ALLOWLIST,
    REQUIRED_CASE_09_STAFF_PATHS,
    REQUIRED_CASE_09_TOOL_SEQUENCE,
    _abort_counters,
    _message,
    load_group_lesson_corpus,
    register_group_lesson_eval_route,
    run_isolated_group_lesson_eval,
)
from wolfhouse.luna_responses_provider import (  # noqa: E402
    COMPATIBILITY_BLOCKER_ID,
    COMPATIBILITY_BLOCKER_MISSING_EVIDENCE,
    PROVIDER_EMPTY_WITH_WIRE_OK,
    classify_empty_tool_boundary,
    design_direct_compare_probe,
    merge_terminal_function_calls_into_assembled,
    normalize_function_call_to_executable,
    normalize_output_to_executable_calls,
    normalize_responses_tool_choice,
    normalize_responses_tools,
    redact_endpoint_identity,
    replay_boundary_fixture,
    responses_tool_choice_wire,
    responses_tool_schema_wire,
)
from wolfhouse.simulate_core import register_simulate_route  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


class _Router:
    def __init__(self):
        self.gets = {}
        self.posts = {}

    def add_get(self, path, handler):
        self.gets[path] = handler

    def add_post(self, path, handler):
        self.posts[path] = handler


class _App:
    def __init__(self):
        self.router = _Router()


class GroupLessonCase09Tests(unittest.TestCase):
    def test_corpus_is_separate_closed_case_09_and_contains_no_caller_controls(self):
        corpus = load_group_lesson_corpus(REPO / "fixtures" / "luna-group-lesson-live-corpus.json")
        self.assertEqual(ALLOWED_CASE_IDS, frozenset({"sunset-group-lesson-09-es"}))
        self.assertEqual([case["id"] for case in corpus["cases"]], ["sunset-group-lesson-09-es"])
        case = corpus["cases"][0]
        self.assertEqual(case["tenant_id"], "sunset")
        self.assertEqual(case["location_id"], "sunset-somo")
        self.assertEqual(case["model"], "gpt-5.6-sol")
        self.assertEqual(case["source_fixture"], "sunset-golden-09-rapid-group-lesson-quote-whatsapp")
        self.assertNotIn("allow_writes", case)

    def test_corpus_rejects_same_id_content_tampering(self):
        canonical = json.loads((REPO / "fixtures" / "luna-group-lesson-live-corpus.json").read_text())
        canonical["cases"][0]["guest_text"] = "caller controlled"
        with tempfile.TemporaryDirectory() as tmp:
            changed = Path(tmp) / "corpus.json"
            changed.write_text(json.dumps(canonical), encoding="utf-8")
            with self.assertRaisesRegex(Exception, "corpus_not_closed"):
                load_group_lesson_corpus(changed)

    def test_exact_tool_and_staff_read_allowlists_do_not_broaden_personality_isolation(self):
        self.assertEqual(READ_ONLY_TOOL_ALLOWLIST, frozenset({
            "get_sunset_lesson_catalog",
            "get_sunset_lesson_availability",
            "get_sunset_offering_quote",
        }))
        self.assertEqual(READ_ONLY_STAFF_PATHS, frozenset({
            "/sunset/catalog",
            "/sunset/joinable-courses",
            "/sunset/lesson-availability",
            "/sunset/offering-quote",
        }))

        personality = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(personality)
        try:
            self.assertIsNotNone(deny_tool_if_isolated("get_sunset_lesson_catalog"))
        finally:
            exit_isolated_turn(tok)

        group = IsolatedTurnCapture(case_id="sunset-group-lesson-09-es", personality_id="sunny")
        group.read_only_tool_allowlist = READ_ONLY_TOOL_ALLOWLIST
        group.read_only_staff_paths = READ_ONLY_STAFF_PATHS
        tok = enter_isolated_turn(group)
        try:
            for name in READ_ONLY_TOOL_ALLOWLIST:
                self.assertIsNone(deny_tool_if_isolated(name, {"location_id": "sunset-somo"}))
                self.assertIsNotNone(deny_tool_if_isolated(name, {}))
            for path in READ_ONLY_STAFF_PATHS:
                self.assertIsNone(deny_post_bot_if_isolated(path, {"location_id": "sunset-somo"}))
                self.assertIsNotNone(deny_post_bot_if_isolated(path, {}))
            for name in ("create_sunset_booking", "create_sunset_payment_link", "terminal", "browser", "send_email"):
                self.assertIsNotNone(deny_tool_if_isolated(name))
            for path in ("/bookings", "/payments", "/waivers", "/staff/save"):
                self.assertIsNotNone(deny_post_bot_if_isolated(path, {}))
        finally:
            exit_isolated_turn(tok)
        self.assertEqual(group.tools_invoked, 0)
        self.assertEqual(group.sends_attempted, 0)
        self.assertEqual(group.sends_completed, 0)
        self.assertEqual(group.journal_writes_completed, 0)
        self.assertEqual(group.persistence_effects_completed, [])

    def test_real_route_composition_registers_authenticated_separate_route(self):
        app = _App()
        env = {
            "HERMES_ROLE": "sunset-luna",
            "SUNSET_LUNA_REQUIRE_ISOLATED_AUTH": "true",
            "WHATSAPP_CLOUD_WEBHOOK_PORT": "8094",
            "LUNA_CLIENT_SLUG": "sunset",
            "LUNA_BOT_INTERNAL_TOKEN": "secret",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            register_simulate_route(app)
        self.assertIn(GROUP_LESSON_EVAL_PATH, app.router.gets)
        self.assertIn(GROUP_LESSON_EVAL_PATH, app.router.posts)

        class Request:
            headers = {}
            async def json(self):
                return {"case_id": "sunset-group-lesson-09-es"}

        def response(body, status=200):
            return body, status

        with mock.patch.dict(sys.modules, {"aiohttp": SimpleNamespace(web=SimpleNamespace(json_response=response))}):
            body, status = _run(app.router.posts[GROUP_LESSON_EVAL_PATH](Request()))
        self.assertEqual(status, 401)
        self.assertEqual(body, {"ok": False, "error": "unauthorized"})

    def test_diagnostic_route_is_separate_and_normal_route_still_rejects_overrides(self):
        app = _App()
        env = {
            "HERMES_ROLE": "sunset-luna", "SUNSET_LUNA_REQUIRE_ISOLATED_AUTH": "true",
            "WHATSAPP_CLOUD_WEBHOOK_PORT": "8094", "LUNA_CLIENT_SLUG": "sunset",
            "LUNA_BOT_INTERNAL_TOKEN": "secret",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            self.assertTrue(register_group_lesson_eval_route(app))
        self.assertIn(GROUP_LESSON_DIAGNOSTIC_PATH, app.router.posts)

        def response(body, status=200):
            return body, status

        request = SimpleNamespace(
            headers={"X-Luna-Bot-Token": "secret"},
            json=lambda: asyncio.sleep(0, result={
                "case_id": "sunset-group-lesson-09-es",
                "diagnostic_control": DIAGNOSTIC_CONTROL_NAME,
            }),
        )
        module = "wolfhouse.luna_group_lesson_live_eval"
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.dict(sys.modules, {"aiohttp": SimpleNamespace(web=SimpleNamespace(json_response=response))}), \
                mock.patch(f"{module}.run_isolated_group_lesson_eval", new=mock.AsyncMock(return_value={"ok": False})) as run:
            unauthorized_request = SimpleNamespace(
                headers={"X-Luna-Bot-Token": "wrong"}, json=request.json,
            )
            unauthorized_body, unauthorized_status = _run(
                app.router.posts[GROUP_LESSON_DIAGNOSTIC_PATH](unauthorized_request)
            )
            normal_body, normal_status = _run(app.router.posts[GROUP_LESSON_EVAL_PATH](request))
            diag_body, diag_status = _run(app.router.posts[GROUP_LESSON_DIAGNOSTIC_PATH](request))
        self.assertEqual((unauthorized_status, unauthorized_body["error"]), (401, "unauthorized"))
        self.assertEqual((normal_status, normal_body["error"]), (400, "caller_override_rejected"))
        self.assertEqual(diag_status, 200)
        self.assertEqual(diag_body, {"ok": False})
        run.assert_awaited_once_with(
            case_id="sunset-group-lesson-09-es", diagnostic_control=DIAGNOSTIC_CONTROL_NAME,
        )

    def test_route_rejects_arbitrary_text_and_all_caller_owned_runtime_overrides(self):
        app = _App()
        env = {
            "HERMES_ROLE": "sunset-luna",
            "SUNSET_LUNA_REQUIRE_ISOLATED_AUTH": "true",
            "WHATSAPP_CLOUD_WEBHOOK_PORT": "8094",
            "LUNA_CLIENT_SLUG": "sunset",
            "LUNA_BOT_INTERNAL_TOKEN": "secret",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            self.assertTrue(register_group_lesson_eval_route(app))

        def response(body, status=200):
            return body, status

        banned = ("text", "guest_text", "prompt", "model", "tenant_id", "location_id", "personality_id", "soul", "auth", "allow_writes")
        with mock.patch.dict(os.environ, env, clear=False):
            for key in banned:
                request = SimpleNamespace(
                    headers={"X-Luna-Bot-Token": "secret"},
                    json=lambda key=key: asyncio.sleep(0, result={"case_id": "sunset-group-lesson-09-es", key: "x"}),
                )
                with mock.patch.dict(sys.modules, {"aiohttp": SimpleNamespace(web=SimpleNamespace(json_response=response))}):
                    body, status = _run(app.router.posts[GROUP_LESSON_EVAL_PATH](request))
                self.assertEqual((body["error"], status), ("caller_override_rejected", 400), key)

            request = SimpleNamespace(
                headers={"X-Luna-Bot-Token": "secret"},
                json=lambda: asyncio.sleep(0, result={"case_id": "sunset-group-lesson-09-es", "unknown": "x"}),
            )
            with mock.patch.dict(sys.modules, {"aiohttp": SimpleNamespace(web=SimpleNamespace(json_response=response))}):
                body, status = _run(app.router.posts[GROUP_LESSON_EVAL_PATH](request))
            self.assertEqual((body["error"], status), ("caller_override_rejected", 400))

    def test_closed_prompt_requires_successful_reads_in_exact_order_before_completion(self):
        case = load_group_lesson_corpus(REPO / "fixtures" / "luna-group-lesson-live-corpus.json")["cases"][0]
        message = _message(case)
        required = (
            "You must successfully complete these read-only tools in this exact order before "
            "completing the response: get_sunset_lesson_catalog -> "
            "get_sunset_lesson_availability -> get_sunset_offering_quote."
        )
        self.assertIn(required, message)
        self.assertIn(case["response_contract"], message)
        self.assertIn("Guest: " + case["guest_text"], message)

    def test_case_09_rejects_authorized_but_uncompleted_reads(self):
        async def invoke(_message, cap, _context):
            args = {"tenant_id": "sunset", "location_id": "sunset-somo"}
            for name in REQUIRED_CASE_09_TOOL_SEQUENCE:
                self.assertIsNone(deny_tool_if_isolated(name, args))
            for path in REQUIRED_CASE_09_STAFF_PATHS:
                self.assertIsNone(deny_post_bot_if_isolated(path, args))
            cap.model_called = True
            cap.model_calls = 1
            cap.model = "gpt-5.6-sol"
            return "not evidence"

        env = {"HERMES_MODEL": "gpt-5.6-sol", "LUNA_CLIENT_SLUG": "sunset"}
        module = "wolfhouse.luna_group_lesson_live_eval"
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch(f"{module}.assert_staging_environment"), \
                mock.patch(f"{module}.assert_sunset_serving_identity", return_value={"runtime": "hermes-sunset-luna-http"}):
            with self.assertRaisesRegex(Exception, "required_tool_sequence_incomplete") as caught:
                _run(run_isolated_group_lesson_eval(
                    case_id="sunset-group-lesson-09-es", invoke_turn=invoke, require_live_seams=False,
                ))
        counters = caught.exception.counters
        self.assertIsInstance(counters, dict)
        self.assertEqual(counters["read_tools_invoked"], list(REQUIRED_CASE_09_TOOL_SEQUENCE))
        self.assertEqual(counters["read_tools_completed"], [])
        self.assertEqual(set(counters["read_staff_paths_invoked"]), REQUIRED_CASE_09_STAFF_PATHS)
        self.assertEqual(counters["read_staff_paths_completed"], [])
        self.assertEqual(counters["sends_attempted"], 0)
        self.assertEqual(counters["sends_completed"], 0)
        self.assertEqual(counters["journal_writes_completed"], 0)
        self.assertEqual(counters["persistence_effects_completed"], [])
        self.assertIn(counters["counter_snapshot_state"], ("settled_tracked_work", "partial"))

    def test_out_of_order_completed_sequence_aborts_with_observed_sequence(self):
        async def invoke(_message, cap, _context):
            cap.read_tools_completed.extend((
                "get_sunset_lesson_availability",
                "get_sunset_lesson_catalog",
                "get_sunset_offering_quote",
            ))
            cap.read_staff_paths_completed.extend(REQUIRED_CASE_09_STAFF_PATHS)
            cap.model_called = True
            cap.model_calls = 1
            cap.model = "gpt-5.6-sol"
            return "not evidence"

        env = {"HERMES_MODEL": "gpt-5.6-sol", "LUNA_CLIENT_SLUG": "sunset"}
        module = "wolfhouse.luna_group_lesson_live_eval"
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch(f"{module}.assert_staging_environment"), \
                mock.patch(f"{module}.assert_sunset_serving_identity", return_value={"runtime": "hermes-sunset-luna-http"}), \
                self.assertRaisesRegex(Exception, "required_tool_sequence_incomplete") as caught:
            _run(run_isolated_group_lesson_eval(
                case_id="sunset-group-lesson-09-es", invoke_turn=invoke, require_live_seams=False,
            ))
        self.assertEqual(caught.exception.counters["read_tools_completed"], [
            "get_sunset_lesson_availability",
            "get_sunset_lesson_catalog",
            "get_sunset_offering_quote",
        ])

    def test_tool_failure_aborts_honestly_without_fake_completion_or_effects(self):
        async def invoke(_message, cap, _context):
            cap.read_tools_invoked.extend((
                "get_sunset_lesson_catalog", "get_sunset_lesson_availability",
            ))
            cap.read_tools_completed.append("get_sunset_lesson_catalog")
            cap.read_staff_paths_invoked.extend((
                "/sunset/catalog", "/sunset/joinable-courses", "/sunset/lesson-availability",
            ))
            cap.read_staff_paths_completed.extend(("/sunset/catalog", "/sunset/joinable-courses"))
            cap.model_called = True
            cap.model_calls = 1
            cap.model = "gpt-5.6-sol"
            raise IsolationAbort("authoritative_read_failed")

        env = {"HERMES_MODEL": "gpt-5.6-sol", "LUNA_CLIENT_SLUG": "sunset"}
        module = "wolfhouse.luna_group_lesson_live_eval"
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch(f"{module}.assert_staging_environment"), \
                mock.patch(f"{module}.assert_sunset_serving_identity", return_value={"runtime": "hermes-sunset-luna-http"}), \
                self.assertRaisesRegex(IsolationAbort, "authoritative_read_failed") as caught:
            _run(run_isolated_group_lesson_eval(
                case_id="sunset-group-lesson-09-es", invoke_turn=invoke, require_live_seams=False,
            ))
        counters = caught.exception.counters
        self.assertEqual(counters["read_tools_invoked"], [
            "get_sunset_lesson_catalog", "get_sunset_lesson_availability",
        ])
        self.assertEqual(counters["read_tools_completed"], ["get_sunset_lesson_catalog"])
        self.assertEqual(counters["sends_completed"], 0)
        self.assertEqual(counters["journal_writes_completed"], 0)
        self.assertEqual(counters["persistence_effects_completed"], [])

    def test_unsettled_abort_nulls_nonfinal_scalars_instead_of_fake_zero(self):
        cap = IsolatedTurnCapture(case_id="sunset-group-lesson-09-es", personality_id="sunny")
        snapshot = _abort_counters(cap, settled=False)
        for key in (
            "tools_invoked_prohibited", "sends_attempted", "sends_completed",
            "journal_writes_completed", "model_calls",
        ):
            self.assertIsNone(snapshot[key], key)
        self.assertEqual(snapshot["counter_snapshot_state"], "partial")
        self.assertEqual(snapshot["read_tools_completed"], [])

    def test_unknown_counter_value_remains_unknown_instead_of_fake_zero(self):
        cap = IsolatedTurnCapture(case_id="sunset-group-lesson-09-es", personality_id="sunny")
        setattr(cap, "sends_completed", None)
        snapshot = _abort_counters(cap, settled=False)
        self.assertIsNone(snapshot["sends_completed"])
        self.assertEqual(snapshot["counter_snapshot_state"], "partial")

    def test_completion_accounting_rejects_explicit_and_ambiguous_failures(self):
        import wolfhouse.luna_personality_isolation as isolation

        failures = (
            {"success": False}, {"ok": False}, {"status": "BLOCKED"},
            {"denied": True}, None, "not-json", [],
        )
        for result in failures:
            self.assertFalse(isolation._isolated_result_succeeded(result), repr(result))
        self.assertTrue(isolation._isolated_result_succeeded({"success": True}))
        self.assertTrue(isolation._isolated_result_succeeded('{"ok": true}'))

    def test_capture_no_invocation_is_not_reached_not_fake_zero(self):
        capture = BoundedMetadataCapture("gpt-5.6-sol", {"wolfhouse": "abc", "hermes": None})
        result = capture.finalize(model_reached=False)
        self.assertEqual(result["request"]["state"], "not-reached")
        self.assertIsNone(result["request"]["attempted"])
        self.assertEqual(result["response"]["state"], "not-reached")
        self.assertEqual(result["executor"]["state"], "not-reached")
        self.assertIsNone(result["executor"]["dispositions"])

    def test_capture_provider_error_preserves_attempt_and_no_payload(self):
        secret = "SECRET guest@example.test"
        capture = BoundedMetadataCapture("gpt-5.6-sol", {"wolfhouse": None, "hermes": None})
        capture.observe_request(attempted=True, sent=True, prompts=[secret], tools=[], tool_choice="auto")
        capture.observe_response(status="provider_error", finish_reason=None, tool_calls=None)
        result = capture.finalize(model_reached=True)
        self.assertTrue(result["request"]["sent"])
        self.assertEqual(result["response"]["status"], "provider_error")
        self.assertIsNone(result["response"]["tool_calls"])
        self.assertEqual(result["executor"]["state"], "capture-unavailable")
        self.assertNotIn(secret, json.dumps(result))

    def test_capture_response_without_calls_is_observed_none(self):
        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        capture.observe_response(status="ok", finish_reason="stop", tool_calls=[])
        capture.observed_no_executor_calls()
        result = capture.finalize(model_reached=True)
        self.assertEqual(result["response"]["state"], "observed-none")
        self.assertEqual(result["response"]["tool_calls"], [])
        self.assertEqual(result["executor"], {"state": "observed-none", "dispositions": []})

    def test_capture_rejected_call_records_validation_and_reason_without_args(self):
        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        capture.observe_response(status="ok", finish_reason="tool_calls", tool_calls=[{
            "id": "call-1", "function": {"name": "get_sunset_lesson_catalog"},
            "arg_validation": "invalid:location_id",
            "arguments": {"credential": "MUST_NOT_LEAK"},
        }])
        capture.record_disposition(call_id="call-1", name="get_sunset_lesson_catalog",
                                   disposition="rejected", reason="arg_validation_failed")
        result = capture.finalize(model_reached=True)
        self.assertEqual(result["response"]["tool_calls"][0]["arg_validation"], "invalid:location_id")
        self.assertEqual(result["executor"]["dispositions"][0]["disposition"], "rejected")
        self.assertNotIn("MUST_NOT_LEAK", json.dumps(result))

    def test_capture_successful_dispatch_is_bounded_metadata_only(self):
        capture = BoundedMetadataCapture("gpt-5.6-sol", {"wolfhouse": "rev-w", "hermes": "rev-h"})
        tools = [{"function": {"name": f"tool-{i}", "parameters": {
            "type": "object", "description": "raw schema secret"}}} for i in range(CAPTURE_LIMIT + 3)]
        capture.observe_request(attempted=True, sent=True, prompts=["private prompt"],
                                tools=tools, tool_choice="required")
        capture.observe_response(status="ok", finish_reason="tool_calls", tool_calls=[{
            "id": "call-2", "function": {"name": "get_sunset_lesson_catalog"},
            "arg_validation": "valid", "arguments": {"guest": "private"},
        }])
        for disposition in ("accepted", "dispatched", "completed"):
            capture.record_disposition(call_id="call-2", name="get_sunset_lesson_catalog",
                                       disposition=disposition, reason=None)
        result = capture.finalize(model_reached=True)
        self.assertEqual(len(result["request"]["tool_names"]), CAPTURE_LIMIT)
        self.assertTrue(all(item.startswith("sha256:") for item in
                            result["request"]["tool_schema_fingerprints"]))
        self.assertEqual([item["disposition"] for item in result["executor"]["dispositions"]],
                         ["accepted", "dispatched", "completed"])
        serialized = json.dumps(result)
        for forbidden in ("private prompt", "raw schema secret", '"arguments"', '"result"'):
            self.assertNotIn(forbidden, serialized)

    def test_capture_preserves_each_model_call_with_discrimination_metadata(self):
        marker = "MANDATORY_READ_SEQUENCE"
        capture = BoundedMetadataCapture(
            "gpt-5.6-sol", {}, instruction_marker=marker,
        )
        valid_tool = {"type": "function", "function": {
            "name": "get_sunset_lesson_catalog",
            "parameters": {"type": "object", "properties": {}},
        }}
        capture.observe_request(
            attempted=True, sent=True,
            prompts=[{"role": "system", "content": marker + " private-first"}],
            tools=[valid_tool], tool_choice="auto",
        )
        capture.observe_provider_result({
            "choices": [{"finish_reason": "stop", "message": {"content": "private answer"}}],
        })
        capture.observe_request(
            attempted=True, sent=True,
            prompts=[{"role": "user", "content": "private-second"}],
            tools=[{"type": "function", "function": {"name": "broken", "parameters": []}}],
            tool_choice="auto",
        )
        capture.observe_provider_result({
            "status": "completed",
            "output": [{"type": "message", "content": [
                {"type": "refusal", "refusal": "private refusal"},
            ]}],
        })

        result = capture.finalize(model_reached=True)
        self.assertEqual(result["schema_version"], 3)
        self.assertEqual([call["call_index"] for call in result["calls"]], [1, 2])
        self.assertEqual(len({call["correlation_id"] for call in result["calls"]}), 2)
        self.assertTrue(result["calls"][0]["request"]["instruction_marker_present"])
        self.assertFalse(result["calls"][1]["request"]["instruction_marker_present"])
        self.assertTrue(result["calls"][0]["request"]["schemas_valid"])
        self.assertFalse(result["calls"][1]["request"]["schemas_valid"])
        self.assertEqual(result["calls"][0]["response"]["provider_shape"], "chat_completions")
        self.assertEqual(result["calls"][0]["response"]["completion_category"], "text_only")
        self.assertEqual(result["calls"][1]["response"]["provider_shape"], "openai_responses")
        self.assertEqual(result["calls"][1]["response"]["completion_category"], "refusal")
        serialized = json.dumps(result)
        for forbidden in ("private-first", "private-second", "private answer", "private refusal"):
            self.assertNotIn(forbidden, serialized)

    def test_capture_classifies_question_only_as_clarification_without_retaining_text(self):
        secret = "PRIVATE clarification?"
        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        capture.observe_request(attempted=True, sent=True, prompts=[], tools=[], tool_choice="auto")
        capture.observe_provider_result({
            "choices": [{"finish_reason": "stop", "message": {"content": secret}}],
        })
        result = capture.finalize(model_reached=True)
        self.assertEqual(result["calls"][0]["response"]["completion_category"], "clarification")
        self.assertNotIn(secret, json.dumps(result))

    def test_capture_links_executor_dispositions_to_current_provider_call(self):
        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        capture.observe_request(attempted=True, sent=True, prompts=[], tools=[], tool_choice="auto")
        capture.observe_response(
            status="ok", finish_reason="tool_calls",
            provider_shape="chat_completions", completion_category="tool_calls",
            tool_calls=[{"id": "provider-call-7", "function": {"name": "read_ok"},
                         "arg_validation": "valid"}],
        )
        capture.record_disposition(
            call_id=None, name="read_ok", disposition="dispatched",
        )
        result = capture.finalize(model_reached=True)
        call = result["calls"][0]
        disposition = call["executor"]["dispositions"][0]
        self.assertEqual(disposition["call_index"], call["call_index"])
        self.assertEqual(disposition["correlation_id"], call["correlation_id"])
        self.assertEqual(disposition["provider_call_id"], "provider-call-7")

    def test_actual_provider_boundary_populates_bounded_request_and_response(self):
        import wolfhouse.luna_personality_isolation as isolation

        secret = "guest-secret@example.test"
        raw_args = '{"location_id":"private-location"}'
        capture = BoundedMetadataCapture("gpt-5.6-sol", {"wolfhouse": "w", "hermes": "h"})
        cap = IsolatedTurnCapture("sunset-group-lesson-09-es", "sunny", tenant_id="sunset")
        cap.metadata_capture = capture
        token = isolation.enter_isolated_turn(cap)
        try:
            create = isolation._observe_create_call(lambda **_kwargs: {
                "choices": [{"finish_reason": "tool_calls", "message": {"tool_calls": [{
                    "id": "call-provider-1", "function": {
                        "name": "get_sunset_lesson_catalog", "arguments": raw_args,
                    },
                }]}}],
            })
            create(model="gpt-5.6-sol", messages=[{"role": "user", "content": secret}],
                   tools=[{"type": "function", "function": {"name": "get_sunset_lesson_catalog",
                           "parameters": {"type": "object", "description": "schema-secret"}}}],
                   tool_choice="required")
        finally:
            isolation.exit_isolated_turn(token)
        result = capture.finalize(model_reached=True)
        self.assertEqual(result["request"]["state"], "observed")
        self.assertEqual((result["request"]["attempted"], result["request"]["sent"]), (True, True))
        self.assertEqual(result["request"]["tool_names"], ["get_sunset_lesson_catalog"])
        self.assertEqual(result["response"]["finish_reason"], "tool_calls")
        self.assertEqual(result["response"]["tool_calls"], [{
            "id": "call-provider-1", "name": "get_sunset_lesson_catalog", "arg_validation": "valid",
        }])
        serialized = json.dumps(result)
        for forbidden in (secret, "private-location", "schema-secret", raw_args):
            self.assertNotIn(forbidden, serialized)

    def test_named_catalog_control_consumption_is_atomic(self):
        cap = IsolatedTurnCapture(case_id="case-09", personality_id="sunny")
        cap.diagnostic_tool_choice = "get_sunset_lesson_catalog"
        cap.diagnostic_tool_choice_remaining = 1

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(lambda _: cap.consume_diagnostic_tool_choice(), range(32)))

        self.assertEqual(outcomes.count("get_sunset_lesson_catalog"), 1)
        self.assertEqual(outcomes.count(None), 31)
        self.assertEqual(cap.diagnostic_tool_choice_remaining, 0)

    def test_named_catalog_control_is_request_local_and_consumed_once(self):
        import wolfhouse.luna_personality_isolation as isolation

        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        cap = IsolatedTurnCapture("sunset-group-lesson-09-es", "sunny", tenant_id="sunset")
        cap.diagnostic_tool_choice = "get_sunset_lesson_catalog"
        cap.diagnostic_tool_choice_remaining = 1
        cap.metadata_capture = capture
        agent = SimpleNamespace(model="gpt-5.6-sol", api_mode="codex_responses")
        binding = cap._request_identity = (cap, agent, agent.model, agent.api_mode)
        actual_choices = []

        class Stream:
            def __iter__(self):
                yield {"type": "response.completed", "response": {"status": "completed", "output": []}}
            def close(self):
                return None

        def provider(**kwargs):
            actual_choices.append(kwargs.get("tool_choice"))
            return Stream()

        base = {"model": agent.model, "stream": True, "input": "private",
                "tools": [{"type": "function", "name": "get_sunset_lesson_catalog",
                           "parameters": {"type": "object"}}], "tool_choice": "auto"}
        token = isolation.enter_isolated_turn(cap)
        try:
            create = isolation._observe_create_call(provider, binding, responses=True)
            first = create(**base)
            list(first)
            first.close()
            second = create(**base)
            list(second)
            second.close()
        finally:
            isolation.exit_isolated_turn(token)
        self.assertEqual(actual_choices, [
            {"type": "function", "name": "get_sunset_lesson_catalog"}, "auto",
        ])
        result = capture.finalize(model_reached=True)
        self.assertEqual([call["request"]["tool_choice"] for call in result["calls"]], [
            "function:get_sunset_lesson_catalog", "auto",
        ])
        self.assertEqual([call["request"]["tool_choice_wire"] for call in result["calls"]], [
            "responses_function", "option",
        ])
        self.assertEqual(cap.diagnostic_tool_choice_remaining, 0)

    def test_real_responses_stream_wrapper_captures_terminal_metadata(self):
        import wolfhouse.luna_personality_isolation as isolation

        secret = "STREAM_SECRET guest@example.test"
        raw_args = '{"location_id":"STREAM_PRIVATE"}'
        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        cap = IsolatedTurnCapture("sunset-group-lesson-09-es", "sunny", tenant_id="sunset")
        agent = SimpleNamespace(model="gpt-5.6-sol", api_mode="codex_responses")
        binding = cap._request_identity = (cap, agent, agent.model, agent.api_mode)
        cap.metadata_capture = capture

        class Stream:
            def __iter__(self):
                yield {"type": "response.completed", "response": {
                    "status": "completed", "output": [{"type": "function_call",
                    "call_id": "call-stream-1", "name": "get_sunset_lesson_catalog",
                    "arguments": raw_args, "raw": secret}]}}
            def close(self):
                return None

        token = isolation.enter_isolated_turn(cap)
        try:
            create = isolation._observe_create_call(lambda **_kwargs: Stream(), binding, responses=True)
            observed = create(model=agent.model, stream=True, input=[{"content": secret}],
                              tools=[{"type": "function", "name": "get_sunset_lesson_catalog",
                                      "parameters": {"description": secret}}])
            self.assertEqual([event["type"] for event in observed], ["response.completed"])
            observed.close()
        finally:
            isolation.exit_isolated_turn(token)
        result = capture.finalize(model_reached=True)
        self.assertEqual((result["request"]["attempted"], result["request"]["sent"]), (True, True))
        self.assertEqual(result["response"]["state"], "observed")
        self.assertEqual(result["response"]["status"], "completed")
        self.assertEqual(result["response"]["finish_reason"], "completed")
        self.assertEqual(result["response"]["provider_shape"], "openai_responses")
        self.assertEqual(result["response"]["completion_category"], "tool_calls")
        self.assertEqual(result["response"]["output_item_types"], ["function_call"])
        self.assertEqual(result["response"]["tool_calls"], [{
            "id": "call-stream-1", "name": "get_sunset_lesson_catalog", "arg_validation": "valid",
        }])
        self.assertEqual(result["response"]["native_stream_event_types"], ["response.completed"])
        self.assertEqual(result["response"]["normalized_call_count"], 1)
        self.assertEqual(result["response"]["boundary_verdict"], "native_calls_present")
        self.assertNotIn(secret, json.dumps(result))
        self.assertNotIn("STREAM_PRIVATE", json.dumps(result))

    def test_real_responses_stream_wrapper_captures_observed_none(self):
        import wolfhouse.luna_personality_isolation as isolation

        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        cap = IsolatedTurnCapture("sunset-group-lesson-09-es", "sunny", tenant_id="sunset")
        agent = SimpleNamespace(model="gpt-5.6-sol", api_mode="codex_responses")
        binding = cap._request_identity = (cap, agent, agent.model, agent.api_mode)
        cap.metadata_capture = capture

        class Stream:
            def __iter__(self):
                yield SimpleNamespace(type="response.completed",
                                      response=SimpleNamespace(status="completed", output=[]))
            def close(self):
                return None

        token = isolation.enter_isolated_turn(cap)
        try:
            observed = isolation._observe_create_call(
                lambda **_kwargs: Stream(), binding, responses=True,
            )(model=agent.model, stream=True, input="private input")
            list(observed)
            observed.close()
        finally:
            isolation.exit_isolated_turn(token)
        result = capture.finalize(model_reached=True)
        self.assertEqual(result["response"]["state"], "observed-none")
        self.assertEqual(result["response"]["tool_calls"], [])
        self.assertEqual(result["response"]["completion_category"], "empty_tool_calls")
        self.assertEqual(result["response"]["output_item_types"], [])
        self.assertEqual(result["executor"], {"state": "observed-none", "dispositions": []})
        self.assertNotIn("private input", json.dumps(result))

    def test_lr32_responses_tool_choice_label_is_not_wire_format(self):
        """Cap LR3.1 saw capture label function:NAME; that string is not wire."""
        flat = {"type": "function", "name": "get_sunset_lesson_catalog"}
        nested = {"type": "function", "function": {"name": "get_sunset_lesson_catalog"}}
        label = "function:get_sunset_lesson_catalog"
        self.assertEqual(responses_tool_choice_wire(flat), "responses_function")
        self.assertEqual(responses_tool_choice_wire(nested), "chat_function")
        self.assertEqual(responses_tool_choice_wire(label), "unsupported_label")
        self.assertEqual(normalize_responses_tool_choice(flat), flat)
        self.assertEqual(normalize_responses_tool_choice(nested), flat)
        with self.assertRaisesRegex(ValueError, "unsupported_tool_choice_label"):
            normalize_responses_tool_choice(label)

        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        capture.observe_request(attempted=True, sent=True, prompts=[], tools=[], tool_choice=flat)
        capture.observe_request(attempted=True, sent=True, prompts=[], tools=[], tool_choice=nested)
        capture.observe_request(attempted=True, sent=True, prompts=[], tools=[], tool_choice=label)
        result = capture.finalize(model_reached=True)
        self.assertEqual([call["request"]["tool_choice"] for call in result["calls"]], [
            "function:get_sunset_lesson_catalog",
            "function:get_sunset_lesson_catalog",
            "function:get_sunset_lesson_catalog",
        ])
        self.assertEqual([call["request"]["tool_choice_wire"] for call in result["calls"]], [
            "responses_function", "chat_function", "unsupported_label",
        ])

    def test_lr32_responses_create_rejects_capture_label_string_tool_choice(self):
        import wolfhouse.luna_personality_isolation as isolation

        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        cap = IsolatedTurnCapture("sunset-group-lesson-09-es", "sunny", tenant_id="sunset")
        agent = SimpleNamespace(model="gpt-5.6-sol", api_mode="codex_responses")
        binding = cap._request_identity = (cap, agent, agent.model, agent.api_mode)
        cap.metadata_capture = capture
        called = []
        token = isolation.enter_isolated_turn(cap)
        try:
            create = isolation._observe_create_call(
                lambda **kwargs: called.append(kwargs), binding, responses=True,
            )
            with self.assertRaisesRegex(IsolationAbort, "unsupported_tool_choice_label"):
                create(model=agent.model, stream=True, input="private",
                       tool_choice="function:get_sunset_lesson_catalog")
        finally:
            isolation.exit_isolated_turn(token)
        self.assertEqual(called, [])

    def test_lr32_responses_create_normalizes_chat_nested_tool_choice(self):
        import wolfhouse.luna_personality_isolation as isolation

        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        cap = IsolatedTurnCapture("sunset-group-lesson-09-es", "sunny", tenant_id="sunset")
        agent = SimpleNamespace(model="gpt-5.6-sol", api_mode="codex_responses")
        binding = cap._request_identity = (cap, agent, agent.model, agent.api_mode)
        cap.metadata_capture = capture
        seen = []

        class Stream:
            def __iter__(self):
                yield {"type": "response.completed", "response": {"status": "completed", "output": []}}
            def close(self):
                return None

        def provider(**kwargs):
            seen.append(kwargs.get("tool_choice"))
            return Stream()

        token = isolation.enter_isolated_turn(cap)
        try:
            create = isolation._observe_create_call(provider, binding, responses=True)
            observed = create(
                model=agent.model, stream=True, input="private",
                tools=[{"type": "function", "name": "get_sunset_lesson_catalog",
                        "parameters": {"type": "object"}}],
                tool_choice={"type": "function",
                             "function": {"name": "get_sunset_lesson_catalog"}},
            )
            list(observed)
            observed.close()
        finally:
            isolation.exit_isolated_turn(token)
        self.assertEqual(seen, [{"type": "function", "name": "get_sunset_lesson_catalog"}])
        result = capture.finalize(model_reached=True)
        self.assertEqual(result["request"]["tool_choice"], "function:get_sunset_lesson_catalog")
        self.assertEqual(result["request"]["tool_choice_wire"], "responses_function")

    def test_lr32_empty_completed_responses_are_diagnosable_empty_tool_calls(self):
        """Sealed Cap LR3.1 boundary: completed + tool_calls=[] must not be opaque other."""
        from enum import Enum

        class ItemType(Enum):
            FUNCTION_CALL = "function_call"
            REASONING = "reasoning"

        sealed = BoundedMetadataCapture("gpt-5.6-sol", {})
        sealed.observe_request(
            attempted=True, sent=True, prompts=[],
            tools=[{"type": "function", "name": "get_sunset_lesson_catalog",
                    "parameters": {"type": "object"}}],
            tool_choice={"type": "function", "name": "get_sunset_lesson_catalog"},
        )
        sealed.observe_provider_result({"status": "completed", "output": []})
        sealed_result = sealed.finalize(model_reached=True)
        self.assertEqual(sealed_result["request"]["tool_choice"], "function:get_sunset_lesson_catalog")
        self.assertEqual(sealed_result["request"]["tool_choice_wire"], "responses_function")
        self.assertEqual(sealed_result["response"]["provider_shape"], "openai_responses")
        # Wire OK + empty native → provider_empty_with_wire_ok (not opaque empty_tool_calls).
        self.assertEqual(sealed_result["response"]["completion_category"], PROVIDER_EMPTY_WITH_WIRE_OK)
        self.assertEqual(sealed_result["response"]["state"], "observed-none")
        self.assertEqual(sealed_result["response"]["tool_calls"], [])
        self.assertEqual(sealed_result["response"]["output_item_types"], [])
        self.assertEqual(sealed_result["response"]["boundary_verdict"], PROVIDER_EMPTY_WITH_WIRE_OK)
        self.assertEqual(
            sealed_result["response"]["boundary_record"]["compatibility_blocker"]["id"],
            COMPATIBILITY_BLOCKER_ID,
        )

        reasoning = BoundedMetadataCapture("gpt-5.6-sol", {})
        reasoning.observe_request(attempted=True, sent=True, prompts=[], tools=[], tool_choice="auto")
        reasoning.observe_provider_result({
            "status": "completed",
            "output": [{"type": "reasoning", "summary": [{"type": "summary_text", "text": "SECRET"}]}],
        })
        reasoning_result = reasoning.finalize(model_reached=True)
        self.assertEqual(reasoning_result["response"]["completion_category"], "empty_tool_calls")
        self.assertEqual(reasoning_result["response"]["output_item_types"], ["reasoning"])
        self.assertNotIn("SECRET", json.dumps(reasoning_result))

        enum_cap = BoundedMetadataCapture("gpt-5.6-sol", {})
        enum_cap.observe_request(attempted=True, sent=True, prompts=[], tools=[], tool_choice="auto")
        enum_cap.observe_provider_result(SimpleNamespace(
            status="completed",
            output=[SimpleNamespace(
                type=ItemType.FUNCTION_CALL, call_id="call-enum-1",
                name="get_sunset_lesson_catalog", arguments="{}",
            )],
        ))
        enum_result = enum_cap.finalize(model_reached=True)
        self.assertEqual(enum_result["response"]["completion_category"], "tool_calls")
        self.assertEqual(enum_result["response"]["tool_calls"], [{
            "id": "call-enum-1", "name": "get_sunset_lesson_catalog", "arg_validation": "valid",
        }])
        self.assertEqual(enum_result["response"]["output_item_types"], ["function_call"])

        nested = BoundedMetadataCapture("gpt-5.6-sol", {})
        nested.observe_request(attempted=True, sent=True, prompts=[], tools=[], tool_choice="auto")
        nested.observe_provider_result({
            "status": "completed",
            "output": [{"type": "function_call", "call_id": "call-nested-1",
                        "function": {"name": "get_sunset_lesson_catalog",
                                     "arguments": "{\"location_id\":\"PRIVATE\"}"}}],
        })
        nested_result = nested.finalize(model_reached=True)
        self.assertEqual(nested_result["response"]["completion_category"], "tool_calls")
        self.assertEqual(nested_result["response"]["tool_calls"], [{
            "id": "call-nested-1", "name": "get_sunset_lesson_catalog", "arg_validation": "valid",
        }])
        self.assertNotIn("PRIVATE", json.dumps(nested_result))

    def test_lr32_flat_and_chat_tools_normalize_to_responses_wire(self):
        """Hermes _responses_tools drops flat tools; wolfhouse must preserve them."""
        flat = [{"type": "function", "name": "get_sunset_lesson_catalog",
                 "parameters": {"type": "object", "properties": {}}}]
        nested = [{"type": "function", "function": {
            "name": "get_sunset_lesson_catalog",
            "parameters": {"type": "object", "properties": {}},
        }}]
        self.assertEqual(responses_tool_schema_wire(flat[0]), "responses_function")
        self.assertEqual(responses_tool_schema_wire(nested[0]), "chat_function")
        expected = [{
            "type": "function",
            "name": "get_sunset_lesson_catalog",
            "description": "",
            "strict": False,
            "parameters": {"type": "object", "properties": {}},
        }]
        self.assertEqual(normalize_responses_tools(flat), expected)
        self.assertEqual(normalize_responses_tools(nested), expected)

    def test_lr32_synthetic_function_call_survives_real_normalization_without_dispatch(self):
        """Offline red→green: native function_call → executable descriptor, no dispatch."""
        from enum import Enum

        class ItemType(Enum):
            FUNCTION_CALL = "function_call"

        dispatched = []
        synthetic = {
            "type": "function_call",
            "call_id": "call-lr32-1",
            "name": "get_sunset_lesson_catalog",
            "arguments": "{}",
            "status": "completed",
        }
        nested = {
            "type": "function_call",
            "call_id": "call-lr32-2",
            "function": {"name": "get_sunset_lesson_availability", "arguments": "{}"},
        }
        enum_item = SimpleNamespace(
            type=ItemType.FUNCTION_CALL, call_id="call-lr32-3",
            name="get_sunset_offering_quote", arguments="{}", status="completed",
        )
        executables = normalize_output_to_executable_calls([synthetic, nested, enum_item])
        self.assertEqual([call["name"] for call in executables], [
            "get_sunset_lesson_catalog",
            "get_sunset_lesson_availability",
            "get_sunset_offering_quote",
        ])
        self.assertEqual(executables[0]["function"]["arguments"], "{}")
        self.assertEqual(dispatched, [], "normalization must not dispatch tools")

        with self.assertRaisesRegex(ValueError, "incomplete_function_call"):
            normalize_function_call_to_executable({
                "type": "function_call", "name": "get_sunset_lesson_catalog",
                "arguments": "{}", "status": "in_progress",
            })
        with self.assertRaisesRegex(ValueError, "function_call_missing_name"):
            normalize_function_call_to_executable({
                "type": "function_call", "call_id": "x", "arguments": "{}",
            })
        self.assertEqual(
            classify_empty_tool_boundary(
                tool_choice_wire="responses_function",
                tools_wire=["responses_function"],
                native_item_types=["refusal"],
                executable_calls=[],
            ),
            "refusal",
        )
        self.assertEqual(
            classify_empty_tool_boundary(
                tool_choice_wire="responses_function",
                tools_wire=["responses_function"],
                native_item_types=[],
                executable_calls=[],
            ),
            PROVIDER_EMPTY_WITH_WIRE_OK,
        )
        self.assertEqual(
            classify_empty_tool_boundary(
                tool_choice_wire="responses_function",
                tools_wire=["responses_function"],
                native_item_types=["function_call"],
                executable_calls=[],
            ),
            "lost_normalization",
        )

    def test_lr32_terminal_only_function_call_is_recovered_into_assembled_output(self):
        """June-pin done-only assembly drops terminal output function_calls — repair merges them."""
        assembled = SimpleNamespace(
            output=[], output_text="", status="completed",
            terminal_event_type="response.completed", model="gpt-5.6-sol",
        )
        terminal = {
            "status": "completed",
            "output": [{
                "type": "function_call",
                "call_id": "call-terminal-1",
                "name": "get_sunset_lesson_catalog",
                "arguments": "{}",
                "status": "completed",
            }],
        }
        merged, evidence = merge_terminal_function_calls_into_assembled(assembled, terminal)
        self.assertEqual(evidence["recovery"], "terminal_function_calls_merged")
        self.assertEqual(evidence["recovered_function_calls"], 1)
        self.assertEqual(evidence["executable_names"], ["get_sunset_lesson_catalog"])
        self.assertEqual(evidence["terminal_output_item_types"], ["function_call"])
        self.assertEqual(evidence["assembled_output_item_types"], [])
        executables = normalize_output_to_executable_calls(merged.output)
        self.assertEqual(executables[0]["name"], "get_sunset_lesson_catalog")
        self.assertEqual(executables[0]["id"], "call-terminal-1")

        empty_merged, empty_evidence = merge_terminal_function_calls_into_assembled(
            assembled, {"status": "completed", "output": []},
        )
        self.assertIs(empty_merged, assembled)
        self.assertEqual(empty_evidence["recovery"], "terminal_empty_or_non_call")

        refusal_merged, refusal_evidence = merge_terminal_function_calls_into_assembled(
            assembled, {"status": "completed", "output": [{"type": "refusal"}]},
        )
        self.assertIs(refusal_merged, assembled)
        self.assertEqual(refusal_evidence["recovery"], "terminal_refusal")

        incomplete_merged, incomplete_evidence = merge_terminal_function_calls_into_assembled(
            assembled, {
                "status": "incomplete",
                "output": [{"type": "function_call", "name": "get_sunset_lesson_catalog",
                            "arguments": "{}", "status": "incomplete"}],
            },
        )
        self.assertIs(incomplete_merged, assembled)
        self.assertEqual(incomplete_evidence["recovery"], "terminal_incomplete")

    def test_lr32_consume_wrap_recovers_terminal_function_call_without_dispatch(self):
        """Real isolation consume wrap: done-only empty assemble + terminal call → recovered."""
        import wolfhouse.luna_personality_isolation as isolation

        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        cap = IsolatedTurnCapture("sunset-group-lesson-09-es", "sunny", tenant_id="sunset")
        agent = SimpleNamespace(model="gpt-5.6-sol", api_mode="codex_responses")
        binding = cap._request_identity = (cap, agent, agent.model, agent.api_mode)
        cap.metadata_capture = capture
        dispatched = []

        class DoneOnlyAssembler:
            """Mirrors June-pin hermes: ignores terminal response.output."""

            def __call__(self, event_iter, *, model, **_kwargs):
                output_items = []
                terminal_event_type = None
                status = "completed"
                for event in event_iter:
                    kind = event.get("type") if isinstance(event, dict) else getattr(event, "type", None)
                    if kind == "response.output_item.done":
                        item = event.get("item") if isinstance(event, dict) else getattr(event, "item", None)
                        if item is not None:
                            output_items.append(item)
                    if kind in {"response.completed", "response.failed", "response.incomplete"}:
                        terminal_event_type = kind
                        response = (event.get("response") if isinstance(event, dict)
                                    else getattr(event, "response", None))
                        if isinstance(response, dict) and isinstance(response.get("status"), str):
                            status = response["status"]
                return SimpleNamespace(
                    output=list(output_items), output_text="", status=status,
                    model=model, terminal_event_type=terminal_event_type,
                )

        runtime = SimpleNamespace(_consume_codex_event_stream=DoneOnlyAssembler())
        token = isolation.enter_isolated_turn(cap)
        try:
            isolation._wrap_codex_parser(runtime)

            class ProviderStream:
                def __iter__(self):
                    yield {"type": "response.completed", "response": {
                        "status": "completed",
                        "output": [{
                            "type": "function_call",
                            "call_id": "call-wire-1",
                            "name": "get_sunset_lesson_catalog",
                            "arguments": "{}",
                            "status": "completed",
                        }],
                    }}

                def close(self):
                    return None

            create = isolation._observe_create_call(
                lambda **_kwargs: ProviderStream(),
                binding, responses=True,
            )
            stream = create(
                model=agent.model, stream=True, input="private",
                tools=[{"type": "function", "function": {
                    "name": "get_sunset_lesson_catalog",
                    "parameters": {"type": "object", "properties": {}},
                }}],
                tool_choice={"type": "function",
                             "function": {"name": "get_sunset_lesson_catalog"}},
            )
            result = runtime._consume_codex_event_stream(stream, model=agent.model)
            stream.close()
        finally:
            isolation.exit_isolated_turn(token)

        self.assertEqual(dispatched, [])
        self.assertEqual(len(result.output), 1)
        executables = normalize_output_to_executable_calls(result.output)
        self.assertEqual(executables[0]["name"], "get_sunset_lesson_catalog")
        self.assertEqual(getattr(stream, "_recovery_evidence", {}).get("recovery"),
                         "terminal_function_calls_merged")
        finalized = capture.finalize(model_reached=True)
        self.assertEqual(finalized["request"]["tool_choice_wire"], "responses_function")
        self.assertEqual(finalized["request"]["tools_wire"], ["responses_function"])
        self.assertEqual(finalized["response"]["completion_category"], "tool_calls")
        self.assertEqual(finalized["response"]["tool_calls"][0]["name"],
                         "get_sunset_lesson_catalog")
        self.assertEqual(finalized["response"]["native_stream_event_types"], ["response.completed"])
        self.assertEqual(finalized["response"]["boundary_verdict"], "adapter_drop_recovered")
        self.assertNotIn("private", json.dumps(finalized))

    def test_lr32_wire_to_native_fixtures_discriminate_native_empty_vs_adapter_drop(self):
        """Offline redacted fixtures: boundary record + replay prove where the call is."""
        root = REPO / "fixtures" / "luna-lr32-wire-to-native"
        expected = {
            "terminal-function-call-adapter-recovery.json": "adapter_drop_recovered",
            "native-empty-wire-ok.json": PROVIDER_EMPTY_WITH_WIRE_OK,
            "observation-incomplete-no-terminal.json": "observation_incomplete",
            "lost-normalization-native-present.json": "lost_normalization",
        }
        for name, verdict in expected.items():
            with self.subTest(fixture=name):
                result = replay_boundary_fixture(root / name)
                self.assertTrue(result["matches_expected"], result)
                self.assertEqual(result["boundary_verdict"], verdict)
                record = result["boundary_record"]
                self.assertEqual(record["transport"]["api_mode"], "codex_responses")
                self.assertEqual(record["transport"]["model"], "gpt-5.6-sol")
                self.assertTrue(record["transport"]["streaming"])
                self.assertEqual(
                    record["transport"]["endpoint"],
                    "https://api.openai.com/v1/responses",
                )
                self.assertIn("tool_choice_wire", record["request_wire"])
                self.assertIn("tools_wire", record["request_wire"])
                self.assertIn("stream_event_types", record["native_response"])
                self.assertIn("normalized_call_count", record["normalization"])
                self.assertNotIn("sk-", json.dumps(record))
                self.assertNotIn("Authorization", json.dumps(record))
        empty = replay_boundary_fixture(root / "native-empty-wire-ok.json")
        self.assertEqual(
            empty["boundary_record"]["compatibility_blocker"]["id"],
            COMPATIBILITY_BLOCKER_ID,
        )
        for field in COMPATIBILITY_BLOCKER_MISSING_EVIDENCE:
            self.assertIn(
                field,
                empty["boundary_record"]["compatibility_blocker"][
                    "missing_evidence_if_observation_unproven"
                ],
            )
        recovered = replay_boundary_fixture(
            root / "terminal-function-call-adapter-recovery.json"
        )
        self.assertEqual(len(recovered["executables"]), 1)
        self.assertEqual(recovered["executables"][0]["name"], "get_sunset_lesson_catalog")

    def test_lr32_consume_wrap_records_stream_event_types_for_native_empty(self):
        """Hypothesis check: empty output_item_types with recorded stream events = native empty."""
        import wolfhouse.luna_personality_isolation as isolation

        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        cap = IsolatedTurnCapture("sunset-group-lesson-09-es", "sunny", tenant_id="sunset")
        agent = SimpleNamespace(model="gpt-5.6-sol", api_mode="codex_responses")
        binding = cap._request_identity = (cap, agent, agent.model, agent.api_mode)
        cap.metadata_capture = capture

        class EmptyTerminalStream:
            def __iter__(self):
                yield {"type": "response.completed", "response": {
                    "status": "completed", "output": [],
                }}

            def close(self):
                return None

        def assemble(event_iter, *, model, **_kwargs):
            for _event in event_iter:
                pass
            return SimpleNamespace(
                output=[], output_text="", status="completed",
                model=model, terminal_event_type="response.completed",
            )

        runtime = SimpleNamespace(_consume_codex_event_stream=assemble)
        token = isolation.enter_isolated_turn(cap)
        try:
            isolation._wrap_codex_parser(runtime)
            create = isolation._observe_create_call(
                lambda **_kwargs: EmptyTerminalStream(), binding, responses=True,
            )
            stream = create(
                model=agent.model, stream=True, input="private",
                tools=[{"type": "function", "name": "get_sunset_lesson_catalog",
                        "parameters": {"type": "object", "properties": {}}}],
                tool_choice={"type": "function", "name": "get_sunset_lesson_catalog"},
            )
            runtime._consume_codex_event_stream(stream, model=agent.model)
            stream.close()
        finally:
            isolation.exit_isolated_turn(token)

        result = capture.finalize(model_reached=True)
        self.assertEqual(result["request"]["api_mode"], "codex_responses")
        self.assertEqual(result["request"]["streaming"], True)
        self.assertEqual(result["response"]["native_stream_event_types"], ["response.completed"])
        self.assertEqual(result["response"]["output_item_types"], [])
        self.assertEqual(result["response"]["completion_category"], PROVIDER_EMPTY_WITH_WIRE_OK)
        self.assertEqual(result["response"]["boundary_verdict"], PROVIDER_EMPTY_WITH_WIRE_OK)
        self.assertEqual(result["response"]["normalized_call_count"], 0)

    def test_lr32_direct_compare_probe_is_flag_gated_and_stops_at_native(self):
        probe = design_direct_compare_probe(
            model="gpt-5.6-sol",
            api_mode="codex_responses",
            endpoint="https://user:secret@api.openai.com/v1/responses?key=leak",
            tool_choice={"type": "function", "name": "get_sunset_lesson_catalog"},
            tools=[{"type": "function", "name": "get_sunset_lesson_catalog",
                    "parameters": {"type": "object"}}],
        )
        self.assertFalse(probe["enabled"])
        self.assertEqual(probe["stop_at"], "native_response")
        self.assertIn("tool_dispatch", probe["disallowed"])
        self.assertEqual(
            probe["preflight_boundary_record"]["transport"]["endpoint"],
            "https://api.openai.com/v1/responses",
        )
        self.assertNotIn("secret", json.dumps(probe))
        self.assertNotIn("leak", json.dumps(probe))
        self.assertEqual(redact_endpoint_identity("https://api.openai.com/v1/responses"),
                         "https://api.openai.com/v1/responses")

    def test_lr32_create_normalizes_chat_nested_tools_on_wire(self):
        import wolfhouse.luna_personality_isolation as isolation

        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        cap = IsolatedTurnCapture("sunset-group-lesson-09-es", "sunny", tenant_id="sunset")
        agent = SimpleNamespace(model="gpt-5.6-sol", api_mode="codex_responses")
        binding = cap._request_identity = (cap, agent, agent.model, agent.api_mode)
        cap.metadata_capture = capture
        seen = []

        class Stream:
            def __iter__(self):
                yield {"type": "response.completed", "response": {"status": "completed", "output": []}}

            def close(self):
                return None

        def provider(**kwargs):
            seen.append(kwargs.get("tools"))
            return Stream()

        token = isolation.enter_isolated_turn(cap)
        try:
            create = isolation._observe_create_call(provider, binding, responses=True)
            observed = create(
                model=agent.model, stream=True, input="private",
                tools=[{"type": "function", "function": {
                    "name": "get_sunset_lesson_catalog",
                    "parameters": {"type": "object", "properties": {}},
                }}],
                tool_choice="auto",
            )
            list(observed)
            observed.close()
        finally:
            isolation.exit_isolated_turn(token)
        self.assertEqual(seen, [[{
            "type": "function",
            "name": "get_sunset_lesson_catalog",
            "description": "",
            "strict": False,
            "parameters": {"type": "object", "properties": {}},
        }]])
        result = capture.finalize(model_reached=True)
        self.assertEqual(result["request"]["tools_wire"], ["responses_function"])
        self.assertEqual(result["request"]["tool_choice_wire"], "option")
        self.assertEqual(
            classify_empty_tool_boundary(
                tool_choice_wire=result["request"]["tool_choice_wire"],
                tools_wire=result["request"]["tools_wire"],
                native_item_types=result["response"].get("output_item_types") or [],
                executable_calls=result["response"].get("tool_calls") or [],
            ),
            PROVIDER_EMPTY_WITH_WIRE_OK,
        )

    def test_responses_predispatch_rejection_is_attempted_but_not_sent(self):
        import wolfhouse.luna_personality_isolation as isolation

        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        cap = IsolatedTurnCapture("sunset-group-lesson-09-es", "sunny", tenant_id="sunset")
        agent = SimpleNamespace(model="gpt-5.6-sol", api_mode="codex_responses")
        binding = cap._request_identity = (cap, agent, agent.model, agent.api_mode)
        cap.metadata_capture = capture
        called = []
        token = isolation.enter_isolated_turn(cap)
        try:
            create = isolation._observe_create_call(lambda **_kwargs: called.append(True), binding,
                                                     responses=True)
            with self.assertRaisesRegex(IsolationAbort, "responses_dispatch_identity_changed"):
                create(model=agent.model, stream=False, input="PRIVATE_REJECTED")
        finally:
            isolation.exit_isolated_turn(token)
        result = capture.finalize(model_reached=False)
        self.assertEqual((result["request"]["attempted"], result["request"]["sent"]), (True, False))
        self.assertEqual(called, [])
        self.assertNotIn("PRIVATE_REJECTED", json.dumps(result))

    def test_actual_dispatcher_wrapper_populates_execution_dispositions(self):
        import wolfhouse.luna_personality_isolation as isolation

        capture = BoundedMetadataCapture("gpt-5.6-sol", {})
        cap = IsolatedTurnCapture("sunset-group-lesson-09-es", "sunny", tenant_id="sunset")
        cap.read_only_tool_allowlist = frozenset({"read_ok", "read_error"})
        cap.metadata_capture = capture
        dispatcher = SimpleNamespace(handle_function_call=lambda name, _args: (
            json.dumps({"error": "controlled"}) if name == "read_error" else json.dumps({"success": True})
        ))
        token = isolation.enter_isolated_turn(cap)
        try:
            self.assertTrue(isolation._wrap_tool_dispatcher(dispatcher))
            valid_args = {"tenant_id": "sunset", "location_id": "sunset-somo",
                          "secret": "never-captured"}
            dispatcher.handle_function_call("read_ok", valid_args)
            dispatcher.handle_function_call("read_error", valid_args)
            dispatcher.handle_function_call("write_denied", {})
        finally:
            isolation.exit_isolated_turn(token)
            isolation.reset_isolation_runtime_for_tests()
        dispositions = capture.finalize(model_reached=True)["executor"]["dispositions"]
        self.assertEqual([item["disposition"] for item in dispositions], [
            "accepted", "dispatched", "completed", "accepted", "dispatched", "failed", "rejected",
        ])
        self.assertEqual(dispositions[-2]["reason"], "dispatcher_error_result")
        self.assertEqual(dispositions[-1]["reason"], "isolation_policy")
        self.assertNotIn("never-captured", json.dumps(dispositions))

    def test_actual_hermes_dispatcher_and_controlled_staff_transport_prove_exact_completed_reads(self):
        import model_tools
        import wolfhouse.luna_personality_isolation as isolation

        original_dispatcher = model_tools.handle_function_call
        staff = SimpleNamespace()
        transport_calls = []

        def controlled_transport(path, payload=None):
            transport_calls.append((path, dict(payload or {})))
            return {"success": True, "path": path, "controlled": True}

        staff._post_bot = controlled_transport
        paths_by_tool = {
            "get_sunset_lesson_catalog": ("/sunset/catalog", "/sunset/joinable-courses"),
            "get_sunset_lesson_availability": ("/sunset/lesson-availability",),
            "get_sunset_offering_quote": ("/sunset/offering-quote",),
        }

        def registry_dispatch(name, args, **_kwargs):
            return json.dumps({
                "success": True,
                "reads": [staff._post_bot(path, args) for path in paths_by_tool[name]],
            })

        try:
            self.assertTrue(isolation._wrap_post_bot((staff,)))
            with mock.patch.object(model_tools.registry, "dispatch", side_effect=registry_dispatch):
                self.assertTrue(isolation._wrap_tool_dispatcher(model_tools))

                async def invoke(_message, cap, _context):
                    args = {"tenant_id": "sunset", "location_id": "sunset-somo"}
                    for name in REQUIRED_CASE_09_TOOL_SEQUENCE:
                        result = json.loads(model_tools.handle_function_call(
                            name, args, skip_pre_tool_call_hook=True,
                            skip_tool_request_middleware=True,
                        ))
                        self.assertTrue(result["success"])
                    self.assertIn("error", json.loads(model_tools.handle_function_call(
                        "create_sunset_booking", args, skip_pre_tool_call_hook=True,
                        skip_tool_request_middleware=True,
                    )))
                    cap.model_called = True
                    cap.model_calls = 1
                    cap.model = "gpt-5.6-sol"
                    return "Invented factual prose that must never be released"

                env = {"HERMES_MODEL": "gpt-5.6-sol", "LUNA_CLIENT_SLUG": "sunset"}
                module = "wolfhouse.luna_group_lesson_live_eval"
                with mock.patch.dict(os.environ, env, clear=False), \
                        mock.patch(f"{module}.assert_staging_environment"), \
                        mock.patch(f"{module}.assert_sunset_serving_identity", return_value={"runtime": "hermes-sunset-luna-http"}):
                    result = _run(run_isolated_group_lesson_eval(
                        case_id="sunset-group-lesson-09-es", invoke_turn=invoke, require_live_seams=False,
                    ))
        finally:
            isolation.reset_isolation_runtime_for_tests()
            staff._post_bot = controlled_transport

        self.assertIs(model_tools.handle_function_call, original_dispatcher)
        self.assertFalse(isolation._tool_dispatcher_wrapped)
        self.assertFalse(any(owner is model_tools and attr == "handle_function_call"
                             for owner, attr, _ in isolation._ORIG_OWNERS))
        self.assertEqual(result["status"], "BLOCKED")
        self.assertTrue(result["generated_reply_withheld"])
        self.assertNotIn("Invented factual prose", result["reply_text"])
        self.assertEqual(tuple(result["read_tools_completed"]), REQUIRED_CASE_09_TOOL_SEQUENCE)
        self.assertEqual(set(result["read_staff_paths_completed"]), REQUIRED_CASE_09_STAFF_PATHS)
        self.assertEqual(len(result["read_staff_paths_completed"]), 4)
        self.assertEqual([path for path, _ in transport_calls], [
            "/sunset/catalog", "/sunset/joinable-courses",
            "/sunset/lesson-availability", "/sunset/offering-quote",
        ])
        self.assertTrue(all(payload == {"tenant_id": "sunset", "location_id": "sunset-somo"}
                            for _, payload in transport_calls))
        self.assertEqual(result["tools_invoked_prohibited"], 0)
        self.assertEqual(result["sends_completed"], 0)
        self.assertEqual(result["journal_writes_completed"], 0)
        self.assertEqual(result["persistence_effects_completed"], [])


if __name__ == "__main__":
    unittest.main()
