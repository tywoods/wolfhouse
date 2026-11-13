"""Offline 3→4 re-quote: original request bytes -> production Staff reader/tenant
 dispatch/create-from-plan wrapper -> real PGlite SQL. No sockets or staging.
Model decisions/wording and payment-link provider edge are mocked; successful
booking receipts, pricing, offer checks and persistence are NOT mocked.
"""
import copy
import io
import json
import os
from http.client import RemoteDisconnected
from pathlib import Path
import unittest
from urllib.error import HTTPError
from urllib.parse import urlsplit

from wolfhouse import test_first_yes_persistence as harness
from wolfhouse import test_serious_booking_persistence as serious


class RequotedSaveStaffBodyTests(unittest.TestCase):
    rpc = serious.SeriousBookingPersistenceTests.rpc
    turn = serious.SeriousBookingPersistenceTests.turn
    clear_context = serious.SeriousBookingPersistenceTests.clear_context
    close_node = serious.SeriousBookingPersistenceTests.close_node
    quote = serious.SeriousBookingPersistenceTests.quote
    assert_saved = serious.SeriousBookingPersistenceTests.assert_saved
    assert_mock_link_completed = serious.SeriousBookingPersistenceTests.assert_mock_link_completed

    def setUp(self):
        serious.SeriousBookingPersistenceTests.setUp(self)
        harness.PLAN.update(check_in='2027-11-08', check_out='2027-11-14', group_gender='mixed')
        harness.PLAN['guests'][1]['explicit_gender'] = 'female'
        self.rpc(requoted_staff_body_pricing=True)
        self.drop_receipt = True

    def http_edge(self, request, **kwargs):
        path = urlsplit(request.full_url).path
        if not path.endswith('/booking-create-from-plan'):
            return serious.SeriousBookingPersistenceTests.http_edge(self, request, **kwargs)
        raw = request.data.decode('utf8')
        self.attempts.append(raw)
        self.assertGreater(len(request.data), 10240, 'Natural accepted-offer request must exceed old cap')
        result = self.rpc(path='/booking-create-from-plan', body=json.loads(raw), raw_body=raw,
                          staff_body_stream=True, guest_phone=request.get_header('X-luna-guest-phone'))
        if result['status'] >= 400:
            raise HTTPError(request.full_url, result['status'], 'Actual Staff reader/handler refusal', {},
                            io.BytesIO(json.dumps(result['body']).encode()))
        if self.drop_receipt:
            self.drop_receipt = False
            self.assertTrue(result['body'].get('write_performed'), result)
            self.checkpoints['lost_receipt'] = copy.deepcopy(result)
            self.checkpoints['at_drop'] = self.rpc(snapshot=True)
            raise RemoteDisconnected('OFFLINE lost receipt AFTER actual Staff wrapper / SQL commit')
        body = io.BytesIO(json.dumps(result['body']).encode())
        body.status, body.headers = result['status'], {}
        return body

    def test_november_three_to_four_over_10kb_saves_once_and_returns_one_deposit_link(self):
        old = self.quote('three-person-quote')
        self.assertEqual(old['total_cents'], 74700, old)
        harness.PLAN['guest_count'] = 4
        harness.PLAN['selected_bed_codes'] = ['R1-B1', 'R1-B2', 'R1-B3', 'R1-B4']
        harness.PLAN['guests'].append({'name': 'Sam', 'explicit_gender': 'male'})
        revised = self.quote('four-person-revised-quote')
        self.assertEqual(revised['total_cents'], 99600, revised)
        self.assertNotEqual(old['offer_fingerprint'], revised['offer_fingerprint'])
        result = self.turn('yes', 'accepted-revised-offer')
        snapshot = self.rpc(snapshot=True)
        creates = [c for c in snapshot['calls'] if c['path'] == '/booking-create-from-plan']
        self.assertTrue(result['booking_result'].get('success'),
                        {'receipt': result['booking_result'], 'creates': creates})
        self.assertEqual(len(creates), 2)
        self.assertEqual(self.attempts[0], self.attempts[1], 'Retry preserves exact unpadded bytes')
        payload = json.loads(self.attempts[0])
        self.assertEqual(payload['accepted_offer'], revised)
        self.assertTrue(payload['idempotency_key'])
        self.assertEqual(payload['guest_count'], 4)
        self.assertFalse(payload.get('per_guest_payment_links'))
        for call in creates:
            self.assertGreater(call['transport']['bytes'], 10240)
            self.assertNotIn('reader_error', call['transport'])
            self.assertEqual(call['transport']['url'], '/staff/bot/booking-create-from-plan')
            self.assertTrue(call['transport']['handler_called'])
            self.assertEqual(call['transport']['bound_client_slug'], 'wolfhouse-somo')
        snapshot = self.assert_saved(revised, 4)
        self.assertEqual(snapshot['tables'], self.checkpoints['at_drop']['tables'])
        self.assertEqual(snapshot['tables']['bookings'][0]['total_amount_cents'], 99600)
        guests = sorted(snapshot['tables']['booking_guests'], key=lambda row: row['guest_number'])
        self.assertEqual([(row['guest_name'], row['assigned_bed_code']) for row in guests],
                         [('Riley', 'R1-B1'), ('Morgan', 'R1-B2'), ('Alex', 'R1-B3'), ('Sam', 'R1-B4')])
        self.assertEqual(sorted(row['bed_code'] for row in snapshot['tables']['booking_beds']),
                         ['R1-B1', 'R1-B2', 'R1-B3', 'R1-B4'])
        for row in snapshot['tables']['booking_beds']:
            self.assertEqual(row['booking_id'], snapshot['tables']['bookings'][0]['id'])
            self.assertEqual(row['assignment_start_date'][:10], '2027-11-08')
            self.assertEqual(row['assignment_end_date'][:10], '2027-11-14')
        self.assertEqual(creates[-1]['response']['body']['booking_id'],
                         self.checkpoints['lost_receipt']['body']['booking_id'])
        self.assertEqual(creates[-1]['response']['body']['payment_id'],
                         self.checkpoints['lost_receipt']['body']['payment_id'])
        self.assertTrue(creates[-1]['response']['body']['idempotent'])
        self.assert_mock_link_completed(result, snapshot)

    def tearDown(self):
        target = os.getenv('REQUOTED_STAFF_BODY_EVIDENCE_DIR')
        if target and hasattr(self, 'rpc_lock'):
            directory = Path(target)
            directory.mkdir(parents=True, exist_ok=True)
            (directory / (self._testMethodName + '.json')).write_text(json.dumps({
                'case': self.id(), 'limitations': __doc__, 'checkpoints': self.checkpoints,
                'create_request_bytes': self.attempts, 'mock_payment_edges': self.payment_edges,
                'messages': self.messages, 'snapshot': self.rpc(snapshot=True)}, indent=2) + '\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
