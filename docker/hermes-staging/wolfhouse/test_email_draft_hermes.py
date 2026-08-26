#!/usr/bin/env python3
"""Tests for in-process Hermes composition provenance (MAIL-MVP-007)."""

from __future__ import annotations

import json
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

STAGING = Path(__file__).resolve().parents[1]
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))

from wolfhouse.email_draft_contract import LIVE_ATTEMPT_SOURCE, MODEL, PROVIDER  # noqa: E402
from wolfhouse.email_draft_hermes import (  # noqa: E402
    DeadlineStream,
    ProvenanceError,
    capture_codex_transport,
    capture_terminal_model,
    captured_transport_is_codex,
    invoke_installed_hermes,
    is_codex_backend_url,
)


PLAN = json.dumps({"acts": [{"act": "thank_guest"}]})
CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
OPENAI_URL = "https://api.openai.com/v1/responses"


class FakeRequest:
    def __init__(self, url: str):
        self.url = url


class FakeHttpx:
    def __init__(self, url: str):
        self.url = url
        self.sends: list[str] = []

    def send(self, request, **kwargs):  # noqa: ARG002
        self.sends.append(str(getattr(request, "url", "")))
        return SimpleNamespace(status_code=200)


class FakeResponses:
    def __init__(self, events, owner):
        self.events = events
        self.owner = owner
        self.create_kwargs = []
        self.closed = False

    def create(self, **kwargs):
        self.create_kwargs.append(kwargs)
        self.owner._client.send(FakeRequest(self.owner.request_url))
        return self

    def __iter__(self):
        return iter(self.events)

    def close(self):
        self.closed = True


class FakeClient:
    def __init__(self, events, request_url=CODEX_URL):
        self.request_url = request_url
        self.base_url = request_url.rsplit("/", 1)[0]
        self._client = FakeHttpx(request_url)
        self.responses = FakeResponses(events, self)


def completed_event(model: str):
    return SimpleNamespace(
        type="response.completed",
        response=SimpleNamespace(model=model, id="resp_live_1", status="completed"),
    )


def codex_events(model: str):
    return [
        SimpleNamespace(type="response.output_text.delta", delta=PLAN),
        completed_event(model),
    ]


def consume_passthrough(event_stream, model=None, on_event=None):
    for event in event_stream:
        if on_event:
            on_event(event)
    return SimpleNamespace(
        output=[
            SimpleNamespace(
                type="message",
                content=[SimpleNamespace(type="output_text", text=PLAN)],
            )
        ],
        output_text=PLAN,
        model=model,
        status="completed",
    )


def composition_for(client):
    return {
        "resolve_runtime_provider": lambda: {"provider": "openai-codex", "source": "auth.json"},
        "resolve_provider_client": lambda provider, model, raw_codex=False: (client, model),
        "consume_codex_event_stream": consume_passthrough,
    }


