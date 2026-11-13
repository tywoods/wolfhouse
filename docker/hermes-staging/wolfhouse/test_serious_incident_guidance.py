"""Offline R10/R9 prompt contracts; not live/model-routing behavior proof."""
from pathlib import Path
import unittest


STAGING = Path(__file__).resolve().parents[1]


class SeriousIncidentGuidanceTests(unittest.TestCase):
    def setUp(self):
        self.soul = (STAGING / 'SOUL.md').read_text(encoding='utf-8')

    def guide(self, name):
        return (STAGING / 'soul-guides' / name).read_text(encoding='utf-8')

    def assert_clauses(self, text, *clauses):
        for clause in clauses:
            with self.subTest(clause=clause):
                self.assertIn(clause, text)

    def test_affected_sections_have_exact_canonical_parity(self):
        for name in ('09-payments-after-booking.md', '11-rooms.md', '13-handoff.md'):
            with self.subTest(guide=name):
                self.assertIn(self.guide(name), self.soul)

    def test_payment_complaint_routes_same_turn_without_booking_code(self):
        for name in ('09-payments-after-booking.md', '13-handoff.md'):
            with self.subTest(guide=name):
                self.assert_clauses(
                    self.guide(name),
                    'I paid but got nothing',
                    'payment complaint',
                    '`flag_needs_human` in the same turn',
                    '`reason: "complaint: guest reports paid but got nothing"`',
                    'Do not require a booking code or a payment lookup before handing off',
                    'Do not send another booking confirmation or resend a payment link',
                    'Never assert that payment succeeded without verified payment truth',
                )

    def test_complaint_priority_preserves_ordinary_self_service(self):
        text = self.guide('09-payments-after-booking.md')
        self.assertTrue(text.startswith('**Payment complaints'), 'Complaint routing must precede ordinary balance/status flow')
        self.assert_clauses(
            text,
            'An ordinary payment-status query or payment-link request is not itself a complaint',
            '**list_my_bookings**', '**get_payment_status**', '**create_balance_payment_link**',
        )

    def test_handoff_note_precedes_pause_and_names_require_staff_info(self):
        self.assert_clauses(
            self.guide('13-handoff.md'),
            'warm and brief, in their language',
            'only the configured staff member\'s name from Staff Info',
            'otherwise say one of our team',
            'without inventing a name or an exact wait time',
            'Send the warm note before the Needs-human pause',
            'then stay quiet for staff',
            'Do not send a second note when the tool reports `ack_sent`',
            'never claim staff were notified without confirmed persistence',
        )

    def test_subgroup_assignment_not_vetoed_by_whole_party_summary(self):
        self.assert_clauses(
            self.guide('11-rooms.md'),
            '**Subgroup scope:**',
            'Staff-approved ordered subgroup assignment',
            'women in female-only beds and a man in a mixed room',
            'whole-party exclusions cannot veto that subgroup assignment',
            'not a global eligibility list for every traveler',
            'Carry each person\'s exact Staff-selected beds and eligibility through `quote_booking` and `create_booking_from_plan`',
            'Never apply one subgroup\'s eligibility to another traveler',
            'adds no new gate or confirmation question',
            'For a Staff-approved split, apply the mapping per subgroup',
            'Apply that exclusion to the person/subgroup Staff evaluated, not the aggregate whole-party summary',
        )

    def test_subgroup_scope_preserves_gender_safety_and_staff_revalidation(self):
        self.assert_clauses(
            self.guide('11-rooms.md'),
            'Women never in men\'s rooms and vice versa',
            'Never derive or store gender from a name',
            'Keep existing Staff availability, eligibility and offer revalidation',
        )


if __name__ == '__main__':
    unittest.main()
