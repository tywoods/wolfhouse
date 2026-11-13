"""Offline regression for Ty's note-first, always-escalate, one-minute retry rule."""
import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from wolfhouse import explicit_human_handoff as handoff
from wolfhouse_staff_api import handoff_guest_note as notes


class DefaultNoteTests(unittest.TestCase):
    def test_missing_wording_uses_standard_note_in_guest_language(self):
        messages = {'en': 'I want to speak to a human',
                    'es': 'Quiero hablar con una persona',
                    'it': 'Vorrei parlare con una persona',
                    'de': 'Ich möchte bitte mit jemandem sprechen',
                    'fr': 'Je voudrais parler à une personne'}
        with patch.object(notes, 'default_fetch_staff_info', return_value={'staff_member_name': 'Camila'}):
            for language, message in messages.items():
                with self.subTest(language=language):
                    self.assertEqual(handoff.acknowledgement_for(message),
                                     notes.default_guest_note(language, 'Camila'))


class RetryGateTests(unittest.TestCase):
    def test_only_exact_note_can_retry_once_through_its_own_handoff_pause(self):
        turn = SimpleNamespace(phone='34611174710', tenant='wolfhouse-somo',
                               origin='https://example.test', handoff_pause_id='offline-pause',
                               handoff_pause_created=True, handoff_existing_staff_owned=False)
        context = {'turn': turn, 'note': 'standard warm note', 'used': False}
        gate = {'send_blocked': True, 'stage_as_draft': False, 'reason': 'paused',
                'whatsapp_channel_mode': 'auto'}
        token = handoff._RETRY_NOTE.set(context)
        env = {'LUNA_CLIENT_SLUG': turn.tenant, 'WOLFHOUSE_STAFF_API_BASE_URL': turn.origin}
        try:
            with patch.dict(os.environ, env), \
                    patch.object(handoff, '_active_handoff_pause_matches', return_value=True):
                allow = getattr(handoff, 'allow_handoff_note_retry', lambda *args: False)
                self.assertFalse(allow('34611174711', context['note'], gate))
                self.assertFalse(allow(turn.phone, 'another reply', gate))
                self.assertFalse(allow(turn.phone, context['note'], dict(gate, stage_as_draft=True)))
                self.assertFalse(allow(turn.phone, context['note'], dict(gate, reason='global_paused')))
                self.assertFalse(allow(turn.phone, context['note'], dict(gate, whatsapp_channel_mode='off')))
                self.assertTrue(allow(turn.phone, context['note'], gate))
                self.assertFalse(allow(turn.phone, context['note'], gate), 'retry bypass is one-use')
        finally:
            handoff._RETRY_NOTE.reset(token)


