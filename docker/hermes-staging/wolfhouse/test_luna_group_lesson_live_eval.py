"""LR2.1 case-09 closed read-only route contract."""

from __future__ import annotations

import asyncio
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
    deny_post_bot_if_isolated,
    deny_tool_if_isolated,
    enter_isolated_turn,
    exit_isolated_turn,
)
from wolfhouse.luna_group_lesson_live_eval import (  # noqa: E402
    ALLOWED_CASE_IDS,
    GROUP_LESSON_EVAL_PATH,
    READ_ONLY_STAFF_PATHS,
    READ_ONLY_TOOL_ALLOWLIST,
    REQUIRED_CASE_09_STAFF_PATHS,
    REQUIRED_CASE_09_TOOL_SEQUENCE,
    load_group_lesson_corpus,
    register_group_lesson_eval_route,
    run_isolated_group_lesson_eval,
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
            with self.assertRaisesRegex(Exception, "required_tool_sequence_incomplete"):
                _run(run_isolated_group_lesson_eval(
                    case_id="sunset-group-lesson-09-es", invoke_turn=invoke, require_live_seams=False,
                ))

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
