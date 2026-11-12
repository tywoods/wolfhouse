"""Offline actual transport regression: Jonas dinner/yoga in the Staff test chat."""
import json
import unittest
from unittest.mock import patch

import wolfhouse.crowsnest_guest_door as door
import wolfhouse_staff_api as plugin
from wolfhouse.test_crowsnest_guest_door import _FakeWhatsApp

BOOKING = '44444444-4444-4444-8444-444444444444'
GUEST = '22222222-2222-4222-8222-222222222222'
CODE = 'WH-20270618-15443747'
ENV = {
    'HERMES_ROLE': 'luna', 'LUNA_TENANT_ID': 'wolfhouse-somo',
    'LUNA_CLIENT_SLUG': 'wolfhouse-somo',
    'WOLFHOUSE_STAFF_API_BASE_URL': 'https://staff-staging.lunafrontdesk.com',
    'PUBLIC_PAYMENT_BASE_URL': 'https://staff-staging.lunafrontdesk.com',
    'WOLFHOUSE_STRIPE_MODE': 'test', 'STRIPE_SECRET_KEY': 'sk_test_offline_fixture',
    'LUNA_ALLOWED_LOCATION_IDS': '', 'SUNSET_INGRESS_LOCATION_ID': '',
}


class NamedAddonTransportTests(unittest.TestCase):
    def exercise(self, code=CODE, environment=None):
        scope = door.CrowsnestGuestScope.create('+34' + '600023001')
        scope.conversation_id = '11111111-1111-4111-8111-111111111111'
        calls = []

        class Response:
            def __init__(self, data): self.data = json.dumps(data).encode()
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self): return self.data

        def http(req, **kwargs):
            path = req.full_url.split('.com', 1)[1]
            payload = json.loads(req.data)
            calls.append((path, payload))
            if path == '/staff/bot/bookings/by-phone':
                return Response({'success': True, 'bookings': [{
                    'booking_id': BOOKING, 'booking_code': CODE, 'location_id': 'wolfhouse-somo',
                    'conversation_id': scope.conversation_id}]})
            if path == '/staff/bot/addon-requests/create':
                return Response({'success': True, 'write_performed': True,
                    'booking_id': BOOKING, 'booking_code': CODE, 'booking_guest_id': GUEST,
                    'guest_name': 'Jonas Keller', 'service_record_id': payload['service_type'],
                    'service_type': payload['service_type'], 'service_date': payload.get('service_date'),
                    'payment_required': True, 'amount_due_cents': 1500,
                    'checkout_url': 'https://checkout.stripe.com/c/pay/cs_test_fixture'})
            if path == '/staff/bot/payments/create-balance-link':
                return Response({'success': True, 'booking_id': BOOKING, 'booking_code': CODE,
                    'guest_payment_url': 'https://staff-staging.lunafrontdesk.com/pay/' + CODE})
            self.fail('unexpected outbound request: ' + path)

        original = plugin._post_bot
        original_phone = plugin._session_guest_phone
        door._INSTALLED_STAFF.discard(id(plugin))
        door.install_request_owned_guards(plugin, _FakeWhatsApp)
        token = door._SCOPE.set(scope)
        try:
            with patch.dict('os.environ', {**ENV, **(environment or {})}), \
                 patch.object(plugin, '_bot_token', return_value='offline-fixture'), \
                 patch.object(plugin.urllib.request, 'urlopen', side_effect=http):
                meal = json.loads(plugin.add_service_to_booking({'booking_code': code,
                    'booking_guest_id': GUEST, 'service_type': 'meal', 'quantity': 1,
                    'service_date': '2027-06-20'}))
                yoga = json.loads(plugin.add_service_to_booking({'booking_code': code,
                    'booking_guest_id': GUEST, 'service_type': 'yoga', 'quantity': 1}))
                link = json.loads(plugin.create_balance_payment_link({'booking_code': code}))
        finally:
            door._SCOPE.reset(token)
            plugin._post_bot = original
            plugin._session_guest_phone = original_phone
            door._INSTALLED_STAFF.discard(id(plugin))
        return meal, yoga, link, calls, scope

    def test_dinner_and_open_date_yoga_reach_real_transport_for_owned_booking(self):
        meal, yoga, link, calls, scope = self.exercise()
        self.assertTrue(meal['write_performed'], meal)
        self.assertTrue(yoga['write_performed'], yoga)
        self.assertEqual(meal['booking_guest_id'], GUEST)
        self.assertTrue(link['success'], link)
        self.assertEqual(link['secure_payment_url'], ENV['PUBLIC_PAYMENT_BASE_URL'] + '/pay/' + CODE)
        writes = [(p, b) for p, b in calls if p != '/staff/bot/bookings/by-phone']
        self.assertEqual(len(writes), 3)
        self.assertEqual(writes[0][1]['service_date'], '2027-06-20')
        self.assertNotIn('service_date', writes[1][1])
        for path, body in writes:
            self.assertEqual(body['booking_id'], BOOKING)
            self.assertTrue(body['suppress_notifications'])
            self.assertTrue(body['suppress_approvals'])
            self.assertNotIn('allow_writes', body)
        self.assertFalse(any(c.get('allow_writes') is True for c in scope.tool_calls))

    def test_foreign_booking_never_gets_addons_or_balance_link(self):
        meal, yoga, link, calls, _ = self.exercise('WH-OTHER-BOOKING')
        self.assertFalse(meal['write_performed'])
        self.assertFalse(yoga['write_performed'])
        self.assertFalse(link['success'])
        self.assertTrue(all(p == '/staff/bot/bookings/by-phone' for p, _ in calls))


if __name__ == '__main__':
    unittest.main()
