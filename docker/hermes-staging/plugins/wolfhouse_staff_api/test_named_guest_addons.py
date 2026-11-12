"""Offline regressions for Jonas's dated dinner and schedule-later yoga."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import wolfhouse_staff_api as plugin


class NamedGuestAddonTests(unittest.TestCase):
    def test_guidance_allows_named_dinner_and_explicit_schedule_later_yoga(self):
        root = Path(plugin.__file__).resolve().parents[2]
        for path in (root / 'SOUL.md', root / 'soul-guides/10-packages-extras.md'):
            with self.subTest(path=path.name):
                text = path.read_text()
                self.assertNotIn('tell them to check with staff for when a meal or yoga session is scheduled', text)
                self.assertIn('For dinner on a supplied date, save that date', text)
                self.assertIn('If yoga is explicitly requested with the date left open', text)
                self.assertIn('handoff_persisted=true', text)

    def test_model_can_bind_addon_to_saved_guest_not_free_text_notes(self):
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **tool): self.tools[tool['name']] = tool
        registry = Registry()
        with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}):
            plugin.register(registry)
        schema = registry.tools['add_service_to_booking']['schema']
        for field in ('booking_guest_id', 'guest_number', 'guest_name'):
            self.assertIn(field, schema['parameters']['properties'])
        self.assertIn('date open', schema['description'])

    def test_dated_dinner_and_undated_yoga_preserve_guest_and_payment_receipt(self):
        for kind, date in [('meal', '2027-06-20'), ('yoga', None)]:
            params = {'booking_code': 'WH-20270618-15443747', 'service_type': kind,
                      'quantity': 1, 'booking_guest_id': 'jonas-id',
                      'guest_name': 'Jonas Keller', 'guest_number': 2}
            if date: params['service_date'] = date
            receipt = {'success': True, 'write_performed': True,
                       'booking_code': params['booking_code'], 'service_record_id': kind + '-id',
                       'booking_guest_id': 'jonas-id', 'guest_name': 'Jonas Keller', 'guest_number': 2,
                       'service_type': kind, 'service_date': date, 'quantity': 1,
                       'payment_required': True, 'amount_due_cents': 1500,
                       'payment_id': kind + '-payment', 'checkout_url': 'https://checkout.stripe.com/test-fixture'}
            with self.subTest(kind=kind), patch.object(plugin, '_post_bot', return_value=receipt) as post:
                result = json.loads(plugin.add_service_to_booking(params))
            payload = post.call_args.args[1]
            self.assertTrue(payload['confirm'])
            self.assertEqual(payload['booking_guest_id'], 'jonas-id')
            self.assertEqual(payload.get('service_date'), date)
            self.assertEqual(result['booking_guest_id'], 'jonas-id')
            self.assertEqual(result['guest_name'], 'Jonas Keller')
            self.assertTrue(result['write_performed'])
            self.assertTrue(result['payment_link_created'])
            self.assertEqual(result['next_action'], 'create_balance_payment_link')

    def test_failed_write_retains_diagnostic_and_requires_real_handoff(self):
        with patch.object(plugin, '_post_bot', return_value={
                'success': False, 'staff_api_status': 'error', 'staff_review_needed': True,
                'error': 'addon_create_failed', 'write_performed': False}):
            result = json.loads(plugin.add_service_to_booking({'service_type': 'meal'}))
        self.assertFalse(result['success'])
        self.assertFalse(result['write_performed'])
        self.assertTrue(result['staff_review_needed'])
        self.assertEqual(result['error'], 'addon_create_failed')
        self.assertIn('flag_needs_human', result['guidance'])
        self.assertIn('handoff_persisted', result['guidance'])


if __name__ == '__main__':
    unittest.main()
