"""Cap integration contract: payment completion propagates ledger failures."""
import unittest
from unittest.mock import patch
from wolfhouse import accepted_quote as owner
from wolfhouse.pending_question import QuestionLedgerError
import wolfhouse_staff_api as api


class CapPendingIntegrationTests(unittest.TestCase):
    def test_payment_completion_must_not_swallow_question_ledger_failure(self):
        token = owner._current.set(object())
        try:
            with patch.object(owner, 'record_payment_completion',
                              side_effect=QuestionLedgerError('metadata unavailable')):
                with self.assertRaises(QuestionLedgerError):
                    api._retain_owner_payment_completion({'success': True})
        finally:
            owner._current.reset(token)
