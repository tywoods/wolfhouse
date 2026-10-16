"""Offline registered-handler regression; all HTTP is intercepted, never books/sends."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
os.environ['LUNA_CLIENT_SLUG'] = 'wolfhouse-somo'
import wolfhouse_staff_api as plugin


class Registry:
    def __init__(self):
        self.tools = {}
    def register_tool(self, **kwargs):
        self.tools[kwargs['name']] = kwargs['handler']


class SelectedBedRetention(unittest.TestCase):
    def setUp(self):
        self.registry = Registry()
        plugin.register(self.registry)
        self.payload = dict(client_slug='wolfhouse-somo', guest_name='Alice',
            guests=[{'name': 'Alice'}, {'name': 'Bob'}], guest_count=2,
            check_in='2026-10-14', check_out='2026-10-16', package_code='package_none',
            room_preference='shared', group_gender='mixed',
            selected_bed_codes=['R8-B3', 'R4-B1'],
            room_name_hints=[{'name': 'Alice', 'hint': 'female', 'confidence': .99,
                              'explicit_gender': 'female'},
                             {'name': 'Bob', 'hint': 'male', 'confidence': .99,
                              'explicit_gender': 'male'}])
        self.beds = [{'bed_code': 'R8-B3', 'room_code': 'R8', 'room_type': 'female_only'},
                     {'bed_code': 'R4-B1', 'room_code': 'R4', 'room_type': 'male_only'}]
        self.calls = []
        self.availability = None

    def assert_recovery(self, result):
        self.assertFalse(any(route == '/booking-create-from-plan' for route, _ in self.calls))
        self.assertFalse(result['success'])
        self.assertFalse(result['write_performed'])
        self.assertEqual(result['error'], 'accepted_bed_selection_revalidation_required')
        self.assertEqual(result['accepted_setup']['selected_bed_codes'], self.payload['selected_bed_codes'])
        self.assertEqual(result['accepted_setup']['guests'], self.payload['guests'])
        self.assertFalse(any(route == '/booking-create-from-plan' for route, _ in self.calls))

    def test_uncertain_or_unavailable_lookup_never_dispatches_create(self):
        for facts in ({'success': False, 'error': 'db_error'},
                      {'success': True, 'available_beds': self.beds[1:]},
                      {'success': True, 'has_enough_beds': False, 'available_beds': []},
                      {'success': True, 'has_enough_beds': False, 'available_beds': self.beds,
                       'blockers': ['occupied']}):
            with self.subTest(facts=facts):
                self.calls = []
                self.availability = facts
                self.assert_recovery(self.run_handler())

    def test_free_requested_beds_without_authoritative_receipt_fail_closed(self):
        self.availability = dict(success=True, has_enough_beds=True,
                                 available_beds=copy.deepcopy(self.beds))
        self.assert_recovery(self.run_handler())

    def test_real_http_mapper_receipt_with_extra_free_bed_reaches_registered_create(self):
        root = Path(__file__).resolve().parents[4]
        raw = subprocess.check_output([
            'node', str(root / 'scripts/verify-sim11-exact-bed-eligibility.js'),
            '--emit-valid-http-json',
        ], text=True, cwd=root)
        self.availability = json.loads(raw)
        self.payload.update(
            guest_name='Holly', guests=[{'name': 'Holly'}], guest_count=1,
            check_in='2026-10-25', check_out='2026-10-28',
            room_preference='shared', selected_bed_codes=['R7-B3'],
        )
        self.payload.pop('room_name_hints', None)
        self.payload.pop('group_gender', None)
        self.run_handler()
        self.assertEqual(self.create_payload()['selected_bed_codes'], ['R7-B3'])
        self.assertEqual(len(self.availability['available_beds']), 2)

    def run_handler(self):
        def api(route, payload):
            self.calls.append((route, copy.deepcopy(payload)))
            if route == '/availability-check':
                if self.availability is not None:
                    return self.availability
                codes = payload.get('selected_bed_codes') or []
                guests = payload.get('guests') or []
                return dict(success=True, has_enough_beds=True, available_beds=self.beds,
                    exact_bed_eligibility={
                        'eligible': True,
                        'selected_bed_codes': copy.deepcopy(codes),
                        'guest_bed_assignments': [
                            {'guest_index': i, 'guest_name': guests[i]['name'], 'bed_code': code}
                            for i, code in enumerate(codes) if i < len(guests)
                        ],
                    })
            self.assertEqual(route, '/booking-create-from-plan', 'no payment/send/handoff requests')
            return dict(success=False, write_performed=False, error='offline_intercept')
        with patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')), \
             patch.object(plugin, '_post_bot', side_effect=api):
            return json.loads(self.registry.tools['create_booking_from_plan'](self.payload))

    def create_payload(self):
        creates = [body for route, body in self.calls if route == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1, 'eligible selection must reach authoritative create')
        return creates[0]

    def test_accepted_mixed_couple_split_dorm_keeps_exact_order(self):
        self.run_handler()
        self.assertEqual(self.create_payload().get('selected_bed_codes'), ['R8-B3', 'R4-B1'])
        self.assertEqual(self.create_payload()['guests'], [{'name': 'Alice'}, {'name': 'Bob'}])


    def test_autoallocated_mixed_unknown_needs_no_gender_hints(self):
        self.payload.pop('selected_bed_codes')
        self.payload.pop('room_name_hints')
        self.payload.pop('group_gender')
        self.payload['room_preference'] = 'mixed'
        for bed in self.beds:
            bed['room_type'] = 'mixed'
        self.availability = dict(success=True, has_enough_beds=True,
                                 selected_bed_codes=['R8-B3', 'R4-B1'], available_beds=self.beds)
        self.run_handler()
        self.assertEqual(self.create_payload()['selected_bed_codes'], ['R8-B3', 'R4-B1'])
        self.assertNotIn('group_gender', self.create_payload())
        self.assertEqual([route for route, _ in self.calls], ['/availability-check', '/booking-create-from-plan'])

    def test_autoallocated_private_unknown_needs_no_gender_hints(self):
        self.payload.pop('selected_bed_codes')
        self.payload.pop('room_name_hints')
        self.payload.pop('group_gender')
        self.payload['room_preference'] = 'private'
        for bed in self.beds:
            bed['room_type'] = 'private'
        self.availability = dict(success=True, has_enough_beds=True,
                                 selected_bed_codes=['R8-B3', 'R4-B1'], available_beds=self.beds)
        self.run_handler()
        self.assertEqual(self.create_payload()['selected_bed_codes'], ['R8-B3', 'R4-B1'])
        self.assertNotIn('group_gender', self.create_payload())

    def test_accepted_private_neutral_preserves_exact_codes_without_hints(self):
        self.payload.pop('room_name_hints')
        self.payload.pop('group_gender')
        self.payload['room_preference'] = 'private'
        for bed in self.beds:
            bed['room_type'] = 'private'
        self.run_handler()
        self.assertEqual(self.create_payload()['selected_bed_codes'], ['R8-B3', 'R4-B1'])
        self.assertNotIn('group_gender', self.create_payload())
        recheck = next(body for route, body in self.calls if route == '/availability-check')
        self.assertEqual(recheck['room_preference'], 'private')

    def test_changed_private_intent_is_rejected_by_staff_without_create(self):
        self.payload.pop('room_name_hints')
        self.payload.pop('group_gender')
        self.payload['room_preference'] = 'private'
        self.availability = dict(success=True, has_enough_beds=True,
            exact_bed_eligibility={
                'eligible': False, 'reason': 'incompatible_preselected_beds',
                'selected_bed_codes': self.payload['selected_bed_codes'],
                'guest_bed_assignments': [],
            })
        self.assert_recovery(self.run_handler())
        recheck = next(body for route, body in self.calls if route == '/availability-check')
        self.assertEqual(recheck['room_preference'], 'private')

    def test_lookup_exception_returns_typed_recovery_without_create(self):
        with patch.object(plugin, '_post_bot', side_effect=RuntimeError('offline lookup failure')) as transport:
            result = json.loads(self.registry.tools['create_booking_from_plan'](self.payload))
        self.assert_recovery(result)
        self.assertEqual([call.args[0] for call in transport.call_args_list], ['/availability-check'])

    def test_staff_ineligible_exact_beds_require_reconfirmation_without_create(self):
        self.availability = dict(success=True, has_enough_beds=True,
            exact_bed_eligibility={
                'eligible': False, 'reason': 'incompatible_preselected_beds',
                'selected_bed_codes': self.payload['selected_bed_codes'],
                'guest_bed_assignments': [],
            })
        self.assert_recovery(self.run_handler())

    def test_changed_staff_bed_receipt_cannot_authorize_accepted_beds(self):
        self.availability = dict(success=True, has_enough_beds=True,
            exact_bed_eligibility={
                'eligible': True, 'selected_bed_codes': ['R8-B4', 'R4-B1'],
                'guest_bed_assignments': [
                    {'guest_index': 0, 'guest_name': 'Alice', 'bed_code': 'R8-B4'},
                    {'guest_index': 1, 'guest_name': 'Bob', 'bed_code': 'R4-B1'},
                ],
            })
        self.assert_recovery(self.run_handler())

    def test_mixed_rooms_allowed_for_both_travelers(self):
        for bed in self.beds:
            bed['room_type'] = 'mixed'
        self.run_handler()
        self.assertEqual(self.create_payload()['selected_bed_codes'], self.payload['selected_bed_codes'])

    def test_staff_exact_bed_eligibility_allows_nonstandard_room_label(self):
        """Staff eligibility, not Python room labels, owns exact-bed admission."""
        self.beds[0]['room_type'] = 'operator_surfweek'
        self.availability = dict(
            success=True, has_enough_beds=True, available_beds=self.beds,
            exact_bed_eligibility={
                'eligible': True,
                'selected_bed_codes': self.payload['selected_bed_codes'],
                'guest_bed_assignments': [
                    {'guest_index': 0, 'guest_name': 'Alice', 'bed_code': 'R8-B3'},
                    {'guest_index': 1, 'guest_name': 'Bob', 'bed_code': 'R4-B1'},
                ],
            },
        )
        self.run_handler()
        create = self.create_payload()
        self.assertEqual(create['selected_bed_codes'], ['R8-B3', 'R4-B1'])
        self.assertEqual(create['guests'], self.payload['guests'])
        self.assertEqual(create['check_in'], self.payload['check_in'])
        self.assertEqual(create['check_out'], self.payload['check_out'])


    def test_explicit_traveler_statement_overrides_hint(self):
        self.payload['room_name_hints'][0].update(hint='male', explicit_gender='female')
        self.run_handler()
        self.assertEqual(self.create_payload()['selected_bed_codes'], self.payload['selected_bed_codes'])


    def test_malformed_code_order_or_count_fails_closed(self):
        for codes in (['R8-B3'], ['R8-B3', 'R8-B3'], ['R8-B3', {}]):
            with self.subTest(codes=codes):
                self.calls = []
                self.payload['selected_bed_codes'] = codes
                self.assert_recovery(self.run_handler())

    def test_empty_exclusions_leave_selection_unchanged(self):
        from wolfhouse.room_eligibility_policy import decide_room_eligibility
        decision = decide_room_eligibility(guest_count=2, explicit_gender='mixed', room_preference='shared')
        decision['excluded_room_preferences'] = []
        with patch.object(plugin, '_room_decision_for_tool', return_value=decision):
            self.run_handler()
        self.assertEqual(self.create_payload()['selected_bed_codes'], self.payload['selected_bed_codes'])
        self.assertEqual([route for route, _ in self.calls], ['/booking-create-from-plan'])


if __name__ == '__main__':
    unittest.main()