class HermesProvenanceTests(unittest.TestCase):
    def test_codex_backend_url_gate(self):
        self.assertTrue(is_codex_backend_url("https://chatgpt.com/backend-api/codex"))
        self.assertTrue(is_codex_backend_url("https://chatgpt.com/backend-api/codex/responses"))
        self.assertFalse(is_codex_backend_url("https://api.openai.com/v1"))
        self.assertFalse(is_codex_backend_url("https://openrouter.ai/api/v1"))
        self.assertFalse(is_codex_backend_url("http://chatgpt.com/backend-api/codex"))
        self.assertFalse(is_codex_backend_url(""))

    def test_capture_reads_terminal_response_model_not_request(self):
        captured, on_event = capture_terminal_model()
        on_event(SimpleNamespace(type="response.output_text.delta", delta="x"))
        on_event(completed_event("gpt-5.6-sol"))
        self.assertEqual(captured["model"], "gpt-5.6-sol")
        self.assertEqual(captured["event_type"], "response.completed")

    def test_live_terminal_model_and_actual_codex_transport(self):
        client = FakeClient([completed_event("gpt-5.6-sol")])
        result = invoke_installed_hermes("sys", "user", composition=composition_for(client))
        self.assertEqual(result.provider, PROVIDER)
        self.assertEqual(result.model, MODEL)
        self.assertEqual(result.source, LIVE_ATTEMPT_SOURCE)
        self.assertEqual(result.content, PLAN)
        self.assertEqual(client.responses.create_kwargs[0]["stream"], True)
        self.assertEqual(client.responses.create_kwargs[0]["store"], False)
        self.assertTrue(client.responses.closed)
        self.assertEqual(client._client.sends, [CODEX_URL])

    def test_client_base_url_label_is_not_accepted_as_transport(self):
        client = FakeClient([completed_event("gpt-5.6-sol")], request_url=OPENAI_URL)
        client.base_url = "https://chatgpt.com/backend-api/codex"
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition_for(client))
        self.assertIn("not_codex_backend", str(ctx.exception))

    def test_missing_terminal_model_fails_closed(self):
        event = SimpleNamespace(
            type="response.completed",
            response=SimpleNamespace(id="resp_x", status="completed"),
        )
        client = FakeClient([event])
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition_for(client))
        self.assertIn("live_model_unavailable", str(ctx.exception))

    def test_config_selected_provider_mismatch_fails_closed(self):
        client = FakeClient([completed_event("gpt-5.6-sol")])
        composition = composition_for(client)
        composition["resolve_runtime_provider"] = lambda: {"provider": "openai"}
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition)
        self.assertIn("runtime_provider_mismatch", str(ctx.exception))

    def test_non_codex_transport_url_fails_closed(self):
        client = FakeClient(
            [completed_event("gpt-5.6-sol")],
            request_url=OPENAI_URL,
        )
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition_for(client))
        self.assertIn("not_codex_backend", str(ctx.exception))

    def test_live_model_mismatch_fails_closed(self):
        client = FakeClient([completed_event("gpt-4o-mini")])
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition_for(client))
        self.assertIn("live_model_mismatch", str(ctx.exception))

    def test_kwargs_model_echo_is_not_accepted_as_live(self):
        event = SimpleNamespace(
            type="response.completed",
            response=SimpleNamespace(id="resp_echo", status="completed"),
        )
        client = FakeClient([event])

        def consume_echo(event_stream, model=None, on_event=None):
            for item in event_stream:
                if on_event:
                    on_event(item)
            return SimpleNamespace(output=[], output_text=PLAN, model=model, status="completed")

        composition = composition_for(client)
        composition["consume_codex_event_stream"] = consume_echo
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition)
        self.assertIn("live_model_unavailable", str(ctx.exception))

    def test_wrapper_source_does_not_use_cli_guess(self):
        src = Path(__file__).with_name("email_draft_hermes.py").read_text(encoding="utf-8")
        self.assertNotIn("hermes chat", src)
        self.assertNotIn("--no-stream", src)
        self.assertIn("responses.create", src)
        self.assertIn("capture_terminal_model", src)
        self.assertIn("capture_codex_transport", src)
        self.assertIn("DeadlineStream", src)

    def test_stream_deadline_after_first_byte(self):
        class HangAfterFirst:
            def __init__(self):
                self.closed = False

            def __iter__(self):
                yield completed_event("gpt-5.6-sol")
                time.sleep(2)
                yield completed_event("gpt-5.6-sol")

            def close(self):
                self.closed = True

        hung = HangAfterFirst()
        with self.assertRaises(ProvenanceError) as ctx:
            list(DeadlineStream(hung, total_s=5, continue_s=0.05))
        self.assertIn("codex_stream_deadline", str(ctx.exception))
        self.assertTrue(hung.closed)


