#!/usr/bin/env python3
"""Regression tests for the exact WhatsApp `Fresh Start` command."""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parent
if str(ROOT.parent) not in sys.path:
    sys.path.insert(0, str(ROOT.parent))

from wolfhouse import whatsapp_fresh_start_command as mod  # noqa: E402


class FakeAdapter:
    def __init__(self):
        self.sent = []
        self.original_calls = []

    async def send(self, **kwargs):
        self.sent.append(kwargs)
        return SimpleNamespace(success=True, message_id="ack-1")


class FreshStartCommandTests(unittest.TestCase):
    def _event(self, text="Fresh Start"):
        return SimpleNamespace(
            content=text,
            message_type=SimpleNamespace(value="text"),
            source=SimpleNamespace(user_id="491700000000", chat_id="491700000000"),
        )

    def test_only_exact_trimmed_words_match(self):
        self.assertTrue(mod.is_fresh_start_command(self._event("Fresh Start")))
        self.assertTrue(mod.is_fresh_start_command(self._event("  Fresh Start\n")))
        for text in ("fresh start", "FRESH START", "Fresh Start please", "/Fresh Start", "Fresh  Start", ""):
            with self.subTest(text=text):
                self.assertFalse(mod.is_fresh_start_command(self._event(text)))

    def test_exact_command_resets_only_guest_session_sends_ack_and_skips_agent(self):
        adapter = FakeAdapter()
        event = self._event()
        original_calls = []

        async def original(_adapter, _event):
            original_calls.append(_event)

        with patch.object(
            mod,
            "reset_session_key_only",
            return_value={"ok": True, "reset": True, "hard_delete": False, "scope": "session_key"},
        ) as reset, patch.object(
            mod,
            "reset_sender_for_adapter_event",
            new=AsyncMock(return_value=True),
        ) as barrier:
            asyncio.run(mod.handle_or_delegate(adapter, event, original))

        reset.assert_called_once_with("491700000000")
        barrier.assert_awaited_once_with(adapter, event)
        self.assertEqual(original_calls, [])
        self.assertEqual(len(adapter.sent), 1)
        self.assertEqual(adapter.sent[0]["chat_id"], "491700000000")
        self.assertIn("Fresh start complete", adapter.sent[0]["content"])

    def test_reset_failure_fails_closed_and_skips_agent(self):
        adapter = FakeAdapter()
        event = self._event()
        original_calls = []

        async def original(_adapter, _event):
            original_calls.append(_event)

        with patch.object(mod, "reset_session_key_only", return_value={"ok": False, "error": "busy"}):
            asyncio.run(mod.handle_or_delegate(adapter, event, original))

        self.assertEqual(original_calls, [])
        self.assertEqual(len(adapter.sent), 1)
        self.assertIn("couldn’t reset", adapter.sent[0]["content"])

    def test_reset_exception_fails_closed_and_uses_public_send(self):
        adapter = FakeAdapter()
        event = self._event()

        async def original(_adapter, _event):
            self.fail("Fresh Start must never enter model dispatch")

        with patch.object(mod, "reset_session_key_only", side_effect=RuntimeError("db unavailable")):
            asyncio.run(mod.handle_or_delegate(adapter, event, original))

        self.assertEqual(len(adapter.sent), 1)
        self.assertIn("couldn’t reset", adapter.sent[0]["content"])
        self.assertEqual(
            adapter.sent[0]["metadata"],
            {"wolfhouse_guest_reply": True, "wolfhouse_fresh_start_ack": True},
        )

    def test_broad_reset_contract_is_rejected(self):
        adapter = FakeAdapter()
        event = self._event()

        async def original(_adapter, _event):
            self.fail("Fresh Start must never enter model dispatch")

        unsafe = {
            "ok": True,
            "reset": True,
            "scope": "all_guest_sessions",
            "hard_delete": True,
            "memories_cleared": {"cleared": ["MEMORY.md"]},
        }
        with patch.object(mod, "reset_session_key_only", return_value=unsafe), patch.object(
            mod, "reset_sender_for_adapter_event", new=AsyncMock()
        ) as barrier:
            asyncio.run(mod.handle_or_delegate(adapter, event, original))

        barrier.assert_not_awaited()
        self.assertIn("couldn’t reset", adapter.sent[0]["content"])

    def test_non_command_delegates_unchanged(self):
        adapter = FakeAdapter()
        event = self._event("Can we make a fresh start?")
        original_calls = []

        async def original(_adapter, _event):
            original_calls.append(_event)
            return "delegated"

        result = asyncio.run(mod.handle_or_delegate(adapter, event, original))
        self.assertEqual(result, "delegated")
        self.assertEqual(original_calls, [event])
        self.assertEqual(adapter.sent, [])

    def test_reset_drops_buffered_sender_work_and_cancels_timers(self):
        from wolfhouse.whatsapp_burst_coalesce import BurstBuffer, BurstCoalescer

        cancelled = []
        coalescer = BurstCoalescer(cancel_fn=lambda handle: cancelled.append(handle))
        adapter = SimpleNamespace(_phone_number_id="pnid")
        event = self._event()
        event.source.platform = SimpleNamespace(value="whatsapp_cloud")
        key = coalescer.key_for_adapter_event(adapter, event)
        state = coalescer._sender(key)
        state.buffer = BurstBuffer(timer_handle="buffer-timer")
        state.pending = BurstBuffer(timer_handle="pending-timer")
        state.structured_queue.append(object())

        self.assertTrue(asyncio.run(coalescer.reset_sender_for_adapter_event(adapter, event)))
        self.assertEqual(cancelled, ["buffer-timer", "pending-timer"])
        self.assertNotIn(key, coalescer._senders)

    def test_reset_cancels_real_active_dispatch_before_ack_boundary(self):
        from wolfhouse.whatsapp_burst_coalesce import AdapterDispatch, BurstCoalescer

        async def scenario():
            coalescer = BurstCoalescer()
            coalescer._guest_paused_before_agent = lambda _event: False
            adapter = SimpleNamespace(_phone_number_id="pnid")
            event = self._event()
            event.source.platform = SimpleNamespace(value="whatsapp_cloud")
            started = asyncio.Event()

            async def stale_dispatch(_event):
                started.set()
                await asyncio.Event().wait()

            dispatch = AdapterDispatch(adapter=adapter, dispatch_fn=stale_dispatch)
            task = asyncio.create_task(coalescer._dispatch_one(dispatch, event))
            await started.wait()
            key = coalescer.key_for_adapter_event(adapter, event)
            state = coalescer._senders[key]
            self.assertIs(state.active_task, task)

            self.assertTrue(await coalescer.reset_sender_for_adapter_event(adapter, event))
            self.assertTrue(task.cancelled())
            self.assertNotIn(key, coalescer._senders)

        asyncio.run(scenario())

    def test_ack_metadata_is_admitted_by_guest_send_guard(self):
        from wolfhouse import guest_send_guard

        with patch.dict("os.environ", {"HERMES_ROLE": "luna", "LUNA_CLIENT_SLUG": "wolfhouse-somo"}, clear=False):
            metadata = {"wolfhouse_guest_reply": True, "wolfhouse_fresh_start_ack": True}
            self.assertFalse(guest_send_guard.suppress_guest_whatsapp_text_send("Fresh start complete", metadata))

    def test_gateway_runtime_installs_command_patch(self):
        source = (ROOT.parent / "apply_gateway_patches.py").read_text(encoding="utf-8")
        self.assertIn('"fresh_start_command": False', source)
        self.assertIn("install_whatsapp_fresh_start_command_patch", source)
        self.assertIn('applied["fresh_start_command"]', source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
