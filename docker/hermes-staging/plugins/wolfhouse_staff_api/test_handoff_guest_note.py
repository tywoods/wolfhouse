"""Offline regression: model-owned handoff note precedes the human pause."""
import asyncio
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'plugins')]
import wolfhouse_staff_api as plugin
import apply_gateway_patches as gateway
from wolfhouse import explicit_human_handoff as handoff, pause_gate
from wolfhouse.test_draft_mode_inbox_persist import _SendResult, _install_gateway_stub


class HandoffGuestNoteTests(unittest.TestCase):
    def test_guest_note_before_pause_with_truthful_failed_send(self):
        for note, provider_ok, blocked in (
            ('Claro, voy a buscar a alguien del equipo para ayudarte.', True, False),
            ('Of course, I’m getting a staff member to help you.', True, False),
            ('Claro, voy a buscar a alguien del equipo para ayudarte.', False, False),
            ('Of course, I’m getting a staff member to help you.', True, True),
        ):
            with self.subTest(note=note, provider_ok=provider_ok, blocked=blocked):
                timeline, results = [], []
                state = {'paused': False}
                phone = '+34900000001'
                event = SimpleNamespace(source=SimpleNamespace(chat_id=phone), text='Necesito ayuda')
                async def provider(_self, chat_id, content, **kwargs):
                    self.assertFalse(state['paused'])
                    self.assertEqual(content, note)
                    self.assertEqual(chat_id, phone)
                    timeline.append('send')
                    return _SendResult(success=provider_ok, message_id='wamid.offline' if provider_ok else None)
                def persist(path, payload):
                    self.assertEqual(path, '/conversation/needs-human')
                    timeline.append('persist')
                    state['paused'] = True
                    return {'success': True, 'needs_human': True, 'conversation_paused': True,
                            'staff_handoff': {'id': 'offline-review'}}
                class Adapter:
                    send = gateway._patched_whatsapp_cloud_send
                adapter = Adapter()
                async def dispatch(_event):
                    params = {'reason': 'human_requested', 'guest_note': note}
                    results.append(json.loads(await asyncio.to_thread(plugin.flag_needs_human, params)))
                    results.append(json.loads(await asyncio.to_thread(plugin.flag_needs_human, params)))
                    final = await adapter.send(phone, 'must not send a second note')
                    self.assertFalse(final.success)
                async def run():
                    await handoff.dispatch_with_handoff_notice(event, SimpleNamespace(
                        adapter=adapter, dispatch_fn=dispatch))
                _install_gateway_stub()
                env = {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
                       'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid',
                       'LUNA_AUTO_SEND_ENABLED': 'true', 'WHATSAPP_DRY_RUN': 'false'}
                with patch.dict(os.environ, env), patch.object(plugin, '_post_bot', side_effect=persist), \
                     patch.object(pause_gate, 'whatsapp_outbound_disposition', side_effect=lambda *a, **k: {
                         'send_blocked': blocked or state['paused'], 'stage_as_draft': False}), \
                     patch.object(gateway, '_orig_whatsapp_cloud_send', provider, create=True):
                    asyncio.run(run())
                self.assertEqual(timeline, ['persist'] if blocked else ['send', 'persist'])
                for result in results:
                    self.assertTrue(result['handoff_persisted'])
                    self.assertTrue(result['conversation_paused'])
                    self.assertEqual(result['ack_sent'], provider_ok and not blocked)
                    self.assertEqual(result['ack_send_failed'], not provider_ok or blocked)

    def test_default_warm_note_when_guest_note_missing(self):
        timeline, sent = [], []
        phone = '+349****0002'
        event = SimpleNamespace(source=SimpleNamespace(chat_id=phone), text='I need a person')
        expected = 'A staff member will help you from here — someone from the team will write to you shortly.'
        async def provider(_self, chat_id, content, **kwargs):
            sent.append(content)
            timeline.append('send')
            return _SendResult(success=True, message_id='wamid.default')
        def persist(path, payload):
            timeline.append('persist')
            return {'success': True, 'needs_human': True, 'conversation_paused': True,
                    'staff_handoff': {'id': 'offline-review'}}
        class Adapter:
            send = gateway._patched_whatsapp_cloud_send
        adapter = Adapter()
        async def dispatch(_event):
            params = {'reason': 'human_requested'}
            json.loads(await asyncio.to_thread(plugin.flag_needs_human, params))
        async def run():
            await handoff.dispatch_with_handoff_notice(event, SimpleNamespace(
                adapter=adapter, dispatch_fn=dispatch))
        _install_gateway_stub()
        env = {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
               'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid',
               'LUNA_AUTO_SEND_ENABLED': 'true', 'WHATSAPP_DRY_RUN': 'false'}
        with patch.dict(os.environ, env), patch.object(plugin, '_post_bot', side_effect=persist), \
             patch.object(pause_gate, 'whatsapp_outbound_disposition', side_effect=lambda *a, **k: {
                 'send_blocked': False, 'stage_as_draft': False}), \
             patch.object(gateway, '_orig_whatsapp_cloud_send', provider, create=True):
            asyncio.run(run())
        self.assertEqual(timeline, ['send', 'persist'])
        self.assertEqual(sent, [expected])


if __name__ == '__main__':
    unittest.main()
