"""Offline reply-only regression: two deposits and priced add-ons, no writes/sends."""
from copy import deepcopy
import unittest
from unittest.mock import patch

from wolfhouse import accepted_quote as owner
from wolfhouse_staff_api import _extract_booking_write_fields


class ArrivalBalanceTests(unittest.TestCase):
    def setUp(self):
        # Synthetic Staff receipt, not a copy of the live Mia/Leon booking.
        self.plan = {'guests': [{'name': 'Mia'}, {'name': 'Leon'}], 'language': 'en'}
        self.offer = {'total_cents': 69800, 'deposit_required_cents': 40000,
                      'remaining_after_deposit_cents': 29800}
        self.receipt = {
            'booking_code': 'WH-OFFLINE-ARRIVAL',
            # A later individual-link result can leave this scalar in the receipt.
            'amount_due_cents': 20000,
            **_extract_booking_write_fields({'quote': {
                'total_cents': 73300,
                'line_items': [
                    {'label': 'Stay', 'total_cents': 69800},
                    {'label': 'Dinner', 'total_cents': 2000},
                    {'label': 'Yoga', 'total_cents': 1500}],
                'add_ons': [{'code': 'dinner'}, {'code': 'yoga'}],
            }}),
            'booking_code': 'WH-OFFLINE-ARRIVAL',
            'guest_payment_links': [
                {'guest_name': name, 'amount_due_cents': 20000,
                 'payment_status': 'checkout_created',
                 'secure_payment_url': 'https://pay.invalid/' + name.lower()}
                for name in ('Mia', 'Leon')],
        }

    def facts(self):
        with patch.object(owner, '_saved_property_location_url', return_value=None):
            return owner._saved_confirmation_facts(self.plan, self.offer, self.receipt)

    def test_two_deposits_and_saved_addons_reach_authoring_and_value_checker(self):
        before = deepcopy((self.plan, self.offer, self.receipt))
        facts = self.facts()
        self.assertEqual(facts['amount_due_now_cents'], 40000)
        self.assertEqual(facts['total_cents'], 73300)
        self.assertEqual(facts['remains_owed_cents'], 33300)
        payload = owner._confirmation_rewrite_payload(facts, 'Old draft', [])
        self.assertEqual(payload['required_guest_facts']['remaining_balance'], '€333.00')
        self.assertEqual(payload['required_guest_facts']['extras'], self.receipt['add_ons'])
        text = ('Booking WH-OFFLINE-ARRIVAL saved. Total €733.00 including dinner and yoga. '
                'Both deposits together: €400.00. After both links are paid, €333.00 on arrival. '
                'Mia https://pay.invalid/mia Leon https://pay.invalid/leon')
        self.assertEqual(owner._sendable_saved_confirmation(text, facts), text)
        self.assertIsNone(owner._sendable_saved_confirmation(text.replace('€333.00', '€298.00'), facts))
        self.assertEqual((self.plan, self.offer, self.receipt), before)

    def test_paid_first_deposit_is_counted_once_with_second_link_still_due(self):
        self.receipt['guest_payment_links'][0]['payment_status'] = 'paid'
        self.receipt['amount_paid_cents'] = 20000
        facts = self.facts()
        self.assertEqual(facts['amount_due_now_cents'], 20000)
        self.assertEqual(facts['remains_owed_cents'], 33300)

    def test_paid_addons_and_paid_deposit_are_not_charged_again_on_arrival(self):
        self.receipt['guest_payment_links'][0]['payment_status'] = 'paid'
        self.receipt['amount_paid_cents'] = 23500
        facts = self.facts()
        self.assertEqual(facts['amount_due_now_cents'], 20000)
        self.assertEqual(facts['remains_owed_cents'], 29800)

    def test_already_inclusive_offer_is_not_charged_for_extras_twice(self):
        self.offer['total_cents'] = 73300
        self.offer['remaining_after_deposit_cents'] = 33300
        self.assertEqual(self.facts()['remains_owed_cents'], 33300)


if __name__ == '__main__':
    unittest.main()
