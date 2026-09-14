from __future__ import annotations

import json
import os
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import apply_luna_append_body_receipt_patch as image_patch
from wolfhouse import luna_append_body_receipt as receipt
from wolfhouse import luna_capture_identity_trace as sink


class AppendBodyReceiptTests(unittest.TestCase):
    def setUp(self):
        self.trace = sink.CaptureIdentityTrace(run_id="request-7", attempt_id="attempt-2")
        self.token = sink.enter_trace(self.trace)
        self.capture = types.SimpleNamespace(
            metadata_capture=types.SimpleNamespace(dispositions=[{"call_id": "call-9", "status": "completed"}])
        )
        self.capture_patch = patch.object(receipt, "_current_capture", return_value=self.capture)
        self.capture_patch.start()

    def tearDown(self):
        self.capture_patch.stop()
        sink.exit_trace(self.token)

    def enabled(self):
        return patch.dict(os.environ, {receipt.ENABLE_ENV: "1"}, clear=True)

    def test_off_emits_nothing(self):
        receipt.observe_append_body(
            {"role": "tool", "name": "lookup", "tool_call_id": "call-9", "content": "ok"},
            producer="executor_return", response_id="response-3", append_site=receipt.ORDINARY_APPEND_SITE,
        )
        self.assertEqual(self.trace.snapshot(), [])

    def test_local_rejection_executor_error_and_success_receipts(self):
        cases = [
            ("local_validation_rejection", '{"error":"denied"}'),
            ("caught_exception", "Error executing tool 'lookup': failed"),
            ("executor_return", {"answer": 42}),
        ]
        with self.enabled():
            for producer, value in cases:
                message = {"role": "tool", "name": "lookup", "tool_call_id": "call-9", "content": value}
                before_value, before_class = message["content"], type(message["content"])
                receipt.observe_append_body(message, producer=producer,
                                            response_id="response-3", append_site=receipt.ORDINARY_APPEND_SITE)
                self.assertIs(message["content"], before_value)
                self.assertIs(type(message["content"]), before_class)
        rows = self.trace.snapshot()
        self.assertEqual([r["producer"] for r in rows], [c[0] for c in cases])
        self.assertTrue(all(r["request_id"] == "request-7" and r["attempt_id"] == "attempt-2" for r in rows))
        self.assertTrue(all(r["response_id"] == "response-3" and r["call_id"] == "call-9" for r in rows))
        self.assertTrue(all(r["append_site"] == receipt.ORDINARY_APPEND_SITE for r in rows))
        self.assertEqual(rows[2]["result_class"], "dict")
        self.assertEqual(json.loads(rows[2]["result_capture"]), {"answer": 42})
        self.assertEqual(rows[0]["dispatcher_disposition"], "completed")
        self.assertFalse(rows[2]["authoritative_read_proven"])

    def test_result_capture_redacts_credentials_without_conversation_payload(self):
        message = {"role": "tool", "name": "lookup", "tool_call_id": "call-9",
                   "content": {"token": "raw-secret", "answer": "safe"}}
        with self.enabled():
            receipt.observe_append_body(message, producer="executor_return",
                                        response_id="response-3")
        serialized = json.dumps(self.trace.snapshot()[0])
        self.assertNotIn("raw-secret", serialized)
        self.assertIn("safe", serialized)

    def test_redaction_and_serialization_failure_are_fail_open_and_incomplete(self):
        class Broken:
            def __str__(self):
                raise RuntimeError("secret TOKEN=raw")
        message = {"role": "tool", "name": "lookup", "tool_call_id": "call-9", "content": Broken()}
        with self.enabled(), patch.object(receipt, "_redact", side_effect=RuntimeError("redactor failed")):
            self.assertIsNone(receipt.observe_append_body(message, producer="executor_return",
                                                           response_id="response-3", append_site=receipt.ORDINARY_APPEND_SITE))
        row = self.trace.snapshot()[0]
        self.assertFalse(row["capture_complete"])
        self.assertEqual(row["capture_failure"], "serialization_or_redaction_failed")
        self.assertNotIn("raw", json.dumps(row))
        self.assertIs(type(message["content"]), Broken)


class OrdinaryAppendPatchTests(unittest.TestCase):
    def test_pinned_owner_patch_is_idempotent_compiles_and_covers_all_producers(self):
        source = Path("/opt/hermes/agent/tool_executor.py").read_text()
        once = image_patch.patch_text(source)
        self.assertEqual(image_patch.patch_text(once), once)
        self.assertEqual(once.count(image_patch.TAG), 1)
        self.assertIn("messages.append(_append_body_message)", once)
        self.assertIn("_observe_append_body(_append_body_message", once)
        for producer in ("local_validation_rejection", "caught_exception", "executor_return"):
            self.assertIn(producer, once)

    def test_observation_toggle_cannot_change_append_or_execution_count(self):
        def ordinary_path(enabled):
            calls = []
            messages = []
            value = {"ok": True}
            calls.append("executed")
            message = {"role": "tool", "tool_call_id": "call-9", "content": value}
            messages.append(message)
            env = {receipt.ENABLE_ENV: "1"} if enabled else {}
            with patch.dict(os.environ, env, clear=True):
                receipt.observe_append_body(message, producer="executor_return", response_id="response-3")
            return calls, messages

        off_calls, off_messages = ordinary_path(False)
        on_calls, on_messages = ordinary_path(True)
        self.assertEqual(off_calls, on_calls)
        self.assertEqual(off_messages, on_messages)
        self.assertIs(type(off_messages[0]["content"]), type(on_messages[0]["content"]))


if __name__ == "__main__":
    unittest.main()
