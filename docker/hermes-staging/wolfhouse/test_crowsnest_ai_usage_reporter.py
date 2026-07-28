import json
import os
import socket
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from wolfhouse import crowsnest_ai_usage_reporter as reporter

ENV = {
    "CROWSNEST_AI_USAGE_INGEST_URL": "http://127.0.0.1:1/ingest",
    "CROWSNEST_AI_USAGE_INGEST_TOKEN": "test-bearer-token",
    "CROWSNEST_AI_USAGE_CLIENT_SLUG": "client_opaque_123",
    "CROWSNEST_AI_USAGE_TENANT_ID": "tenant_opaque_456",
    "CROWSNEST_AI_USAGE_SOURCE_SERVICE": "sunset-hermes",
}

class Recorder(BaseHTTPRequestHandler):
    status = 200
    received = []
    def do_POST(self):
        body = self.rfile.read(int(self.headers["content-length"]))
        type(self).received.append((self.headers.get("authorization"), json.loads(body)))
        self.send_response(type(self).status); self.end_headers()
    def log_message(self, *args): pass

class ReporterTests(unittest.TestCase):
    def setUp(self): Recorder.received = []; Recorder.status = 200

    def test_config_reads_only_exact_five_names_and_noops_when_incomplete(self):
        aliases = {"AI_USAGE_INGEST_URL":"http://bad", "LUNA_CLIENT_SLUG":"bad", "CROWSNEST_AI_USAGE_INGEST_TOKEN":"x"}
        self.assertIsNone(reporter.read_config(aliases))
        self.assertIsNone(reporter.report_success(SimpleNamespace(model="gpt-5.5", usage=SimpleNamespace(input_tokens=1, output_tokens=2, total_tokens=3)), 7, env=aliases))

    def test_success_extracts_only_safe_openai_facts_and_posts_bearer(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
        import threading
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env = {**ENV, "CROWSNEST_AI_USAGE_INGEST_URL": f"http://127.0.0.1:{server.server_port}/ingest"}
        raw = SimpleNamespace(model="gpt-5.5", usage=SimpleNamespace(input_tokens=11, output_tokens=7, total_tokens=18), output_text="SECRET RESPONSE", id="guest-id")
        self.assertIsNone(reporter.report_success(raw, 42, cost={"state":"unavailable"}, env=env))
        server.shutdown(); server.server_close()
        auth, event = Recorder.received[0]
        self.assertEqual(auth, "Bearer test-bearer-token")
        self.assertEqual(event["model"], "gpt-5.5")
        self.assertEqual(event["tokens"], {"availability":"measured", "input_tokens":11, "output_tokens":7, "total_tokens":18})
        self.assertEqual(event["operation"], "guest_reply")
        self.assertNotIn("SECRET", json.dumps(event))
        self.assertRegex(event["event_id"], r"^evt_[0-9a-f]{32}$")

    def test_failure_has_configured_model_opaque_code_and_unavailable_usage(self):
        event = reporter.build_failure_event("gpt-5.5", 9, "provider_timeout", env=ENV)
        self.assertEqual(event["status"], "failed")
        self.assertEqual(event["error_code"], "provider_timeout")
        self.assertEqual(event["tokens"], {"availability":"unavailable"})
        self.assertEqual(event["cost"], {"state":"unavailable"})

    def test_network_timeout_and_http_errors_are_silent_and_bounded(self):
        with patch("urllib.request.urlopen", side_effect=[socket.timeout(), Exception("401 SECRET"), Exception("500 SECRET")]) as call:
            for _ in range(3):
                self.assertIsNone(reporter.report_failure("gpt-5.5", 1, "provider_error", env=ENV))
        self.assertTrue(all(c.kwargs["timeout"] <= reporter.MAX_HTTP_TIMEOUT_SECONDS for c in call.call_args_list))

    def test_daemon_path_returns_immediately_and_never_changes_provider_semantics(self):
        with patch.object(reporter, "report_success", side_effect=lambda *a, **k: time.sleep(.2)):
            start=time.monotonic(); self.assertIsNone(reporter.report_success_daemon(object(), 1, env=ENV))
            self.assertLess(time.monotonic()-start, .1)
        result = object()
        unreachable = {**ENV, "HERMES_ROLE": "sunset-luna"}
        self.assertIs(reporter.observe_provider_attempt(lambda: result, model="gpt-5.5", env=unreachable), result)
        expected = RuntimeError("provider secret error")
        with self.assertRaises(RuntimeError) as got:
            reporter.observe_provider_attempt(lambda: (_ for _ in ()).throw(expected), model="gpt-5.5", env=unreachable)
        self.assertIs(got.exception, expected)

    def test_wrong_bearer_401_does_not_change_provider_response(self):
        Recorder.status = 401
        server = ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
        import threading
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env = {**ENV, "HERMES_ROLE": "sunset-luna", "CROWSNEST_AI_USAGE_INGEST_URL": f"http://127.0.0.1:{server.server_port}/ingest", "CROWSNEST_AI_USAGE_INGEST_TOKEN": "wrong-token"}
        raw = SimpleNamespace(model="gpt-5.5", usage=SimpleNamespace(input_tokens=1, output_tokens=2, total_tokens=3))
        self.assertIs(reporter.observe_provider_attempt(lambda: raw, model="gpt-5.5", env=env), raw)
        server.shutdown(); server.server_close()

if __name__ == "__main__": unittest.main()
