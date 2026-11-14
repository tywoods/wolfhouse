"""Offline real-plugin/transport regression: saved separate payments on a later turn."""
import json
import unittest
from unittest.mock import patch
import wolfhouse.crowsnest_guest_door as door
import wolfhouse_staff_api as plugin
from wolfhouse.test_crowsnest_guest_door import _FakeWhatsApp
from wolfhouse.test_crowsnest_named_addons import ENV, BOOKING, CODE

GUESTS = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']

class SavedGuestPayments(unittest.TestCase):
    def exercise(self, foreign=False, tenant="wolfhouse-somo", mismatched_guest=False, add_guest=False, followthrough=None, group_choice=None):
        scope = door.CrowsnestGuestScope.create('+34600023001')
        scope.conversation_id = '11111111-1111-4111-8111-111111111111'
        calls = []
        class Response:
            def __init__(self, value): self.data = json.dumps(value).encode()
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self): return self.data
        def http(req, **kwargs):
            path = req.full_url.split('.com', 1)[1]
            body = json.loads(req.data)
            calls.append((path, body))
            if path == '/staff/bot/payments/prepare':
                return Response({'success': True, 'booking_id': BOOKING,
                        'payment_id': '44444444-4444-4444-8444-444444444444'})
            if path.endswith('/payments/status'):
                return Response({'success': True, 'booking_id': BOOKING, 'booking_code': CODE, 'latest_payment': None})
            if path.endswith('/create-stripe-link'):
                return Response({'success': True, 'booking_id': BOOKING, 'booking_code': CODE,
                    'payment_short_url': ENV['PUBLIC_PAYMENT_BASE_URL'] + '/pay/' + CODE})
            if path.endswith('/bookings/by-phone'):
                return Response({'success': True, 'bookings': [{
                    'booking_id': BOOKING, 'booking_code': CODE, 'client_slug': tenant,
                    'conversation_id': 'foreign' if foreign else scope.conversation_id}]})
            if path.endswith('/booking-guests/payment-status'):
                gid = body.get('booking_guest_id') or GUESTS[int(body['guest_number']) - 1]
                return Response({'success': True, 'booking_guest_id': GUESTS[1 - GUESTS.index(gid)] if mismatched_guest else gid, 'booking_id': BOOKING,
                    'booking_code': CODE, 'guest_number': GUESTS.index(gid) + 1})
            if path.endswith('/bookings/add-guest'):
                return Response({'success': True, 'write_performed': True, 'booking_code': CODE,
                    'booking_guest_id': GUESTS[1], 'guest_name': 'Tom', 'guest_number': 2,
                    'assigned_bed_code': 'R1-B2', 'total_amount_cents': 59800})
            if path.endswith('/create-payment-link'):
                gid = path.split('/booking-guests/')[1].split('/')[0]
                number = GUESTS.index(gid) + 1
                return Response({'success': True, 'booking_id': BOOKING, 'booking_code': CODE,
                    'booking_guest_id': gid, 'guest_number': number, 'guest_name': ['Ola', 'Pia'][number - 1],
                    'amount_due_cents': 20000 if body['payment_target'] == 'deposit' else 29900, 'payment_status': 'checkout_created',
                    'guest_payment_url': ENV['PUBLIC_PAYMENT_BASE_URL'] + '/pay/' + CODE + '/g' + str(number)})
            if path.endswith('/conversation/needs-human'):
                return Response({'success': True, 'needs_human': True, 'handoff_persisted': True})
            self.fail('Unexpected HTTP: ' + path)
        original = (plugin._post_bot, plugin._session_guest_phone, plugin._live_turn_guest_phone)
        door._INSTALLED_STAFF.discard(id(plugin))
        door.install_request_owned_guards(plugin, _FakeWhatsApp)
        token = door._SCOPE.set(scope)
        try:
            with patch.dict('os.environ', ENV), patch.object(plugin, '_bot_token', return_value='offline-fixture'), \
                 patch.object(plugin.urllib.request, 'urlopen', side_effect=http):
                if group_choice:
                    results = [json.loads(plugin.create_payment_link({
                        'booking_code': CODE, 'payment_choice': group_choice}))]
                elif add_guest:
                    results = [json.loads(plugin.add_guest_to_booking({
                        'booking_code': CODE, 'guest_name': 'Tom'}))]
                    if followthrough:
                        later = door.CrowsnestGuestScope.create(scope.synthetic_phone)
                        later.conversation_id = scope.conversation_id
                        later_token = door._SCOPE.set(later)
                        try:
                            results.append(json.loads(plugin.create_guest_payment_link({
                                'booking_guest_id': results[0]['booking_guest_id'],
                                'payment_target': followthrough})))
                        finally:
                            door._SCOPE.reset(later_token)
                else:
                    results = [json.loads(plugin.create_guest_payment_link({
                        'booking_code': CODE, 'guest_number': number, 'payment_target': 'deposit'}))
                        for number in (1, 2)]
        finally:
            door._SCOPE.reset(token)
            plugin._post_bot, plugin._session_guest_phone, plugin._live_turn_guest_phone = original
            door._INSTALLED_STAFF.discard(id(plugin))
        return results, calls

    def test_two_saved_guests_receive_one_personal_link_each_on_new_request(self):
        results, calls = self.exercise()
        self.assertTrue(all(r['success'] for r in results), results)
        self.assertEqual(len({r['secure_payment_url'] for r in results}), 2)
        writes = [(p, b) for p, b in calls if p.endswith('/create-payment-link')]
        self.assertEqual(len(writes), 2)
        self.assertTrue(all(b['payment_target'] == 'deposit' for _, b in writes))
        self.assertFalse(any('/payments/' in p for p, _ in calls))

    def test_other_conversation_never_authorizes_guest_link(self):
        results, calls = self.exercise(foreign=True)
        self.assertFalse(any(r['success'] for r in results))
        self.assertFalse(any(p.endswith('/create-payment-link') for p, _ in calls))

    def test_prepare_group_payment_requires_durable_conversation_ownership(self):
        for choice in ('deposit', 'full'):
            for foreign in (False, True):
                with self.subTest(choice=choice,foreign=foreign):
                    results,calls = self.exercise(foreign=foreign,group_choice=choice)
                    if foreign:
                        self.assertFalse(results[0].get('success'))
                        self.assertFalse(any(p.endswith('/prepare-payment') or p.endswith('/create-stripe-link') for p,_ in calls))
                    else:
                        self.assertTrue(results[0].get('success'), results)
                        self.assertEqual([p for p,_ in calls].count('/staff/bot/payments/prepare'), 1)
                        self.assertEqual(sum(p.endswith('/create-stripe-link') for p,_ in calls), 1)

    def test_saved_guest_addition_reaches_only_owned_booking_before_payment(self):
        results, calls = self.exercise(add_guest=True)
        self.assertTrue(results[0]['success'], results)
        self.assertTrue(results[0]['payment_choice_needed'])
        writes = [(p, b) for p, b in calls if p.endswith('/bookings/add-guest')]
        self.assertEqual(len(writes), 1)
        self.assertTrue(writes[0][1]['idempotency_key'])
        self.assertFalse(any(p.endswith('/create-payment-link') for p, _ in calls))

    def test_added_guest_gets_one_personal_link_after_later_amount_choice(self):
        for target, amount in [('deposit', 20000), ('full_share', 29900)]:
            with self.subTest(target=target):
                results, calls = self.exercise(add_guest=True, followthrough=target)
                self.assertTrue(all(r['success'] for r in results), results)
                writes = [(p,b) for p,b in calls if p.endswith('/create-payment-link')]
                self.assertEqual(len(writes), 1)
                self.assertIn(GUESTS[1], writes[0][0])
                self.assertEqual(writes[0][1]['payment_target'], target)
                self.assertEqual(results[1]['amount_due_cents'], amount)
                self.assertFalse(any('/payments/' in p for p,_ in calls))

    def test_foreign_saved_booking_cannot_get_added_guest(self):
        results, calls = self.exercise(add_guest=True, foreign=True)
        self.assertFalse(results[0]['success'])
        self.assertFalse(any(p.endswith('/bookings/add-guest') for p, _ in calls))

    def test_other_tenant_never_authorizes_guest_link(self):
        results, calls = self.exercise(tenant='sunset')
        self.assertFalse(any(r['success'] for r in results))
        self.assertFalse(any(p.endswith('/create-payment-link') for p, _ in calls))

    def test_status_for_a_different_person_cannot_authorize_uuid(self):
        results, calls = self.exercise(mismatched_guest=True)
        self.assertFalse(any(r['success'] for r in results))
        self.assertFalse(any(p.endswith('/create-payment-link') for p, _ in calls))

if __name__ == '__main__': unittest.main()
