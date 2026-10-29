import unittest

from wolfhouse import pending_question


class ClearGoAheadAcceptanceTests(unittest.TestCase):
    def test_supported_localized_clear_acceptance(self):
        for text in ('Yes', 'Yes, save it.', 'Sí', 'Sí, guárdala.',
                     'Ja', 'Ja, bitte speichern.'):
            with self.subTest(text=text):
                self.assertTrue(pending_question.clear_go_ahead_acceptance(text))

    def test_stale_payment_question_cannot_consume_save_yes_as_first_option(self):
        state = {
            'pending_question': {'kind': 'payment_choice',
                                 'options': ['deposit', 'full']},
            'plan': {'guest_count': 3, 'payment_choice': 'deposit',
                     'payment_link_distribution': 'separate'},
            'completion_plan': {'payment_choice': 'deposit'},
            'presentation': {'offer_revision': {'payment_choice': 'deposit'}},
        }
        bound = pending_question.bind_answer(state, 'accept', 'Sí, guárdala.')
        self.assertEqual(bound['kind'], 'go_ahead')
        self.assertEqual(bound['answer'], 'accepted')
        self.assertFalse(bound['plan_changed'])

    def test_conditions_changes_and_negatives_are_not_clear_acceptance(self):
        for text in ('No', 'Maybe', 'Yes, if breakfast is included',
                     'Sí, pero cambia las fechas', 'Ja, aber später'):
            with self.subTest(text=text):
                self.assertFalse(pending_question.clear_go_ahead_acceptance(text))


if __name__ == '__main__':
    unittest.main()
