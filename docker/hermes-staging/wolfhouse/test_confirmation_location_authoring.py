"""Regression for the reported Brandt confirmation missing its returned map."""
from pathlib import Path
import unittest

from wolfhouse import accepted_quote


class ConfirmationLocationAuthoringTests(unittest.TestCase):
    def test_brandt_confirmation_requires_returned_location_in_normal_authoring(self):
        location = 'https://maps.app.goo.gl/oPRckhqozVBvXxL16'
        payment = 'https://staff-staging.lunafrontdesk.com/pay/WH-20270913-00748233'
        draft = (
            '🌊 Lisa, your booking is saved! *WH-20270913-00748233*\n'
            '👤 Guest: Lisa Brandt\n'
            '📅 13–17 September 2027 · 4 nights\n'
            '🛏️ Room 1 · mixed shared room\n'
            '🏠 Package: Malibu\n'
            '💶 Total: *€180*\n'
            '💳 Full payment due now: *€180*\n'
            f'🔗 {payment}'
        )
        facts = {
            'reference': 'WH-20270913-00748233',
            'total_cents': 18000, 'amount_due_now_cents': 18000,
            'remains_owed_cents': 0, 'payment_links': [payment],
            'location_url': location, 'location_already_sent': False,
            'rewrite_context': {'language': 'en'},
        }
        self.assertEqual(accepted_quote._confirmation_reject_reasons(draft, facts),
                         ['missing_location'])
        # A fixture of Luna-authored copy, not a new runtime append/fallback path.
        complete = draft + '\n\n📍 Here’s our location:\n' + location
        self.assertEqual(accepted_quote._sendable_saved_confirmation(complete, facts),
                         complete)

        root = Path(__file__).resolve().parents[1]
        guide = (root / 'soul-guides/06-confirmation.md').read_text()
        soul = (root / 'SOUL.md').read_text()
        location_rule = next(line for line in guide.splitlines()
                             if line.startswith('**Location once per chat:**'))
        self.assertTrue(location_rule in soul,
                        'Normal SOUL is missing the existing location-once authoring rule')
        info = (root / 'soul-guides/03-info-questions.md').read_text()
        for source in (soul, info):
            self.assertNotIn('`guest_location_line`', source,
                             'Map instructions must not require the retired tool field')
            self.assertTrue('returned `location_url`' in source)
        required_location = (
            '- the exact returned `location_url`, unless trusted `location_already_sent` '
            'is true; a guest request to resend it still gets the canonical URL.'
        )
        for source in (soul, guide):
            checklist = source.split('## Booking confirmation guide', 1)[1].split('**How:**', 1)[0]
            self.assertIn(required_location, checklist)


if __name__ == '__main__':
    unittest.main()
