#!/usr/bin/env python3
"""Phase 1 durability, gate, and send-off contract tests."""
from __future__ import annotations

import json
from pathlib import Path
import unittest

from wolfhouse.email_draft_replay import ReplayCache
from wolfhouse.luna_http_contract import LOCATION_KEY, REQUEST_SCHEMA, TENANT
from wolfhouse.luna_http_gate import normalize_gate_snapshot
from wolfhouse.luna_http_server import handle_inbound_request

TOKEN = "phase1-token"


class FakeStore:
    def __init__(self):
        self.calls = []
        self.seen = {}

    def persist_and_enqueue(self, req):
        self.calls.append(("persist_and_enqueue", req["request_id"]))
        if req["request_id"] in self.seen:
            return {**self.seen[req["request_id"]], "duplicate": True}
        context = {
            "duplicate": False,
            "inbound_event_id": "11111111-1111-4111-8111-111111111111",
            "conversation_id": "22222222-2222-4222-8222-222222222222",
        }
        self.seen[req["request_id"]] = context
        return context

    def complete_turn(self, context, payload, gate_snapshot):
        self.calls.append(("complete_turn", payload["request_id"]))
        return {
            "idempotency_key": f"sunset-luna-http:{payload['request_id']}:reply:v1",
            "status": "blocked" if gate_snapshot["live_send_blocked"] else "pending",
            "send_enabled": False,
        }


def envelope(request_id="phase1-request"):
    return json.dumps({
        "schema": REQUEST_SCHEMA,
        "tenant_id": TENANT,
        "location_key": LOCATION_KEY,
        "request_id": request_id,
        "channel": "http_probe",
        "thread_key": "phase1-thread",
        "text": "Thursday for 2",
        "date": "2026-09-03",
        "quantity": 2,
        "outbound_mode": "none",
    }).encode()


def open_gate(_req):
    return {
        "success": True,
        "bot_paused": False,
        "live_send_blocked": False,
        "needs_human": False,
        "whatsapp_channel_mode": "auto",
    }


class Phase1Tests(unittest.TestCase):
    def call(self, *, store, request_id="phase1-request", availability=None, gate=open_gate):
        return handle_inbound_request(
            raw_body=envelope(request_id),
            authorization=f"Bearer {TOKEN}",
            expected_token=TOKEN,
            replay=ReplayCache(),
            store=store,
            gate_lookup=gate,
            availability=availability or (lambda _params: json.dumps({"success": True})),
        )

    def test_persist_and_enqueue_happens_before_model_and_outbox_send_is_off(self):
        store = FakeStore()

        def model(_params):
            self.assertEqual(store.calls, [("persist_and_enqueue", "phase1-order")])
            return json.dumps({"success": True})

        status, payload = self.call(store=store, request_id="phase1-order", availability=model)
        self.assertEqual(status, 200)
        self.assertEqual(store.calls[-1], ("complete_turn", "phase1-order"))
        self.assertFalse(payload["outbox"]["send_enabled"])

    def test_durable_duplicate_returns_200_without_model(self):
        store = FakeStore()
        self.call(store=store, request_id="phase1-dupe")
        status, payload = self.call(
            store=store,
            request_id="phase1-dupe",
            availability=lambda _params: self.fail("model must not run twice"),
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["duplicate"])

    def test_model_failure_after_commit_returns_200_and_keeps_event_queued(self):
        store = FakeStore()

        def fail_model(_params):
            raise RuntimeError("model down")

        status, payload = self.call(
            store=store,
            request_id="phase1-model-fails",
            availability=fail_model,
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["accepted"])
        self.assertEqual(payload["processing_status"], "queued")
        self.assertEqual(store.calls, [("persist_and_enqueue", "phase1-model-fails")])

    def test_value_error_after_commit_returns_200_and_keeps_event_queued(self):
        store = FakeStore()

        def fail_model(_params):
            raise ValueError("downstream malformed result")

        status, payload = self.call(
            store=store,
            request_id="phase1-value-error",
            availability=fail_model,
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["accepted"])
        self.assertEqual(payload["processing_status"], "queued")

    def test_admission_serializes_duplicate_request_keys_before_lookup(self):
        source = Path(__file__).with_name("luna_http_store.py").read_text()
        lock_at = source.index("pg_advisory_xact_lock")
        prior_at = source.index(
            "FROM luna_guest_inbound_events WHERE tenant_id=$1 AND request_id=$2"
        )
        self.assertLess(lock_at, prior_at)

    def test_needs_human_is_visible_but_not_a_sunset_send_block(self):
        snapshot = normalize_gate_snapshot({
            "success": True,
            "bot_paused": False,
            "live_send_blocked": False,
            "needs_human": True,
            "whatsapp_channel_mode": "auto",
        })
        self.assertTrue(snapshot["needs_human"])
        self.assertFalse(snapshot["live_send_blocked"])

    def test_pause_auto_off_and_authoritative_lookup_failure_block(self):
        cases = [
            {"success": True, "bot_paused": True, "live_send_blocked": True},
            {"success": True, "whatsapp_channel_mode": "off"},
            {"success": False, "lookup_error": True},
        ]
        for payload in cases:
            with self.subTest(payload=payload):
                self.assertTrue(normalize_gate_snapshot(payload)["live_send_blocked"])


if __name__ == "__main__":
    unittest.main()
