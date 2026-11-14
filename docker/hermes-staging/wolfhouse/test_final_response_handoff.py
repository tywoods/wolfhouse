"""Offline final-response repairs through the real handoff owner and flag tool.

Only Staff/provider transport and Staff Info are fixtures. No network or DB.
"""
import asyncio
from copy import deepcopy
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import wolfhouse_staff_api as plugin
from wolfhouse_staff_api import handoff_guest_note as notes
from wolfhouse import explicit_human_handoff as handoff


class FinalResponseHandoffTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.enterContext(patch.dict(os.environ, {
            'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
            'WOLFHOUSE_STAFF_API_BASE_URL': 'https://staff.invalid',
            'LUNA_BOT_INTERNAL_TOKEN': 'offline',
        }))
        self.enterContext(patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')))
        self.enterContext(patch('socket.create_connection', side_effect=AssertionError('network forbidden')))
        self.enterContext(patch.object(notes, 'default_fetch_staff_info',
                                       return_value={'staff_member_name': 'Camila'}))
        self.enterContext(patch.object(plugin, '_post_bot', new=self.post))
        self.sent, self.posts, self.order = [], [], []
        self.delivery_ok = True
        self.persist_ok = True
        self.phone = '+34' + '600000123'
        self.event = SimpleNamespace(source=SimpleNamespace(chat_id=self.phone), text='deposit')
        test = self

        class Adapter:
            async def send(self, phone, text, **kwargs):
                test.assertEqual(phone, test.phone)
                test.sent.append(text)
                test.order.append('note')
                return SimpleNamespace(success=test.delivery_ok,
                                       message_id='offline-receipt' if test.delivery_ok else None,
                                       raw_response={})

        self.adapter = Adapter()
        handoff._LOCAL_AUTOMATION_BLOCKED.clear()

    async def asyncTearDown(self):
        for task in tuple(handoff._RETRY_TASKS):
            task.cancel()
        await asyncio.gather(*tuple(handoff._RETRY_TASKS), return_exceptions=True)
        handoff._LOCAL_AUTOMATION_BLOCKED.clear()

    def post(self, path, payload):
        self.assertEqual(path, '/conversation/needs-human')
        self.assertEqual(payload['phone'], self.phone)
        self.assertTrue(self.sent, 'warm note attempt must precede persistent flag')
        self.order.append('flag')
        self.posts.append(deepcopy(payload))
        return {'success': self.persist_ok, 'needs_human': self.persist_ok,
                'pause_id': 'offline-pause', 'created': True,
                'staff_handoff': {'id': 'offline-handoff'}}

    async def run_final(self, result, before=None):
        async def dispatch(_):
            if before:
                await before()
            return result
        return await handoff.dispatch_with_handoff_notice(
            self.event, SimpleNamespace(adapter=self.adapter, dispatch_fn=dispatch))

    async def test_neutral_final_note_returns_configured_note_actually_attempted(self):
        expected = notes.default_guest_note('en', 'Camila')
        actual = await self.run_final(notes.WARM_NOTES['en'])
        self.assertEqual(self.order, ['note', 'flag'])
        self.assertEqual(self.sent, [expected])
        self.assertEqual(actual, expected)
        self.assertIn('shortly', actual)

    async def test_failed_final_note_still_flags_then_retries_exactly_once_after_sixty_seconds(self):
        self.delivery_ok = False
        release = asyncio.Event()
        delays = []

        async def sleep(seconds):
            delays.append(seconds)
            await release.wait()

        with patch.object(handoff, '_retry_sleep', new=sleep):
            note = notes.default_guest_note('en', 'Camila')
            self.assertEqual(await self.run_final(note), note)
            self.assertEqual(self.order, ['note', 'flag'])
            await asyncio.sleep(0)
            self.assertEqual(delays, [60])
            self.delivery_ok = True
            release.set()
            await asyncio.gather(*tuple(handoff._RETRY_TASKS))
            self.assertEqual(self.order, ['note', 'flag', 'note'])
            self.assertEqual(self.sent, [note, note])
            self.assertEqual(len(self.posts), 1)

    async def test_no_free_form_intent_guessing_or_booking_summary_rewrite(self):
        note = notes.default_guest_note('en', 'Camila')
        ordinary = [None, '', 'deposit', 'separate', 'Please get a human',
                    'Camila can help at reception.', 'The team will contact you shortly.',
                    'I cannot look up the weather. Please try again.',
                    'Booking WH-SAVED is saved. ' + note,
                    {'messages': [{'role': 'assistant', 'content': note}],
                     'final_response': 'Your deposit is pending.'}]
        for result in ordinary:
            with self.subTest(result=result):
                self.assertIs(await self.run_final(result), result)
        self.assertEqual(self.posts, [])
        self.assertEqual(self.sent, [])

    async def test_unconfigured_model_staff_name_does_not_create_a_decision(self):
        result = notes.default_guest_note('en', 'Invented Teammate')
        self.assertEqual(await self.run_final(result), result)
        self.assertEqual(self.posts, [])
        self.assertEqual(self.sent, [])

    async def test_existing_successful_flag_is_not_repeated(self):
        async def flag():
            await asyncio.to_thread(plugin.flag_needs_human, {'reason': 'human_requested'})
        note = notes.default_guest_note('en', 'Camila')
        self.assertEqual(await self.run_final(note, before=flag), note)
        self.assertEqual(self.order, ['note', 'flag'])
        self.assertEqual(self.posts[0]['reason'], 'human_requested')

    async def test_saved_booking_receipt_survives_final_note_repair(self):
        receipt = {'success': True, 'write_performed': True, 'booking_code': 'WH-SAVED'}
        observed = []

        async def save():
            self.assertTrue(handoff.note_successful_booking_create(receipt))
            observed.append(handoff._ORDINARY_TURN.get())

        await self.run_final(notes.default_guest_note('en', 'Camila'), before=save)
        self.assertTrue(observed[0].booking_saved)
        self.assertEqual(observed[0].booking_reference, 'WH-SAVED')
        self.assertEqual(self.posts[0]['reason'], 'handoff_notice_without_persistence')
        self.assertEqual(self.order, ['note', 'flag'])

    async def test_failed_persistence_blocks_automation_without_claiming_success(self):
        self.persist_ok = False
        await self.run_final(notes.default_guest_note('en', 'Camila'))
        self.assertEqual(self.order, ['note', 'flag'])
        self.assertTrue(handoff.is_local_automation_blocked(self.phone))

    async def test_every_standard_language_retains_its_configured_note(self):
        for language in notes.WARM_NOTES:
            with self.subTest(language=language):
                note = notes.default_guest_note(language, 'Camila')
                self.assertEqual(await self.run_final(note), note)
                self.assertEqual(self.sent[-1], note)
                self.assertEqual(self.posts[-1]['language'], language)

    async def test_no_owner_or_revoked_owner_has_no_write_authority(self):
        note = notes.default_guest_note('en', 'Camila')
        self.assertEqual(handoff.finalize_handoff_response(note), note)
        owner = []

        async def capture():
            owner.append(handoff._ORDINARY_TURN.get())

        await self.run_final('normal reply', before=capture)
        token = handoff._ORDINARY_TURN.set(owner[0])
        try:
            self.assertEqual(await asyncio.to_thread(handoff.finalize_handoff_response, note), note)
        finally:
            handoff._ORDINARY_TURN.reset(token)
        self.assertEqual(self.posts, [])
        self.assertEqual(self.sent, [])

    async def test_real_quote_owner_failure_decision_persists_even_without_wording(self):
        from wolfhouse import accepted_quote
        from unittest.mock import Mock
        agent = SimpleNamespace(_create_request_openai_client=Mock(
            side_effect=RuntimeError('offline wording unavailable')))
        result = accepted_quote._owner_failure_response(agent, 'deposit', (), {})
        self.assertTrue(result['handoff_required'])
        self.assertIsNone(result['final_response'])
        actual = await self.run_final(result)
        self.assertEqual(self.order, ['note', 'flag'])
        self.assertEqual(actual['final_response'], notes.default_guest_note('en', 'Camila'))
        self.assertEqual(self.posts[0]['reason'], 'business_tool_error: owner_handoff_required')
        self.assertEqual(actual['error'], 'owner_reply_unavailable')

    async def test_structured_final_response_preserves_booking_receipt_and_history(self):
        note = notes.WARM_NOTES['en']
        saved = {'success': True, 'write_performed': True, 'booking_code': 'WH-ALREADY-SAVED'}
        result = {'completed': True, 'final_response': note, 'booking_result': saved,
                  'messages': [{'role': 'user', 'content': 'deposit'},
                               {'role': 'assistant', 'content': note}]}
        before = deepcopy(result)
        actual = await self.run_final(result)
        expected = notes.default_guest_note('en', 'Camila')
        self.assertEqual(actual['final_response'], expected)
        self.assertEqual(actual['messages'][-1]['content'], expected)
        self.assertEqual(actual['booking_result'], saved)
        self.assertEqual(result, before, 'caller result must not be mutated')
        self.assertEqual(self.order, ['note', 'flag'])


if __name__ == '__main__':
    unittest.main()
