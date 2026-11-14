"""R3 registered-handler evidence with real SQLite restart and offline transport.

Run from repository root with PYTHONPATH=docker/hermes-staging:docker/hermes-staging/plugins:/opt/hermes
/opt/hermes/.venv/bin/python -m unittest wolfhouse.test_bc_p1_fix_r3_owner -v
BC_P1_OWNER_BASE selects a base-owner comparison via the R2 fixture.
The semantic producer/schema is deliberately outside this owner-only test.
"""
from copy import deepcopy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from hermes_state import SessionDB
from wolfhouse import accepted_quote as owner
from wolfhouse import test_bc_p1_fix_r2_payment_amendment as support
import wolfhouse_staff_api as api


class RestartedPaymentHandlerTests(unittest.TestCase):
    # Reuse the real ingress/SessionDB fixture without inheriting its test cases.
    setUp = support.SavedPaymentAmendmentTests.setUp
    close_turn = support.SavedPaymentAmendmentTests.close_turn
    turn = support.SavedPaymentAmendmentTests.turn
    state = support.SavedPaymentAmendmentTests.state
    seed = support.SavedPaymentAmendmentTests.seed
    request = support.SavedPaymentAmendmentTests.request

    def handler(self, guest):
        class Registry:
            def __init__(self): self.handlers = {}
            def register_tool(self, **kw): self.handlers[kw['name']] = kw['handler']
        registry = Registry()
        api.register(registry)
        return registry.handlers['create_guest_payment_link' if guest else 'create_payment_link']

    def params(self, guest, choice=None):
        result = ({'booking_guest_id': 'guest-one'} if guest
                  else {'payment_id': 'payment-one'})
        if choice is not None:
            result['payment_target' if guest else 'payment_choice'] = (
                'full_share' if guest and choice == 'full' else choice)
        return result

    def transport(self, path, payload):
        self.calls.append((path, deepcopy(payload)))
        expected = ('/booking-guests/guest-one/create-payment-link' if self.guest
                    else '/payments/payment-one/create-stripe-link')
        self.assertEqual(path, expected)  # No save, lookup, or other business call.
        return dict(self.receipt, checkout_url='https://payments.example.invalid/r3',
                    booking_guest_id='guest-one', payment_target=payload.get('payment_target'),
                    amount_due_cents=50000 if payload.get('payment_choice') == 'full'
                    or payload.get('payment_target') == 'full_share' else 10000)

    def setup_handler(self, guest):
        self.guest = guest
        self.calls = []
        self.receipt['booking_guests'] = [{'booking_guest_id': 'guest-one'}]
        p = patch.object(api, '_post_bot', side_effect=self.transport)
        p.start(); self.addCleanup(p.stop)
        p = patch.object(api, '_trusted_client_slug', return_value='wolfhouse-somo')
        p.start(); self.addCleanup(p.stop)
        p = patch.object(api, 'flag_needs_human', side_effect=AssertionError('no handoff'))
        p.start(); self.addCleanup(p.stop)
        return self.handler(guest)

    def reopen(self):
        self.close_turn()
        self.db.close()
        self.db = SessionDB(Path(self.tmp.name) / 'state.db')
        self.agent._session_db = self.db
        self.turn('after-restart', 'Send the payment link please')

    def assert_tier(self, choice):
        field = 'payment_target' if self.guest else 'payment_choice'
        expected = 'full_share' if self.guest and choice == 'full' else choice
        self.assertEqual(self.calls[-1][1][field], expected)
        self.assertEqual(self.state()['bound_question_fields']['payment_choice'], choice)
        self.assertEqual(self.state()['completion_plan']['payment_choice'], choice)
        self.assertEqual(self.state()['receipt']['booking_id'], 'booking-one')
        self.assertTrue(self.state()['receipt']['success'])

    def direction(self, guest, old, new):
        handler = self.setup_handler(guest)
        self.seed(old)
        history = deepcopy(self.state()['pending_question'])
        params = self.params(guest, new)
        params['payment_choice_amendment'] = self.request(old, new)['payment_choice_amendment']
        original = deepcopy(params)
        self.assertTrue(json.loads(handler(params))['success'])
        self.assertEqual(params, original)
        self.assert_tier(new)
        self.assertEqual(self.state()['pending_question'], history)
        self.reopen()
        # Optional tier and amendment both omitted: persisted authority must win.
        self.assertTrue(json.loads(handler(self.params(guest)))['success'])
        self.assert_tier(new)
        self.assertEqual(len(self.calls), 2)
        # A stale model/default tier still cannot silently reverse guest consent.
        self.assertTrue(json.loads(handler(self.params(guest, old)))['success'])
        self.assert_tier(new)
        self.assertEqual(len(self.calls), 3)

    def test_whole_deposit_to_full_reopen_omitted(self):
        self.direction(False, 'deposit', 'full')

    def test_whole_full_to_deposit_reopen_omitted(self):
        self.direction(False, 'full', 'deposit')

    def test_guest_deposit_to_full_share_reopen_omitted(self):
        self.direction(True, 'deposit', 'full')

    def test_guest_full_share_to_deposit_reopen_omitted(self):
        self.direction(True, 'full', 'deposit')

    def defaults(self, guest):
        handler = self.setup_handler(guest)
        self.seed('deposit')
        self.assertTrue(json.loads(handler(self.params(guest, 'full')))['success'])
        self.assert_tier('deposit')
        self.reopen()
        self.assertTrue(json.loads(handler(self.params(guest)))['success'])
        self.assert_tier('deposit')

    def test_whole_arbitrary_default_does_not_amend(self):
        self.defaults(False)

    def test_guest_full_share_without_amendment_does_not_amend(self):
        self.defaults(True)

    def no_consent(self, guest):
        handler = self.setup_handler(guest)
        owner._transaction(lambda state, ingress: state.update(
            receipt=deepcopy(self.receipt), plan={'guest_count': 1,
                'payment_choice': 'full', 'ask_payment_amount': False}))
        self.reopen()
        result = json.loads(handler(self.params(guest, 'full')))
        self.assertEqual(result['next_action'], 'ask_deposit_or_full')
        self.assertEqual(self.calls, [])
        self.assertEqual(self.state()['receipt']['booking_id'], 'booking-one')
        self.assertTrue(self.state()['receipt']['success'])

    def test_whole_unconsented_default_withholds_payment_only(self):
        self.no_consent(False)

    def test_guest_unconsented_default_withholds_payment_only(self):
        self.no_consent(True)


if __name__ == '__main__':
    unittest.main()
