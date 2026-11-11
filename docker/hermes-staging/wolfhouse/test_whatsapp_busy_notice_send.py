"""Offline regression for busy acks that bypass gateway status preparation.

Run: python3 docker/hermes-staging/wolfhouse/test_whatsapp_busy_notice_send.py
The real runtime installer wraps an adapter with a recording transport; all
external dependencies are isolated so this test cannot send or call Staff.
"""
from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


class BusyNoticeSendTest(unittest.TestCase):
    def test_installed_send_filter_blocks_busy_acks_not_guest_replies(self):
        spec = importlib.util.spec_from_file_location(
            "busy_notice_gateway_patches",
            Path(__file__).resolve().parents[1] / "apply_gateway_patches.py",
        )
        assert spec is not None and spec.loader is not None
        patches = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(patches)
        sent = []

        class Adapter:
            async def send(self, chat_id, content, reply_to=None, metadata=None):
                sent.append(content)
                return SimpleNamespace(success=True, message_id="offline-id", raw_response={})

            async def _send_with_retry(self, **kwargs):
                # Busy acknowledgements call this directly, not the status preparer.
                return await self.send(**kwargs)

        def module(name, **attrs):
            result = ModuleType(name)
            result.__dict__.update(attrs)
            return result

        gateway = module("gateway", __path__=[])
        platforms = module("gateway.platforms", __path__=[])
        cloud = module("gateway.platforms.whatsapp_cloud", WhatsAppCloudAdapter=Adapter)
        run = module("gateway.run", _prepare_gateway_status_message=lambda *args: args[-1])
        gateway.__dict__.update(run=run, platforms=platforms)
        platforms.__dict__.update(whatsapp_cloud=cloud)
        modules = {
            "gateway": gateway,
            "gateway.run": run,
            "gateway.platforms": platforms,
            "gateway.platforms.whatsapp_cloud": cloud,
            "gateway.platforms.base": module("gateway.platforms.base", SendResult=SimpleNamespace),
            "wolfhouse": module("wolfhouse", __path__=[]),
            "wolfhouse.explicit_human_handoff": module(
                "wolfhouse.explicit_human_handoff",
                is_saved_booking_turn=lambda *a: False,
                suppress_ordinary_handoff_reply=lambda *a: False,
                allow_saved_booking_reply=lambda *a: False,
            ),
            "wolfhouse.guest_send_guard": module(
                "wolfhouse.guest_send_guard", suppress_guest_whatsapp_text_send=lambda *a: False),
            "wolfhouse.send_flags": module(
                "wolfhouse.send_flags", guest_whatsapp_send_flag_block=lambda *a: None,
                log_flag_block=lambda *a: None, flag_block_raw_response=lambda *a: {}),
            "wolfhouse.pause_gate": module(
                "wolfhouse.pause_gate", whatsapp_outbound_disposition=lambda *a, **k: {}),
        }
        notices = [
            "⚡ Interrupting current task. I'll respond to your message shortly.",
            "⚡ Interrupting current task (iteration 2/90, running: terminal). "
            "I'll respond to your message shortly.\n\nUse /busy queue to queue messages instead.",
            "⚡ Interrupting current task… /busy queue…",
            "⏳ Queued for the next turn. I'll respond once the current task finishes.",
            "⏩ Steered into current run. Your message arrives after the next tool call.",
            "⏳ Subagent working — your message is queued for when it finishes "
            "(use /stop to cancel everything).",
        ]
        replies = [
            "We're busy at reception, but I can help with your booking.",
            "There is a queue for the surf lesson; I'll check availability.",
            "Your booking is confirmed. See you soon!",
        ]

        async def exercise():
            self.assertTrue(patches.install_runtime_whatsapp_patches()["plain_reply_send"])
            self.assertFalse(patches.install_runtime_whatsapp_patches()["plain_reply_send"])
            adapter = Adapter()
            for notice in notices:
                with self.subTest(notice=notice):
                    before = list(sent)
                    result = await adapter._send_with_retry(chat_id="offline-guest", content=notice)
                    self.assertEqual(sent, before, "internal busy notice reached transport")
                    self.assertIsNone(result.message_id)
                    self.assertTrue(result.raw_response["suppressed_internal_status"])
            for reply in replies:
                result = await adapter._send_with_retry(chat_id="offline-guest", content=reply)
                self.assertTrue(result.success)
                self.assertEqual(sent[-1], reply)
            self.assertEqual(sent, replies)

        with patch.dict(sys.modules, modules), patch.object(
            importlib.util, "spec_from_file_location", side_effect=RuntimeError("offline: no mirror I/O")
        ):
            asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main(verbosity=2)
