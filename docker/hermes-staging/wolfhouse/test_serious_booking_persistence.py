"""Incident regressions: real Staff handlers/PGlite, never a mocked create receipt.

The fixture's create-from-plan label calls handleBotBookingCreate directly, NOT
production route middleware. LLM/HTTP edges are offline; payment URL is explicitly
mocked (no Stripe/payment collection). Inventory/prices are synthetic SQL fixtures,
not a claim about live availability. Run with the existing first-yes Hermes setup.
"""
import copy
import io
import json
import os
from http.client import IncompleteRead, RemoteDisconnected
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from wolfhouse import test_first_yes_persistence as harness

R1 = dict(check_in='2027-09-08', check_out='2027-09-14', guest_count=3,
          guest_name='Riley', guests=[{'name': n, 'explicit_gender': 'male'}
                                    for n in ('Riley', 'Morgan', 'Alex')],
          phone=harness.PLAN['phone'], package_code='malibu', room_type='shared',
          room_preference='shared', group_gender='male', payment_choice='deposit',
          payment_link_distribution='together', per_guest_payment_links=False)
R9 = dict(check_in='2027-10-06', check_out='2027-10-12', guest_count=3,
          guest_name='Riley', guests=[
              {'name': 'Riley', 'explicit_gender': 'female', 'selected_bed_code': 'R5-B1'},
              {'name': 'Maya', 'explicit_gender': 'female', 'selected_bed_code': 'R5-B2'},
              {'name': 'Leo', 'explicit_gender': 'male', 'selected_bed_code': 'R1-B1'}],
          phone=harness.PLAN['phone'], package_code='malibu', room_type='shared',
          room_preference='shared', group_gender='mixed', payment_choice='deposit',
          payment_link_distribution='together', per_guest_payment_links=False,
          selected_bed_codes=['R5-B1', 'R5-B2', 'R1-B1'])


