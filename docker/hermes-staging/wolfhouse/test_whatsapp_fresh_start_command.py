#!/usr/bin/env python3
"""Regression tests for the exact WhatsApp `Fresh Start` command."""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
if str(ROOT.parent) not in sys.path:
    sys.path.insert(0, str(ROOT.parent))

from wolfhouse import whatsapp_fresh_start_command as mod  # noqa: E402


class FakeAdapter:
    def __init__(self):
        self.sent = []
        self.original_calls = []

    async def _send_with_retry(self, **kwargs):
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
        ) as reset:
            asyncio.run(mod.handle_or_delegate(adapter, event, original))

        reset.assert_called_once_with("491700000000")
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

    def test_gateway_runtime_installs_command_patch(self):
        source = (ROOT.parent / "apply_gateway_patches.py").read_text(encoding="utf-8")
        self.assertIn('"fresh_start_command": False', source)
        self.assertIn("install_whatsapp_fresh_start_command_patch", source)
        self.assertIn('applied["fresh_start_command"]', source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
