from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import apply_luna_append_body_receipt_patch as image_patch
from wolfhouse import luna_append_body_receipt as receipt
from wolfhouse import luna_capture_identity_trace as sink


class AppendBodyReceiptTests(unittest.TestCase):
    def setUp(self):
        self.trace = sink.CaptureIdentityTrace(run_id="synthetic-run-7", attempt_id="attempt-2")
        self.token = sink.enter_trace(self.trace)
        self.capture = types.SimpleNamespace(
            metadata_capture=types.SimpleNamespace(dispositions=[{"call_id": "call-9", "status": "completed"}])
        )
        self.capture_patch = patch.object(receipt, "_current_capture", return_value=self.capture)
        self.capture_patch.start()

    def tearDown(self):
        self.capture_patch.stop()
        sink.exit_trace(self.token)

    def emit(self, value, **kwargs):
        snapshot = receipt.snapshot_append_body(value)
        return receipt.observe_append_body(
            snapshot, call_id="call-9", producer="executor_return",
            api_request_id="api-request-3", response_id=None, **kwargs,
        )

    def test_off_and_non_synthetic_scope_emit_nothing(self):
        self.emit("ok")
        with patch.dict(os.environ, {receipt.ENABLE_ENV: "1"}, clear=True), \
             patch.object(receipt, "_current_capture", return_value=None):
            self.emit("ok")
        self.assertEqual(self.trace.snapshot(), [])

    def test_structured_recursive_redaction_before_serialization(self):
        value = {
            "nested": [{"token": "raw-secret", "safe": "kept"}],
            "authorization": "Bearer   abcDEF123456789",
            "basic": "authorization: Basic dXNlcjpwYXNz",
            "multiline": "password:\n  hunter2",
            "escaped": r"api_key:\n  escapedSecret",
            "url": "https://example.invalid/x?safe=yes&access_token=urlSecret#frag",
            "generic": "AbCdEfGhIjKlMnOpQrStUv123456",
        }
        with patch.dict(os.environ, {receipt.ENABLE_ENV: "1"}, clear=True):
            self.emit(value)
        row = self.trace.snapshot()[0]
        serialized = row["result_capture"]
        for secret in ("raw-secret", "abcDEF", "dXNlcjpwYXNz", "hunter2", "escapedSecret", "urlSecret", "AbCdEf"):
            self.assertNotIn(secret, serialized)
        self.assertIn("kept", serialized)
        self.assertTrue(row["capture_complete"])
        self.assertEqual(row["api_request_id"], "api-request-3")
        self.assertIsNone(row["response_id"])
        self.assertEqual(row["run_id"], "synthetic-run-7")

    def test_snapshot_is_immutable_defensive_and_unknown_is_explicitly_incomplete(self):
        value = {"items": [{"answer": "before"}]}
        snapshot = receipt.snapshot_append_body(value)
        value["items"][0]["answer"] = "after"
        with patch.dict(os.environ, {receipt.ENABLE_ENV: "1"}, clear=True):
            receipt.observe_append_body(snapshot, call_id="call-9", producer="executor_return",
                                        api_request_id="req", response_id=None)
            self.emit(object())
        rows = self.trace.snapshot()
        self.assertIn("before", rows[0]["result_capture"])
        self.assertNotIn("after", rows[0]["result_capture"])
        self.assertFalse(rows[1]["capture_complete"])
        self.assertEqual(rows[1]["capture_failure"], "unsupported_result_object")
        self.assertIsNone(rows[1]["result_capture"])

    def test_regular_observer_failure_is_swallowed(self):
        with patch.dict(os.environ, {receipt.ENABLE_ENV: "1"}, clear=True), \
             patch.object(receipt, "_redact_frozen", side_effect=RuntimeError("observer failed")):
            self.assertIsNone(self.emit("safe"))
        row = self.trace.snapshot()[0]
        self.assertFalse(row["capture_complete"])
        self.assertEqual(row["capture_failure"], "serialization_or_redaction_failed")

    def test_real_sink_preserves_under_cap_body_and_marks_over_cap_incomplete(self):
        """Receipt bounds at 1024; the real sink must not silently clip result_capture to 128."""
        under = {"answer": "U" * 200}
        over = {"answer": "O" * 2000}
        expected_under = json.dumps(under, ensure_ascii=True, separators=(",", ":"))
        expected_over = json.dumps(over, ensure_ascii=True, separators=(",", ":"))
        self.assertGreater(len(expected_under), 128)
        self.assertLessEqual(len(expected_under), receipt._MAX_CAPTURE)
        self.assertGreater(len(expected_over), receipt._MAX_CAPTURE)
        with patch.dict(os.environ, {receipt.ENABLE_ENV: "1"}, clear=True):
            receipt.observe_append_body(
                receipt.snapshot_append_body(under), call_id="call-9",
                producer="P" * 200, api_request_id="A" * 200, response_id=None,
            )
            receipt.observe_append_body(
                receipt.snapshot_append_body(over), call_id="call-9",
                producer="executor_return", api_request_id="api-request-3",
                response_id=None,
            )
        under_row, over_row = self.trace.snapshot()
        self.assertEqual(under_row["result_capture"], expected_under)
        self.assertGreater(len(under_row["result_capture"]), 128)
        self.assertTrue(under_row["capture_complete"])
        self.assertIsNone(under_row["capture_failure"])
        self.assertEqual(under_row["producer"], "P" * 128)
        self.assertEqual(under_row["api_request_id"], "A" * 128)
        self.assertEqual(len(over_row["result_capture"]), receipt._MAX_CAPTURE)
        self.assertEqual(over_row["result_capture"], expected_over[:receipt._MAX_CAPTURE])
        self.assertFalse(over_row["capture_complete"])
        self.assertEqual(over_row["capture_failure"], "capture_truncated")