class SeriousBookingPersistenceTests(unittest.TestCase):
    # Reuse the bounded ingress/SQL adapter without inheriting its test cases.
    rpc = harness.FirstYesPersistenceTests.rpc
    turn = harness.FirstYesPersistenceTests.turn
    clear_context = harness.FirstYesPersistenceTests.clear_context
    close_node = harness.FirstYesPersistenceTests.close_node

    def setUp(self):
        self.plan_patch = patch.dict(harness.PLAN, copy.deepcopy(R1), clear=True)
        self.plan_patch.start()
        self.addCleanup(self.plan_patch.stop)
        self.drop = None
        self.attempts = []
        self.payment_edges = []
        self.checkpoints = {}
        harness.FirstYesPersistenceTests.setUp(self)
        self.rpc(serious_booking_setup=True)
        self.direct_create = True

    def http_edge(self, request, **kwargs):
        path = urlsplit(request.full_url).path
        if path.endswith('/create-stripe-link'):
            payment_id = path.split('/')[-2]
            snapshot = self.rpc(snapshot=True)
            self.assertIn(payment_id, [row['id'] for row in snapshot['tables']['payments']])
            self.payment_edges.append({'path': path, 'payment_id': payment_id,
                                       'mode': 'MOCKED offline payment-link edge; NO Stripe'})
            body = io.BytesIO(json.dumps({'success': True,
                'checkout_url': 'https://payments.example.invalid/offline/' + payment_id}).encode())
            body.status, body.headers = 200, {}
            return body
        if path.endswith('/booking-create-from-plan'):
            self.attempts.append(request.data.decode())
            mode, self.drop = self.drop, None
            if mode == 'before':
                self.checkpoints['at_drop'] = self.rpc(snapshot=True)
                raise RemoteDisconnected('OFFLINE injected disconnect BEFORE SQL write')
            if mode in ('after', 'incomplete'):
                response = harness.FirstYesPersistenceTests.http_edge(self, request, **kwargs)
                raw = response.read()
                self.checkpoints['lost_receipt'] = json.loads(raw)
                self.assertTrue(self.checkpoints['lost_receipt'].get('write_performed'))
                self.checkpoints['at_drop'] = self.rpc(snapshot=True)
                if mode == 'incomplete':
                    class PartialReply(io.BytesIO):
                        status, headers = 200, {}

                        def read(self, size: int | None = -1):
                            # urlopen succeeds; the committed response body truncates.
                            raise IncompleteRead(super().read(16), len(raw) - 16)
                    return PartialReply(raw)
                raise RemoteDisconnected('OFFLINE injected lost response AFTER real SQL commit')
        return harness.FirstYesPersistenceTests.http_edge(self, request, **kwargs)

    def quote(self, message_id):
        result = self.turn('Please quote this booking', message_id)
        self.assertTrue(self.quote_result.get('success'), self.quote_result)
        self.assertEqual(self.quote_result.get('availability', {}).get('status'), 'checked', self.quote_result)
        self.assertFalse(self.rpc(snapshot=True)['tables']['bookings'])
        self.checkpoints[message_id] = {'quote': copy.deepcopy(self.quote_result), 'turn': result}
        return self.quote_result['offer_revision']

    def assert_saved(self, revision, count):
        snapshot = self.rpc(snapshot=True)
        self.assertEqual(snapshot['errors'], [])
        tables = snapshot['tables']
        self.assertEqual(len(tables['bookings']), 1, snapshot)
        self.assertEqual(len(tables['booking_beds']), count)
        self.assertEqual(len(tables['booking_guests']), count)
        self.assertEqual(len(tables['payments']), 1)
        guests = sorted(tables['booking_guests'], key=lambda row: row['guest_number'])
        self.assertEqual([(r['guest_name'].lower(), r['assigned_bed_code']) for r in guests],
                         [(r['guest_name'].lower(), r['bed_code']) for r in revision['guest_bed_assignments']])
        self.assertEqual(tables['bookings'][0]['guest_count'], count)
        self.assertEqual(tables['payments'][0]['payment_kind'], 'deposit_only')
        self.assertEqual(tables['bookings'][0]['check_in'][:10], harness.PLAN['check_in'])
        self.assertEqual(tables['bookings'][0]['check_out'][:10], harness.PLAN['check_out'])
        self.assertEqual(tables['bookings'][0]['package_code'], 'malibu')
        self.assertEqual(tables['payments'][0]['amount_due_cents'], revision['payment_link_amount_cents'])
        return snapshot

    def assert_mock_link_completed(self, result, snapshot):
        receipt = result['booking_result']
        self.assertTrue(receipt['success'], receipt)
        self.assertTrue(receipt['payment_link_created'], receipt)
        self.assertEqual(receipt['secure_payment_url'],
                         'https://payments.example.invalid/offline/' + snapshot['tables']['payments'][0]['id'])
        self.assertIn(receipt['secure_payment_url'], result['final_response'])
        self.assertEqual(len(self.payment_edges), 1)

    def run_r1(self, drop):
        old = self.quote('three-person-quote')
        harness.PLAN['guest_count'] = 4
        harness.PLAN['selected_bed_codes'] = ['R1-B1', 'R1-B2', 'R1-B3', 'R1-B4']
        harness.PLAN['guests'].append({'name': 'Sam', 'explicit_gender': 'male'})
        revised = self.quote('four-person-revised-quote')
        self.assertNotEqual(old['offer_fingerprint'], revised['offer_fingerprint'])
        self.assertEqual(len(revised['guest_bed_assignments']), 4)
        self.drop = drop
        result = self.turn('yes', 'one-accepted-revised-offer')
        snapshot = self.assert_saved(revised, 4)
        self.assert_mock_link_completed(result, snapshot)
        self.assertEqual(len(self.attempts), 2)
        self.assertEqual(self.attempts[0], self.attempts[1], 'Retry must freeze the exact request bytes')
        payload = json.loads(self.attempts[0])
        self.assertTrue(payload['idempotency_key'])
        self.assertEqual(payload['guest_count'], 4)
        self.assertEqual(payload['accepted_offer'], revised)
        self.assertEqual(len(self.payment_edges), 1, 'One combined deposit link, not per-person links')
        self.assertIn(snapshot['tables']['bookings'][0]['booking_code'], result['final_response'])
        if drop == 'before':
            self.assertEqual(self.checkpoints['at_drop']['tables']['bookings'], [])
        else:
            self.assertEqual(snapshot['tables'], self.checkpoints['at_drop']['tables'])
            calls = [c for c in snapshot['calls'] if c['path'] == '/booking-create-from-plan']
            self.assertTrue(calls[-1]['response']['body']['idempotent'])
            self.assertEqual(calls[-1]['response']['body']['booking_id'],
                             self.checkpoints['lost_receipt']['booking_id'])
            self.assertEqual(calls[-1]['response']['body']['payment_id'],
                             self.checkpoints['lost_receipt']['payment_id'])

    def test_r1_revised_four_person_offer_disconnect_before_write(self):
        self.run_r1('before')

    def test_r1_revised_four_person_offer_lost_commit_response(self):
        self.run_r1('after')

    def test_r1_revised_four_person_offer_incomplete_commit_response(self):
        self.run_r1('incomplete')

    def r9_offer(self):
        harness.PLAN.clear()
        harness.PLAN.update(copy.deepcopy(R9))
        availability = json.loads(self.registry.tools['check_availability']['handler'](dict(harness.PLAN)))
        self.checkpoints['availability'] = availability
        self.assertTrue(availability.get('success'), availability)
        self.assertTrue(availability.get('available'), availability)
        self.assertEqual(availability.get('selected_bed_codes'), R9['selected_bed_codes'])
        return self.quote('person-bound-split-quote')

    def split_a_offer(self, mixed_guest_gender=None):
        self.rpc(serious_booking_setup=True, split_save_only=True)
        harness.PLAN.clear()
        harness.PLAN.update(copy.deepcopy(R9))
        # Mixed beds do not require a demographic answer. Only the women-only
        # occupants need explicit eligibility, bound to their ordered slots.
        harness.PLAN['guests'][2].pop('explicit_gender')
        if mixed_guest_gender:
            harness.PLAN['guests'][2]['explicit_gender'] = mixed_guest_gender
        harness.PLAN['guests'][2]['selected_bed_code'] = 'R1-B2'
        harness.PLAN['selected_bed_codes'][2] = 'R1-B2'
        check = self.registry.tools['check_availability']['handler']
        dates = {key: harness.PLAN[key] for key in ('check_in', 'check_out')}
        # Earlier legacy observations have no indexed roster. They must neither
        # confer person eligibility nor veto a later exact Staff-checked split.
        for label, fields in (
            ('women_subgroup', dict(guest_count=2, room_preference='female_only',
                                   gender_preference='female')),
            ('mixed_subgroup', dict(guest_count=1, room_preference='mixed')),
            ('whole_party_unbound', dict(guest_count=3, group_gender='mixed')),
        ):
            self.checkpoints[label] = json.loads(check(dict(dates, room_type='shared', **fields)))
        self.assertEqual(self.checkpoints['women_subgroup']['selected_bed_codes'], ['R5-B1', 'R5-B2'])
        self.assertEqual(self.checkpoints['mixed_subgroup']['selected_bed_codes'], ['R1-B2'])
        self.assertFalse(self.checkpoints['whole_party_unbound']['available'])
        availability = json.loads(check(dict(harness.PLAN)))
        self.checkpoints['indexed_availability'] = availability
        raw = self.rpc(snapshot=True)['calls'][-1]['response']['body']
        self.assertTrue(raw['exact_bed_eligibility']['eligible'], raw)
        self.assertEqual(raw['exact_bed_eligibility']['guest_bed_assignments'], [
            dict(guest_index=0, guest_name='Riley', bed_code='R5-B1'),
            dict(guest_index=1, guest_name='Maya', bed_code='R5-B2'),
            dict(guest_index=2, guest_name='Leo', bed_code='R1-B2')])
        self.assertTrue(availability['available'], availability)
        self.assertEqual(availability['selected_bed_codes'], harness.PLAN['selected_bed_codes'])
        self.assertFalse(availability['room_decision']['clarification_needed'])
        revision = self.quote('split-a-quote')
        self.assertFalse(self.quote_result['room_decision']['clarification_needed'])
        self.assertNotEqual(self.quote_result.get('next_action'), 'ask_room_eligibility')
        return revision

    def test_split_a_checked_women_and_mixed_beds_save_without_mixed_guest_gender(self):
        revision = self.split_a_offer()
        result = self.turn('yes', 'split-a-accepted')
        snapshot = self.assert_saved(revision, 3)
        self.assert_mock_link_completed(result, snapshot)
        guests = sorted(snapshot['tables']['booking_guests'], key=lambda row: row['guest_number'])
        self.assertEqual([(row['guest_number'], row['guest_name'].lower(), row['assigned_bed_code'])
                          for row in guests],
                         [(1, 'riley', 'R5-B1'), (2, 'maya', 'R5-B2'), (3, 'leo', 'R1-B2')])
        self.assertEqual(len(self.attempts), 1)

    def test_split_a_known_male_in_mixed_bed_also_saves(self):
        revision = self.split_a_offer(mixed_guest_gender='male')
        result = self.turn('yes', 'split-a-known-accepted')
        snapshot = self.assert_saved(revision, 3)
        self.assert_mock_link_completed(result, snapshot)
        self.assertEqual(len(self.attempts), 1)

    def test_split_a_occupied_checked_bed_refuses_without_extra_booking(self):
        self.split_a_offer()
        self.rpc(block_bed='R1-B2', check_in=R9['check_in'], check_out=R9['check_out'])
        before = self.rpc(snapshot=True)['tables']
        self.assertEqual(len(before['bookings']), 1)
        self.turn('yes', 'split-a-occupied')
        snapshot = self.rpc(snapshot=True)
        self.assertEqual(snapshot['tables'], before)
        self.assertEqual(self.payment_edges, [])
        creates = [call for call in snapshot['calls'] if call['path'] == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]['response']['status'], 409)
        self.assertEqual(creates[0]['response']['body']['block_reason'], 'overlap_conflict')

    def test_r9_person_bound_split_saves_ordered_assignments(self):
        revision = self.r9_offer()
        result = self.turn('yes', 'split-accepted')
        snapshot = self.assert_saved(revision, 3)
        self.assert_mock_link_completed(result, snapshot)
        guests = sorted(snapshot['tables']['booking_guests'], key=lambda row: row['guest_number'])
        self.assertEqual([(r['guest_name'].lower(), r['assigned_bed_code']) for r in guests],
                         [('riley', 'R5-B1'), ('maya', 'R5-B2'), ('leo', 'R1-B1')])
        self.assertEqual(len(self.payment_edges), 1)

    def test_r9_occupied_checked_bed_refuses_without_extra_booking(self):
        self.r9_offer()
        self.rpc(block_bed='R5-B1', check_in=R9['check_in'], check_out=R9['check_out'])
        before = self.rpc(snapshot=True)['tables']
        self.assertEqual(len(before['bookings']), 1)
        self.turn('yes', 'occupied-split-accepted')
        self.assertEqual(self.rpc(snapshot=True)['tables'], before)
        self.assertEqual(self.payment_edges, [])
        creates = [c for c in self.rpc(snapshot=True)['calls'] if c['path'] == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]['response']['status'], 409)
        self.assertEqual(creates[0]['response']['body']['block_reason'], 'overlap_conflict')

    def tearDown(self):
        target = os.getenv('SERIOUS_BOOKING_EVIDENCE_DIR')
        if target and hasattr(self, 'rpc_lock'):
            directory = Path(target)
            directory.mkdir(parents=True, exist_ok=True)
            (directory / (self._testMethodName + '.json')).write_text(json.dumps({
                'case': self.id(), 'mode': __doc__, 'checkpoints': self.checkpoints,
                'create_request_bytes': self.attempts, 'mock_payment_edges': self.payment_edges,
                'messages': self.messages, 'snapshot': self.rpc(snapshot=True)}, indent=2) + '\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
