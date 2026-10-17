"""Offline regression for late booking-preview availability loss."""
import json
import os
import unittest
from unittest.mock import patch

os.environ['LUNA_CLIENT_SLUG'] = 'wolfhouse-somo'
import wolfhouse_staff_api as plugin


class PreviewRevisionFailure(unittest.TestCase):
    def test_successful_preflight_then_null_revision_uses_clarification(self):
        params = {
            'check_in': '2027-07-05', 'check_out': '2027-07-12',
            'guest_count': 1, 'guest_name': 'Alex', 'guests': [{'name': 'Alex'}],
            'package_code': 'package_none', 'room_preference': 'shared',
        }
        calls = []
        for availability in ('unavailable', 'not_checked', None):
            with self.subTest(availability=availability):
                calls.clear()
                def transport(route, payload):
                    calls.append(route)
                    if route == '/availability-check':
                        return {'success': True, 'has_enough_beds': True,
                                'selected_bed_codes': ['R7-B3']}
                    self.assertEqual(route, '/booking-preview')
                    return {'success': True, 'availability': availability,
                            'offer_revision': None, 'quote_total_cents': 10000,
                            'deposit_required_cents': 3000,
                            'reply_draft': 'Pay the deposit now'}
                with patch.object(plugin, '_post_bot', side_effect=transport), \
                     patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')):
                    result = json.loads(plugin.quote_booking(params))
                self.assertEqual(calls, ['/availability-check', '/booking-preview'])
                self.assertFalse(result['success'])
                self.assertEqual(result['quote_status'], 'needs_guest_clarification')
                self.assertIsNone(result['offer_revision'])
                self.assertIsNone(result['total_cents'])
                self.assertIsNone(result['deposit_required_cents'])
                self.assertFalse(result['payment_choice_needed'])


if __name__ == '__main__':
    unittest.main()
