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
    def test_fallback_notes_say_staff_will_help_shortly(self):
        from wolfhouse_staff_api.handoff_guest_note import default_guest_note, resolve_guest_note, WARM_NOTES
        expected = dict(WARM_NOTES)
        for language, note in expected.items():
            with self.subTest(language=language):
                self.assertEqual(default_guest_note(language), note)
                named = default_guest_note(language, 'Ale')
                self.assertIn('Ale', named)
                self.assertRegex(named, r'shortly|enseguida|a breve|gleich|tout de suite')
        self.assertEqual(default_guest_note('unknown'), expected['en'])
        stale = 'Your booking has not been saved. Please try again shortly.'
        self.assertEqual(resolve_guest_note({'language': 'en'}, stale), expected['en'])
        authored = 'Claro, voy a buscar a alguien del equipo para ayudarte.'
        self.assertEqual(resolve_guest_note({'language': 'en'}, authored), expected['en'])
        from pathlib import Path
        staging = Path(__file__).resolve().parents[2]
        guide = (staging / 'soul-guides/13-handoff.md').read_bytes()
        self.assertIn(b'shortly', guide)
        self.assertIn(b'Staff Info', guide)
        self.assertNotIn(b'Do not promise a response time', guide)

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
                    from wolfhouse_staff_api.handoff_guest_note import WARM_NOTES
                    self.assertEqual(content, WARM_NOTES['en'])
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
                delivered = provider_ok and not blocked
                if delivered:
                    self.assertEqual(timeline, ['send', 'persist'])
                else:
                    self.assertNotIn('persist', timeline)
                for result in results:
                    self.assertEqual(bool(result.get('handoff_persisted')), delivered, result)
                    self.assertEqual(bool(result.get('ack_sent')), delivered, result)
                    if not delivered:
                        self.assertTrue(result.get('ack_send_failed') or not result.get('handoff_persisted'))

    def test_default_warm_note_when_guest_note_missing(self):
        timeline, sent = [], []
        phone = '+349****0002'
        event = SimpleNamespace(source=SimpleNamespace(chat_id=phone), text='I need a person')
        expected = "I'm getting a staff member to help you, they'll be with you shortly."
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