class InstalledHermesMutationTests(unittest.TestCase):
    def setUp(self):
        if "/opt/hermes" not in sys.path:
            sys.path.insert(0, "/opt/hermes")

    def _installed(self):
        from agent.codex_runtime import _consume_codex_event_stream

        return _consume_codex_event_stream

    def test_wrong_endpoint_provider_transport_fails_closed(self):
        consume = self._installed()
        client = FakeClient(codex_events("gpt-5.6-sol"), request_url=OPENAI_URL)
        composition = {
            "resolve_runtime_provider": lambda: {"provider": "openai-codex"},
            "resolve_provider_client": lambda provider, model, raw_codex=False: (client, model),
            "consume_codex_event_stream": consume,
        }
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition)
        self.assertIn("not_codex_backend", str(ctx.exception))

    def test_wrong_terminal_model_fails_closed(self):
        consume = self._installed()
        client = FakeClient(codex_events("gpt-4o-mini"))
        composition = {
            "resolve_runtime_provider": lambda: {"provider": "openai-codex"},
            "resolve_provider_client": lambda provider, model, raw_codex=False: (client, model),
            "consume_codex_event_stream": consume,
        }
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition)
        self.assertIn("live_model_mismatch", str(ctx.exception))

    def test_fallback_other_client_fails_closed(self):
        consume = self._installed()
        other = FakeClient(codex_events("gpt-5.6-sol"), request_url=OPENAI_URL)
        other.base_url = "https://api.openai.com/v1"

        def resolve_other(provider, model, raw_codex=False):
            return (other, model)

        composition = {
            "resolve_runtime_provider": lambda: {"provider": "openai-codex"},
            "resolve_provider_client": resolve_other,
            "consume_codex_event_stream": consume,
        }
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition)
        self.assertIn("not_codex_backend", str(ctx.exception))

    def test_concurrent_mixed_attempts_fail_closed_without_cross_bind(self):
        consume = self._installed()
        good = FakeClient(codex_events("gpt-5.6-sol"), request_url=CODEX_URL)
        bad = FakeClient(codex_events("gpt-5.6-sol"), request_url=OPENAI_URL)
        barrier = threading.Barrier(2)
        results: dict[str, object] = {}

        def run(name, client):
            barrier.wait(2)

            def delayed_consume(event_stream, model=None, on_event=None):
                time.sleep(0.05)
                return consume(event_stream, model=model, on_event=on_event)

            composition = {
                "resolve_runtime_provider": lambda: {"provider": "openai-codex"},
                "resolve_provider_client": lambda provider, model, raw_codex=False: (client, model),
                "consume_codex_event_stream": delayed_consume,
            }
            try:
                results[name] = invoke_installed_hermes("sys", "user", composition=composition)
            except Exception as exc:
                results[name] = exc

        threads = [
            threading.Thread(target=run, args=("good", good)),
            threading.Thread(target=run, args=("bad", bad)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
        if not hasattr(results.get("good"), "provider"):
            self.fail(f"good attempt failed closed unexpectedly: {results.get('good')!r}")
        self.assertEqual(results["good"].provider, PROVIDER)
        self.assertEqual(results["good"].model, MODEL)
        self.assertIsInstance(results["bad"], ProvenanceError)
        self.assertIn("not_codex_backend", str(results["bad"]))

    def test_transport_capture_restores_send_and_does_not_disable_tls(self):
        class GuardedHttpx:
            def __init__(self):
                self.verify = True

            def send(self, request, **kwargs):  # noqa: ARG002
                return SimpleNamespace(ok=True)

        http = GuardedHttpx()
        original = http.send
        client = SimpleNamespace(_client=http)
        with capture_codex_transport(client) as sink:
            http.send(FakeRequest(CODEX_URL))
            self.assertTrue(captured_transport_is_codex(sink))
            self.assertTrue(http.verify)
        self.assertEqual(http.send.__func__, original.__func__)
        self.assertTrue(http.verify)
        self.assertNotIn("send", http.__dict__)


class InstalledHermesCliSurfaceTests(unittest.TestCase):
    def test_chat_parser_has_no_no_stream_json_flags(self):
        parser_path = Path("/opt/hermes/hermes_cli/_parser.py")
        self.assertTrue(parser_path.is_file(), "installed Hermes parser missing")
        text = parser_path.read_text(encoding="utf-8")
        self.assertIn("def build_top_level_parser", text)
        self.assertIn("-z", text)
        self.assertNotIn("--no-stream", text)
        venv = Path("/opt/hermes/.venv/bin/python")
        self.assertTrue(venv.is_file(), "installed Hermes venv missing")
        import subprocess

        probe = subprocess.run(
            [
                str(venv),
                "-c",
                "from hermes_cli._parser import build_top_level_parser\n"
                "p, s, c = build_top_level_parser()\n"
                "opts = set()\n"
                "for action in c._actions:\n"
                "    opts.update(action.option_strings)\n"
                "assert '--no-stream' not in opts, opts\n"
                "assert '--json' not in opts, opts\n"
                "assert '-q' in opts, opts\n"
                "print('CHAT_FLAGS_OK')\n",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(probe.returncode, 0, probe.stderr)
        self.assertIn("CHAT_FLAGS_OK", probe.stdout)

    def test_codex_adapter_uses_responses_api(self):
        aux = Path("/opt/hermes/agent/auxiliary_client.py")
        self.assertTrue(aux.is_file())
        text = aux.read_text(encoding="utf-8")
        self.assertIn("class CodexAuxiliaryClient", text)
        self.assertIn("_CODEX_AUX_BASE_URL = \"https://chatgpt.com/backend-api/codex\"", text)
        self.assertIn("def resolve_provider_client", text)
        self.assertIn('if provider == "openai-codex":', text)
        runtime = Path("/opt/hermes/hermes_cli/runtime_provider.py")
        self.assertTrue(runtime.is_file())
        self.assertIn("def resolve_runtime_provider", runtime.read_text(encoding="utf-8"))

    def test_production_interpreter_is_hermes_venv(self):
        venv = Path("/opt/hermes/.venv/bin/python")
        self.assertTrue(venv.is_file())
        compose = (STAGING.parent / "hermes-sunset" / "docker-compose.vm.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("/opt/hermes/.venv/bin/python", compose)
        aca = (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8")
        self.assertIn("/opt/hermes/.venv/bin/python", aca)
        self.assertNotIn("\n          - python\n", aca)


if __name__ == "__main__":
    unittest.main(verbosity=2)
