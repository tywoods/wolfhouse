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

    def assert_saved_at_staff_quote(self, args=None, *, staff_quote=None, previews=1):
        """Create intent saves once; diagnostics never replace Staff-owned money."""
        args = self.case['create_args'] if args is None else args
        staff_quote = self.case['quote_result'] if staff_quote is None else staff_quote
        result = self.call('create_booking_from_plan', args)
        self.assertTrue(result['success'], result)
        self.assertTrue(result['payment_link_created'], result)
        repeated = self.call('create_booking_from_plan', args)
        self.assertTrue(repeated['success'], repeated)
        self.assertTrue(repeated['idempotent'], repeated)
        self.assertFalse(repeated['write_performed'], repeated)
        self.assertEqual(repeated['booking_id'], result['booking_id'])
        creates = [body for path, body in self.calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        wire = creates[0]
        self.assertTrue(wire['always_save_accepted_booking'])
        self.assertTrue(wire['idempotency_key'])
        self.assertTrue(wire['require_offer_identity'])
        self.assertTrue(wire['booking_check_warnings'])
        for key in ('total_cents', 'deposit_required_cents', 'payment_link_amount_cents',
                    'currency', 'per_person', 'included_items'):
            expected_offer_value = staff_quote['offer_revision'].get(key, staff_quote[key])
            self.assertEqual(wire['accepted_offer'][key], expected_offer_value, key)
            self.assertEqual(wire['accepted_quote'][key], staff_quote[key], key)
        self.assertFalse(any(path == '/conversation/needs-human' for path, _ in self.calls))
        self.assertEqual(sum(path == '/booking-preview' for path, _ in self.calls), previews)
        self.assertFalse(any(path == '/availability-check' for path, _ in self.calls))
        return wire

    def test_unchecked_availability_saves_with_staff_warning(self):
        self.case = deepcopy(FIXTURES['klein'])
        self.case['quote_result']['offer_revision']['availability_checked'] = False
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.assert_saved_at_staff_quote()

    def test_missing_payer_name_saves_with_staff_warning(self):
        self.case = deepcopy(FIXTURES['klein'])
        self.case['quote_result']['offer_revision']['guest_bed_assignments'][1]['guest_name'] = ''
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.assert_saved_at_staff_quote()

    def test_later_model_create_is_acceptance_without_initial_request(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            clear_session_vars(self.tokens)
            self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='c1',
                user_id='g1', session_key='k1', session_id='no-final-ask', message_id='later')
            ledger.observe_owner_turn(self.agent, 'Please book it now.')
            ledger._transaction(lambda state, _: state.update(initial_create_request=None))
            self.assert_saved_at_staff_quote()

    def test_partial_deposit_mismatch_saves_exact_staff_money_with_warning(self):
        self.case = deepcopy(FIXTURES['brandt'])
        self.case['quote_result']['deposit_required_cents'] = 10000
        self.case['quote_result']['offer_revision']['deposit_required_cents'] = 10000
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.assert_saved_at_staff_quote()

    def test_unsupported_payment_options_default_deposit_and_save_with_flag(self):
        self.case = deepcopy(FIXTURES['klein'])
        quote_args = {**self.case['quote_args'], 'present_payment_options': ['deposit', 'full']}
        create_args = {k: v for k, v in self.case['create_args'].items() if k != 'payment_choice'}
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            quoted = self.call('quote_booking', quote_args)
            self.assertTrue(quoted['success'], quoted)
            wire = self.assert_saved_at_staff_quote(create_args)
        self.assertEqual(wire['payment_choice'], 'deposit')
        self.assertIn('quote_payment_options_unsupported', wire['booking_check_warnings'])
        self.assertEqual(wire['accepted_quote']['payment_link_amount_cents'], 40000)

    def test_ready_quote_alone_does_not_create(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            result = self.call('quote_booking', self.case['quote_args'])
            self.assertTrue(result['success'], result)
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))
        self.assertFalse(any(p.startswith('/payments/') for p, _ in self.calls))

    def test_explicit_confirm_false_does_not_write(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            result = self.call('create_booking_from_plan', {**self.case['create_args'], 'confirm': False})
        self.assertFalse(result.get('write_performed'), result)
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))
        self.assertFalse(any(p.startswith('/payments/') for p, _ in self.calls))

    def _assert_minimal_create_accepts(self, args):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.assert_saved_at_staff_quote(args)

    def test_empty_create_call_uses_owner_plan_and_expresses_acceptance(self):
        self._assert_minimal_create_accepts({})

    def test_confirm_only_create_call_uses_owner_plan(self):
        self._assert_minimal_create_accepts({'confirm': True})

    def test_create_without_confirm_expresses_acceptance(self):
        self._assert_minimal_create_accepts({k: v for k, v in FIXTURES['klein']['create_args'].items()
                                            if k != 'confirm'})

    def _assert_changed_terms_saved(self, change):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.assert_saved_at_staff_quote({**self.case['create_args'], **change})

    def test_changed_payment_choice_saves_at_staff_quote(self):
        self._assert_changed_terms_saved({'payment_choice': 'full'})

    def test_changed_dates_save_at_staff_quote(self):
        self._assert_changed_terms_saved({'check_out': '2027-09-28'})

    def test_changed_guest_names_save_at_staff_quote(self):
        self._assert_changed_terms_saved({'guests': [{'name': 'Marta Klein'}, {'name': 'Other Person'}]})

    def test_changed_beds_save_at_staff_quote(self):
        self._assert_changed_terms_saved({'selected_bed_codes': ['R1-B1', 'R1-B2']})

    def test_model_money_cannot_replace_staff_snapshots(self):
        self._assert_changed_terms_saved({'total_cents': 1, 'deposit_required_cents': 1,
            'payment_link_amount_cents': 1, 'quote_total_cents': 1,
            'accepted_quote': {'total_cents': 1}, 'accepted_offer': {'total_cents': 1}})

    def test_changed_verification_is_not_fetched_after_price_and_saves_owner_quote(self):
        self.case = deepcopy(FIXTURES['klein'])
        original = deepcopy(self.case['quote_result'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.case['quote_result']['total_cents'] += 100
            self.case['quote_result']['offer_revision']['total_cents'] += 100
            self.assert_saved_at_staff_quote(staff_quote=original)

    def test_later_staff_quote_saves_changed_offer_without_new_presentation(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.case['quote_result']['total_cents'] += 100
            self.case['quote_result']['offer_revision']['total_cents'] += 100
            self.call('quote_booking', self.case['quote_args'])
            self.assert_saved_at_staff_quote(previews=2)

    def test_missing_names_save_at_staff_quote_with_warning(self):
        self.case = deepcopy(FIXTURES['klein'])
        self.case['quote_result']['missing_fields'] = ['guests']
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.assert_saved_at_staff_quote()

    def test_staff_review_needed_saves_at_staff_quote_with_warning(self):
        self.case = deepcopy(FIXTURES['klein'])
        self.case['quote_result']['staff_review_needed'] = True
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            self.assert_saved_at_staff_quote()

    def test_accepted_create_ticket_cannot_outlive_runtime_session(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            prepared = ledger.prepare_create(self.case['create_args'])
            self.db.end_session('no-final-ask', 'reset')
            with self.assertRaises(ledger.QuoteBoundaryError):
                ledger.dispatch_create(prepared, lambda: self.fail('Expired runtime dispatched'))
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.calls))

    def test_accepted_create_ticket_cannot_cross_runtime_chat_binding(self):
        self.case = deepcopy(FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            prepared = ledger.prepare_create(self.case['create_args'])
            clear_session_vars(self.tokens)
            self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='other-chat',
                user_id='g1', session_key='k1', session_id='no-final-ask', message_id='initial')
            with self.assertRaises(ledger.QuoteBoundaryError):
                ledger.dispatch_create(prepared, lambda: self.fail('Wrong runtime scope dispatched'))
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
            self.assertEqual(sum(p == '/booking-preview' for p, _ in self.calls), 1)
            self.assertFalse(any(p == '/availability-check' for p, _ in self.calls))


if __name__ == '__main__':
    unittest.main()
