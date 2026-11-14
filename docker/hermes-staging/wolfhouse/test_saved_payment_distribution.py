"""Offline adapter/registered-handler regressions; Staff transport is synthetic."""
import json
import sys

import unittest
from unittest.mock import patch
from wolfhouse import accepted_quote as owner
from wolfhouse import pending_question as pq
from wolfhouse.test_save_payment_marker import checked_response
import wolfhouse_staff_api as api


class SavedPaymentDistributionTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.guests = [{'booking_guest_id': f'g{i}', 'guest_number': i,
                        'guest_name': f'Guest {i}'} for i in (1, 2)]
        self.receipt = dict(success=True, write_performed=True, booking_id='b1',
                            booking_code='WH-OFFLINE', payment_id='p1',
                            total_cents=83000, deposit_required_cents=40000,
                            booking_guests=self.guests)
        for target, value in [('socket.socket.connect', AssertionError('NETWORK')),
                              ('urllib.request.urlopen', AssertionError('HTTP'))]:
            p = patch(target, side_effect=value); p.start(); self.addCleanup(p.stop)
        for target, value in [('_post_bot', self.transport),
                              ('_save_post_booking_email', lambda *a, **k: None),
                              ('_auto_save_pending_transfers', lambda *a, **k: []),
                              ('_trusted_client_slug', lambda: 'wolfhouse-somo')]:
            p = patch.object(api, target, side_effect=value); p.start(); self.addCleanup(p.stop)
        p = patch.object(api, 'flag_needs_human', side_effect=AssertionError('HANDOFF'))
        p.start(); self.addCleanup(p.stop)
        token = owner._current.set(None); self.addCleanup(owner._current.reset, token)
        token = owner._dispatch_ticket.set(None); self.addCleanup(owner._dispatch_ticket.reset, token)
        modules = patch.dict(sys.modules)
        modules.start(); self.addCleanup(modules.stop)
        # Remove leaked suite stubs for standalone compatibility, restoring both
        # sys.modules and the package attribute after this fixture.
        import agent
        p = patch.object(agent, 'conversation_loop', None, create=True)
        p.start(); self.addCleanup(p.stop)
        sys.modules.pop('agent.conversation_loop', None)
        # Standalone adapter compatibility requires this module to be absent.

    def transport(self, path, payload):
        self.calls.append((path, dict(payload)))
        if path == '/booking-create-from-plan':
            return dict(self.receipt)
        if path == '/payments/p1/create-stripe-link':
            return dict(success=True, booking_id='b1', booking_code='WH-OFFLINE',
                        payment_id='p1', amount_due_cents=83000 if payload.get('payment_choice') == 'full' else 40000,
                        checkout_url='https://payments.example.invalid/whole')
        for guest in self.guests:
            if path == f"/booking-guests/{guest['booking_guest_id']}/create-payment-link":
                return dict(guest, success=True, booking_id='b1', booking_code='WH-OFFLINE',
                            amount_due_cents=41500 if payload['payment_target'] == 'full_share' else 20000,
                            checkout_url='https://payments.example.invalid/' + guest['booking_guest_id'])
        raise AssertionError(('UNEXPECTED TRANSPORT', path, payload))

    def test_save_with_tier_but_unknown_distribution_inserts_without_checkout(self):
        for choice in ('deposit', 'full'):
            with self.subTest(choice=choice):
                self.calls.clear()
                result = json.loads(api._commit_and_complete_booking(dict(
                    guest_count=2, payment_choice=choice, ask_payment_amount=False)))
                self.assertEqual([p for p, _ in self.calls], ['/booking-create-from-plan'])
                self.assertTrue(result['write_performed'])
                self.assertEqual(result['next_action'], 'ask_together_or_separate')
                self.assertFalse(result['staff_review_needed'])

    def test_checked_projection_does_not_invent_distribution(self):
        for explicit in (None, False, True):
            prepared = {'guest_count': 2, 'payment_choice': 'deposit', 'ask_payment_amount': False}
            if explicit is not None:
                prepared['per_guest_payment_links'] = explicit
            checked = owner._checked_plan(prepared, checked_response(2), 'wolfhouse-somo')
            self.assertIs(checked.get('per_guest_payment_links'), explicit)

    def test_saved_renderer_and_author_facts_ask_distribution_after_tier(self):
        plan = {'guest_count': 2, 'payment_choice': 'deposit', 'ask_payment_amount': False}
        offer = checked_response(2)['offer_revision']
        text = owner._styled_booking_receipt_copy(plan, offer, self.receipt)
        self.assertIn('together', text.lower())
        self.assertIn('separate', text.lower())
        self.assertNotIn('Which would you like?', text)
        facts = owner._saved_confirmation_facts(plan, offer, self.receipt)
        self.assertTrue(facts['ask_payment_distribution'])
        self.assertNotIn('ask_payment_amount', facts)
        requirement = owner._confirmation_rewrite_payload(facts, '', [])['required_guest_facts']['payment_link_guest_copy_requirement']
        self.assertIn('together', requirement)
        self.assertIn('separate', requirement)

    def test_registered_tools_wait_then_use_subsequent_distribution_answer(self):
        from wolfhouse.question_test_support import persisted_state
        class Registry:
            def __init__(self): self.handlers = {}
            def register_tool(self, **kw): self.handlers[kw['name']] = kw['handler']
        registry = Registry()
        api.register(registry)
        initial = {'plan': {'guest_count': 2, 'payment_choice': 'deposit', 'ask_payment_amount': True},
                   'completion': dict(self.receipt)}
        with persisted_state(initial) as answer:
            answer('deposit')
            for tool, params in [('create_balance_payment_link', {'booking_code': 'WH-OFFLINE'}),
                                 ('create_payment_link', {'payment_id': 'p1'}),
                                 ('create_guest_payment_link', {'booking_guest_id': 'g1'})]:
                self.calls.clear()
                result = json.loads(registry.handlers[tool](params))
                self.assertEqual(self.calls, [])
                self.assertEqual(result['next_action'], 'ask_together_or_separate')
                state = owner._read_owner_state(lambda s, _: s.copy())
                self.assertEqual(state['outbound_question']['options'], ['together', 'separate'])
                self.assertFalse(result['staff_review_needed'])
            answer('separate', ['together', 'separate'])
            links = []
            for guest in self.guests:
                result = json.loads(registry.handlers['create_guest_payment_link'](
                    {'booking_guest_id': guest['booking_guest_id']}))
                self.assertEqual(result['amount_due_cents'], 20000)
                links.append(result['secure_payment_url'])
            self.assertEqual(len(set(links)), 2)
            self.assertEqual(len(self.calls), 2)

    def test_subsequent_together_full_and_solo(self):
        from wolfhouse.question_test_support import persisted_state
        for count in (1, 2):
            with self.subTest(count=count):
                self.calls.clear()
                state = {'plan': {'guest_count': count, 'payment_choice': 'deposit',
                                  'ask_payment_amount': True}, 'completion': dict(self.receipt)}
                with persisted_state(state) as answer:
                    answer('full')
                    result = json.loads(api.create_payment_link({'payment_id': 'p1'}))
                    if count == 2:
                        self.assertEqual(self.calls, [])
                        self.assertEqual(result['next_action'], 'ask_together_or_separate')
                        answer('together', ['together', 'separate'])
                        result = json.loads(api.create_payment_link({'payment_id': 'p1'}))
                    self.assertEqual(result['amount_due_cents'], 83000)
                    self.assertEqual(len(self.calls), 1)
                    self.assertEqual(self.calls[0][1]['payment_choice'], 'full')
                    state = owner._read_owner_state(lambda s, _: s.copy())
                    self.assertEqual(state['pending_question']['status'], 'answered')

    def test_full_separate_and_initial_balance_redirect(self):
        state = {'plan': {'guest_count': 2, 'payment_choice': 'full',
                          'per_guest_payment_links': True, 'ask_payment_amount': False},
                 'completion': dict(self.receipt), 'current_turn': {'raw': 'separate'}}
        # A legacy plan value is not consent: bind the prior explicit answer.
        from wolfhouse import pending_question as pq
        pq.open_question(state, 'payment_choice', ['deposit', 'full'], 1, 'Amount?', scope='test')
        self.assertTrue(pq.bind_answer(state, 'full', 'amount-answer', scope='test'))
        pq.open_question(state, 'payment_choice', ['together', 'separate'], 2, 'Distribution?', scope='test')
        self.assertTrue(pq.bind_answer(state, 'separate', 'distribution-answer', scope='test'))
        with patch.object(owner, '_owner_state_call', side_effect=lambda fn, **kw: fn(state, {})):
            token = owner._current.set(object())
            try:
                result = json.loads(api.create_balance_payment_link({'booking_code': 'WH-OFFLINE'}))
                self.assertEqual(result['next_action'], 'create_guest_payment_link')
                self.assertEqual(self.calls, [])
                for guest in self.guests:
                    result = json.loads(api.create_guest_payment_link({'booking_guest_id': guest['booking_guest_id']}))
                    self.assertEqual(result['amount_due_cents'], 41500)
                self.assertEqual(len(self.calls), 2)
                # Added guests are outside the original receipt and must not
                # inherit its initial-payment amount/distribution decisions.
                payload = {'booking_guest_id': 'added-guest', 'payment_target': 'deposit'}
                self.assertIsNone(api._saved_payment_gate(payload, 'create_guest_payment_link'))
                self.assertEqual(payload['payment_target'], 'deposit')
            finally:
                owner._current.reset(token)

    def test_later_balance_and_other_booking_are_not_gated(self):
        for receipt, code in ((dict(self.receipt, payment_status='partially_paid'), 'WH-OFFLINE'),
                              (dict(self.receipt), 'WH-OTHER')):
            state = {'plan': {'guest_count': 2, 'payment_choice': 'deposit'},
                     'completion': receipt, 'current_turn': {'raw': 'pay my balance'}}
            with patch.object(owner, '_owner_state_call', side_effect=lambda fn, **kw: fn(state, {})), \
                 patch.object(api, '_post_bot', return_value={'success': True,
                     'checkout_url': 'https://payments.example.invalid/balance'}) as transport:
                token = owner._current.set(object())
                try:
                    api.create_balance_payment_link({'booking_code': code})
                    transport.assert_called_once_with('/payments/create-balance-link', {'booking_code': code})
                finally:
                    owner._current.reset(token)

    def test_answered_amount_does_not_reask_from_stale_save_receipt(self):
        state = {'plan': {'guest_count': 2, 'payment_choice': 'deposit', 'ask_payment_amount': True},
                 'completion': dict(self.receipt, ask_payment_amount=True,
                                    payment_choice_pending=True, next_action='ask_deposit_or_full'),
                 'checked_offer': checked_response(2)['offer_revision'],
                 'current_turn': {'raw': 'full'}}
        from wolfhouse.question_test_support import persisted_answer
        persisted_answer(state, 'full')
        with patch.object(owner, '_owner_state_call', side_effect=lambda fn, **kw: fn(state, {})):
            token = owner._current.set(object())
            try:
                result = json.loads(api.create_payment_link({'payment_id': 'p1'}))
                self.assertEqual(result['next_action'], 'ask_together_or_separate')
                self.assertEqual(self.calls, [])
                facts = owner._saved_confirmation_facts(
                    state['completion_plan'], state['checked_offer'], state['completion'])
                self.assertNotIn('ask_payment_amount', facts)
                self.assertTrue(facts['ask_payment_distribution'])
                self.assertFalse(state['completion']['ask_payment_amount'])
                self.assertFalse(state['completion']['payment_choice_pending'])
                self.assertEqual(state['completion']['next_action'], 'ask_together_or_separate')
            finally:
                owner._current.reset(token)

    def test_finalizer_retains_distribution_pending_question(self):
        plan = {'guest_count': 2, 'payment_choice': 'full', 'ask_payment_amount': False}
        state = {'plan': plan, 'completion_plan': plan, 'completion': dict(self.receipt),
                 'checked_offer': checked_response(2)['offer_revision'],
                 'current_turn': {'raw': 'full'}}
        with patch.object(owner, '_owner_state_call', side_effect=lambda fn, **kw: fn(state, {'tenant': 'wolfhouse-somo'})):
            owner.finalize_offer_response({'completed': True, 'final_response': '', 'messages': []},
                                          saved_booking_projection=self.receipt)
        self.assertEqual(state['pending_question']['options'], ['together', 'separate'])


if __name__ == '__main__':
    unittest.main()
