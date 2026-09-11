from __future__ import annotations

import ast
import importlib.util
import json
import os
import shutil
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import apply_luna_live_loop_trace_patch as patcher
from wolfhouse import luna_capture_identity_trace as sink
from wolfhouse import luna_live_loop_trace as live

PINNED = Path("/opt/hermes")


class LiveLoopTraceTests(unittest.TestCase):
    def setUp(self):
        self.identity = sink.CaptureIdentityTrace(run_id="run", attempt_id="attempt")
        self.capture = object()
        self.trace_token = sink.enter_trace(self.identity)
        self.capture_patch = patch.object(live, "_current_capture", return_value=self.capture)
        self.capture_patch.start()

    def tearDown(self):
        self.capture_patch.stop()
        sink.exit_trace(self.trace_token)

    def enabled(self):
        return patch.dict(os.environ, {live.ENABLE_ENV: "1"}, clear=True)

    def test_default_off_and_explicit_enable_plus_synthetic_restriction(self):
        item = types.SimpleNamespace(type="function_call", status="completed", id="i", call_id="c", name="tool", arguments="{}")
        live.observe_output_item_done(item)
        self.assertEqual(self.identity.snapshot(), [])
        with self.enabled():
            with patch.object(live, "_current_capture", return_value=None):
                live.observe_output_item_done(item)
            self.assertEqual(self.identity.snapshot(), [])
            live.observe_output_item_done(item)
        self.assertEqual(len(self.identity.snapshot()), 1)

    def test_completed_incomplete_absent_null_and_malformed_controls(self):
        rows = []
        cases = [
            types.SimpleNamespace(type="function_call", status="completed", id="i1", call_id="c1", name="ok", arguments='{"x":1}'),
            types.SimpleNamespace(type="function_call", status="in_progress", id="i2", call_id="c2", name="wait", arguments='{"x":'),
            types.SimpleNamespace(type="function_call", id="i3", call_id="c3", name="absent", arguments="{}"),
            types.SimpleNamespace(type="function_call", status=None, id="i4", call_id="c4", name="null", arguments=object()),
        ]
        with self.enabled():
            for item in cases:
                live.observe_output_item_done(item, response_id="resp")
        rows = self.identity.snapshot()
        self.assertEqual([r["status_literal"] for r in rows], ["completed", "in_progress", "absent", "null"])
        self.assertEqual([r["arguments_valid"] for r in rows], [True, False, True, False])
        # The upstream assembly predicate is only ``done_item is not None``;
        # literal item status is diagnostic metadata and never filters the item.
        self.assertEqual([r["excluded"] for r in rows], [False, False, False, False])
        self.assertEqual([r["branch"] for r in rows], ["assemble"] * 4)
        self.assertTrue(all(r["response_id"] == "resp" and r["capture_id"] == id(self.capture) for r in rows))

    def test_normalized_return_uses_actual_calls_and_correlated_item_ids(self):
        calls = [types.SimpleNamespace(id="c", response_item_id="fc_1", function=types.SimpleNamespace(name="lookup", arguments="{}"))]
        assistant = types.SimpleNamespace(tool_calls=calls)
        response = types.SimpleNamespace(id="resp")
        with self.enabled():
            live.observe_normalized_return(response, assistant, "tool_calls")
        row = self.identity.snapshot()[0]
        self.assertEqual((row["returned_call_count"], row["call_id"], row["call_name"], row["input_item_id"], row["finish_reason"]), (1, "c", "lookup", "fc_1", "tool_calls"))

    def test_actual_decision_rejection_and_continuation_metadata_is_content_free(self):
        calls = [types.SimpleNamespace(id="c", response_item_id="fc_1", function=types.SimpleNamespace(name="lookup", arguments='{"secret":"NOPE"}'))]
        history = [{"role": "assistant", "type": "message", "content": "TOP SECRET", "tool_call_id": "prior"}]
        with self.enabled():
            live.observe_assistant_tool_calls(types.SimpleNamespace(tool_calls=calls), calls, history, branch="continue", reason="tool_calls_accepted")
        row = self.identity.snapshot()[0]
        self.assertEqual((row["history_role"], row["history_type"], row["history_call_id"], row["branch"]), ("assistant", "message", "prior", "continue"))
        serialized = json.dumps(row)
        self.assertNotIn("TOP SECRET", serialized)
        self.assertNotIn("NOPE", serialized)
        self.assertNotIn("arguments", row)

        # Every real loop branch samples history where that branch executes.  A
        # missing response-item correlation remains explicit (None), never copied
        # from the tool-call id.
        with self.enabled():
            live.observe_conversation_branch(
                calls[0], history + [{"role": "tool", "tool_call_id": "c", "content": "SECRET"}],
                branch="invalid_name_retry", reason="unknown_tool", predicate=True,
            )
        rejected = self.identity.snapshot()[1]
        self.assertEqual(
            (rejected["branch"], rejected["reason_code"], rejected["history_role"],
             rejected["history_call_id"], rejected["call_id"], rejected["input_item_id"]),
            ("invalid_name_retry", "unknown_tool", "tool", "c", "c", "fc_1"),
        )
        self.assertNotIn("SECRET", json.dumps(rejected))
        missing = types.SimpleNamespace(id="call-only", function=types.SimpleNamespace(name="lookup", arguments="{}"))
        with self.enabled():
            live.observe_conversation_branch(missing, [], branch="invalid_json_retry", reason="malformed_arguments", predicate=True)
        self.assertEqual(self.identity.snapshot()[2]["call_id"], "call-only")
        self.assertIsNone(self.identity.snapshot()[2]["input_item_id"])

    def test_mixed_call_selection_and_dispatch_preserve_full_count_and_correlations(self):
        calls = [
            types.SimpleNamespace(id="valid", response_item_id="fc_valid", function=types.SimpleNamespace(name="lookup", arguments="{}")),
            types.SimpleNamespace(id="invalid", response_item_id="fc_invalid", function=types.SimpleNamespace(name="not_a_tool", arguments="{}")),
        ]
        with self.enabled():
            live.observe_conversation_branch(calls, [], branch="tool_selection_true", reason="tool_calls_present", predicate=True)
            live.observe_conversation_branch(calls, [], branch="post_dispatch_continue", reason="tool_results_appended", predicate=True)
            live.observe_conversation_branch(calls[1], [], branch="invalid_name_retry", reason="unknown_tool", predicate=True)
        selected, selected_second, dispatched, dispatched_second, rejected = self.identity.snapshot()
        self.assertEqual(
            [(selected["actual_call_count"], selected["call_id"], selected["input_item_id"]),
             (selected_second["actual_call_count"], selected_second["call_id"], selected_second["input_item_id"])],
            [(2, "valid", "fc_valid"), (2, "invalid", "fc_invalid")],
        )
        self.assertEqual(
            [(dispatched["actual_call_count"], dispatched["call_id"]),
             (dispatched_second["actual_call_count"], dispatched_second["call_id"])],
            [(2, "valid"), (2, "invalid")],
        )
        self.assertEqual((rejected["actual_call_count"], rejected["call_id"]), (1, "invalid"))

    def test_bounds_concurrency_correlation_and_sink_failure_fail_open(self):
        identities = [sink.CaptureIdentityTrace(run_id="r", attempt_id=str(i), limit=2) for i in range(2)]
        captures = [object(), object()]
        def worker(index):
            token = sink.enter_trace(identities[index])
            try:
                with patch.dict(os.environ, {live.ENABLE_ENV: "1"}, clear=True), patch.object(live, "_current_capture", return_value=captures[index]):
                    for _ in range(4):
                        live.observe_output_item_done(types.SimpleNamespace(type="message"), response_id="r" + str(index))
            finally:
                sink.exit_trace(token)
        threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual([len(i.snapshot()) for i in identities], [2, 2])
        self.assertNotEqual(identities[0].snapshot()[0]["capture_id"], identities[1].snapshot()[0]["capture_id"])
        with self.enabled(), patch.object(self.identity, "emit", side_effect=OSError("sink")):
            self.assertIsNone(live.observe_output_item_done(types.SimpleNamespace(type="message")))


