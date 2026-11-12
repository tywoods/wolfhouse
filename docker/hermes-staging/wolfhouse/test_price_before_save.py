"""Offline registered-tool replays of staging chats 7a0791d3 and 28d2a9f9.

Staff responses are captured staging fixtures; repair replies are explicitly
stubbed model output. No model, Staff, booking, payment or guest transport runs.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from gateway.session_context import clear_session_vars, set_session_vars
from wolfhouse import accepted_quote as owner
from wolfhouse import test_no_final_ask as support
from wolfhouse.test_quote_delivery_support import offline_send_result
import wolfhouse_staff_api as plugin

TRACES = json.loads((Path(__file__).parent / 'fixtures/price_before_save_traces.json').read_text())


class PriceBeforeSaveTests(unittest.TestCase):
    def setUp(self):
        self.h = support.NoFinalAskTests()
        self.h.setUp()
        self.addCleanup(self.h.tearDown)
        self.transport = patch.object(plugin, '_post_bot', side_effect=self.h.staff)
        self.transport.start()
        self.addCleanup(self.transport.stop)

    def turn(self, message_id, text):
        clear_session_vars(self.h.tokens)
        self.h.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='c1',
            user_id='g1', session_key='k1', session_id='no-final-ask', message_id=message_id)
        owner.observe_owner_turn(self.h.agent, text)

    def quote(self, name='hartmann'):
        self.h.case = deepcopy(TRACES[name])
        self.turn('extras-plus-names', self.h.case['guest_message'])
        result = self.h.call('quote_booking', self.h.case['quote_args'])
        self.assertTrue(result['success'], result)
        self.assertEqual(result['pending_question']['kind'], 'add_on')
        return result

    def result(self, text):
        return {'completed': True, 'final_response': text,
                'messages': [{'role': 'user', 'content': self.h.case['guest_message']},
                             {'role': 'assistant', 'content': text}]}

    def priced_reply(self):
        if self.h.case['quote_result']['deposit_required_cents'] == 40000:
            return ('Malibu, shared room, 7 nights for two: €498. Hard boards: €280; '
                    'wetsuits free. Total €778; deposit €400, remaining €378 at arrival. '
                    'Would you need the shuttle?')
        return ('Malibu, shared room, 4 nights for two: €320. Soft boards: €120; '
                'wetsuits free. Total €440; deposit €200, remaining €240 at arrival. '
                'Would you need the shuttle?')

    def select_payment_and_create(self):
        # The same Staff fixture is refreshed with the now-resolved guest choice,
        # exactly as the real registered create performs its authoritative read.
        quote = self.h.case['quote_result']
        quote.update(payment_choice_needed=False, payment_choice='deposit',
                     per_guest_payment_links=True, payment_link_distribution='separate')
        quote['offer_revision'].update(payment_choice='deposit', per_guest_payment_links=True)
        self.turn('shuttle-no', 'No shuttle, thanks.')
        self.turn('pay-deposit', 'Separate deposit links, please.')
        return self.h.call('create_booking_from_plan', self.h.case['create_args'])

    def assert_no_create(self):
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.h.calls))

    def replay_repair(self, name):
        self.quote(name)
        repair = Mock(return_value=self.priced_reply())
        output = owner.finalize_offer_response(self.result(self.h.case['unpriced_draft']),
                                               quote_rewrite_callback=repair)
        repair.assert_called_once()
        self.assertEqual(output['final_response'], self.priced_reply())
        self.assertEqual(output['final_response'].count('?'), 1)
        self.assertNotIn('shall I book', output['final_response'].lower())
        self.assertEqual(owner._transaction(lambda s, _: s['pending_question']['kind']), 'add_on')
        self.assert_no_create()
        offline_send_result(output)
        created = self.select_payment_and_create()
        self.assertTrue(created['success'], created)
        self.assertEqual(sum(p == '/booking-create-from-plan' for p, _ in self.h.calls), 1)

    def test_hartmann_extras_and_names_same_message_get_price_before_save(self):
        self.replay_repair('hartmann')

    def test_berg_total_without_deposit_is_repaired_before_save(self):
        self.replay_repair('berg')

    def test_failed_price_repair_never_becomes_presentation_or_booking(self):
        self.quote()
        repair = Mock(return_value='Would you need the shuttle?')
        output = owner.finalize_offer_response(self.result(self.h.case['unpriced_draft']),
                                               quote_rewrite_callback=repair)
        self.assertTrue(output.get('failed'), output)
        self.assertIsNone(output.get('final_response'))
        self.assertIsNone(owner._transaction(lambda s, _: s.get('presentation')))
        self.assertFalse(self.select_payment_and_create()['success'])
        self.assert_no_create()

    def test_complete_first_quote_needs_no_repair_or_save_question(self):
        self.quote()
        repair = Mock(side_effect=AssertionError('Complete quote must not be rewritten'))
        output = owner.finalize_offer_response(self.result(self.priced_reply()),
                                               quote_rewrite_callback=repair)
        self.assertEqual(output['final_response'], self.priced_reply())
        offline_send_result(output)
        self.assertTrue(self.select_payment_and_create()['success'])

    def test_unchanged_priced_offer_allows_brief_shuttle_followup(self):
        self.quote()
        offline_send_result(owner.finalize_offer_response(self.result(self.priced_reply())))
        self.turn('followup', 'Is the shuttle optional?')
        self.h.call('quote_booking', self.h.case['quote_args'])
        text = 'Yes, it is optional. Would you like it?'
        repair = Mock(side_effect=AssertionError('Do not replay an unchanged price'))
        output = owner.finalize_offer_response(self.result(text), quote_rewrite_callback=repair)
        self.assertEqual(output['final_response'], text)
        self.assertTrue(self.select_payment_and_create()['success'])

    def test_changed_quote_requires_new_total_and_deposit(self):
        self.quote()
        offline_send_result(owner.finalize_offer_response(self.result(self.priced_reply())))
        self.turn('changed-price', 'Could you check the current quote?')
        self.h.case['quote_result']['total_cents'] = 78800
        self.h.case['quote_result']['offer_revision']['total_cents'] = 78800
        self.h.call('quote_booking', self.h.case['quote_args'])
        repair = Mock(return_value=self.priced_reply().replace('€778', '€788').replace('€378', '€388'))
        output = owner.finalize_offer_response(self.result('Would you need the shuttle?'),
                                               quote_rewrite_callback=repair)
        repair.assert_called_once()
        self.assertIn('€788', output['final_response'])

    def test_legacy_unpriced_presentation_cannot_authorize_new_create(self):
        self.quote()
        offline_send_result(owner.finalize_offer_response(self.result(self.priced_reply())))
        def legacy(state, _):
            p = state['presentation']
            p['displayed_text'] = self.h.case['unpriced_draft']
            p['displayed_text_digest'] = hashlib.sha256(p['displayed_text'].encode()).hexdigest()
        owner._transaction(legacy)
        self.assertFalse(self.select_payment_and_create()['success'])
        self.assert_no_create()

    def test_all_details_upfront_still_cannot_save_without_price(self):
        self.h.case = deepcopy(support.FIXTURES['klein'])
        quoted = self.h.call('quote_booking', self.h.case['quote_args'])
        self.assertTrue(quoted['success'], quoted)
        self.assertFalse(self.h.call('create_booking_from_plan', self.h.case['create_args'])['success'])
        self.assert_no_create()


if __name__ == '__main__':
    unittest.main()