class OrdinaryAppendPatchTests(unittest.TestCase):
    def test_pinned_owner_patch_is_idempotent_and_uses_exception_snapshot_and_correct_correlation(self):
        source = Path("/opt/hermes/agent/tool_executor.py").read_text()
        once = image_patch.patch_text(source)
        self.assertEqual(image_patch.patch_text(once), once)
        self.assertEqual(once.count(image_patch.TAG), 1)
        self.assertIn("_snapshot_append_body(_tool_content)", once)
        self.assertIn("if _append_receipt_enabled():", once)
        self.assertNotIn("_observe_append_body(_append_body_message", once)
        self.assertIn("api_request_id=getattr(agent, \"_current_api_request_id\", None)", once)
        self.assertIn("response_id=None", once)
        self.assertNotIn("except BaseException", once[once.index(image_patch.TAG):once.index(image_patch.TAG) + 3000])

    def test_actual_patched_sequential_executor_integration(self):
        """Copy the pin, apply predecessor/candidate patches, import and drive the real owner."""
        staging = Path(__file__).resolve().parents[1]
        harness = r'''
import json, os, sys, types
from pathlib import Path
from unittest.mock import MagicMock
root, staging = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(root)); sys.path.insert(0, str(staging))
import apply_luna_executor_handoff_patch as handoff
import apply_luna_live_loop_trace_patch as live
import apply_luna_append_body_receipt_patch as candidate
handoff.main(); live.patch_root(root); candidate.patch_root(root)
# Keep the integration focused on the real patched owner while replacing only
# its broad optional import graph with deterministic seams.
def module(name, **attrs):
    value = types.ModuleType(name)
    for key, item in attrs.items(): setattr(value, key, item)
    sys.modules[name] = value
    return value
noop = lambda *a, **kw: None
class Budget: pass
class Decision:
    def __init__(self, allows_execution=True): self.allows_execution = allows_execution
    @classmethod
    def allow(cls): return cls(True)
module('agent.display', KawaiiSpinner=object, build_tool_preview=lambda *a: '',
       get_cute_tool_message=lambda *a, **kw: '', get_tool_emoji=lambda *a: '',
       _detect_tool_failure=lambda name, result: (isinstance(result, str) and ('Error executing' in result or '"error"' in result), None))
module('agent.tool_guardrails', ToolGuardrailDecision=Decision)
module('agent.tool_dispatch_helpers', _is_destructive_command=lambda *a: False,
       _is_multimodal_tool_result=lambda *a: False, _multimodal_text_summary=str,
       _append_subdir_hint_to_multimodal=noop,
       make_tool_result_message=lambda name, content, cid: {'role':'tool','name':name,'content':content,'tool_call_id':cid})
tools = module('tools'); tools.__path__ = []
module('tools.terminal_tool', get_active_env=lambda *a: None)
module('tools.thread_context', propagate_context_to_thread=lambda fn: fn)
module('tools.tool_result_storage', maybe_persist_tool_result=lambda content, **kw: content,
       enforce_turn_budget=noop)
module('tools.budget_config', BudgetConfig=Budget, DEFAULT_BUDGET=Budget(),
       budget_for_context_window=lambda *a: Budget())
module('tools.tool_search', TOOL_CALL_NAME='tool_search', resolve_underlying_call=lambda a: (None,None,None))
plugins_pkg = module('hermes_cli'); plugins_pkg.__path__ = []
plugins = module('hermes_cli.plugins', get_pre_tool_call_block_message=lambda *a, **kw: None)
module('agent.agent_runtime_helpers', agent_runtime_owns_post_tool_hook=lambda *a: False)
module('model_tools', _emit_post_tool_call_hook=noop)
from agent import tool_executor as owner
from wolfhouse import luna_append_body_receipt as receipt
from wolfhouse import luna_capture_identity_trace as sink

trace = sink.CaptureIdentityTrace(run_id='synthetic-integration', attempt_id='attempt-1')
token = sink.enter_trace(trace)
capture = types.SimpleNamespace(metadata_capture=types.SimpleNamespace(dispositions=[]))
receipt._current_capture = lambda: capture
os.environ[receipt.ENABLE_ENV] = '1'
executions = []

def dispatch(name, args, *a, **kw):
    executions.append(name)
    if name == 'explode': raise RuntimeError('caught-boom')
    return {'answer': 'ok', 'kind': name}
owner._ra = lambda: types.SimpleNamespace(handle_function_call=dispatch)
owner._apply_tool_request_middleware_for_agent = lambda agent, **kw: (kw['function_args'], [])
owner.maybe_persist_tool_result = lambda content, **kw: content
owner.enforce_turn_budget = lambda *a, **kw: None
owner.get_active_env = lambda *a, **kw: None
plugins.get_pre_tool_call_block_message = lambda name, *a, **kw: 'local-denied' if name == 'reject' else None

agent = MagicMock()
agent._interrupt_requested = False; agent.quiet_mode = True; agent.verbose_logging = False
agent.tool_progress_callback = None; agent.tool_start_callback = None; agent.tool_complete_callback = None
agent.tool_delay = 0; agent.session_id = 'session'; agent.valid_tool_names = set()
agent._context_engine_tool_names = set(); agent._memory_manager = None
agent._current_turn_id = 'turn'; agent._current_api_request_id = 'api-request-real'
agent._tool_guardrails.before_call.return_value = Decision.allow()
agent._append_guardrail_observation.side_effect = lambda n, a, result, **kw: result
agent._tool_result_content_for_active_model.side_effect = lambda n, result: result
agent._subdirectory_hints.check_tool_call.return_value = ''
agent._should_emit_quiet_tool_messages.return_value = False
agent._should_use_spinner.return_value = False
agent._checkpoint_mgr.enabled = False
agent._apply_pending_steer_to_tool_results.return_value = None
agent._record_file_mutation_result.return_value = None
agent._touch_activity.return_value = None

def call(name, cid):
    tc = types.SimpleNamespace(id=cid, function=types.SimpleNamespace(name=name, arguments='{}'))
    msg = types.SimpleNamespace(tool_calls=[tc]); messages=[]
    owner.execute_tool_calls_sequential(agent, msg, messages, 'task')
    return messages
outputs = [call('reject','c1'), call('explode','c2'), call('success','c3')]
# A normal observer exception at the patched seam must not change execution or append.
original_observe = receipt.observe_append_body
receipt.observe_append_body = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError('observer-boom'))
failed_observer_output = call('success_after_observer_failure','c4')
receipt.observe_append_body = original_observe
snapshot_calls = []
original_snapshot = receipt.snapshot_append_body
receipt.snapshot_append_body = lambda value: (snapshot_calls.append(value), original_snapshot(value))[1]
os.environ[receipt.ENABLE_ENV] = '0'
off_output = call('success_off','c5')
rows = trace.snapshot(); sink.exit_trace(token)
print(json.dumps({'executions': executions, 'outputs': outputs, 'failed_observer_output': failed_observer_output,
                  'off_output': off_output, 'off_snapshot_calls': len(snapshot_calls), 'rows': rows}, default=str))
'''
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "hermes"
            subprocess.run(["cp", "-a", "--reflink=auto", "/opt/hermes", str(root)], check=True)
            subprocess.run(["chmod", "-R", "u+w", str(root)], check=True)
            env = dict(os.environ, HERMES_ROOT=str(root), PYTHONPATH=f"{root}:{staging}")
            proc = subprocess.run(
                [sys.executable, "-c", harness, str(root), str(staging)], env=env,
                text=True, capture_output=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + "\n" + proc.stderr)
        result = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(result["executions"], ["explode", "success", "success_after_observer_failure", "success_off"])
        self.assertEqual(len(result["rows"]), 3)  # observer failure and OFF each emit no receipt
        self.assertEqual([row["producer"] for row in result["rows"]],
                         ["local_validation_rejection", "caught_exception", "executor_return"])
        self.assertTrue(all(row["api_request_id"] == "api-request-real" and row["response_id"] is None
                            for row in result["rows"]))
        appended = result["outputs"]
        self.assertEqual([m[0]["tool_call_id"] for m in appended], ["c1", "c2", "c3"])
        self.assertIsInstance(appended[0][0]["content"], str)
        self.assertIsInstance(appended[1][0]["content"], str)
        self.assertIsInstance(appended[2][0]["content"], dict)
        self.assertEqual(appended[2][0]["content"], {"answer": "ok", "kind": "success"})
        self.assertEqual(result["failed_observer_output"][0]["content"]["kind"], "success_after_observer_failure")
        self.assertEqual(result["off_output"][0]["content"]["kind"], "success_off")
        self.assertEqual(result["off_snapshot_calls"], 0)


if __name__ == "__main__":
    unittest.main()
