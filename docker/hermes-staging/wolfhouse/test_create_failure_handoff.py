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

    def test_two_recoverable_refusals_send_default_note_before_flag(self):
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
            first = json.loads(await asyncio.to_thread(plugin.create_booking_from_plan, {}))
            self.assertFalse(first['success'])
            self.assertEqual(timeline, [])
            second = json.loads(await asyncio.to_thread(plugin.create_booking_from_plan, {}))
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


    def test_equivalent_requote_preserves_budget_and_success_resets(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            first = ledger.record_create_attempt({'success': False, 'do_not_retry_create': True})
            self.assertEqual(first['failures'], 1)
            self.assertFalse(first['handoff_required'])
            self.call('quote_booking', self.case['quote_args'])
            second = ledger.record_create_attempt({'success': False})
            self.assertEqual(second['failures'], 2)

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

    def test_transport_exceptions_count_toward_same_budget(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        def transport(path, body):
            if path == '/booking-create-from-plan':
                raise RuntimeError('offline transport failure')
            return self.staff(path, body)
        with patch.object(plugin, '_post_bot', side_effect=transport), \
             patch.object(plugin, 'flag_needs_human', return_value=json.dumps({
                 'success': True, 'handoff_persisted': True})) as flag:
            self.call('quote_booking', self.case['quote_args'])
            with self.assertRaises(RuntimeError):
                self.call('create_booking_from_plan', self.case['create_args'])
            flag.assert_not_called()
            result = self.call('create_booking_from_plan', self.case['create_args'])
            self.assertTrue(result['handoff']['handoff_persisted'])
            flag.assert_called_once()

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
