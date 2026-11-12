"""Trace-based offline adapter regressions; no model or live Staff calls."""
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from hermes_state import SessionDB
from gateway.session_context import set_session_vars, clear_session_vars
from wolfhouse import accepted_quote as ledger
import wolfhouse_staff_api as plugin

FIXTURES = json.loads((Path(__file__).parent / 'fixtures/no_final_ask_traces.json').read_text())


class NoFinalAskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.db.create_session('no-final-ask', source='whatsapp')
        self.agent = SimpleNamespace(_session_db=self.db, session_id='no-final-ask')
        self.env = patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        self.env.start()
        self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='c1',
            user_id='g1', session_key='k1', session_id='no-final-ask', message_id='initial')
        ledger.observe_owner_turn(self.agent,
            "Hi! I'm Marta Klein. I'd like to book the Malibu package for 2 people "
            "(me and Jan Klein), 7 nights, check-in 20 Sep 2027, check-out 27 Sep 2027. "
            "A shared room is fine. No shuttle, no add-ons, no discounts. "
            "We'd each like to pay just the deposit now, with separate links please.")
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        self.registry = Registry()
        plugin.register(self.registry)
        self.calls = []

    def tearDown(self):
        ledger.close_turn()
        clear_session_vars(self.tokens)
        self.env.stop()
        self.db.close()
        self.temp.cleanup()

    def call(self, name, args):
        return json.loads(self.registry.tools[name]['handler'](deepcopy(args)))

    def staff(self, path, body):
        self.calls.append((path, deepcopy(body)))
        if path == '/conversation/needs-human':
            return {'success': True, 'needs_human': True, 'handoff_id': 'offline-handoff'}
        if path == '/booking-preview':
            return deepcopy(self.case['quote_result'])
        if path == '/availability-check':
            offer = self.case['quote_result']['offer_revision']
            return {'success': True, 'has_enough_beds': True,
                'available_beds': deepcopy(offer['room_arrangement']),
                'exact_bed_eligibility': {'eligible': True,
                    'selected_bed_codes': [r['bed_code'] for r in offer['guest_bed_assignments']],
                    'guest_bed_assignments': [dict(row, guest_name=body['guests'][i]['name'])
                        for i, row in enumerate(offer['guest_bed_assignments'])]}}
        if path == '/booking-create-from-plan':
            return {'success': True, 'write_performed': True,
                    'booking_id': 'offline-booking', 'booking_code': 'OFFLINE-NO-ASK',
                    'payment_id': 'offline-payment'}
        if path.startswith('/payments/'):
            return {'success': True, 'guest_payment_url': 'https://example.invalid/pay/offline'}
        self.fail(f'Unexpected transport: {path}')

    def test_unchecked_availability_cannot_authorize_create(self):
        self.case = deepcopy(FIXTURES['klein'])
        self.case['quote_result']['offer_revision']['availability_checked'] = False
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.assertFalse(self.call('create_booking_from_plan', self.case['create_args'])['success'])
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))

    def test_missing_payer_name_cannot_authorize_create(self):
        self.case = deepcopy(FIXTURES['klein'])
        self.case['quote_result']['offer_revision']['guest_bed_assignments'][1]['guest_name'] = ''
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.assertFalse(self.call('create_booking_from_plan', self.case['create_args'])['success'])
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))

    def test_initial_request_does_not_authorize_a_later_turn(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            clear_session_vars(self.tokens)
            self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='c1',
                user_id='g1', session_key='k1', session_id='no-final-ask', message_id='later')
            ledger.observe_owner_turn(self.agent, 'Actually, wait please.')
            self.assertFalse(self.call('create_booking_from_plan', self.case['create_args'])['success'])
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))

    def test_partial_deposit_cannot_be_silently_upgraded_to_full(self):
        self.case = deepcopy(FIXTURES['brandt'])
        self.case['quote_result']['deposit_required_cents'] = 10000
        self.case['quote_result']['offer_revision']['deposit_required_cents'] = 10000
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.assertFalse(self.call('create_booking_from_plan', self.case['create_args'])['success'])
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))

    def test_ready_quote_is_not_create_consent(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            for args in ({}, {'confirm': True},
                         {**self.case['create_args'], 'confirm': False},
                         {k: v for k, v in self.case['create_args'].items() if k != 'confirm'}):
                with self.subTest(args=args):
                    result = self.call('create_booking_from_plan', args)
                    self.assertFalse(result['success'], result)
            self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))

    def test_changed_create_terms_cannot_use_initial_request(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            for change in ({'payment_choice': 'full'}, {'check_out': '2027-09-28'},
                           {'guests': [{'name': 'Marta Klein'}, {'name': 'Other Person'}]},
                           {'selected_bed_codes': ['R1-B1', 'R1-B2']}):
                result = self.call('create_booking_from_plan', {**self.case['create_args'], **change})
                self.assertFalse(result['success'], result)
            self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))

    def test_changed_revalidation_requires_new_offer_acceptance(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.case['quote_result']['total_cents'] += 100
            self.case['quote_result']['offer_revision']['total_cents'] += 100
            result = self.call('create_booking_from_plan', self.case['create_args'])
            self.assertFalse(result['success'], result)
            self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))
            self.assertIsNone(ledger._transaction(lambda s, _: s.get('initial_create_request')))

    def test_later_quote_cannot_relabel_changed_offer_as_initial(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.case['quote_result']['total_cents'] += 100
            self.case['quote_result']['offer_revision']['total_cents'] += 100
            self.call('quote_booking', self.case['quote_args'])
            result = self.call('create_booking_from_plan', self.case['create_args'])
            self.assertFalse(result['success'], result)
            self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))

    def test_missing_names_and_unchecked_availability_fail_closed(self):
        for field, value in (('missing_fields', ['guests']), ('staff_review_needed', True)):
            self.case = deepcopy(FIXTURES['klein'])
            self.case['quote_result'][field] = value
            with patch.object(plugin, '_post_bot', side_effect=self.staff):
                self.call('quote_booking', self.case['quote_args'])
                result = self.call('create_booking_from_plan', self.case['create_args'])
                self.assertFalse(result['success'], result)
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))

    def test_brandt_original_deposit_instruction_is_same_full_only_charge(self):
        self.case = deepcopy(FIXTURES['brandt'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            result = self.call('create_booking_from_plan', {
                **self.case['quote_args'], 'confirm': True})
            self.assertTrue(result['success'], result)
            wire = next(b for p, b in self.calls if p == '/booking-create-from-plan')
            self.assertEqual(wire['payment_choice'], 'full')
            self.assertEqual(wire['accepted_offer']['payment_link_amount_cents'], 18000)

    def test_brandt_full_only_deposit_alias_has_no_go_ahead(self):
        self.case = deepcopy(FIXTURES['brandt'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            quoted = self.call('quote_booking', self.case['quote_args'])
            self.assertTrue(quoted['success'], quoted)
            self.assertNotEqual((quoted.get('pending_question') or {}).get('kind'), 'go_ahead')
            state = ledger._transaction(lambda s, _: deepcopy(s))
            self.assertEqual(state['checked_offer']['payment_choice'], 'full')
            self.assertEqual(state['checked_offer']['payment_link_amount_cents'], 18000)
            self.assertIsNone(state.get('presentation'))
            created = self.call('create_booking_from_plan', self.case['create_args'])
            self.assertTrue(created['success'], created)

    def test_klein_quote_does_not_request_redundant_go_ahead(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            quoted = self.call('quote_booking', self.case['quote_args'])
            self.assertNotEqual((quoted.get('pending_question') or {}).get('kind'), 'go_ahead')
            self.assertEqual(ledger._transaction(lambda s, _: s['status']), 'offered')
            self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))

    def test_klein_same_turn_registered_create_without_delivered_presentation(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            quoted = self.call('quote_booking', self.case['quote_args'])
            self.assertTrue(quoted['success'], quoted)
            created = self.call('create_booking_from_plan', self.case['create_args'])
            self.assertTrue(created['success'], created)
            self.assertIsNone(ledger._transaction(lambda s, _: s.get('presentation')))
            self.assertIsNone(ledger._transaction(lambda s, _: s.get('accepted_presentation')))
            repeated = self.call('create_booking_from_plan', self.case['create_args'])
            self.assertTrue(repeated['success'], repeated)
            creates = [b for p, b in self.calls if p == '/booking-create-from-plan']
            self.assertEqual(len(creates), 1)
            self.assertTrue(creates[0]['idempotency_key'])
            self.assertTrue(creates[0]['require_offer_identity'])
            self.assertEqual(creates[0]['accepted_offer']['total_cents'], 59800)
            self.assertEqual(creates[0]['accepted_offer']['deposit_required_cents'], 40000)
            self.assertGreaterEqual(sum(p == '/booking-preview' for p, _ in self.calls), 2)


if __name__ == '__main__':
    unittest.main()
