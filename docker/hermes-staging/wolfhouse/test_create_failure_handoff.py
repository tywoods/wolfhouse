"""Offline create-attempt budget regressions; real owner DB and handoff adapter."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch

import unittest
from copy import deepcopy
from wolfhouse import test_no_final_ask as fixture
from wolfhouse import accepted_quote as ledger
import wolfhouse_staff_api as plugin


class CreateFailureHandoffTests(unittest.TestCase):
    setUp = fixture.NoFinalAskTests.setUp
    tearDown = fixture.NoFinalAskTests.tearDown
    call = fixture.NoFinalAskTests.call
    staff = fixture.NoFinalAskTests.staff

    def test_two_preaccept_refusals_keep_default_note_before_flag(self):
        from wolfhouse import explicit_human_handoff as handoff
        from wolfhouse_staff_api import handoff_guest_note
        timeline = []
        phone = '+34900000981'
        event = SimpleNamespace(source=SimpleNamespace(chat_id=phone), text='Please book it')

        class Adapter:
            async def send(self, chat_id, content, **kwargs):
                self_test.assertEqual(content, handoff_guest_note.WARM_NOTES['de'])
                timeline.append('note')
                return SimpleNamespace(success=True, message_id='offline-note', raw_response={})

        self_test = self
        def persist(path, payload):
            self.assertEqual(path, '/conversation/needs-human')
            self.assertEqual(payload['reason'], 'booking_create_failure_limit')
            timeline.append('flag')
            return {'success': True, 'needs_human': True,
                    'staff_handoff': {'id': 'offline-budget'}}

        ledger._transaction(lambda state, _: state.update(guest_language='de', plan={
            'check_in': '2027-09-20', 'check_out': '2027-09-27', 'guest_count': 2}))
        async def dispatch(_event):
            first = json.loads(await asyncio.to_thread(plugin.create_booking_from_plan, {'confirm': False}))
            self.assertFalse(first['success'])
            self.assertEqual(timeline, [])
            second = json.loads(await asyncio.to_thread(plugin.create_booking_from_plan, {'confirm': False}))
            self.assertFalse(second['success'])
            self.assertTrue(second['handoff']['handoff_persisted'])
            self.assertFalse(second['do_not_escalate'])
            self.assertEqual(second['next_action'], 'staff_handoff')

        async def run():
            await handoff.dispatch_with_handoff_notice(event, SimpleNamespace(
                adapter=Adapter(), dispatch_fn=dispatch))

        with patch.dict('os.environ', {'HERMES_ROLE': 'luna', 'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid'}), \
             patch.object(plugin, '_post_bot', side_effect=persist), \
             patch.object(handoff_guest_note, 'default_fetch_staff_info', return_value={}), \
             patch('wolfhouse.luna_intelligence.public_research_failed_this_turn', return_value=True):
            asyncio.run(run())
        self.assertEqual(timeline, ['note', 'flag'])


    def test_after_save_business_diagnostics_do_not_send_or_flag(self):
        for reason in ('business_tool_error: private room mismatch',
                       'business_tool_error: bed_already_taken',
                       'booking_create_failure_limit', 'misc_booking_check',
                       'unknown', 'post_save_room_check'):
            with self.subTest(reason=reason):
                self._assert_postsave_handoff(True, reason=reason, suppressed=True)

    def test_after_save_explicit_human_and_safety_still_handoff(self):
        for reason in ('human_requested', 'urgent_safety'):
            with self.subTest(reason=reason):
                self._assert_postsave_handoff(True, reason=reason)

    def test_after_save_payment_report_is_not_a_room_diagnostic(self):
        for reason in ('business_tool_error: payment_reported_unresolved',
                       'payment_state_mismatch', 'complaint: paid but got nothing'):
            with self.subTest(reason=reason):
                self._assert_postsave_handoff(True, reason=reason, message='I paid but got nothing')

    def test_failed_warm_note_does_not_silently_flag_needs_human(self):
        self._assert_postsave_handoff(False, reason='human_requested')

    def _assert_postsave_handoff(self, deliver, *, reason, suppressed=False, message='Sí, gracias'):
        from wolfhouse import explicit_human_handoff as handoff
        from wolfhouse_staff_api import handoff_guest_note
        self.case = deepcopy(fixture.FIXTURES['klein'])
        timeline = []
        phone = '+34900000981'
        event = SimpleNamespace(source=SimpleNamespace(chat_id=phone), text=message)
        test = self
        class Adapter:
            async def send(self, chat_id, content, **kwargs):
                test.assertEqual(content, handoff_guest_note.default_guest_note('es', 'Ale'))
                timeline.append('note')
                return SimpleNamespace(success=deliver, message_id='offline-note' if deliver else None, raw_response={})
        def transport(path, payload):
            if path == '/conversation/needs-human':
                timeline.append('flag')
                return {'success': True, 'needs_human': True,
                        'staff_handoff': {'id': 'offline-after-save'}}
            return self.staff(path, payload)
        async def dispatch(_event):
            before = ledger.current_create_receipt()
            prior_calls = len(self.calls)
            result = json.loads(await asyncio.to_thread(plugin.flag_needs_human, {'reason': reason}))
            self.assertEqual(ledger.current_create_receipt(), before)
            self.assertEqual(len(self.calls), prior_calls, 'no create/payment resend on handoff')
            if deliver and not suppressed:
                self.assertTrue(handoff.suppress_ordinary_handoff_reply(phone))
            self.assertEqual(result['handoff_persisted'], deliver and not suppressed, result)
            self.assertEqual(result.get('ack_sent', False), deliver and not suppressed, result)
            if suppressed:
                self.assertFalse(result['needs_human'], result)
                self.assertTrue(result['do_not_escalate'], result)
                self.assertTrue(before['payment_link_created'], before)
                self.assertEqual(ledger.current_create_receipt(), before)
        async def run():
            await handoff.dispatch_with_handoff_notice(event, SimpleNamespace(
                adapter=Adapter(), dispatch_fn=dispatch))
        with patch.dict('os.environ', {'HERMES_ROLE': 'luna', 'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid'}), \
             patch.object(plugin, '_post_bot', side_effect=transport), \
             patch.object(handoff_guest_note, 'default_fetch_staff_info', return_value={'staff_member_name': 'Ale'}):
            self.call('quote_booking', self.case['quote_args'])
            self.assertTrue(self.call('create_booking_from_plan', self.case['create_args'])['success'])
            ledger._transaction(lambda state, _: state.update(guest_language='es'))
            asyncio.run(run())
        self.assertEqual(timeline, [] if suppressed else (['note', 'flag'] if deliver else ['note']))

    def test_owner_save_proof_is_thread_and_tenant_scoped(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        self.assertIsNone(plugin._successful_owner_booking_receipt())
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.call('create_booking_from_plan', self.case['create_args'])
        receipt = plugin._successful_owner_booking_receipt()
        self.assertTrue(receipt['success'])
        self.assertEqual(asyncio.run(asyncio.to_thread(plugin._successful_owner_booking_receipt)), receipt)
        with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'other-tenant'}):
            self.assertIsNone(plugin._successful_owner_booking_receipt())
        from gateway.session_context import set_session_vars, clear_session_vars
        tokens = set_session_vars(chat_id='other-chat', session_key='other-thread')
        try:
            self.assertIsNone(plugin._successful_owner_booking_receipt())
        finally:
            clear_session_vars(tokens)
        ledger.close_turn()
        self.assertIsNone(plugin._successful_owner_booking_receipt())

    def test_model_occupied_bed_reason_is_not_staff_evidence(self):
        with patch.object(plugin, '_post_bot') as transport, \
             patch('wolfhouse_staff_api.handoff_guest_note.send_before_handoff') as note:
            result = json.loads(plugin.flag_needs_human({
                'reason': 'business_tool_error: bed_already_taken',
                '_staff_booking_conflict': {'success': False, 'bed_already_taken': True}}))
        self.assertEqual(result['blocked_reasons'], ['staff_booking_conflict_required'])
        note.assert_not_called()
        transport.assert_not_called()

    def test_http_occupied_bed_warm_handoff(self):
        self._assert_http_conflict_handoff(True)

    def test_http_occupied_bed_failed_note_does_not_flag(self):
        self._assert_http_conflict_handoff(False)

    def _assert_http_conflict_handoff(self, deliver):
        import io
        from email.message import Message
        from wolfhouse import explicit_human_handoff as handoff
        from wolfhouse_staff_api import handoff_guest_note
        self.case = deepcopy(fixture.FIXTURES['klein'])
        timeline = []
        test = self
        class Adapter:
            async def send(self, chat_id, content, **kwargs):
                test.assertEqual(content, handoff_guest_note.WARM_NOTES['de'])
                timeline.append('note')
                return SimpleNamespace(success=deliver, message_id='note' if deliver else None, raw_response={})
        def urlopen(request, **kwargs):
            path = plugin.urllib.parse.urlsplit(request.full_url).path.removeprefix('/staff/bot')
            body = json.loads(request.data)
            if path == '/booking-create-from-plan':
                raise plugin.urllib.error.HTTPError(request.full_url, 409, 'Conflict', Message(),
                    io.BytesIO(json.dumps({'success': False, 'reason_code': 'availability_changed',
                                          'conflict_beds': ['R1-B1'], '_blocked': True}).encode()))
            if path == '/conversation/needs-human':
                timeline.append('flag')
                response = {'success': True, 'needs_human': True, 'staff_handoff': {'id': 'occupied'}}
            else:
                response = self.staff(path, body)
            return io.BytesIO(json.dumps(response).encode())
        async def dispatch(_):
            result = json.loads(await asyncio.to_thread(plugin.create_booking_from_plan, self.case['create_args']))
            self.assertFalse(result['success'])
            self.assertEqual(result['error'], 'bed_already_taken')
            self.assertEqual(result['handoff']['handoff_persisted'], deliver)
        async def run():
            await handoff.dispatch_with_handoff_notice(
                SimpleNamespace(source=SimpleNamespace(chat_id='+349****0981'), text='Please book it'),
                SimpleNamespace(adapter=Adapter(), dispatch_fn=dispatch))
        with patch.dict('os.environ', {'HERMES_ROLE': 'luna', 'LUNA_BOT_INTERNAL_TOKEN': 'offline',
                  'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid'}), \
             patch.object(plugin.urllib.request, 'urlopen', side_effect=urlopen), \
             patch.object(handoff_guest_note, 'default_fetch_staff_info', return_value={}):
            self.call('quote_booking', self.case['quote_args'])
            ledger._transaction(lambda state, _: state.update(guest_language='de'))
            asyncio.run(run())
        self.assertEqual(timeline, ['note', 'flag'] if deliver else ['note'])

    def test_handoff_without_send_context_does_not_silently_flag(self):
        from wolfhouse_staff_api import handoff_guest_note
        with patch.object(plugin, '_post_bot', side_effect=self.staff), \
             patch.object(handoff_guest_note, 'default_fetch_staff_info', return_value={}):
            result = json.loads(plugin.flag_needs_human({
                'reason': 'business_tool_error: private room mismatch', 'phone': '+34900000981'}))
        self.assertFalse(result['needs_human'], result)
        self.assertFalse(result['handoff_persisted'], result)
        self.assertFalse(self.calls)

    def test_equivalent_requote_preserves_preaccept_budget(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            first = ledger.record_create_attempt({'success': False, 'do_not_retry_create': True})
            self.assertEqual(first['failures'], 1)
            self.assertFalse(first['handoff_required'])
            self.call('quote_booking', self.case['quote_args'])
            second = ledger.record_create_attempt({'success': False})
            self.assertEqual(second['failures'], 2)
            self.assertTrue(second['handoff_required'])

    def test_successful_registered_create_resets_budget(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            ledger.record_create_attempt({'success': False})
            created = self.call('create_booking_from_plan', self.case['create_args'])
            self.assertTrue(created['success'], created)
            self.assertEqual(ledger.record_create_attempt({'success': False})['failures'], 1)

    def test_new_dates_or_party_reset_budget(self):
        for field, value in [('check_in', '2027-09-21'), ('guest_count', 3)]:
            with self.subTest(field=field):
                ledger._transaction(lambda state, _: state.update(plan={
                    'check_in': '2027-09-20', 'check_out': '2027-09-27', 'guest_count': 2},
                    create_attempt_budget={}))
                self.assertEqual(ledger.record_create_attempt({'success': False})['failures'], 1)
                ledger._transaction(lambda state, _: state['plan'].update({field: value}))
                self.assertIsNone(ledger._transaction(lambda state, _: state.get('create_attempt_budget')))
                fresh = ledger.record_create_attempt({'success': False})
                self.assertEqual(fresh['failures'], 1)
                self.assertFalse(fresh['handoff_required'])

    def test_accepted_transport_failures_are_diagnostic_not_terminal(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        attempts = []
        def transport(path, body):
            if path == '/booking-create-from-plan':
                attempts.append(deepcopy(body))
                if len(attempts) <= 2:
                    raise RuntimeError('offline transport failure')
            return self.staff(path, body)
        with patch.object(plugin, '_post_bot', side_effect=transport), \
             patch.object(plugin, 'flag_needs_human', return_value=json.dumps({
                 'success': True, 'handoff_persisted': True})) as flag:
            self.call('quote_booking', self.case['quote_args'])
            for expected_failures in (1, 2):
                with self.assertRaisesRegex(RuntimeError, 'offline transport failure'):
                    self.call('create_booking_from_plan', self.case['create_args'])
                flag.assert_not_called()
                self.assertEqual(ledger._transaction(
                    lambda state, _: state['create_attempt_budget']['failures']), expected_failures)
            outcome = ledger.record_create_attempt({'success': False})
            self.assertEqual(outcome['failures'], 2)
            self.assertFalse(outcome['handoff_required'])
            result = self.call('create_booking_from_plan', self.case['create_args'])
            self.assertTrue(result['success'], result)
            self.assertTrue(result['payment_link_created'], result)
            self.assertNotIn('handoff', result)
            flag.assert_not_called()
            self.assertIn('booking_create_failure_limit', attempts[-1]['booking_check_warnings'])
            self.assertEqual(len({body['idempotency_key'] for body in attempts}), 1)
            for body in attempts:
                self.assertTrue(body['always_save_accepted_booking'])
                self.assertEqual(body['accepted_offer']['total_cents'], 59800)
                self.assertEqual(body['accepted_quote']['deposit_required_cents'], 40000)
            self.assertEqual(ledger._transaction(
                lambda state, _: state['create_attempt_budget']['failures']), 0)
            replay = self.call('create_booking_from_plan', self.case['create_args'])
            self.assertTrue(replay['idempotent'], replay)
            self.assertEqual(len(attempts), 3)

    def test_recoverable_markers_do_not_imply_terminal(self):
        for error in ('quote_owner_presented_offer_required', 'missing_guest_names',
                      'accepted_bed_selection_revalidation_required'):
            with self.subTest(error=error):
                ledger.record_create_attempt({'success': True})
                outcome = ledger.record_create_attempt({
                    'success': False, 'error': error, 'do_not_retry_create': True})
                self.assertFalse(outcome['handoff_required'])


if __name__ == '__main__':
    unittest.main()
