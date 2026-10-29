import unittest

from wolfhouse import pending_question


class ClearGoAheadAcceptanceTests(unittest.TestCase):
    def test_supported_localized_clear_acceptance(self):
        for text in ('Yes', 'Yes, save it.', 'Sí', 'Sí, guárdala.',
                     'Ja', 'Ja, bitte speichern.', 'Sì, salvala.',
                     'Oui, réservez-la.'):
            with self.subTest(text=text):
                self.assertTrue(pending_question.clear_go_ahead_acceptance(text))

    def test_stale_payment_question_requires_owner_rendered_final_save(self):
        state = {
            'pending_question': {'kind': 'payment_choice',
                                 'options': ['deposit', 'full']},
            'plan': {'guest_count': 3, 'payment_choice': 'deposit',
                     'payment_link_distribution': 'separate'},
            'completion_plan': {'payment_choice': 'deposit'},
            'presentation': {
                'create_ready': True,
                'quote_revision': {'payment_choice': 'deposit'},
                'displayed_text': '¿Guardo esta reserva?',
            },
        }
        bound = pending_question.bind_answer(state, 'accept', 'Sí, guárdala.')
        self.assertEqual(bound['kind'], 'go_ahead')
        self.assertEqual(bound['answer'], 'accepted')
        self.assertFalse(bound['plan_changed'])

    def test_yes_to_non_save_question_never_becomes_booking_authority(self):
        for kind, options in (
                ('add_on', None),
                ('payment_choice', ['together', 'separate'])):
            state = {
                'pending_question': {'kind': kind, **({'options': options} if options else {})},
                'plan': {'guest_count': 2, 'payment_choice': 'deposit',
                         'payment_link_distribution': 'separate'},
                'completion_plan': {'payment_choice': 'deposit'},
                'presentation': {
                    'create_ready': False,
                    'quote_revision': {'payment_choice': 'deposit'},
                    'displayed_text': 'Do you need the shuttle?',
                },
            }
            with self.subTest(kind=kind):
                self.assertIsNone(
                    pending_question.bind_answer(state, 'clarify', 'Yes'))

    def test_combined_distribution_and_side_question_keeps_explicit_choice(self):
        state = {
            'pending_question': {'kind': 'payment_choice',
                                 'options': ['together', 'separate']},
            'plan': {'guest_count': 2, 'payment_choice': 'deposit'},
        }
        raw = 'Separate links, and what time is check-in?'
        bound = pending_question.bind_answer(state, 'clarify', raw)
        self.assertEqual(bound['kind'], 'payment_choice')
        self.assertEqual(bound['answer'], 'separate')
        self.assertEqual(state['plan']['payment_link_distribution'], 'separate')

    def test_conditions_changes_and_negatives_are_not_clear_acceptance(self):
        for text in ('No', 'Maybe', 'Yes, if breakfast is included',
                     'Sí, pero cambia las fechas', 'Ja, aber später'):
            with self.subTest(text=text):
                self.assertFalse(pending_question.clear_go_ahead_acceptance(text))


if __name__ == '__main__':
    unittest.main()
