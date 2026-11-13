"""Offline registered create boundary: dropped responses reuse one frozen operation."""
from copy import deepcopy
import http.client
import io
import json
import urllib.parse
import unittest
from unittest.mock import patch

from wolfhouse import test_no_final_ask as fixture
from wolfhouse import accepted_quote as owner
import wolfhouse_staff_api as plugin


class BookingConnectionRecoveryTests(unittest.TestCase):
    setUp = fixture.NoFinalAskTests.setUp
    tearDown = fixture.NoFinalAskTests.tearDown
    call = fixture.NoFinalAskTests.call
    staff = fixture.NoFinalAskTests.staff

    def test_disconnect_before_write_retries_same_operation_and_completes(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        attempts = []
        def urlopen(request, **kwargs):
            path = urllib.parse.urlsplit(request.full_url).path.removeprefix('/staff/bot')
            body = json.loads(request.data)
            if path == '/booking-create-from-plan':
                attempts.append(deepcopy(body))
                if len(attempts) == 1:
                    raise http.client.RemoteDisconnected('Remote end closed connection without response')
            return io.BytesIO(json.dumps(self.staff(path, body)).encode())
        with patch.dict('os.environ', {'LUNA_BOT_INTERNAL_TOKEN': 'offline-token',
                'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid'}), \
             patch.object(plugin.urllib.request, 'urlopen', side_effect=urlopen):
            self.call('quote_booking', self.case['quote_args'])
            result = self.call('create_booking_from_plan', self.case['create_args'])
        self.assertTrue(result.get('success'), result)
        self.assertTrue(result.get('payment_link_created'), result)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0], attempts[1])
        self.assertTrue(attempts[0]['idempotency_key'])
        self.assertEqual(sum(p == '/booking-create-from-plan' for p, _ in self.calls), 1)
        self.assertFalse(any(p == '/conversation/needs-human' for p, _ in self.calls))
        self.assertEqual(owner.current_create_receipt()['booking_id'], result['booking_id'])

    def test_lost_committed_response_recovers_receipt_without_new_operation(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        attempts, saved = [], {}
        def urlopen(request, **kwargs):
            path = urllib.parse.urlsplit(request.full_url).path.removeprefix('/staff/bot')
            body = json.loads(request.data)
            if path == '/booking-create-from-plan':
                attempts.append(deepcopy(body))
                key = body['idempotency_key']
                if key not in saved:
                    saved[key] = self.staff(path, body)
                    raise http.client.RemoteDisconnected('lost committed response')
                response = dict(saved[key], idempotent=True, duplicate=True, write_performed=False)
            else:
                response = self.staff(path, body)
            return io.BytesIO(json.dumps(response).encode())
        with patch.dict('os.environ', {'LUNA_BOT_INTERNAL_TOKEN': 'offline-token',
                'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid'}), \
             patch.object(plugin.urllib.request, 'urlopen', side_effect=urlopen):
            self.call('quote_booking', self.case['quote_args'])
            result = self.call('create_booking_from_plan', self.case['create_args'])
            replay = self.call('create_booking_from_plan', self.case['create_args'])
        self.assertTrue(result.get('success'), result)
        self.assertTrue(result.get('payment_link_created'), result)
        self.assertEqual(sum(p.startswith('/payments/') for p, _ in self.calls), 1)
        self.assertEqual(replay['booking_id'], result['booking_id'])
        self.assertEqual(len(saved), 1)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0], attempts[1])
        self.assertFalse(any(p == '/conversation/needs-human' for p, _ in self.calls))

    def test_exhaustion_is_bounded_and_does_not_claim_saved(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        attempts = []
        def urlopen(request, **kwargs):
            path = urllib.parse.urlsplit(request.full_url).path.removeprefix('/staff/bot')
            body = json.loads(request.data)
            if path == '/booking-create-from-plan':
                attempts.append(deepcopy(body))
                raise http.client.RemoteDisconnected('connection remains down')
            return io.BytesIO(json.dumps(self.staff(path, body)).encode())
        with patch.dict('os.environ', {'LUNA_BOT_INTERNAL_TOKEN': 'offline-token',
                'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid'}), \
             patch.object(plugin.urllib.request, 'urlopen', side_effect=urlopen):
            self.call('quote_booking', self.case['quote_args'])
            result = self.call('create_booking_from_plan', self.case['create_args'])
        self.assertFalse(result.get('success'), result)
        self.assertFalse(result.get('booking_id'), result)
        self.assertEqual(len(attempts), 3)
        self.assertTrue(all(a == attempts[0] for a in attempts))
        self.assertFalse(any('/payments/' in p for p, _ in self.calls))

    def test_no_retry_for_business_refusal_unkeyed_create_or_other_writes(self):
        import urllib.error
        from email.message import Message
        cases = [
            ('/booking-create-from-plan', {'idempotency_key': 'same-key'},
             urllib.error.HTTPError('https://offline.invalid', 409, 'Conflict', Message(),
                io.BytesIO(b'{"success":false,"block_reason":"overlap_conflict"}'))),
            ('/booking-create-from-plan', {}, http.client.RemoteDisconnected('drop')),
            ('/payments/p1/create-stripe-link', {'idempotency_key': 'same-key'},
             http.client.RemoteDisconnected('drop')),
            ('/booking-create-from-plan', {'idempotency_key': 'same-key'},
             urllib.error.URLError('invalid configuration')),
        ]
        for path, body, error in cases:
            with self.subTest(path=path, error=type(error).__name__), \
                 patch.dict('os.environ', {'LUNA_BOT_INTERNAL_TOKEN': 'offline-token',
                    'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid'}), \
                 patch.object(plugin.urllib.request, 'urlopen', side_effect=error) as transport:
                result = plugin._post_bot(path, body)
                self.assertFalse(result['success'], result)
                self.assertEqual(transport.call_count, 1)


if __name__ == '__main__':
    unittest.main()
