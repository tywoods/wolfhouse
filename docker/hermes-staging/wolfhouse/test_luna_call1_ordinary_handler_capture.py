"""Offline full ordinary-handler parity for the LR3.2 call-1 envelope.

The exact-image gate runs this file with ``--network none``.  Provider and Staff
transport are deterministic doubles; route registration, request admission,
GatewayRunner._handle_message, metadata capture, copied worker context, the
registered Staff plugin, production tool-result append owner and envelope sink
stay real.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from wolfhouse import luna_call1_failure_envelope as envelope
from wolfhouse.luna_group_lesson_live_eval import (
    GROUP_LESSON_EVAL_PATH,
    register_group_lesson_eval_route,
)
from wolfhouse.luna_personality_isolation import reset_isolation_runtime_for_tests


CASE_ID = "sunset-group-lesson-09-es"
MODEL = "gpt-5.6-sol"
RUN_ID = "lr32-ordinary-handler-offline-parity"
CALL_ID = "call-lr32-ordinary-handler-1"
RESPONSE_ID = "resp-lr32-ordinary-handler-1"


class _Stream:
    def __init__(self, events):
        self._events = list(events)

    def __iter__(self):
        return iter(self._events)

    def close(self):
        return None


class _DeterministicResponses:
    def __init__(self):
        self.calls = 0

    def create(self, **kwargs):
        self.calls += 1
        if self.calls == 1:
            call = {
                "type": "function_call",
                "id": "item-lr32-ordinary-handler-1",
                "call_id": CALL_ID,
                "name": envelope.TARGET_TOOL,
                "arguments": json.dumps({"location_id": "sunset-somo"}),
                "status": "completed",
            }
            return _Stream([
                {"type": "response.output_item.done", "item": call},
                {"type": "response.completed", "response": {
                    "id": RESPONSE_ID,
                    "model": MODEL,
                    "status": "completed",
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                    "output": [call],
                }},
            ])
        message = {
            "type": "message",
            "id": "msg-lr32-ordinary-handler-2",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": "Offline deterministic stop."}],
        }
        return _Stream([
            {"type": "response.output_text.delta", "delta": "Offline deterministic stop.",
             "item_id": "msg-offline", "output_index": 0, "content_index": 0},
            {"type": "response.output_item.done", "item": message},
            {"type": "response.completed", "response": {
                "id": "resp-lr32-ordinary-handler-2",
                "model": MODEL,
                "status": "completed",
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "output": [message],
            }},
        ])


class _DeterministicChatCompletions:
    def __init__(self):
        self.calls = 0

    def create(self, **kwargs):
        self.calls += 1
        from openai.types.chat import ChatCompletionChunk

        def chunk(payload):
            return ChatCompletionChunk.model_validate(payload)

        if self.calls == 1:
            return _Stream([
                chunk({
                    "id": RESPONSE_ID,
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": MODEL,
                    "choices": [{
                        "index": 0,
                        "delta": {
                            "content": None,
                            "tool_calls": [{
                                "index": 0,
                                "id": CALL_ID,
                                "type": "function",
                                "function": {
                                    "name": envelope.TARGET_TOOL,
                                    "arguments": json.dumps({"location_id": "sunset-somo"}),
                                },
                            }],
                        },
                        "finish_reason": None,
                    }],
                }),
                chunk({
                    "id": RESPONSE_ID,
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": MODEL,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                }),
            ])
        return _Stream([
            chunk({
                "id": "resp-lr32-ordinary-handler-2",
                "object": "chat.completion.chunk",
                "created": 2,
                "model": MODEL,
                "choices": [{
                    "index": 0,
                    "delta": {"content": "Offline deterministic stop."},
                    "finish_reason": "stop",
                }],
            }),
        ])


class _DeterministicClient:
    def __init__(self):
        self.responses = _DeterministicResponses()
        self.chat = types.SimpleNamespace(completions=_DeterministicChatCompletions())

    def close(self):
        return None


class _Router:
    def __init__(self):
        self.posts = {}
        self.gets = {}

    def add_post(self, path, handler):
        self.posts[path] = handler

    def add_get(self, path, handler):
        self.gets[path] = handler


class _App:
    def __init__(self):
        self.router = _Router()


class _Request:
    headers = {"X-Luna-Bot-Token": "offline-route-token"}

    async def json(self):
        return {"case_id": CASE_ID}


def _decode_response(response):
    return response.status, json.loads(response.body.decode("utf-8"))


def _normalized_result(body):
    counters = body.get("counters") or body
    return {
        "status": body.get("status"),
        "error": body.get("error"),
        "read_tools_invoked": counters.get("read_tools_invoked"),
        "read_tools_completed": counters.get("read_tools_completed"),
        "read_staff_paths_invoked": counters.get("read_staff_paths_invoked"),
        "read_staff_paths_completed": counters.get("read_staff_paths_completed"),
        "model_calls": counters.get("model_calls"),
        "sends_attempted": counters.get("sends_attempted"),
        "sends_completed": counters.get("sends_completed"),
        "journal_writes_completed": counters.get("journal_writes_completed"),
        "persistence_effects_completed": counters.get("persistence_effects_completed"),
    }


class OrdinaryHandlerEnvelopeParityTests(unittest.TestCase):
    def test_plugin_disabled_fresh_process_has_no_catalog_or_dispatcher(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / "home"
            home.mkdir(mode=0o700)
            (home / "config.yaml").write_text(
                "model:\n  default: gpt-5.6-sol\n  provider: openrouter\n",
                encoding="utf-8",
            )
            plugins = home / "plugins"
            plugins.mkdir()
            shutil.copytree(
                "/etc/hermes-staging/plugins/wolfhouse_staff_api",
                plugins / "wolfhouse_staff_api",
            )
            script = """
