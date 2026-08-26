#!/usr/bin/env python3
"""Tests for in-process Hermes composition provenance (MAIL-MVP-007)."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

STAGING = Path(__file__).resolve().parents[1]
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))

from wolfhouse.email_draft_contract import LIVE_ATTEMPT_SOURCE, MODEL, PROVIDER  # noqa: E402
from wolfhouse.email_draft_hermes import (  # noqa: E402
    ProvenanceError,
    capture_terminal_model,
    invoke_installed_hermes,
    is_codex_backend_url,
)


PLAN = json.dumps({"acts": [{"act": "thank_guest"}]})


class FakeResponses:
    def __init__(self, events, create_kwargs=None):
        self.events = events
        self.create_kwargs = create_kwargs if create_kwargs is not None else []
        self.closed = False

    def create(self, **kwargs):
        self.create_kwargs.append(kwargs)
        return self

    def __iter__(self):
        return iter(self.events)

    def close(self):
        self.closed = True


class FakeClient:
    def __init__(self, events, base_url="https://chatgpt.com/backend-api/codex"):
        self.base_url = base_url
        self.responses = FakeResponses(events)


def completed_event(model: str):
    return SimpleNamespace(
        type="response.completed",
        response=SimpleNamespace(model=model, id="resp_live_1", status="completed"),
    )


def consume_passthrough(event_stream, model=None, on_event=None):
    items = []
    for event in event_stream:
        if on_event:
            on_event(event)
        items.append(event)
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


class HermesProvenanceTests(unittest.TestCase):
    def test_codex_backend_url_gate(self):
        self.assertTrue(is_codex_backend_url("https://chatgpt.com/backend-api/codex"))
        self.assertTrue(is_codex_backend_url("https://chatgpt.com/backend-api/codex/responses"))
        self.assertFalse(is_codex_backend_url("https://api.openai.com/v1"))
        self.assertFalse(is_codex_backend_url("https://openrouter.ai/api/v1"))
        self.assertFalse(is_codex_backend_url(""))

    def test_capture_reads_terminal_response_model_not_request(self):
        captured, on_event = capture_terminal_model()
        on_event(SimpleNamespace(type="response.output_text.delta", delta="x"))
        on_event(completed_event("gpt-5.6-sol"))
        self.assertEqual(captured["model"], "gpt-5.6-sol")
        self.assertEqual(captured["event_type"], "response.completed")

    def test_live_terminal_model_and_runtime_provider(self):
        client = FakeClient([completed_event("gpt-5.6-sol")])
        composition = {
            "resolve_runtime_provider": lambda: {"provider": "openai-codex", "source": "auth.json"},
            "resolve_provider_client": lambda provider, model, raw_codex=False: (client, model),
            "consume_codex_event_stream": consume_passthrough,
        }
        result = invoke_installed_hermes("sys", "user", composition=composition)
        self.assertEqual(result.provider, PROVIDER)
        self.assertEqual(result.model, MODEL)
        self.assertEqual(result.source, LIVE_ATTEMPT_SOURCE)
        self.assertEqual(result.content, PLAN)
        self.assertEqual(client.responses.create_kwargs[0]["stream"], True)
        self.assertEqual(client.responses.create_kwargs[0]["store"], False)
        self.assertTrue(client.responses.closed)

    def test_missing_terminal_model_fails_closed(self):
        event = SimpleNamespace(
            type="response.completed",
            response=SimpleNamespace(id="resp_x", status="completed"),
        )
        client = FakeClient([event])
        composition = {
            "resolve_runtime_provider": lambda: {"provider": "openai-codex"},
            "resolve_provider_client": lambda provider, model, raw_codex=False: (client, model),
            "consume_codex_event_stream": consume_passthrough,
        }
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition)
        self.assertIn("live_model_unavailable", str(ctx.exception))

    def test_config_selected_provider_mismatch_fails_closed(self):
        client = FakeClient([completed_event("gpt-5.6-sol")])
        composition = {
            "resolve_runtime_provider": lambda: {"provider": "openai"},
            "resolve_provider_client": lambda provider, model, raw_codex=False: (client, model),
            "consume_codex_event_stream": consume_passthrough,
        }
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition)
        self.assertIn("runtime_provider_mismatch", str(ctx.exception))

    def test_non_codex_base_url_fails_closed(self):
        client = FakeClient(
            [completed_event("gpt-5.6-sol")],
            base_url="https://api.openai.com/v1",
        )
        composition = {
            "resolve_runtime_provider": lambda: {"provider": "openai-codex"},
            "resolve_provider_client": lambda provider, model, raw_codex=False: (client, model),
            "consume_codex_event_stream": consume_passthrough,
        }
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition)
        self.assertIn("not_codex_backend", str(ctx.exception))

    def test_live_model_mismatch_fails_closed(self):
        client = FakeClient([completed_event("gpt-4o-mini")])
        composition = {
            "resolve_runtime_provider": lambda: {"provider": "openai-codex"},
            "resolve_provider_client": lambda provider, model, raw_codex=False: (client, model),
            "consume_codex_event_stream": consume_passthrough,
        }
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition)
        self.assertIn("live_model_mismatch", str(ctx.exception))

    def test_kwargs_model_echo_is_not_accepted_as_live(self):
        """Hermes _consume_codex_event_stream sets final.model from kwargs.

        Provenance must come from the terminal event, not that echo.
        """
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

        composition = {
            "resolve_runtime_provider": lambda: {"provider": "openai-codex"},
            "resolve_provider_client": lambda provider, model, raw_codex=False: (client, model),
            "consume_codex_event_stream": consume_echo,
        }
        with self.assertRaises(ProvenanceError) as ctx:
            invoke_installed_hermes("sys", "user", composition=composition)
        self.assertIn("live_model_unavailable", str(ctx.exception))

    def test_wrapper_source_does_not_use_cli_guess(self):
        src = Path(__file__).with_name("email_draft_hermes.py").read_text(encoding="utf-8")
        self.assertNotIn("hermes chat", src)
        self.assertNotIn("--no-stream", src)
        self.assertIn("resolve_runtime_provider", src)
        self.assertIn("responses.create", src)
        self.assertIn("capture_terminal_model", src)


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
