"""PRIVATE-OPT tool-contract tests; synthetic Staff HTTP, never live business writes.

SQL persistence/locking is proved separately by verify-room-selling-booking and
verify-private-optional-concurrency, not by the transport fixtures here.
"""
import json
import unittest
from copy import deepcopy
from unittest.mock import patch

import wolfhouse_staff_api as plugin


class PrivateOptionalBookingTests(unittest.TestCase):
    def plan(self, count=1, alias='private'):
        return dict(client_slug='wolfhouse-somo', check_in='2027-04-10',
                    check_out='2027-04-13', guest_count=count,
                    room_type=alias, room_preference=alias,
                    guest_name='Offline Guest 1',
                    guests=[{'name': f'Offline Guest {n + 1}'} for n in range(count)],
                    package_code='package_none', payment_choice='deposit')

    @staticmethod
    def availability(count):
        codes = [f'R1-B{i + 1}' for i in range(count)]
        return dict(success=True, has_enough_beds=True,
                    selected_bed_codes=codes, selected_room_code='R1',
                    allocation_split=False, allocation_reason='exclusive_private_room',
                    private_room_available=True, available_count=count,
                    available_beds=[dict(bed_code=code, room_code='R1',
                                         room_type='mixed', selected_selling_mode='private')
                                    for code in codes])

    def test_same_price_shared_to_private_requires_new_offer_presentation(self):
        # Existing session/Staff offer builder fixture, not a model-consent classifier.
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        from wolfhouse import accepted_quote as ledger
        fixture = FirstYesOwnerTests('test_sim9_ordinary_equivalent_requote_retains_shown_authority')
        fixture.setUp()
        try:
            shared = deepcopy(fixture.plan)
            beds = [dict(bed_code=f'R1-B{i}', room_code='R1', room_type='mixed',
                         gender_strategy='mixed') for i in (1, 2)]
            old = fixture._checked_offer(shared, beds)
            ledger.record_quote(shared, old)
            displayed = ('Alex and Sam: 1–8 November, accommodation only, two beds in the same '
                         'mixed room. Total €200; full payment €200. Would you like to book this offer?')
            shown = ledger.finalize_offer_response({'completed': True, 'final_response': displayed})
            self.assertEqual(shown['final_response'], displayed)
            self.assertTrue(ledger._transaction(lambda state, _: state.get('presentation')))
            fixture.turn('private-change', 'A private room instead, please')
            private = {**shared, 'room_type': 'private', 'room_preference': 'private'}
            revised = fixture._checked_offer(private, beds)
            self.assertEqual(old['total_cents'], revised['total_cents'])
            self.assertNotEqual(old['offer_revision']['offer_fingerprint'],
                                revised['offer_revision']['offer_fingerprint'])
            ledger.record_quote(private, revised)
            self.assertIsNone(ledger._transaction(lambda state, _: state.get('presentation')),
                              'old shared-room presentation cannot authorize private create')
            with self.assertRaises(ledger.QuoteBoundaryError):
                ledger.prepare_create({})
        finally:
            fixture.tearDown()

    def test_private_and_double_solo_and_group_use_same_non_r6_availability(self):
        for count in (1, 3):
            for alias in ('private', 'double', 'private_room', 'couple_private'):
                with self.subTest(count=count, alias=alias):
                    calls = []
                    def staff(path, body):
                        calls.append((path, deepcopy(body)))
                        return self.availability(count)
                    with patch.object(plugin, '_post_bot', side_effect=staff):
                        result = json.loads(plugin.check_availability(self.plan(count, alias)))
                    self.assertEqual(calls[0][0], '/availability-check')
                    self.assertEqual(calls[0][1]['room_type'], 'private')
                    self.assertEqual(calls[0][1]['room_preference'], 'private')
                    self.assertTrue(result['available'], result)
                    self.assertEqual(result['selected_room_code'], 'R1')
                    self.assertEqual(len(result['selected_bed_codes']), count)
                    self.assertTrue(result['room_decision']['private_room'])
                    self.assertFalse(result['room_decision']['clarification_needed'])
                    self.assertEqual(result['selected_room_description'], 'private')


if __name__ == '__main__':
    unittest.main()