from hermes_cli.plugins import discover_plugins, get_plugin_manager
discover_plugins()
import model_tools
name = 'get_sunset_lesson_catalog'
definitions = model_tools.get_tool_definitions(skip_tool_search_assembly=True)
offered = {item.get('function', {}).get('name') for item in definitions if isinstance(item, dict)}
assert name not in offered
assert name not in set(get_plugin_manager()._plugin_tool_names)
import os
os._exit(0)
"""
            env = dict(os.environ)
            env.update({
                "HOME": str(home),
                "HERMES_HOME": str(home),
                "WOLFHOUSE_STAFF_API_BASE_URL": "https://offline.invalid",
                "LUNA_BOT_INTERNAL_TOKEN": "offline-token",
            })
            result = subprocess.run(
                [sys.executable, "-c", script],
                env=env,
                text=True,
                capture_output=True,
                timeout=60,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir(mode=0o700)
        (self.home / "SOUL.md").write_text("offline exact-image Luna\n", encoding="utf-8")
        (self.home / "config.yaml").write_text(
            "model:\n"
            "  default: gpt-5.6-sol\n"
            "  provider: openrouter\n"
            "toolsets:\n"
            "  - wolfhouse_staff_api\n"
            "plugins:\n"
            "  enabled:\n"
            "    - wolfhouse-staff-api\n",
            encoding="utf-8",
        )
        plugins = self.home / "plugins"
        plugins.mkdir()
        shutil.copytree(
            "/etc/hermes-staging/plugins/wolfhouse_staff_api",
            plugins / "wolfhouse_staff_api",
        )
        envelope.ARTIFACT_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        for item in envelope.ARTIFACT_DIR.iterdir():
            if item.is_file():
                item.unlink()
        self.base_env = {
            "HERMES_ROLE": "sunset-luna",
            "LUNA_CLIENT_SLUG": "sunset",
            "SUNSET_INGRESS_LOCATION_ID": "sunset-somo",
            "LUNA_ALLOWED_LOCATION_IDS": "sunset-somo",
            "HERMES_MODEL": MODEL,
            "HERMES_HOME": str(self.home),
            "LUNA_PERSONALITY_EXPECTED_HERMES_HOME": str(self.home),
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://sunset-staging.lunafrontdesk.com",
            "WHATSAPP_CLOUD_WEBHOOK_PORT": "8094",
            "SUNSET_LUNA_REQUIRE_ISOLATED_AUTH": "true",
            "LUNA_BOT_INTERNAL_TOKEN": "offline-route-token",
            "OPENAI_API_KEY": "offline-provider-token",
            "OPENROUTER_API_KEY": "offline-provider-token",
            "LUNA_AUTO_SEND_ENABLED": "0",
            "LUNA_CAPTURE_IDENTITY_TRACE_ENABLED": "0",
            "LUNA_LIVE_LOOP_TRACE_ENABLED": "0",
            "LUNA_APPEND_BODY_RECEIPT_ENABLED": "0",
            "LUNA_LR32_DIRECT_COMPARE_ENABLED": "0",
        }
        if os.getenv("LR32_TEST_TRACE_TOKEN") == "valid":
            self.base_env["LUNA_LR32_CAPTURE_IDENTITY_TRACE_PATH"] = (
                "/tmp/lr32-capture-identity-trace.jsonl"
            )
        if os.getenv("LR32_TEST_EXPORT_ARTIFACT"):
            self.base_env["LR32_TEST_EXPORT_ARTIFACT"] = os.environ[
                "LR32_TEST_EXPORT_ARTIFACT"
            ]

    def tearDown(self):
        reset_isolation_runtime_for_tests()
        envelope.reset_for_tests()
        self.tmp.cleanup()

    async def _run_route(self, enabled, *, scope_overrides=None):
        client = _DeterministicClient()
        app = _App()
        adapter_results = []
        append_results = []
        receipt_rows = []
        real_adapter_entry = envelope.adapter_entry
        real_append_result = envelope.append_result
        real_trace_emit = envelope.trace_emit

        def observed_trace_emit(identity, event, **kwargs):
            if event in {"lr32_adapter_outcome", "lr32_append_outcome", "lr32_publication_outcome"}:
                receipt_rows.append({
                    "event": event,
                    **{key: value for key, value in kwargs.items() if key != "capture"},
                })
            return real_trace_emit(identity, event, **kwargs)

        def observed_adapter_entry(*args, **kwargs):
            identity = envelope.current_trace()
            capture = envelope._current_capture()
            approved = envelope.approved_server_run_id()
            proven = envelope._metadata_call1(capture) if capture is not None else None
            result = real_adapter_entry(*args, **kwargs)
            pending = getattr(capture, envelope._CAPTURE_PENDING_ATTR, ()) if capture else ()
            adapter_results.append({
                "admitted": result is not None,
                "identity_present": identity is not None,
                "capture_present": capture is not None,
                "approved_present": approved is not None,
                "run_ids_match": bool(identity and approved == identity.run_id),
                "server_marker": bool(
                    capture and getattr(capture, "_lr32_server_validated_synthetic", False) is True
                ),
                "metadata_call1": proven is not None,
                "metadata_expected_id": proven[1] if proven is not None else None,
                "returned_handle": result is not None,
                "handle_expected_id": result.expected_call_id if result is not None else None,
                "handle_capture_failure": result.capture_failure if result is not None else None,
                "pending_count_after": len(pending) if type(pending) is tuple else None,
                "pending_contains_handle": bool(
                    result is not None and type(pending) is tuple
                    and sum(item is result for item in pending) == 1
                ),
                "capture_identity": id(capture) if capture is not None else None,
            })
            return result

        def observed_append_result(*args, **kwargs):
            capture = envelope._current_capture()
            pending_before = getattr(capture, envelope._CAPTURE_PENDING_ATTR, ()) if capture else ()
            actual_id = kwargs.get("call_id")
            matches_before = (
                [item for item in pending_before if item.expected_call_id == str(actual_id)[:128]]
                if type(pending_before) is tuple else []
            )
            observed_handle = matches_before[0] if len(matches_before) == 1 else None
            result = real_append_result(*args, **kwargs)
            pending_after = getattr(capture, envelope._CAPTURE_PENDING_ATTR, ()) if capture else ()
            append_results.append({
                "actual_id": actual_id,
                "capture_identity": id(capture) if capture is not None else None,
                "pending_count_before": len(pending_before) if type(pending_before) is tuple else None,
                "exact_match_count_before": len(matches_before),
                "matched_expected_id": (
                    observed_handle.expected_call_id if observed_handle is not None else None
                ),
                "consumed": bool(
                    observed_handle is not None and type(pending_after) is tuple
                    and all(item is not observed_handle for item in pending_after)
                ),
                "pending_count_after": len(pending_after) if type(pending_after) is tuple else None,
                "publication_path": str(result) if result is not None else None,
                "published": bool(result is not None and result.is_file()),
                "handle_capture_failure": (
                    observed_handle.capture_failure if observed_handle is not None else None
                ),
                "producer": kwargs.get("producer"),
            })
            return result
        env = dict(self.base_env)
        env.update({
            envelope.ENABLE_ENV: "1" if enabled else "0",
            envelope.APPROVED_RUN_ENV: RUN_ID if enabled else "",
            envelope.ARTIFACT_DIR_ENV: str(envelope.ARTIFACT_DIR) if enabled else "",
        })
        # Apply the historical scope tuple after fixture defaults and before ordinary entry.
        for key, value in (scope_overrides or {}).items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
        with patch.dict(os.environ, env, clear=True):
            from gateway import run as gateway_run
            from hermes_cli.plugins import discover_plugins, get_plugin_manager
            discover_plugins()
            import model_tools
            definitions = model_tools.get_tool_definitions(
                enabled_toolsets=["wolfhouse_staff_api"],
                skip_tool_search_assembly=True,
            )
            offered = {
                item.get("function", {}).get("name")
                for item in definitions
                if isinstance(item, dict)
            }
            self.assertIn(envelope.TARGET_TOOL, offered)
            loaded = get_plugin_manager().list_plugins()
            self.assertTrue(
                any(item.get("name") == "wolfhouse-staff-api" for item in loaded),
                loaded,
            )
            self.assertIn(
                envelope.TARGET_TOOL,
                set(get_plugin_manager()._plugin_tool_names),
            )
            from run_agent import AIAgent
            runtime = {
                "api_key": "offline-provider-token",
                "base_url": "https://offline.invalid/v1",
                "provider": "openai",
                "api_mode": "codex_responses",
                "command": None,
                "args": [],
                "credential_pool": None,
                "max_tokens": None,
            }
            with patch.object(
                     gateway_run, "_resolve_runtime_agent_kwargs", return_value=runtime,
                 ), patch.object(
                     AIAgent, "_create_openai_client", return_value=client,
                 ), patch(
                     "urllib.request.urlopen", side_effect=TimeoutError("offline-staff-transport"),
                 ), patch.object(
                     envelope, "adapter_entry", side_effect=observed_adapter_entry,
                 ), patch.object(
                     envelope, "append_result", side_effect=observed_append_result,
                 ), patch.object(
                     envelope, "trace_emit", side_effect=observed_trace_emit,
                 ):
                runner = gateway_run.GatewayRunner()
                gateway_run._wolfhouse_gateway_runner = runner
                self.assertTrue(register_group_lesson_eval_route(app))
                response = await app.router.posts[GROUP_LESSON_EVAL_PATH](_Request())
        self.last_receipt_rows = receipt_rows
        return _decode_response(response), max(
            client.responses.calls, client.chat.completions.calls,
        ), adapter_results, append_results

    def test_off_on_full_ordinary_handler_publishes_correlated_failure_envelope(self):
        trace_enabled = os.getenv("LR32_TEST_TRACE_TOKEN") == "valid"
        off, off_provider_calls, off_adapter, off_append = asyncio.run(self._run_route(False))
        reset_isolation_runtime_for_tests()
        envelope.reset_for_tests()
        self.assertEqual(list(envelope.ARTIFACT_DIR.iterdir()), [])

        on, on_provider_calls, on_adapter, on_append = asyncio.run(self._run_route(True))

        self.assertEqual(off[0], 503)
        self.assertEqual(on[0], 503)
        self.assertEqual(off_provider_calls, 2, off[1])
        self.assertEqual(on_provider_calls, 2, on[1])
        self.assertEqual(_normalized_result(off[1]), _normalized_result(on[1]))
        self.assertEqual([item["admitted"] for item in off_adapter], [False])
        self.assertEqual(on_adapter, [{
            "admitted": trace_enabled,
            "identity_present": trace_enabled,
            "capture_present": True,
            "approved_present": True,
            "run_ids_match": trace_enabled,
            "server_marker": True,
            "metadata_call1": True,
            "metadata_expected_id": CALL_ID,
            "returned_handle": trace_enabled,
            "handle_expected_id": CALL_ID if trace_enabled else None,
            "handle_capture_failure": None,
            "pending_count_after": 1 if trace_enabled else 0,
            "pending_contains_handle": trace_enabled,
            "capture_identity": on_adapter[0]["capture_identity"],
        }], on[1])
        self.assertEqual(len(off_append), 1)
        self.assertEqual(len(on_append), 1)
        self.assertEqual(off_append[0]["actual_id"], CALL_ID)
        self.assertEqual(off_append[0]["exact_match_count_before"], 0)
        self.assertFalse(off_append[0]["consumed"])
        self.assertFalse(off_append[0]["published"])
        self.assertEqual(on_append[0], {
            "actual_id": CALL_ID,
            "capture_identity": on_adapter[0]["capture_identity"],
            "pending_count_before": 1 if trace_enabled else 0,
            "exact_match_count_before": 1 if trace_enabled else 0,
            "matched_expected_id": CALL_ID if trace_enabled else None,
            "consumed": trace_enabled,
            "pending_count_after": 0,
            "publication_path": (
                str(envelope.ARTIFACT_DIR / f"lr32-call1-{RUN_ID}.json")
                if trace_enabled else None
            ),
            "published": trace_enabled,
            "handle_capture_failure": None,
            "producer": "executor_return",
        }, on[1])

        artifact = envelope.ARTIFACT_DIR / f"lr32-call1-{RUN_ID}.json"
        if not trace_enabled:
            self.assertFalse(artifact.exists())
            return
        self.assertTrue(artifact.is_file(), on[1])
        document = json.loads(artifact.read_text(encoding="utf-8"))
        digest = document.pop("checksum_sha256")
        canonical = json.dumps(document, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
        self.assertEqual(digest, hashlib.sha256(canonical).hexdigest())
        self.assertTrue(document["capture_complete"])
        self.assertEqual(document["ids"]["run_id"], RUN_ID)
        self.assertEqual(document["ids"]["tool_call_id"], CALL_ID)
        # The ordinary executor append DTO does not carry the provider response id;
        # correlation is owned by the server run id plus exact tool-call id.
        self.assertIsNone(document["ids"]["model_response_id"])
        self.assertEqual(document["transport"]["outcome"], "transport_exception")
        self.assertEqual(document["transport"]["exception_class"], "TimeoutError")
        self.assertEqual(document["plugin_return"]["classification"], "json_failure")
        self.assertEqual(document["dispatcher"]["disposition"], "failed")
        self.assertEqual(document["append"]["producer"], "executor_return")
        print("ARTIFACT_EVIDENCE " + json.dumps({
            "checksum_sha256": digest,
            "capture_complete": document["capture_complete"],
            "run_id": document["ids"]["run_id"],
            "tool_call_id": document["ids"]["tool_call_id"],
            "transport_outcome": document["transport"]["outcome"],
            "dispatcher_disposition": document["dispatcher"]["disposition"],
            "append_producer": document["append"]["producer"],
        }, sort_keys=True))
        export_path = os.getenv("LR32_TEST_EXPORT_ARTIFACT")
        if export_path:
            shutil.copy2(artifact, export_path)

    def test_scope_parity_missing_ingress_reproduces_sealed_rejection(self):
        """Config evidence lacks ingress and the ordinary path reproduces sealed scope_mismatch."""
        self.maxDiff = None
        self.base_env["LUNA_LR32_CAPTURE_IDENTITY_TRACE_PATH"] = (
            "/tmp/lr32-capture-identity-trace.jsonl"
        )

        accepted, accepted_calls, accepted_adapter, accepted_append = asyncio.run(
            self._run_route(True)
        )
        accepted_receipts = list(self.last_receipt_rows)
        accepted_artifact = envelope.ARTIFACT_DIR / f"lr32-call1-{RUN_ID}.json"
        accepted_document = json.loads(accepted_artifact.read_text(encoding="utf-8"))
        accepted_digest = accepted_document.pop("checksum_sha256")
        accepted_canonical = json.dumps(
            accepted_document, ensure_ascii=True, sort_keys=True, separators=(",", ":")
        ).encode()
        self.assertEqual(accepted_digest, hashlib.sha256(accepted_canonical).hexdigest())

        accepted_artifact.unlink()
        reset_isolation_runtime_for_tests()
        envelope.reset_for_tests()

        synthetic, synthetic_calls, synthetic_adapter, synthetic_append = asyncio.run(
            self._run_route(
                True,
                scope_overrides={
                    "HERMES_ROLE": "sunset-luna",
                    "LUNA_CLIENT_SLUG": "sunset",
                    "LUNA_BOT_CLIENT_SLUG": None,
                    "SUNSET_INGRESS_LOCATION_ID": None,
                },
            )
        )
        synthetic_receipts = list(self.last_receipt_rows)

        self.assertEqual(accepted[0], 503)
        self.assertEqual(synthetic[0], 503)
        self.assertEqual(accepted_calls, 2)
        self.assertEqual(synthetic_calls, 2)
        self.assertEqual(_normalized_result(accepted[1]), _normalized_result(synthetic[1]))
        normalized = _normalized_result(synthetic[1])
        self.assertEqual(normalized["sends_attempted"], 0)
        self.assertEqual(normalized["sends_completed"], 0)
        self.assertEqual(normalized["journal_writes_completed"], 0)
        self.assertEqual(normalized["persistence_effects_completed"], [])

        self.assertEqual(len(accepted_adapter), 1)
        self.assertTrue(accepted_adapter[0]["identity_present"])
        self.assertTrue(accepted_adapter[0]["capture_present"])
        self.assertTrue(accepted_adapter[0]["approved_present"])
        self.assertTrue(accepted_adapter[0]["run_ids_match"])
        self.assertTrue(accepted_adapter[0]["server_marker"])
        self.assertTrue(accepted_adapter[0]["metadata_call1"])
        self.assertTrue(accepted_adapter[0]["pending_contains_handle"])
        self.assertEqual(accepted_append[0]["exact_match_count_before"], 1)
        self.assertTrue(accepted_append[0]["consumed"])
        self.assertTrue(accepted_append[0]["published"])
        self.assertEqual(
            [(row["event"], row["status"], row["reason"]) for row in accepted_receipts],
            [
                ("lr32_adapter_outcome", "accepted", "handle_created"),
                ("lr32_append_outcome", "consumed", "exact_match"),
                ("lr32_publication_outcome", "completed", "published"),
            ],
        )

        # This tuple is explicitly synthetic: stopped-container/config evidence proves
        # the variable was absent, not that it was absent at adapter execution time.
        self.assertEqual(len(synthetic_adapter), 1)
        self.assertFalse(synthetic_adapter[0]["admitted"])
        self.assertTrue(synthetic_adapter[0]["identity_present"])
        self.assertTrue(synthetic_adapter[0]["capture_present"])
        self.assertTrue(synthetic_adapter[0]["approved_present"])
        self.assertTrue(synthetic_adapter[0]["run_ids_match"])
        self.assertTrue(synthetic_adapter[0]["server_marker"])
        self.assertFalse(synthetic_adapter[0]["pending_contains_handle"])
        self.assertEqual(len(synthetic_append), 1)
        self.assertEqual(synthetic_append[0]["actual_id"], CALL_ID)
        self.assertEqual(synthetic_append[0]["exact_match_count_before"], 0)
        self.assertFalse(synthetic_append[0]["consumed"])
        self.assertFalse(synthetic_append[0]["published"])
        self.assertEqual(
            [(row["event"], row["status"], row["reason"]) for row in synthetic_receipts],
            [
                ("lr32_adapter_outcome", "rejected", "scope_mismatch"),
                ("lr32_append_outcome", "rejected", "no_exact_match"),
            ],
        )
        adapter_receipt = synthetic_receipts[0]
        self.assertFalse(adapter_receipt["scope_match"])
        self.assertIsNone(adapter_receipt["metadata_call1"])
        self.assertFalse(adapter_receipt["pending_created"])
        append_receipt = synthetic_receipts[1]
        self.assertEqual(append_receipt["call_id"], CALL_ID)
        self.assertEqual(append_receipt["exact_match_count"], 0)
        self.assertFalse(append_receipt["handle_match"])
        self.assertFalse(append_receipt["consumed"])
        self.assertFalse(any(row["event"] == "lr32_publication_outcome"
                             for row in synthetic_receipts))
        self.assertEqual(list(envelope.ARTIFACT_DIR.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
