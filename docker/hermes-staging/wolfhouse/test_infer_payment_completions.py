"""Guest wording: 'full ammount' is full payment. No SessionDB / Hermes runtime."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


def _load_pending_question():
    path = Path(__file__).with_name('pending_question.py')
    spec = importlib.util.spec_from_file_location('pending_question_under_test', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pq = _load_pending_question()

TOTAL = 41500
DEPOSIT = 20000


class InferPaymentCompletionsTests(unittest.TestCase):
    def test_full_ammount_typo_is_full(self):
        self.assertEqual(
            pq.infer_payment_completions('full ammount')['payment_choice'],
            'full')

    def test_full_amount_spelled_correctly_is_full(self):
        self.assertEqual(
            pq.infer_payment_completions('the full amount')['payment_choice'],
            'full')

    def test_together_plus_full_ammount_keeps_both(self):
        got = pq.infer_payment_completions('pay together\nfull ammount')
        self.assertEqual(got['payment_choice'], 'full')
        self.assertEqual(got['payment_link_distribution'], 'together')
        self.assertIs(got['per_guest_payment_links'], False)

    def test_together_alone_is_not_a_deposit_choice(self):
        got = pq.infer_payment_completions('pay together')
        self.assertNotIn('payment_choice', got)
        self.assertEqual(got['payment_link_distribution'], 'together')

    def test_together_only_withholds_link_and_does_not_block_save(self):
        plan = {'payment_link_distribution': 'together'}
        offer = {'deposit_required_cents': DEPOSIT, 'total_cents': TOTAL}
        self.assertTrue(pq.requires_payment_amount_choice(plan, offer))
        self.assertTrue(pq.withhold_payment_link(plan, offer))

    def test_seconds_apart_full_ammount_is_one_answer(self):
        prior = [{'raw': 'pay together', 'at': 100.0}]
        combined = pq.combine_recent_guest_text(prior, 'full ammount', now=103.0)
        got = pq.infer_payment_completions(combined)
        self.assertEqual(got['payment_choice'], 'full')
        self.assertEqual(got['payment_link_distribution'], 'together')
        self.assertFalse(pq.withhold_payment_link(
            {'payment_choice': 'full'},
            {'deposit_required_cents': DEPOSIT, 'total_cents': TOTAL}))

    def test_stale_message_outside_window_is_not_merged(self):
        prior = [{'raw': 'pay together', 'at': 100.0}]
        combined = pq.combine_recent_guest_text(prior, 'full ammount', now=130.0)
        self.assertEqual(combined, 'full ammount')

    def test_saved_receipt_amount_beats_quote_deposit_guess(self):
        receipt = {'amount_due_cents': TOTAL, 'booking_code': 'WH-20270615-14908309'}
        plan = {'payment_link_distribution': 'together'}
        offer = {'deposit_required_cents': DEPOSIT, 'total_cents': TOTAL}
        self.assertEqual(pq.saved_pay_amount_cents(receipt), TOTAL)
        self.assertFalse(pq.withhold_payment_link(plan, offer, receipt))
        self.assertNotEqual(pq.saved_pay_amount_cents(receipt), DEPOSIT)

    def test_deposit_full_deposit_pay_amounts(self):
        amounts = []
        for choice in ('deposit', 'full', 'deposit'):
            amounts.append(pq.saved_pay_amount_cents(
                None, choice, total_cents=TOTAL, deposit_cents=DEPOSIT))
        self.assertEqual(amounts, [DEPOSIT, TOTAL, DEPOSIT])

    def test_just_the_deposit_wins_over_full_amount_wording(self):
        got = pq.infer_payment_completions(
            'not the full amount, just the deposit')
        self.assertEqual(got['payment_choice'], 'deposit')
        self.assertNotEqual(got['payment_choice'], 'full')

    def test_full_then_actually_deposit_please_latest_wins(self):
        prior = [{'raw': 'full amount', 'at': 100.0}]
        combined = pq.combine_recent_guest_text(
            prior, 'actually deposit please', now=103.0)
        got = pq.infer_payment_completions(combined)
        self.assertEqual(got['payment_choice'], 'deposit')
        self.assertNotEqual(got['payment_choice'], 'full')

    def test_together_then_full_still_full(self):
        prior = [{'raw': 'together', 'at': 100.0}]
        combined = pq.combine_recent_guest_text(prior, 'full', now=103.0)
        got = pq.infer_payment_completions(combined)
        self.assertEqual(got['payment_choice'], 'full')
        self.assertEqual(got['payment_link_distribution'], 'together')


if __name__ == '__main__':
    unittest.main()
