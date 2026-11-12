"""Discount stopgap: guide contract and real handoff boundary, offline transports."""
import asyncio
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'plugins')]


class DiscountHandoffTests(unittest.TestCase):
    def test_discount_contract_and_price_only_exclusion(self):
        guide = (ROOT / 'soul-guides/14-hard-rules.md').read_text()
        paragraph = guide.split('\n\n')[1]
        self.assertIn(paragraph, (ROOT / 'SOUL.md').read_text())
        for required in ('Discount requests (temporary handoff)', 'discount_requested',
                         'lower price', 'a deal', 'guest_note', 'Staff Info',
                         'Do not negotiate', 'only asks what the price is',
                         'Normal quotes and package prices are unchanged',
                         'standard warm note', 'shortly to help',
                         'passed to the team for review'):
            self.assertIn(required, guide)

    def test_discount_uses_real_note_before_pause_without_duplicate(self):
        import wolfhouse_staff_api as plugin
        import apply_gateway_patches as gateway
        from wolfhouse import explicit_human_handoff as handoff, pause_gate
        from wolfhouse.test_draft_mode_inbox_persist import _SendResult, _install_gateway_stub
        for text, note in (
            ('Can you give me a discount?', 'Of course, I’m getting a staff member to help you.'),
            ('¿Me puedes hacer un descuento?', 'Claro, voy a buscar a alguien del equipo para ayudarte.'),
        ):
            with self.subTest(text=text):
                timeline, receipts = [], []
                phone = '+34900000981'
                event = SimpleNamespace(source=SimpleNamespace(chat_id=phone), text=text)
                async def provider(_self, chat_id, content, **kwargs):
                    self.assertEqual(chat_id, phone)
                    self.assertEqual(content, note)
                    timeline.append('note')
                    return _SendResult(success=True, message_id='wamid.offline.discount')
                def persist(path, payload):
                    self.assertEqual(path, '/conversation/needs-human')
                    self.assertEqual(payload['reason'], 'discount_requested')
                    timeline.append('needs_human')
                    return {'success': True, 'needs_human': True, 'conversation_paused': True,
                            'staff_handoff': {'id': 'offline-discount'}}
                class Adapter:
                    send = gateway._patched_whatsapp_cloud_send
                adapter = Adapter()
                async def dispatch(_event):
                    for _ in range(2):
                        receipts.append(json.loads(await asyncio.to_thread(
                            plugin.flag_needs_human,
                            {'reason': 'discount_requested', 'guest_note': note})))
                async def run():
                    await handoff.dispatch_with_handoff_notice(event, SimpleNamespace(
                        adapter=adapter, dispatch_fn=dispatch))
                _install_gateway_stub()
                with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo',
                        'HERMES_ROLE': 'luna', 'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid',
                        'LUNA_AUTO_SEND_ENABLED': 'true', 'WHATSAPP_DRY_RUN': 'false'}), \
                     patch.object(plugin, '_post_bot', side_effect=persist), \
                     patch.object(pause_gate, 'whatsapp_outbound_disposition', return_value={
                         'send_blocked': False, 'stage_as_draft': False}), \
                     patch.object(gateway, '_orig_whatsapp_cloud_send', provider, create=True):
                    asyncio.run(run())
                self.assertEqual(timeline, ['note', 'needs_human'])
                for receipt in receipts:
                    self.assertTrue(receipt['handoff_persisted'])
                    self.assertTrue(receipt['ack_sent'])


if __name__ == '__main__':
    unittest.main()
