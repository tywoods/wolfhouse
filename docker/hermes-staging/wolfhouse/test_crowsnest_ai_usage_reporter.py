import contextvars
import json
import queue
import socket
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from wolfhouse import crowsnest_ai_usage_reporter as reporter

ENV = {
    "HERMES_ROLE": "sunset-luna",
    "CROWSNEST_AI_USAGE_INGEST_URL": "https://crowsnest.lunafrontdesk.com/api/ai-usage",
    "CROWSNEST_AI_USAGE_INGEST_TOKEN": "test-bearer-token",
    "CROWSNEST_AI_USAGE_CLIENT_SLUG": "client_opaque_123",
    "CROWSNEST_AI_USAGE_TENANT_ID": "tenant_opaque_456",
    "CROWSNEST_AI_USAGE_SOURCE_SERVICE": "sunset-hermes",
}
RAW = SimpleNamespace(model="configured-model", status="completed", terminal_event_type="response.completed", usage=SimpleNamespace(input_tokens=11, output_tokens=7, total_tokens=18))


class ReporterTests(unittest.TestCase):
    def setUp(self):
        reporter._reset_worker_for_tests()

    def tearDown(self):
        reporter._reset_worker_for_tests()

    def test_config_requires_exact_crowsnest_https_endpoint(self):
        self.assertIsNotNone(reporter.read_config(ENV))
        bad = [
            "http://crowsnest.lunafrontdesk.com/api/ai-usage",
            "https://crowsnest.lunafrontdesk.com:443/api/ai-usage",
            "https://user@crowsnest.lunafrontdesk.com/api/ai-usage",
            "https://crowsnest.lunafrontdesk.com/api/ai-usage?x=1",
            "https://crowsnest.lunafrontdesk.com/api/ai-usage#x",
            "https://evil.example/api/ai-usage",
        ]
        for url in bad:
            self.assertIsNone(reporter.read_config({**ENV, "CROWSNEST_AI_USAGE_INGEST_URL": url}), url)

    def test_all_canonical_ids_reject_secret_shapes(self):
        keys = ["CROWSNEST_AI_USAGE_CLIENT_SLUG", "CROWSNEST_AI_USAGE_TENANT_ID", "CROWSNEST_AI_USAGE_SOURCE_SERVICE"]
        for key in keys:
            for value in ("sk-abcdefghijklmno", "sk-ant-abcdefghijklmno", "Bearer_hidden"):
                self.assertIsNone(reporter.read_config({**ENV, key: value}), (key, value))
        self.assertIsNone(reporter.build_success_event(SimpleNamespace(model="sk-abcdefghijklmno", status="completed"), 1, env=ENV))
        self.assertIsNone(reporter.build_failure_event("model", 1, "Bearer_hidden", env=ENV))

    def test_integers_are_nonnegative_js_safe_and_never_coerced(self):
        invalid = [True, False, "1", -1, 9007199254740992, 1.5]
        for value in invalid:
            self.assertIsNone(reporter.build_success_event(RAW, value, env=ENV), value)
        for field in ("input_tokens", "output_tokens", "total_tokens"):
            usage = {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3, field: True}
            event = reporter.build_success_event(SimpleNamespace(model="model", status="completed", usage=usage), 1, env=ENV)
            self.assertEqual(event["tokens"], {"availability": "unavailable"})

    def test_cost_is_always_unavailable_and_caller_cost_is_not_accepted(self):
        self.assertEqual(reporter.build_success_event(RAW, 1, env=ENV)["cost"], {"state": "unavailable"})
        with self.assertRaises(TypeError):
            reporter.build_success_event(RAW, 1, cost={"state": "estimated", "amount_micros": 1, "currency": "USD"}, env=ENV)

    def test_terminal_failed_and_incomplete_are_failures_with_closed_codes(self):
        for status, code in (("failed", "provider_response_failed"), ("incomplete", "provider_response_incomplete")):
            response = SimpleNamespace(model="actual-model", status=status, terminal_event_type=f"response.{status}", usage=None, error="SECRET")
            event = reporter.build_attempt_event(response=response, configured_model="configured-model", latency_ms=4, env=ENV)
            self.assertEqual(event["status"], "failed")
            self.assertEqual(event["error_code"], code)
            self.assertNotIn("SECRET", json.dumps(event))

    def test_completed_uses_actual_model_and_success(self):
        response = SimpleNamespace(model="actual-model", status="completed", terminal_event_type="response.completed", usage=RAW.usage)
        event = reporter.build_attempt_event(response=response, configured_model="configured-model", latency_ms=4, env=ENV)
        self.assertEqual(event["status"], "succeeded")
        self.assertEqual(event["model"], "actual-model")

    def test_completed_status_without_completed_terminal_event_fails_closed(self):
        response = SimpleNamespace(model="actual-model", status="completed", usage=RAW.usage, output_text="usable partial")
        event = reporter.build_attempt_event(response=response, configured_model="configured-model", latency_ms=4, env=ENV)
        self.assertEqual(event["status"], "failed")
        self.assertEqual(event["error_code"], "provider_response_no_terminal")

    def test_model_validation_matches_canonical_js_and_rejects_slash(self):
        self.assertIsNone(reporter.build_failure_event("openai/gpt-malicious", 1, "provider_error", env=ENV))

    def test_marker_role_and_provider_scope_attempt_observation(self):
        emitted = []
        with patch.object(reporter, "enqueue_event", side_effect=lambda event, **_: emitted.append(event)):
            reporter.observe_attempt_result(RAW, "configured-model", 1, provider="openai-codex", env=ENV)
            with reporter.guest_reply_context():
                reporter.observe_attempt_result(RAW, "configured-model", 1, provider="anthropic", env=ENV)
                reporter.observe_attempt_result(RAW, "configured-model", 1, provider="openai-codex", env={**ENV, "HERMES_ROLE": "orchestrator"})
                reporter.observe_attempt_result(RAW, "configured-model", 1, provider="openai-codex", env=ENV)
        self.assertEqual(len(emitted), 1)

    def test_two_attempt_sequences_emit_distinct_events_and_preserve_exceptions(self):
        emitted = []
        first = ConnectionError("SECRET transport")
        with patch.object(reporter, "enqueue_event", side_effect=lambda event, **_: emitted.append(event)), reporter.guest_reply_context():
            reporter.observe_attempt_failure(first, "model", 2, provider="openai-codex", env=ENV)
            reporter.observe_attempt_result(RAW, "model", 3, provider="openai-codex", env=ENV)
        self.assertEqual([e["status"] for e in emitted], ["failed", "succeeded"])
        self.assertNotEqual(emitted[0]["event_id"], emitted[1]["event_id"])
        emitted.clear()
        second = TimeoutError("SECRET timeout")
        with patch.object(reporter, "enqueue_event", side_effect=lambda event, **_: emitted.append(event)), reporter.guest_reply_context():
            for exc in (first, second):
                reporter.observe_attempt_failure(exc, "model", 2, provider="openai-codex", env=ENV)
        self.assertEqual(len(emitted), 2)
        self.assertEqual([e["status"] for e in emitted], ["failed", "failed"])
        self.assertNotEqual(emitted[0]["event_id"], emitted[1]["event_id"])

    def test_one_lazy_bounded_worker_no_start_when_invalid_and_nonblocking_drop(self):
        with patch("threading.Thread") as thread:
            reporter.enqueue_event({"x": 1}, env={})
            thread.assert_not_called()
        fake_queue = queue.Queue(maxsize=1)
        fake_queue.put_nowait({"full": True})
        with patch.object(reporter, "_queue", fake_queue), patch("threading.Thread") as thread:
            started = time.monotonic()
            self.assertIsNone(reporter.enqueue_event(reporter.build_success_event(RAW, 1, env=ENV), env=ENV))
            self.assertLess(time.monotonic() - started, 0.1)
            thread.assert_not_called()

    def test_queue_copies_only_minimal_transport_config_not_full_environment(self):
        event = reporter.build_success_event(RAW, 1, env=ENV)
        env = {**ENV, "UNRELATED_SECRET": "must-not-be-copied"}
        with patch("threading.Thread"):
            reporter.enqueue_event(event, env=env)
        queued_event, queued_config = reporter._queue.get_nowait()
        self.assertIs(queued_event, event)
        self.assertEqual(set(queued_config), set(reporter.ENV_NAMES))
        self.assertNotIn("UNRELATED_SECRET", queued_config)

    def test_post_disables_redirects_and_never_returns_body_or_error(self):
        event = reporter.build_success_event(RAW, 1, env=ENV)
        with patch("urllib.request.build_opener") as build:
            opener = build.return_value
            response = opener.open.return_value.__enter__.return_value
            response.read.side_effect = AssertionError("body must not be read")
            self.assertIsNone(reporter._post(event, ENV))
            build.assert_called_once()
            self.assertTrue(any(isinstance(h, reporter._NoRedirect) for h in build.call_args.args))
        with patch("urllib.request.build_opener", side_effect=Exception("SECRET")):
            self.assertIsNone(reporter._post(event, ENV))


if __name__ == "__main__":
    unittest.main()
