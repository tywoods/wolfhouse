"""Offline: save first, then ask deposit or full; no link until the guest answers.

No SessionDB. No network. Never blocks a booking save.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

STAGING = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(STAGING), str(STAGING / 'plugins')]

from wolfhouse import accepted_quote as owner
from wolfhouse import pending_question as pq


class DepositOrFullAfterSaveTests(unittest.TestCase):
    def test_solo_no_choice_save_then_ask_no_link(self):
        # Live hole: model-default deposit + guest said 'save' minted a link.
        got = owner._with_inferred_guest_payment(
            {'payment_choice': 'deposit'},
            {'current_turn': {'raw': 'save'}},
        )
        self.assertEqual(got['payment_choice'], 'deposit')
        self.assertIs(got['ask_payment_amount'], True)
        offer = {'deposit_required_cents': 20000, 'total_cents': 41500}
        self.assertTrue(pq.withhold_payment_link(got, offer))

    def test_ask_before_save_never_happens(self):
        plan = {}
        offer = {
            'deposit_required_cents': 20000,
            'total_cents': 41500,
            'guest_count': 1,
        }
        self.assertEqual(pq.quote_question_kind(plan, offer, 'en', False), 'go_ahead')
        self.assertNotEqual(
            pq.quote_question_kind(plan, offer, 'en', False), 'payment_choice')

    def test_quote_renderer_saves_without_distribution_selection(self):
        for count, distribution in ((1, None), (2, None), (2, False), (2, True)):
            for ready in (False, True):
                with self.subTest(count=count, distribution=distribution, ready=ready):
                    plan = {'guest_count': count, 'shuttle_needed': False}
                    if distribution is not None:
                        plan['per_guest_payment_links'] = distribution
                    offer = {'guest_count': count, 'deposit_required_cents': 20000,
                             'total_cents': 41500, 'currency': 'EUR',
                             'room_arrangement': []}
                    with patch('socket.socket.connect', side_effect=AssertionError('NETWORK')):
                        text = owner._styled_quote_copy(plan, offer, 'en', create_ready=ready)
                    self.assertEqual(text.splitlines()[-1], owner._style_copy('en')['save'])

    def test_pending_owner_saves_without_distribution_selection(self):
        for count, distribution in ((1, None), (2, None), (2, False), (2, True)):
            for ready in (False, True):
                with self.subTest(count=count, distribution=distribution, ready=ready):
                    plan = {'guest_count': count, 'shuttle_needed': False}
                    if distribution is not None:
                        plan['per_guest_payment_links'] = distribution
                    offer = {'guest_count': count, 'deposit_required_cents': 20000,
                             'total_cents': 41500}
                    kind = pq.quote_question_kind(plan, offer, 'en', ready)
                    self.assertEqual(kind, 'go_ahead')
                    options = pq.rendered_options(plan, offer, 'en', ready, kind)
                    self.assertIsNone(options)
                    state = {}
                    pq.persist(state, kind, options)
                    self.assertEqual(state['pending_question'], {'kind': 'go_ahead'})

    def test_guest_answers_deposit_one_link(self):
        got = owner._with_inferred_guest_payment(
            {},
            {'current_turn': {'raw': 'deposit'}},
        )
        self.assertEqual(got['payment_choice'], 'deposit')
        self.assertIs(got['ask_payment_amount'], False)
        offer = {'deposit_required_cents': 20000, 'total_cents': 41500}
        self.assertFalse(pq.withhold_payment_link(got, offer))

    def test_prior_explicit_deposit_is_kept(self):
        got = owner._with_inferred_guest_payment(
            {'payment_choice': 'deposit'},
            {
                'plan': {'payment_choice': 'deposit', 'ask_payment_amount': False},
                'current_turn': {'raw': 'ok'},
            },
        )
        self.assertEqual(got['payment_choice'], 'deposit')
        self.assertIs(got['ask_payment_amount'], False)

    def test_model_default_deposit_plus_separate_still_asks(self):
        got = owner._with_inferred_guest_payment(
            {'payment_choice': 'deposit'},
            {'current_turn': {'raw': 'separate'}},
        )
        self.assertIs(got['ask_payment_amount'], True)
        self.assertEqual(got['payment_choice'], 'deposit')

    def test_never_pops_payment_choice(self):
        got = owner._with_inferred_guest_payment(
            {},
            {'current_turn': {'raw': 'save the booking'}},
        )
        self.assertIn('payment_choice', got)
        self.assertEqual(got['payment_choice'], 'deposit')
        self.assertIs(got['ask_payment_amount'], True)

    def test_no_network(self):
        with patch('socket.socket.connect', side_effect=AssertionError('NETWORK')):
            owner._with_inferred_guest_payment(
                {'payment_choice': 'deposit'},
                {'current_turn': {'raw': 'save'}},
            )


if __name__ == '__main__':
    unittest.main()