class ImagePatchTests(unittest.TestCase):
    def copy_tree(self, root: Path):
        (root / "agent").mkdir()
        paths = [root / "agent/codex_runtime.py", root / "agent/codex_responses_adapter.py", root / "agent/conversation_loop.py"]
        for target in paths:
            shutil.copy2(PINNED / target.relative_to(root), target)
            target.chmod(0o600)
        return paths

    def test_patch_is_static_exactly_three_sites_idempotent_and_compiles(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            paths = self.copy_tree(root)
            patcher.patch_root(root)
            once = [p.read_bytes() for p in paths]
            patcher.patch_root(root)
            self.assertEqual(once, [p.read_bytes() for p in paths])
            self.assertEqual(sum(data.count(patcher.HOOK_TAG.encode()) for data in once), 3)
            for path in paths:
                ast.parse(path.read_text())
            loop = paths[2].read_text()
            self.assertNotIn("run_agent.py", [relative for relative, _, _ in patcher.PATCHES])
            for branch in (
                "tool_selection_true", "tool_selection_false", "invalid_name_early_return",
                "invalid_name_retry", "invalid_json_early_return", "invalid_json_retry",
                "invalid_json_recovery", "post_dispatch_continue",
            ):
                self.assertIn(f'branch="{branch}"', loop)

    def test_anchor_drift_and_partial_patch_fail_closed_without_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            paths = self.copy_tree(root)
            originals = [p.read_bytes() for p in paths]
            paths[0].write_text(paths[0].read_text().replace('if event_type == "response.output_item.done":', 'if False:'))
            drifted = [p.read_bytes() for p in paths]
            with self.assertRaisesRegex(RuntimeError, "anchor"):
                patcher.patch_root(root)
            self.assertEqual(drifted, [p.read_bytes() for p in paths])
            self.assertNotEqual(originals, drifted)

    def test_partial_current_file_write_failure_restores_every_attempted_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            paths = self.copy_tree(root)
            # Docker image tests run after the patch is applied. Normalize copied
            # pinned sources back to their original state so this test exercises
            # the write/rollback path in both host and built-image environments.
            for path in paths:
                source = path.read_text()
                relative = str(path.relative_to(root))
                for patch_relative, anchor, replacement in patcher.PATCHES:
                    if patch_relative == relative and replacement in source:
                        source = source.replace(replacement, anchor, 1)
                path.write_text(source)
            originals = {path: path.read_bytes() for path in paths}
            real_write_text = Path.write_text
            failed_path = paths[1]
            failed_once = False

            def partial_then_fail(path, text, *args, **kwargs):
                nonlocal failed_once
                if path == failed_path and not failed_once:
                    failed_once = True
                    real_write_text(path, text[:37], *args, **kwargs)
                    raise OSError("injected partial current-file write")
                return real_write_text(path, text, *args, **kwargs)

            with patch.object(Path, "write_text", partial_then_fail):
                with self.assertRaisesRegex(OSError, "injected partial"):
                    patcher.patch_root(root)
            self.assertEqual(originals, {path: path.read_bytes() for path in paths})

    def test_mixed_valid_invalid_patch_targets_actual_offender_and_full_lists(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            paths = self.copy_tree(root)
            patcher.patch_root(root)
            loop = paths[2].read_text()
            self.assertIn('_observe_live_branch(assistant_message.tool_calls, messages, branch="tool_selection_true"', loop)
            self.assertIn('_observe_live_branch(assistant_message.tool_calls, messages, branch="post_dispatch_continue"', loop)
            self.assertNotIn('_observe_live_branch(assistant_message.tool_calls[0]', loop)
            self.assertIn('next(tc for tc in assistant_message.tool_calls if tc.function.name == invalid_name)', loop)
            self.assertIn('next(tc for tc in assistant_message.tool_calls if tc.function.name == tool_name)', loop)

    def test_dockerfile_installs_and_applies_patch_twice(self):
        dockerfile = Path(__file__).parent / "Dockerfile"
        if not dockerfile.exists():
            self.skipTest("Dockerfile is not copied into the built image")
        text = dockerfile.read_text()
        self.assertIn("COPY apply_luna_live_loop_trace_patch.py", text)
        self.assertIn("COPY test_luna_live_loop_trace_patch.py", text)
        self.assertEqual(text.count("python /etc/hermes-staging/apply_luna_live_loop_trace_patch.py"), 2)


if __name__ == "__main__":
    unittest.main()
