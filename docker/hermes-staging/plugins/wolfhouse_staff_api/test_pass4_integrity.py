"""PASS4 offline regressions. Mock Staff transport; sockets forbidden, no live sims."""
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'docker/hermes-staging'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wolfhouse_staff_api as plugin


class Registry:
    def __init__(self):
        self.tools = {}
    def register_tool(self, **tool):
        self.tools[tool['name']] = tool


class Pass4IntegrityTests(unittest.TestCase):
    def setUp(self):
        for guard in (patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}, clear=True),
                      patch('socket.socket.connect', side_effect=AssertionError('offline only')),
                      patch('socket.create_connection', side_effect=AssertionError('offline only')),
                      patch('urllib.request.urlopen', side_effect=AssertionError('offline only'))):
            guard.start()
            self.addCleanup(guard.stop)
        self.params = {'check_in': '2026-10-26', 'check_out': '2026-10-30',
                       'guest_count': 2, 'guest_name': 'Riley Chen',
                       'guests': [{'name': 'Riley Chen'}, {'name': 'Morgan Blake'}],
                       'room_preference': 'mixed', 'selected_bed_codes': ['R3-B1', 'R3-B2'],
                       'package_code': 'package_none', 'payment_choice': 'deposit',
                       'add_ons': [{'code': 'yoga_class', 'quantity': 2}],
                       'catalog_selections': [{'service_id': 'offline-drone', 'name': 'Drone',
                                               'service_date': '2026-10-30', 'quantity': 2, 'days': 1}]}

    def test_catalog_selection_is_persisted_before_payment_link(self):
        calls = []
        def transport(path, body):
            calls.append((path, body))
            if path == '/booking-create-from-plan':
                return {'success': True, 'write_performed': True, 'booking_code': 'OFFLINE',
                        'booking_id': 'offline-booking', 'payment_id': 'offline-payment'}
            if path == '/add-catalog-service':
                return {'success': True, 'write_performed': True, 'created': True,
                        'service_record_id': 'offline-drone-record'}
            return {'success': True, 'checkout_url': 'https://staff.invalid/pay/OFFLINE',
                    'expires_at': '2026-10-07T12:00:00Z'}
        with patch.object(plugin, '_post_bot', side_effect=transport):
            result = json.loads(plugin.create_booking_from_plan(self.params))
        self.assertEqual([path for path, _ in calls], [
            '/booking-create-from-plan', '/add-catalog-service',
            '/payments/offline-payment/create-stripe-link'])
        self.assertEqual(calls[1][1]['service_type'], 'service:offline-drone')
        self.assertEqual(calls[1][1]['quantity'], 2)
        self.assertTrue(result['catalog_selections_persisted'])
        self.assertTrue(result['success'])
        self.assertEqual(result['payment_deadline'], '2026-10-07T12:00:00Z')

    def test_catalog_attach_failure_returns_no_payment_link(self):
        calls = []
        def transport(path, body):
            calls.append((path, body))
            if path == '/booking-create-from-plan':
                return {'success': True, 'write_performed': True, 'booking_code': 'OFFLINE',
                        'booking_id': 'offline-booking', 'payment_id': 'offline-payment'}
            return {'success': False, 'write_performed': False, 'error': 'catalog attach failed'}
        with patch.object(plugin, '_post_bot', side_effect=transport):
            result = json.loads(plugin.create_booking_from_plan(self.params))
        self.assertEqual([path for path, _ in calls], [
            '/booking-create-from-plan', '/add-catalog-service'])
        self.assertFalse(result['success'])
        self.assertFalse(result['catalog_selections_persisted'])
        self.assertIsNone(result['secure_payment_url'])
        self.assertFalse(result['payment_link_created'])
        self.assertEqual(result['next_action'], 'retry_booking_create_with_same_catalog_selections')

    def test_catalog_retry_and_reordering_use_service_identity(self):
        attach_bodies = []
        def transport(path, body):
            if path == '/booking-create-from-plan':
                return {'success': True, 'write_performed': False, 'booking_code': 'OFFLINE',
                        'booking_id': 'offline-booking', 'payment_id': None}
            attach_bodies.append(body)
            return {'success': True, 'created': False, 'idempotent': True}
        params = dict(self.params)
        params['catalog_selections'] = [
            {'service_id': 'drone', 'quantity': 2, 'service_date': '2026-10-07'},
            {'service_id': 'yoga', 'quantity': 2, 'service_date': '2026-10-08'},
        ]
        with patch.object(plugin, '_post_bot', side_effect=transport):
            first = json.loads(plugin.create_booking_from_plan(params))
            params['catalog_selections'].reverse()
            second = json.loads(plugin.create_booking_from_plan(params))
        self.assertTrue(first['catalog_selections_persisted'])
        self.assertTrue(second['catalog_selections_persisted'])
        first_keys = {body['service_type']: body['idempotency_key'] for body in attach_bodies[:2]}
        second_keys = {body['service_type']: body['idempotency_key'] for body in attach_bodies[2:]}
        self.assertEqual(first_keys, second_keys)
        self.assertNotEqual(first_keys['service:drone'], first_keys['service:yoga'])


    def test_registered_schema_preserves_catalog_and_dynamic_minimum(self):
        registry = Registry()
        plugin.register(registry)
        for name in ('quote_booking', 'create_booking_from_plan'):
            tool = registry.tools[name]
            properties = tool['schema']['parameters']['properties']
            selection = properties['catalog_selections']['items']
            self.assertEqual(selection['anyOf'], [{'required': ['service_id']}, {'required': ['service_code']}])
            self.assertIn('service_code', selection['properties'])
            self.assertIn('service_date', selection['properties'])
            self.assertNotIn('7+', properties['package_code']['description'])
            self.assertNotIn('<7', tool['description'])
        with patch.object(plugin, '_post_bot') as transport:
            result = json.loads(registry.tools['quote_booking']['handler'](self.params))
        transport.assert_not_called()
        self.assertEqual(result['error'], 'catalog_selection_not_atomic')

    def test_catalog_inventory_preserves_authoritative_facts_and_failure_is_unknown(self):
        facts = {'name': 'Drone', 'price_cents': 15000, 'price_unit': 'day',
                 'per_guest': True, 'active_until': '2026-10-30'}
        for success in (True, False):
            with self.subTest(success=success), patch.object(plugin, '_post_bot', return_value={
                'success': success, 'matched': True, 'service': facts,
                'within_window': True, 'facts': facts, 'reply': 'Drone is available.'}):
                result = json.loads(plugin.lookup_catalog_service({
                    'message_text': 'Drone', 'check_in': '2026-10-26', 'check_out': '2026-10-30', 'guest_count': 2}))
            if success:
                self.assertEqual(result['facts'], facts)
                self.assertTrue(result['within_window'])
            else:
                self.assertFalse(result['matched'])
                self.assertIsNone(result['facts'])
                self.assertIsNone(result['guest_safe_next_action'])

    def test_soul_requires_no_degraded_create_and_grounded_inventory(self):
        soul = (ROOT / 'docker/hermes-staging/SOUL.md').read_text()
        for rule in ('Never create a reduced booking', 'explicit guest decision',
                     'current authoritative Staff response', 'Missing facts mean unknown',
                     'staff_review_needed` alone is not persisted notification'):
            self.assertIn(rule, soul)
        self.assertNotIn('create_booking_from_plan using the **camp dates**', soul)

    def test_named_group_full_payment_uses_whole_booking_link(self):
        params = {k: v for k, v in self.params.items() if k != 'catalog_selections'}
        params['payment_choice'] = 'full'
        receipt = {'success': True, 'write_performed': True, 'booking_code': 'OFFLINE',
                   'payment_id': 'offline-payment', 'uses_per_guest_model': True,
                   'booking_guests': [{'booking_guest_id': 'offline-g1', 'guest_number': 1},
                                      {'booking_guest_id': 'offline-g2', 'guest_number': 2}]}
        calls = []
        def transport(path, body):
            calls.append((path, body))
            if path == '/booking-create-from-plan':
                return receipt
            return {'success': True, 'guest_payment_url': 'https://staff.invalid/pay/OFFLINE',
                    'amount_due_cents': 47000}
        with patch.object(plugin, '_post_bot', side_effect=transport):
            result = json.loads(plugin.create_booking_from_plan(params))
        self.assertEqual([p for p, _ in calls], ['/booking-create-from-plan',
                                               '/payments/offline-payment/create-stripe-link'])
        self.assertEqual(result['secure_payment_url'], 'https://staff.invalid/pay/OFFLINE')
        self.assertEqual(result['amount_due_cents'], 47000)
        self.assertFalse(result.get('guest_payment_links'))
        self.assertEqual(calls[0][1]['guests'], params['guests'])

    def test_standalone_payment_tools_propagate_deadlines(self):
        deadline = '2026-10-07T12:00:00Z'
        def transport(path, body):
            if path.endswith('/create-stripe-link'):
                return {'success': True, 'payment_id': 'p1',
                        'checkout_url': 'https://checkout.stripe.com/c/pay/whole',
                        'expires_at': deadline}
            if path.endswith('/create-payment-link'):
                return {'success': True, 'booking_guest_id': 'g1',
                        'guest_payment_url': 'https://staff.invalid/pay/OFFLINE/g1',
                        'expires_at': deadline}
            raise AssertionError(path)
        with patch.object(plugin, '_post_bot', side_effect=transport):
            whole = json.loads(plugin.create_payment_link({'payment_id': 'p1'}))
            guest = json.loads(plugin.create_guest_payment_link({'booking_guest_id': 'g1'}))
        for result in (whole, guest):
            self.assertEqual(result['expires_at'], deadline)
            self.assertEqual(result['payment_deadline'], deadline)


if __name__ == '__main__':
    unittest.main()
