"""Offline adapter contract only; real SQL save proof is verify-missing-payment-choice-always-saves.js.

Only the Staff transport is replaced. No live booking, link, handoff or network.
"""
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'docker/hermes-staging'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wolfhouse_staff_api as plugin


class MissingPaymentChoiceTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        for guard in (
            patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}, clear=True),
            patch('socket.socket.connect', side_effect=AssertionError('NETWORK FORBIDDEN')),
            patch('socket.create_connection', side_effect=AssertionError('NETWORK FORBIDDEN')),
        ):
            guard.start()
            self.addCleanup(guard.stop)

    def complete(self, *, pending, distribution, idempotent=False, choice=None,
                 per_guest=True, nested=False, next_action_only=False):
        self.calls.clear()
        receipt = {
            'success': True, 'write_performed': not idempotent, 'idempotent': idempotent,
            'booking_id': 'offline-booking', 'booking_code': 'OFFLINE', 'payment_id': 'offline-payment',
            'uses_per_guest_model': per_guest,
            'booking_guests': [{'booking_guest_id': 'offline-guest-1', 'guest_number': 1},
                               {'booking_guest_id': 'offline-guest-2', 'guest_number': 2}],
            'payment_choice_pending': pending, 'ask_payment_amount': pending,
            'next_action': 'ask_deposit_or_full' if pending else 'create_stripe_link',
        }
        if nested:
            receipt = {'success': True, 'write_performed': not idempotent, 'idempotent': idempotent,
                       'create_outcome': {'create_response': receipt}}
        elif next_action_only:
            receipt.pop('payment_choice_pending')
            receipt.pop('ask_payment_amount')
        payload = {'client_slug': 'wolfhouse-somo', 'payment_link_distribution': distribution,
                   'total_cents': 41500, 'deposit_required_cents': 20000}
        if choice is not None:
            payload['payment_choice'] = choice

        def staff(path, body):
            self.calls.append((path, deepcopy(body)))
            if path == '/booking-create-from-plan':
                return deepcopy(receipt)
            if path.endswith('/create-stripe-link') or path.endswith('/create-payment-link'):
                return {'success': True, 'guest_payment_url': 'https://checkout.invalid/offline',
                        'payment_id': 'offline-payment', 'payment_target': body.get('payment_target'),
                        'amount_due_cents': 20000 if choice == 'deposit' else 41500}
            raise AssertionError('Unexpected Staff operation: ' + path)

        with patch.object(plugin, '_post_bot', side_effect=staff):
            return json.loads(plugin._commit_and_complete_booking(payload))

    def test_pending_save_and_idempotent_receipt_never_create_links_or_escalate(self):
        for idempotent in (False, True):
            for distribution in ('together', 'separate'):
                for per_guest in (False, True):
                    for choice in (None, '', 'deposit'):
                        with self.subTest(idempotent=idempotent, distribution=distribution,
                                          per_guest=per_guest, choice=choice):
                            result = self.complete(pending=True, distribution=distribution,
                                                   idempotent=idempotent, per_guest=per_guest, choice=choice)
                            self.assertEqual([p for p, _ in self.calls], ['/booking-create-from-plan'])
                            self.assertTrue(result['success'])
                            self.assertEqual(result['booking_id'], 'offline-booking')
                            self.assertEqual(result['payment_id'], 'offline-payment')
                            self.assertEqual(result['write_performed'], not idempotent)
                            self.assertEqual(result['next_action'], 'ask_deposit_or_full')
                            self.assertTrue(result['payment_choice_pending'])
                            self.assertTrue(result['ask_payment_amount'])
                            self.assertFalse(result['staff_review_needed'])
                            self.assertFalse(result['needs_human'])
                            self.assertFalse(result['secure_payment_url'])
                            self.assertFalse(result['guest_payment_links'])
                            self.assertFalse(result['payment_link_failures'])

    def test_nested_or_next_action_pending_receipt_preserves_question(self):
        for options in ({'nested': True}, {'next_action_only': True}):
            with self.subTest(options=options):
                result = self.complete(pending=True, distribution='separate', **options)
                self.assertEqual([p for p, _ in self.calls], ['/booking-create-from-plan'])
                self.assertEqual(result['next_action'], 'ask_deposit_or_full')
                self.assertFalse(result['staff_review_needed'])

    def test_explicit_deposit_and_full_still_create_whole_and_guest_links(self):
        for choice in ('deposit', 'full'):
            for distribution in ('together', 'separate'):
                for idempotent in (False, True):
                    with self.subTest(choice=choice, distribution=distribution, idempotent=idempotent):
                        result = self.complete(pending=False, distribution=distribution,
                                               idempotent=idempotent, choice=choice)
                        links = [(p, b) for p, b in self.calls if p != '/booking-create-from-plan']
                        self.assertEqual(len(links), 2 if distribution == 'separate' else 1)
                        self.assertTrue(result['success'])
                        self.assertFalse(result['staff_review_needed'])
                        if distribution == 'separate':
                            self.assertTrue(all(p.endswith('/create-payment-link') for p, _ in links))
                            self.assertEqual([b['payment_target'] for _, b in links],
                                             [ 'full_share' if choice == 'full' else 'deposit'] * 2)
                            self.assertEqual(result['next_action'], 'send_per_guest_payment_links')
                        else:
                            self.assertTrue(links[0][0].endswith('/create-stripe-link'))
                            self.assertEqual(result['next_action'], 'send_secure_payment_link')


if __name__ == '__main__':
    unittest.main(verbosity=2)