class ReviewRegressions(unittest.IsolatedAsyncioTestCase):
    async def test_failed_receipts_retry_once_and_report(self):
        from wolfhouse import pause_gate
        receipts = [None, SimpleNamespace(success=False, message_id=None, raw_response={}),
                    SimpleNamespace(success=True, message_id=None, raw_response={}),
                    SimpleNamespace(success=True, message_id='draft', raw_response={'suppressed_draft_mode': True})]
        for receipt in receipts:
            with self.subTest(receipt=receipt):
                calls, reports = [], []
                class Adapter:
                    async def send(self, *args, **kwargs):
                        calls.append('send')
                        return receipt
                async def clock(seconds):
                    self.assertEqual(seconds, 60)
                async def report(*args):
                    reports.append(args)
                def persist(**kwargs):
                    calls.append('persist')
                    return {'success': True, 'needs_human': True}
                env = {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna'}
                with patch.dict(os.environ, env), patch.object(notes, 'default_fetch_staff_info', return_value={}), \
                        patch.object(pause_gate, 'guest_paused_for_event', return_value=False), \
                        patch.object(handoff, 'execute_explicit_human_handoff', side_effect=persist), \
                        patch.object(handoff, '_retry_sleep', clock), \
                        patch.object(handoff, '_report_failed_handoff_note', report):
                    result = await handoff.maybe_short_circuit_explicit_human(
                        SimpleNamespace(text='I want to speak to a human', chat_id='34611174713'),
                        SimpleNamespace(adapter=Adapter()))
                    self.assertTrue(result['needs_human'])
                    if handoff._RETRY_TASKS:
                        await asyncio.gather(*tuple(handoff._RETRY_TASKS))
                    self.assertEqual(calls, ['send', 'persist', 'send'])
                    self.assertEqual(len(reports), 1)

    async def test_missing_adapter_still_persists_and_reports(self):
        from wolfhouse import pause_gate
        async def clock(seconds):
            self.assertEqual(seconds, 60)
        with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna'}), \
                patch.object(notes, 'default_fetch_staff_info', return_value={}), \
                patch.object(pause_gate, 'guest_paused_for_event', return_value=False), \
                patch.object(handoff, 'execute_explicit_human_handoff', return_value={'success': True, 'needs_human': True}) as persist, \
                patch.object(handoff, '_retry_sleep', clock), \
                patch.object(handoff, '_report_failed_handoff_note') as report:
            result = await handoff.maybe_short_circuit_explicit_human(
                SimpleNamespace(text='I want to speak to a human', chat_id='34611174714'), SimpleNamespace())
            self.assertTrue(result['needs_human'])
            persist.assert_called_once()
            await asyncio.gather(*tuple(handoff._RETRY_TASKS))
            report.assert_awaited_once()

    async def test_plugin_preserves_original_note_after_first_attempt(self):
        import threading
        turn = SimpleNamespace(ack_attempted=True, handoff_note='Original Spanish note',
                               closed=False, task=asyncio.current_task(), tenant='wolfhouse-somo',
                               origin='', phone='34611174715', lock=threading.Lock(), event=SimpleNamespace(text=''))
        token = handoff._ORDINARY_TURN.set(turn)
        try:
            with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': turn.tenant, 'WOLFHOUSE_STAFF_API_BASE_URL': ''}), \
                    patch.object(notes, 'resolve_guest_note', return_value='Different English note') as resolve:
                notes.send_before_handoff({'phone': turn.phone}, None)
                self.assertEqual(turn.handoff_note, 'Original Spanish note')
                resolve.assert_not_called()
        finally:
            handoff._ORDINARY_TURN.reset(token)


class RetryTests(unittest.IsolatedAsyncioTestCase):
    async def exercise_retry(self, second_succeeds):
        from wolfhouse import pause_gate
        order, delays, reports = [], [], []
        release = asyncio.Event()
        async def clock(seconds):
            delays.append(seconds)
            await release.wait()
        async def report(*args):
            reports.append(args)
        class Adapter:
            async def send(self, phone, content, **kwargs):
                order.append('send')
                if order.count('send') == 1 or not second_succeeds:
                    raise RuntimeError('offline delivery failure')
                return SimpleNamespace(success=True, message_id='offline-retry', raw_response={})
        def persist(**kwargs):
            order.append('persist')
            return {'success': True, 'needs_human': True, 'conversation_paused': True}
        env = {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
               'WOLFHOUSE_STAFF_API_BASE_URL': 'https://example.test'}
        event = SimpleNamespace(text='I want to speak to a human', chat_id='34611174710',
                                message_id='offline-retry-' + str(second_succeeds))
        with patch.dict(os.environ, env), \
                patch.object(notes, 'default_fetch_staff_info', return_value={}), \
                patch.object(pause_gate, 'guest_paused_for_event', return_value=False), \
                patch.object(handoff, 'execute_explicit_human_handoff', side_effect=persist), \
                patch.object(handoff, '_retry_sleep', clock, create=True), \
                patch.object(handoff, '_report_failed_handoff_note', report, create=True):
            result = await handoff.maybe_short_circuit_explicit_human(event, SimpleNamespace(adapter=Adapter()))
            self.assertTrue(result['needs_human'])
            self.assertEqual(order, ['send', 'persist'], 'flag must not wait for retry')
            # Dispatch and the next unrelated task both finish while the retry clock is held.
            await asyncio.sleep(0)
            self.assertEqual(delays, [60])
            self.assertEqual(order.count('send'), 1, 'no second attempt before sixty seconds')
            release.set()
            for _ in range(8):
                await asyncio.sleep(0)
            self.assertEqual(order, ['send', 'persist', 'send'])
            self.assertEqual(len(reports), 0 if second_succeeds else 1)
            self.assertEqual(delays, [60], 'no third attempt or second delay')

    async def test_real_flag_still_persists_after_ordinary_note_send_failure(self):
        import wolfhouse_staff_api as plugin
        order, delays = [], []
        release = asyncio.Event()
        async def clock(seconds):
            delays.append(seconds)
            await release.wait()
        class Adapter:
            async def send(self, *args, **kwargs):
                order.append('send')
                raise RuntimeError('offline provider failure')
        def post(path, payload):
            order.append('persist')
            return {'success': True, 'needs_human': True, 'pause_id': 'offline-pause',
                    'created': True, 'staff_handoff': {'id': 'offline-handoff'}}
        env = {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
               'WOLFHOUSE_STAFF_API_BASE_URL': 'https://example.test'}
        event = SimpleNamespace(text='Quiero hablar con una persona', chat_id='34611174711')
        async def dispatch(_):
            import json
            result = json.loads(await asyncio.to_thread(plugin.flag_needs_human,
                                                        {'reason': 'human_requested'}))
            self.assertTrue(result['needs_human'], result)
            self.assertEqual(order, ['send', 'persist'])
        with patch.dict(os.environ, env), patch.object(plugin, '_post_bot', side_effect=post), \
                patch.object(notes, 'default_fetch_staff_info', return_value={}), \
                patch.object(handoff, '_retry_sleep', clock):
            await handoff.dispatch_with_handoff_notice(event, SimpleNamespace(adapter=Adapter(), dispatch_fn=dispatch))
            for _ in range(3):
                await asyncio.sleep(0)
            self.assertEqual(delays, [60])
            self.assertEqual(order, ['send', 'persist'], 'the pending retry cannot hold up dispatch')

    async def test_explicit_real_plugin_gets_one_note_then_persistence(self):
        import wolfhouse_staff_api as plugin
        from wolfhouse import pause_gate
        order = []
        class Adapter:
            async def send(self, *args, **kwargs):
                order.append('send')
                return SimpleNamespace(success=True, message_id='offline-first', raw_response={})
        def post(path, payload):
            order.append('persist')
            return {'success': True, 'needs_human': True, 'pause_id': 'offline-pause',
                    'created': True, 'staff_handoff': {'id': 'offline-handoff'}}
        env = {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
               'WOLFHOUSE_STAFF_API_BASE_URL': 'https://example.test'}
        event = SimpleNamespace(text='I want to speak to a human', chat_id='34611174712',
                                message_id='offline-real-plugin')
        with patch.dict(os.environ, env), patch.object(plugin, '_post_bot', side_effect=post), \
                patch.object(notes, 'default_fetch_staff_info', return_value={}), \
                patch.object(pause_gate, 'guest_paused_for_event', return_value=False):
            result = await handoff.maybe_short_circuit_explicit_human(event, SimpleNamespace(adapter=Adapter()))
            self.assertTrue(result['needs_human'], result)
            self.assertEqual(order, ['send', 'persist'])

    async def exercise_gateway_retry(self, second_succeeds=True):
        import apply_gateway_patches as gateway
        import wolfhouse_staff_api as plugin
        from wolfhouse import pause_gate
        from wolfhouse.test_draft_mode_inbox_persist import _install_gateway_stub, _SendResult
        _install_gateway_stub()
        release = asyncio.Event()
        paused, sends, reports = [], [], []
        async def delay(seconds):
            self.assertEqual(seconds, 60)
            await release.wait()
        async def provider(adapter, phone, note, **kwargs):
            sends.append(note)
            self.assertEqual(bool(paused), len(sends) == 2)
            return _SendResult(success=len(sends) == 2 and second_succeeds,
                               message_id='offline-retry' if len(sends) == 2 else None)
        def persist(path, payload):
            paused.append(True)
            return {'success': True, 'needs_human': True, 'conversation_paused': True,
                    'created': True, 'pause_id': 'own-pause', 'staff_handoff': {'id': 'offline'}}
        class Adapter:
            send = gateway._patched_whatsapp_cloud_send
        async def dispatch(event):
            result = await asyncio.to_thread(plugin.flag_needs_human, {'reason': 'human_requested'})
            self.assertIn('"needs_human": true', result)
        async def report(*args):
            reports.append(args)
        event = SimpleNamespace(source=SimpleNamespace(chat_id='34611174710'), text='I need a person')
        env = {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
               'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid',
               'WHATSAPP_DRY_RUN': 'false', 'LUNA_AUTO_SEND_ENABLED': 'true'}
        with patch.dict(os.environ, env), patch.object(plugin, '_post_bot', side_effect=persist), \
                patch.object(notes, 'default_fetch_staff_info', return_value={}), \
                patch.object(gateway, '_orig_whatsapp_cloud_send', provider, create=True), \
                patch.object(handoff, '_retry_sleep', delay), \
                patch.object(handoff, '_report_failed_handoff_note', report), \
                patch.object(handoff, '_active_handoff_pause_matches', return_value=True), \
                patch('socket.socket.connect', side_effect=RuntimeError('offline only')), \
                patch.object(pause_gate, 'whatsapp_outbound_disposition', side_effect=lambda *a, **k: {
                    'send_blocked': bool(paused), 'stage_as_draft': False,
                    'reason': 'paused' if paused else 'active', 'whatsapp_channel_mode': 'auto'}):
            await handoff.dispatch_with_handoff_notice(event, SimpleNamespace(adapter=Adapter(), dispatch_fn=dispatch))
            self.assertEqual(len(sends), 1)
            release.set()
            for _ in range(12):
                await asyncio.sleep(0)
            self.assertEqual(len(sends), 2)
            self.assertEqual(sends[0], sends[1])
            self.assertEqual(len(reports), 0 if second_succeeds else 1)

    async def test_retry_uses_real_gateway_after_handoff_pause(self):
        await self.exercise_gateway_retry()

    async def test_failed_real_gateway_retry_is_reported(self):
        await self.exercise_gateway_retry(False)

    async def test_final_failure_reports_without_reopening_or_reflagging(self):
        import wolfhouse_staff_api as plugin
        calls = []
        turn = SimpleNamespace(phone='34611174710')
        def post(path, payload):
            calls.append((path, payload))
            return {'success': True, 'note_failure_recorded': True}
        with patch.object(plugin, '_post_bot', side_effect=post):
            await handoff._report_failed_handoff_note(handoff._notice_scope(), turn.phone, 'human_requested')
        self.assertEqual(calls, [('/conversation/needs-human', {
            'phone': turn.phone, 'report_handoff_note_failure': True})])

    async def test_explicit_failure_flags_immediately_then_one_retry_succeeds(self):
        await self.exercise_retry(True)

    async def test_explicit_double_failure_reports_to_staff_after_one_retry(self):
        await self.exercise_retry(False)


if __name__ == '__main__':
    unittest.main()
