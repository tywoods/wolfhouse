"""BC-P1-FIX-R2: saved-payment owner admission, not autonomous/live checkout.

Run with PYTHONPATH=docker/hermes-staging:/opt/hermes /opt/hermes/.venv/bin/python -m unittest
wolfhouse.test_bc_p1_fix_r2_payment_amendment -v.  For exact base-owner RED,
set BC_P1_OWNER_BASE=bd48250a3ce111a744fec28c5c939a451e3b5cac.
Only SessionDB is used; socket access is forbidden.
"""
import linecache
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from copy import deepcopy
from unittest.mock import patch

from hermes_state import SessionDB
from gateway.session_context import set_session_vars, clear_session_vars
from wolfhouse import accepted_quote as owner, pending_question as pq

if os.environ.get('BC_P1_OWNER_BASE'):
    filename = owner.__file__
    source = subprocess.check_output([
        'git', 'show', os.environ['BC_P1_OWNER_BASE'] +
        ':docker/hermes-staging/wolfhouse/accepted_quote.py'], text=True)
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
    exec(compile(source, filename, 'exec'), owner.__dict__)


class SavedPaymentAmendmentTests(unittest.TestCase):
    def setUp(self):
        self.network = patch('socket.socket.connect', side_effect=AssertionError('offline only'))
        self.network.start()
        self.addCleanup(self.network.stop)
        self.env = patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = SessionDB(Path(self.tmp.name) / 'state.db')
        self.addCleanup(lambda: self.db.close())
        self.db.create_session('r2-owner', source='whatsapp')
        self.agent = SimpleNamespace(_session_db=self.db, session_id='r2-owner')
        self.tokens = None
        self.addCleanup(self.close_turn)
        self.turn('initial', 'Please save my booking')
        self.receipt = {'success': True, 'booking_id': 'booking-one',
                        'booking_code': 'WH-ONE', 'payment_id': 'payment-one',
                        'total_cents': 50000, 'deposit_required_cents': 10000}

    def close_turn(self):
        owner.close_turn()
        if self.tokens:
            clear_session_vars(self.tokens)
            self.tokens = None

    def turn(self, message, raw):
        self.close_turn()
        self.tokens = set_session_vars(platform='whatsapp', source='whatsapp',
            chat_id='r2-chat', user_id='r2-guest', session_key='r2-key',
            session_id='r2-owner', message_id=message)
        owner.observe_owner_turn(self.agent, raw)

    def state(self):
        return owner._transaction(lambda state, ingress: deepcopy(state))

    def seed(self, choice, *, group=False):
        def seed(state, ingress):
            state['receipt'] = deepcopy(self.receipt)
            state['plan'] = {'guest_count': 2 if group else 1,
                             'payment_choice': 'deposit'}
            pq.open_question(state, 'payment_choice', ['deposit', 'full'], 1,
                             'Deposit or full?', scope=owner._encode(state['scope']))
        owner._transaction(seed)
        self.turn('original-choice', choice)
        self.assertEqual(self.state()['bound_question_fields']['payment_choice'], choice)
        self.turn('amendment', 'Please change my payment tier')

    def request(self, old, new):
        return {'booking_id': 'booking-one', 'payment_choice': new,
                'payment_choice_amendment': {
                    'booking_id': 'booking-one', 'inbound_message_id': 'amendment',
                    'previous_choice': old, 'payment_choice': new,
                    'guest_confirmed': True}}

    def check_direction(self, old, new):
        self.seed(old)
        request = self.request(old, new)
        original = deepcopy(request)
        result = owner.prepare_saved_payment(request)
        self.assertEqual(result['plan']['payment_choice'], new)
        self.assertFalse(result['plan']['ask_payment_amount'])
        self.assertIsNone(result['question'])
        self.assertEqual(request, original)
        self.assertEqual(self.state()['bound_question_fields']['payment_choice'], new)
        self.assertEqual(self.state()['receipt']['booking_id'], 'booking-one')
        self.assertNotIn('secure_payment_url', self.state()['receipt'])
        # Exact same operation is idempotent; stale original bound answer cannot win.
        self.assertEqual(owner.prepare_saved_payment(request)['plan']['payment_choice'], new)
        self.db.close()
        self.db = SessionDB(Path(self.tmp.name) / 'state.db')
        self.agent._session_db = self.db
        self.turn('later', 'Send the link please')
        result = owner.prepare_saved_payment({'booking_id': 'booking-one', 'payment_choice': old})
        self.assertEqual(result['plan']['payment_choice'], new)
        self.assertIsNone(result['question'])

    def test_deposit_to_full(self):
        self.check_direction('deposit', 'full')

    def test_full_to_deposit(self):
        self.check_direction('full', 'deposit')

    def test_arbitrary_model_choice_never_amends(self):
        self.seed('deposit')
        result = owner.prepare_saved_payment({'booking_id': 'booking-one', 'payment_choice': 'full'})
        self.assertEqual(result['plan']['payment_choice'], 'deposit')

    def test_default_without_bound_consent_withholds_only_payment(self):
        owner._transaction(lambda state, ingress: state.update(
            receipt=deepcopy(self.receipt), plan={'guest_count': 1, 'payment_choice': 'full',
                                                'ask_payment_amount': False}))
        result = owner.prepare_saved_payment({'booking_id': 'booking-one', 'payment_choice': 'full'})
        self.assertEqual(result['question']['options'], ['deposit', 'full'])
        self.assertTrue(result['receipt']['success'])
        self.assertEqual(result['receipt']['booking_id'], 'booking-one')

    def test_wrong_checkout_booking_does_not_mutate(self):
        self.seed('deposit')
        before = self.state()
        request = self.request('deposit', 'full')
        request['booking_id'] = 'booking-other'
        self.assertIsNone(owner.prepare_saved_payment(request))
        self.assertEqual(self.state(), before)

    def test_invalid_semantic_consent_never_rebinds(self):
        self.seed('deposit')
        for changes in ({'booking_id': 'booking-other'}, {'booking_id': ''},
                        {'guest_confirmed': False}, {'guest_confirmed': 'true'},
                        {'inbound_message_id': 'old-turn'}, {'previous_choice': 'full'},
                        {'payment_choice': 'pay_on_arrival'}):
            with self.subTest(changes=changes):
                before = self.state()
                request = self.request('deposit', 'full')
                request['payment_choice_amendment'].update(changes)
                with self.assertRaises(pq.PaymentAdmissionError):
                    owner.prepare_saved_payment(request)
                self.assertEqual(self.state(), before)

    def test_amendment_cannot_promote_unconsented_default(self):
        owner._transaction(lambda state, ingress: state.update(
            receipt=deepcopy(self.receipt), plan={'guest_count': 1, 'payment_choice': 'deposit',
                                                'ask_payment_amount': False}))
        self.turn('amendment', 'Please change my payment tier')
        before = self.state()
        with self.assertRaises(pq.PaymentAdmissionError):
            owner.prepare_saved_payment(self.request('deposit', 'full'))
        self.assertEqual(self.state(), before)

    def test_same_turn_conflict_and_later_replay_rejected(self):
        self.seed('deposit')
        request = self.request('deposit', 'full')
        owner.prepare_saved_payment(request)
        before = self.state()
        with self.assertRaises(pq.PaymentAdmissionError):
            owner.prepare_saved_payment(self.request('full', 'deposit'))
        self.assertEqual(self.state(), before)
        self.turn('another-turn', 'Send the link')
        before = self.state()
        with self.assertRaises(pq.PaymentAdmissionError):
            owner.prepare_saved_payment(request)
        self.assertEqual(self.state(), before)

    def test_later_bound_answer_replaces_amendment(self):
        self.seed('deposit')
        owner.prepare_saved_payment(self.request('deposit', 'full'))
        owner._transaction(lambda state, ingress: pq.open_question(
            state, 'payment_choice', ['deposit', 'full'], 2, 'Choose again?',
            scope=owner._encode(state['scope'])))
        self.turn('new-bound-answer', 'deposit')
        result = owner.prepare_saved_payment({'booking_id': 'booking-one'})
        self.assertEqual(result['plan']['payment_choice'], 'deposit')
        self.assertIsNone(result['question'])

    def test_group_amendment_preserves_missing_distribution(self):
        self.seed('deposit', group=True)
        result = owner.prepare_saved_payment(self.request('deposit', 'full'))
        self.assertEqual(result['plan']['payment_choice'], 'full')
        self.assertEqual(result['plan']['guest_count'], 2)
        self.assertEqual(result['question']['options'], ['together', 'separate'])
        self.assertFalse(result['receipt']['ask_payment_amount'])


if __name__ == '__main__':
    unittest.main()
