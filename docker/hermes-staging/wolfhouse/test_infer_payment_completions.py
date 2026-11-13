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


if __name__ == '__main__':
    unittest.main()
