"""Offline ordinary registered-tool proofs; Staff replies are synthetic, no live calls."""
import copy
import json
import os
import subprocess
from pathlib import Path
import unittest
from unittest.mock import patch

import wolfhouse_staff_api as plugin


class Registry:
    def __init__(self):
        self.tools = {}

    def register_tool(self, **tool):
        self.tools[tool['name']] = tool


class PackageMinimumTests(unittest.TestCase):
    def setUp(self):
        for target in ('urllib.request.urlopen', 'socket.socket.connect',
                       'socket.create_connection', 'socket.getaddrinfo'):
            guard = patch(target, side_effect=AssertionError('offline only'))
            mocked = guard.start()
            self.addCleanup(guard.stop)
            self.addCleanup(mocked.assert_not_called)
        env = patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        env.start()
        self.addCleanup(env.stop)
        registry = Registry()
        plugin.register(registry)
        self.tools = registry.tools
        self.params = {'check_in': '2027-07-05', 'check_out': '2027-07-09',
                       'guest_count': 1, 'guest_name': 'Alex',
                       'room_preference': 'mixed', 'selected_bed_codes': ['M1'],
                       'package_code': 'malibu', 'payment_choice': 'deposit'}

    def create_transport(self, receipt):
        def transport(route, payload):
            if route == '/availability-check':
                return {'success': True, 'has_enough_beds': True, 'available_beds': [
                    {'bed_code': 'M1', 'room_code': 'M', 'room_type': 'mixed'}]}
            self.assertEqual(route, '/booking-create-from-plan')
            return receipt
        return transport

    def invoke(self, tool, params):
        return json.loads(self.tools[tool]['handler'](params))

    def test_create_preserves_short_date_package_for_authoritative_validation(self):
        original = copy.deepcopy(self.params)
        # Deliberate backend rejection means this proof creates no booking/payment.
        with patch.object(plugin, '_post_bot', side_effect=self.create_transport({
            'success': False, 'write_performed': False,
            'next_action': 'package_not_available_for_dates',
        })) as transport:
            self.invoke('create_booking_from_plan', self.params)
        self.assertEqual(transport.call_count, 2)
        self.assertEqual(transport.call_args.args[0], '/booking-create-from-plan')
        self.assertEqual(transport.call_args.args[1]['package_code'], 'malibu')
        self.assertEqual(self.params, original)

    def test_preview_retains_admin_minimum_and_ineligible_is_not_handoff(self):
        receipt = {'success': False, 'nights': 4, 'package_min_nights': 5,
                   'package_eligible': False, 'packages': {}}
        with patch.object(plugin, '_post_bot', return_value=receipt):
            result = self.invoke('preview_package_prices', self.params)
        self.assertEqual(result.get('package_min_nights'), 5)
        self.assertIs(result.get('package_eligible'), False)
        self.assertFalse(result['staff_review_needed'])
        self.assertEqual(result['next_action'], 'offer_accommodation_or_change_dates')

    def test_missing_package_explains_real_options_without_accommodation_default(self):
        params = {k: v for k, v in self.params.items() if k != 'package_code'}
        receipt = {'success': True, 'nights': 4, 'package_min_nights': 3,
                   'package_eligible': True,
                   'packages': {'malibu': {'success': True, 'per_person_cents': 16000}}}
        with patch.object(plugin, '_post_bot', return_value=receipt) as transport:
            result = self.invoke('quote_booking', params)
        self.assertEqual(transport.call_args.args[0], '/package-price-preview')
        self.assertEqual(result['next_action'], 'explain_packages_then_ask_choice')
        self.assertTrue(result['package_choice_needed'])
        self.assertNotIn('total_cents', result)
        self.assertEqual(result['packages'], receipt['packages'])
        with patch.object(plugin, '_post_bot') as transport:
            result = self.invoke('create_booking_from_plan', params)
        transport.assert_not_called()
        self.assertFalse(result['write_performed'])
        self.assertEqual(result['next_action'], 'choose_package_or_accommodation')

    def test_rejected_selected_package_is_clarification_not_quote_success(self):
        receipt = {'success': True, 'next_action': 'package_not_available_for_dates',
                   'package_night_violation': {'package_min_nights': 5, 'package_eligible': False},
                   'quote': {'success': False, 'total_cents': 0},
                   'reply_draft': 'Packages require a 5-night stay.'}
        with patch.object(plugin, '_post_bot', return_value=receipt):
            result = self.invoke('quote_booking', self.params)
        self.assertFalse(result['success'])
        self.assertEqual(result['package_min_nights'], 5)
        self.assertFalse(result['package_eligible'])
        self.assertFalse(result['staff_review_needed'])
        self.assertEqual(result['next_action'], 'offer_accommodation_or_change_dates')

    def test_actual_booking_preview_receipt_preserves_minimum(self):
        root = Path(__file__).resolve().parents[4]
        script = """
        const t = require('./scripts/verify-package-minimum-transport');
        t.bookingPreview(t.syntheticPricingPg({items:t.policyItems(10)}), t.bookingBody())
          .then(r => process.stdout.write(JSON.stringify(r.body)));
        """
        receipt = json.loads(subprocess.check_output(['node', '-e', script], cwd=root, text=True))
        self.assertEqual(receipt['package_night_rule']['package_min_nights'], 10)
        with patch.object(plugin, '_post_bot', return_value=receipt) as transport:
            result = self.invoke('quote_booking', self.params)
        transport.assert_called_once()
        self.assertEqual(result['package_min_nights'], 10)
        self.assertFalse(result['package_eligible'])
        self.assertFalse(result['success'])
        self.assertFalse(result['staff_review_needed'])
        self.assertEqual(result['next_action'], 'offer_accommodation_or_change_dates')

    def test_actual_create_rejection_is_not_missing_package_or_handoff(self):
        root = Path(__file__).resolve().parents[4]
        script = """
        const t = require('./scripts/verify-package-minimum-transport');
        t.createFromPlan(t.syntheticPricingPg({items:t.policyItems(10)}))
          .then(r => process.stdout.write(JSON.stringify(r.body)));
        """
        receipt = json.loads(subprocess.check_output(['node', '-e', script], cwd=root, text=True))
        self.assertEqual(receipt['reason_code'], 'package_min_nights_violation')
        with patch.object(plugin, '_post_bot', side_effect=self.create_transport(receipt)) as transport:
            result = self.invoke('create_booking_from_plan', self.params)
        self.assertEqual(transport.call_count, 2)
        self.assertFalse(result['staff_review_needed'])
        self.assertTrue(result['do_not_escalate'])
        self.assertFalse(result['write_performed'])
        self.assertEqual(result['package_min_nights'], 10)
        self.assertEqual(result['blocked_reasons'], ['package_min_nights_violation'])
        self.assertEqual(result['next_action'], 'offer_accommodation_or_change_dates')

    def test_actual_commit_rejection_reaches_hermes_without_handoff(self):
        root = Path(__file__).resolve().parents[4]
        script = """
        const t = require('./scripts/verify-package-minimum-transport');
        t.createAtCommitChange().then(r => process.stdout.write(JSON.stringify(r.body)));
        """
        receipt = json.loads(subprocess.check_output(['node', '-e', script], cwd=root, text=True))
        with patch.object(plugin, '_post_bot', side_effect=self.create_transport(receipt)) as transport:
            result = self.invoke('create_booking_from_plan', self.params)
        self.assertEqual(transport.call_count, 2)
        self.assertFalse(result['staff_review_needed'])
        self.assertTrue(result['do_not_escalate'])
        self.assertFalse(result['write_performed'])
        self.assertEqual(result['package_min_nights'], 10)
        self.assertEqual(result['blocked_reasons'], ['package_min_nights_violation'])
        self.assertEqual(result['next_action'], 'offer_accommodation_or_change_dates')

    def test_explicit_accommodation_and_mixed_choices_are_preserved(self):
        for selected in ({'package_code': 'package_none'},
                         {'package_code': '', 'guest_packages': [{'guest_number': 1, 'package_code': 'malibu'}]}):
            params = {**self.params, **selected}
            with patch.object(plugin, '_post_bot', return_value={'success': False, 'error': 'offline stop'}) as transport:
                self.invoke('quote_booking', params)
            self.assertEqual(transport.call_args.args[0], '/booking-preview')
            for key, value in selected.items():
                self.assertEqual(transport.call_args.args[1][key], value)

    def test_missing_or_invalid_policy_cannot_offer_packages(self):
        for minimum in (None, 0, -1, 2.5, '4', True):
            for eligibility in (True, False, None):
                with self.subTest(minimum=minimum, eligibility=eligibility):
                    receipt = {'success': True, 'package_min_nights': minimum,
                               'package_eligible': eligibility, 'packages': {'malibu': {'success': True}}}
                    with patch.object(plugin, '_post_bot', return_value=receipt):
                        result = self.invoke('preview_package_prices', self.params)
                    self.assertFalse(result['success'])
                    self.assertEqual(result['packages'], {})
                    self.assertEqual(result['next_action'], 'package_eligibility_unavailable')


if __name__ == '__main__':
    unittest.main()
