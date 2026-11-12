"""Offline prompt contracts, not live model/transcript acceptance.

Regression scenario: Luna asks an unknown guest's name in the welcome;
the guest ignores it and asks about the house, then asks another info question.
The authoring owner must answer both without repeating the introductory ask.
Existing runtime name suites separately prove retention and create requirements.
"""
from pathlib import Path
import unittest


STAGING = Path(__file__).resolve().parents[1]


class NameAskOnceContractTests(unittest.TestCase):
    def test_unanswered_intro_is_not_a_standing_name_request(self):
        guide = (STAGING / 'soul-guides/02-greeting-intake.md').read_text()
        for instruction in (
            'If the guest leaves the introductory contact-name question unanswered',
            'do not repeat it on later information turns',
            'Answer their current question and continue helping without a name reminder',
            '`contact_name_needed` means the identity is unknown, not that you must ask again',
            'Use the conversation to recognize the unanswered introduction',
        ):
            with self.subTest(instruction=instruction):
                self.assertTrue(instruction in guide, f'Missing authoring rule: {instruction}')

    def test_deferred_intro_preserves_identity_and_required_booking_completion(self):
        guide = (STAGING / 'soul-guides/02-greeting-intake.md').read_text()
        for instruction in (
            'Retain and capture any name they later supply',
            'never invent a name or treat silence as a supplied name',
            'When they proceed with a booking, ask only for genuinely missing names needed to complete it',
            'do not skip required booking-name completion or re-ask names already known',
        ):
            with self.subTest(instruction=instruction):
                self.assertTrue(instruction in guide, f'Missing booking safeguard: {instruction}')

    def test_greeting_guide_is_present_verbatim_in_runtime_soul(self):
        guide = (STAGING / 'soul-guides/02-greeting-intake.md').read_bytes()
        self.assertTrue(guide in (STAGING / 'SOUL.md').read_bytes(),
                        'Greeting guide must be mirrored verbatim in runtime SOUL')


if __name__ == '__main__':
    unittest.main()
