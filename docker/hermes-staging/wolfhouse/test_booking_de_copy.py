"""D/E instruction and actual neutral-room response regression."""
import pathlib
import re
import unittest
from wolfhouse import room_eligibility_policy as policy

ROOT = pathlib.Path(__file__).resolve().parents[1]

class BookingDECopyTests(unittest.TestCase):
    def test_guest_guides_use_shared_room(self):
        for name in ('06-confirmation.md', '11-rooms.md'):
            with self.subTest(name=name):
                text = (ROOT / 'soul-guides' / name).read_text()
                self.assertIsNone(re.search(r'\bdorm(?:s)?\b', text, re.I))

    def test_neutral_policy_response(self):
        self.assertEqual(policy._NEUTRAL_PROMPT, 'Would a mixed shared room work for you?')

    def test_confirmation_spacing_contract(self):
        text = (ROOT / 'soul-guides' / '06-confirmation.md').read_text()
        self.assertIn('Put total, package and add-ons on separate lines', text)
        self.assertIn('blank line before the payment-link section', text)
        self.assertIn('blank line before the location line', text)

if __name__ == '__main__':
    unittest.main()
